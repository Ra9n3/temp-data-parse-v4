// Stage 3a/3b: engine WebSocket client. Connects to the scorch-engine sidecar
// spawned by the Rust shell. Protocol v1 (handshake) + v1 extension (load/
// transport/panic/state — Stage 3b additive). Deterministic reconnect backoff
// (NO random jitter — standing rule: no RNG).

import type { PhysicalMidiStreamEvent } from "../plugins/expressionMaps";
import type { Project } from "../shared/schema";

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
  /** Stage 3b-fix: present on no_audio_device errors (human-readable reason). */
  detail?: string;
}

export interface StateMessage {
  type: "state";
  playing: boolean;
  tick: number;
}

/** Stage 3c-1 — one plugin description from the engine's VST3 scan. */
export interface ScannedPlugin {
  name: string;
  vendor: string;
  version?: string;
  /** Plugin identity string (JUCE uniqueId). Stable per plugin. */
  uid: string;
  isInstrument?: boolean;
  path: string;
}

/** Stage 3c-1 — a .vst3 whose scan-worker child crashed or timed out. */
export interface ScanFailedEntry {
  path: string;
  error: string;
}

export interface ScanResultMessage {
  type: "scan_result";
  plugins: ScannedPlugin[];
  failed: ScanFailedEntry[];
  scannedDirs: { dir: string; status: string }[];
}

type EngineMessage = HelloMessage | PongMessage | ErrorMessage | StateMessage | ScanResultMessage;

// Deterministic backoff sequence (seconds): 1, 2, 4, 8, 16 — no jitter.
const BACKOFF_SEQUENCE = [1, 2, 4, 8, 16] as const;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Minimal Note[] → PhysicalMidiStreamEvent[] adapter for the test synth.
 * Emits NOTE_ON at startTick and NOTE_OFF at startTick+durationTicks.
 * Reuses the PhysicalMidiStreamEvent TYPE from expressionMaps.ts (M9).
 * The full vst3EventAdapter (with CCs/bends/articulation switches) is a 3c
 * concern when the engine gets a real sampler; the test synth ignores CCs/bends.
 * Key-switch notes (isKeySwitch) are excluded — they're export-only, never
 * scheduled in playback (same rule as usePlayback.ts:203).
 */
export function notesToEngineEvents(project: Project): PhysicalMidiStreamEvent[] {
  const events: PhysicalMidiStreamEvent[] = [];
  for (const track of project.tracks) {
    // Skip structure/chords/audio tracks (no instrument notes)
    if (track.role === "structure" || track.role === "chords" || track.role === "audio") continue;
    const channel = track.midiChannel ?? 1;
    for (const note of track.notes) {
      if (note.isKeySwitch) continue;
      if (note.durationTicks <= 0) continue;
      events.push({
        eventType: "NOTE_ON",
        channel,
        data1: note.pitch,
        data2: note.velocity,
        timestampTicks: note.startTick,
      });
      events.push({
        eventType: "NOTE_OFF",
        channel,
        data1: note.pitch,
        data2: 0,
        timestampTicks: note.startTick + note.durationTicks,
      });
    }
  }
  // Sort by tick (NOTE_OFF before NOTE_ON at same tick — tie-breaker)
  events.sort((a, b) => a.timestampTicks - b.timestampTicks ||
    (a.eventType === "NOTE_OFF" ? -1 : 1) - (b.eventType === "NOTE_OFF" ? -1 : 1));
  return events;
}

export interface EngineLoadMeta {
  bpm: number;
  ppqn: number;
  timeSignature: { numerator: number; denominator: number };
  endTick: number;
}

export class EngineClient {
  private ws: WebSocket | null = null;
  private status: EngineStatus = "off";
  private reconnectAttempts = 0;
  private reconnectTimer: number | null = null;
  private lastRtt: number | null = null;
  private lastKnownTick = 0;
  private onStatusChange: (status: EngineStatus, rtt: number | null) => void;
  private onStateChange: ((playing: boolean, tick: number) => void) | null = null;
  private onAudioErrorChange: ((code: string | null, detail: string) => void) | null = null;
  private onScanResultChange: ((result: ScanResultMessage) => void) | null = null;

  constructor(onStatusChange: (status: EngineStatus, rtt: number | null) => void) {
    this.onStatusChange = onStatusChange;
  }

  getStatus(): EngineStatus { return this.status; }
  getRtt(): number | null { return this.lastRtt; }

  /** Register a callback for engine state messages (playing + tick). */
  onState(cb: (playing: boolean, tick: number) => void): void {
    this.onStateChange = cb;
  }

  /**
   * Stage 3b-fix: register a callback for engine audio-init failures.
   * Fired with ("no_audio_device", detail) when a transport play is rejected
   * because lazy audio init found no device. Fired with (null, "") when the
   * failure is cleared (reconnect, or a subsequent successful play).
   */
  onAudioError(cb: (code: string | null, detail: string) => void): void {
    this.onAudioErrorChange = cb;
  }

  /** Stage 3c-1: register a callback for VST3 scan results. */
  onScanResult(cb: (result: ScanResultMessage) => void): void {
    this.onScanResultChange = cb;
  }

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
          // Fresh connection — a previous session's audio error is stale.
          this.onAudioErrorChange?.(null, "");
        } else if (msg.type === "pong") {
          if (this.pingSentAt !== null) {
            this.lastRtt = Math.round(performance.now() - this.pingSentAt);
            this.pingSentAt = null;
            this.setStatus("ready");
          }
        } else if (msg.type === "state") {
          // A successful play (playing=true) clears any prior audio failure.
          if (msg.playing) this.onAudioErrorChange?.(null, "");
          // Stage 3b polish: remember the last reported position — the UI
          // playhead keeps it on disconnect instead of snapping to 0.
          this.lastKnownTick = msg.tick;
          if (this.onStateChange) {
            this.onStateChange(msg.playing, msg.tick);
          }
        } else if (msg.type === "scan_result") {
          this.onScanResultChange?.(msg);
        } else if (msg.type === "error") {
          console.warn("[engine] error:", msg.code, msg.echo, msg.detail ?? "");
          // Stage 3b-fix: surface audio-init failure to the UI (footer shows
          // "engine: no audio device" in red while the connection stays up).
          if (msg.code === "no_audio_device") {
            this.onAudioErrorChange?.(msg.code, msg.detail ?? "");
          }
        }
      } catch {
        // Ignore malformed messages.
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      // Panic on disconnect — no stuck notes. Report the LAST KNOWN tick, not
      // 0: the playhead must freeze at the drop position, not snap to zero.
      if (this.onStateChange) this.onStateChange(false, this.lastKnownTick);
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

  /** Load events + meta into the engine (full replace, idempotent). */
  load(events: PhysicalMidiStreamEvent[], meta: EngineLoadMeta): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "load", events, meta }));
    }
  }

  /**
   * Transport control: play, stop, or seek.
   * Stage 3b polish: play MAY carry a start tick. The frontend ALWAYS sends
   * one (the last engine-reported position or a seek target); the engine
   * resumes from its remembered position when the tick is absent and NEVER
   * auto-resets to 0. Stop is panic semantics on the engine side.
   */
  transport(command: "play" | "stop" | "seek", tick?: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = { type: "transport", command };
      if (tick !== undefined) msg.tick = tick;
      this.ws.send(JSON.stringify(msg));
    }
  }

  /** All notes off immediately (stop safety). */
  panic(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "panic" }));
    }
  }

  /**
   * Stage 3c-1: request a VST3 scan. Without dirs the engine scans its own
   * defaults (%COMMONPROGRAMFILES%\VST3 + %APPDATA%\VST3 on Windows); the
   * desktop frontend passes the shell's vst3_paths() so per-user dirs resolve
   * for the logged-in user. Reply arrives via onScanResult.
   */
  scan(dirs?: string[]): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg: Record<string, unknown> = { type: "scan" };
      if (dirs && dirs.length) msg.dirs = dirs;
      this.ws.send(JSON.stringify(msg));
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
