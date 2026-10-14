// Stage 3a: engine WebSocket client. Connects to the scorch-engine sidecar
// spawned by the Rust shell. Protocol v1 (4 message types — see engine/src/main.cpp).
// Deterministic reconnect backoff (NO random jitter — standing rule: no RNG).
//
// This module is display-only this stage: the status indicator in the footer
// reflects connection state. No musical behavior wires to the engine yet (3b).

export type EngineStatus =
  | "off"            // engine exe not found / not spawned
  | "connecting"     // WS opening
  | "handshake"      // connected, waiting for hello
  | "ready"          // hello received, protocol OK
  | "restarting"     // dropped, attempting reconnect
  | "failed";        // max reconnects exceeded

export interface HelloMessage {
  type: "hello";
  engineVersion: string;
  protocol: number;
}

export interface PongMessage {
  type: "pong";
  t: number;
}

export interface ErrorMessage {
  type: "error";
  code: string;
  echo: string;
}

type EngineMessage = HelloMessage | PongMessage | ErrorMessage;

// Deterministic backoff sequence (seconds): 1, 2, 4, 8, 16 — no jitter.
const BACKOFF_SEQUENCE = [1, 2, 4, 8, 16] as const;
const MAX_RECONNECT_ATTEMPTS = 5;

export class EngineClient {
  private ws: WebSocket | null = null;
  private status: EngineStatus = "off";
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private lastRtt: number | null = null;
  private onStatusChange: (status: EngineStatus, rtt: number | null) => void;

  constructor(onStatusChange: (status: EngineStatus, rtt: number | null) => void) {
    this.onStatusChange = onStatusChange;
  }

  getStatus(): EngineStatus { return this.status; }
  getRtt(): number | null { return this.lastRtt; }

  connect(port: number): void {
    this.currentPort = port;
    if (port === 0) {
      this.setStatus("off");
      return;
    }
    this.cleanup();
    this.setStatus("connecting");
    const url = `ws://127.0.0.1:${port}`;
    try {
      this.ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws.onopen = () => {
      this.setStatus("handshake");
    };
    this.ws.onmessage = (event) => {
      try {
        const msg: EngineMessage = JSON.parse(event.data);
        if (msg.type === "hello") {
          this.reconnectAttempts = 0;
          this.setStatus("ready");
        } else if (msg.type === "pong") {
          // RTT = round-trip; the engine's t is monotonic ms, but we can't
          // compute true RTT from it alone. For the indicator we use the
          // time between our ping send and the pong arrival (measured here).
          if (this.pingSentAt !== null) {
            this.lastRtt = Math.round(performance.now() - this.pingSentAt);
            this.pingSentAt = null;
            this.setStatus("ready");
          }
        }
        // Errors are logged to console but don't change status (still connected).
        if (msg.type === "error") {
          console.warn("[engine] error:", msg.code, msg.echo);
        }
      } catch {
        // Ignore malformed messages.
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      if (this.status !== "failed" && this.status !== "off") {
        this.scheduleReconnect();
      }
    };
    this.ws.onerror = () => {
      // onclose will fire after this; reconnect handled there.
    };
  }

  private pingSentAt: number | null = null;

  ping(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.pingSentAt = performance.now();
      this.ws.send(JSON.stringify({ type: "ping" }));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setStatus("failed");
      return;
    }
    this.setStatus("restarting");
    const delay = BACKOFF_SEQUENCE[this.reconnectAttempts] ?? 16;
    this.reconnectAttempts++;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = window.setTimeout(() => {
      const port = this.currentPort;
      if (port) this.connect(port);
    }, delay * 1000);
  }

  private currentPort: number | null = null;

  private setStatus(status: EngineStatus): void {
    this.status = status;
    this.onStatusChange(status, this.lastRtt);
  }

  private cleanup(): void {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  dispose(): void {
    this.cleanup();
    this.setStatus("off");
  }
}
