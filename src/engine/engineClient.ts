// Stage 3a/3b: engine WebSocket client. Connects to the scorch-engine sidecar
// spawned by the Rust shell. Protocol v1 (handshake) + v1 extension (load/
// transport/panic/state — Stage 3b additive). Deterministic reconnect backoff
// (NO random jitter — standing rule: no RNG).

import type { PhysicalMidiStreamEvent } from "../plugins/expressionMaps";
import type { Project } from "../shared/schema";
import { writeErrorLog } from "../diagnostics/errorLog";

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

/** Stage 3c-hotfix (additive): the engine's load receipt — proof the score arrived.
 * The frontend's source switch gates on it; a load that never arrives, is
 * rejected, or parses with skipped events can no longer look like success. */
export interface LoadAckMessage {
  type: "loadAck";
  seq: number;
  /** Entries in the events array as the engine saw it. */
  received: number;
  /** Events that passed validation and are now held by the engine. */
  loaded: number;
  skipped: number;
  firstErrorIndex: number;
  firstErrorReason: string;
  /** Raw message byte size as received by the engine. */
  byteSize: number;
}

export interface LoadReceipt {
  ok: true;
  seq: number;
  received: number;
  loaded: number;
  skipped: number;
  firstErrorIndex: number;
  firstErrorReason: string;
  byteSize: number;
}

export interface LoadFailure {
  ok: false;
  reason: string;
  /** What the frontend TRIED to send (0 bytes if it never got to send). */
  sentEvents: number;
  sentBytes: number;
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
  /** 3e-1/3f-2: the full VST3 class identifier string
   * (PluginDescription::createIdentifierString()) — the load-matching key
   * and the merge key scan_probe results address the row by. */
  classId?: string;
  /** 3f-2: NEVER present in scan_result itself (describe never instantiates);
   * merged into the stored row when the engine's background scan_probe
   * succeeds. */
  capabilities?: ScanPluginCapabilities;
  /** 3f-2: annotation from a FAILED probe. A probe failure NEVER removes or
   * changes the row's identity — the row stays listed and usable. */
  capabilitiesError?: string;
}

/** Stage 3c-1 — a .vst3 whose scan-worker child crashed or timed out.
 * Stage 3f-2: every failed entry also carries the diagnostics (exit code,
 * wall-clock elapsed ms, and the last 2000 chars of the worker's stderr —
 * JUCE merges the child's stdout+stderr into one pipe, so for a crashed
 * worker that tail IS the stderr evidence). */
export interface ScanFailedEntry {
  path: string;
  error: string;
  exitCode?: number;
  elapsedMs?: number;
  stderrTail?: string;
}

export interface ScanResultMessage {
  type: "scan_result";
  plugins: ScannedPlugin[];
  failed: ScanFailedEntry[];
  scannedDirs: { dir: string; status: string }[];
}

/** 3f-2 — the capability record as a scan probe reports it: the same shape
 * the plugin_capabilities handshake carries, minus the instanceId wrapper
 * (a scan row is not a hosted instance). */
export type ScanPluginCapabilities = Omit<PluginCapabilitiesMessage, "type" | "instanceId">;

/** 3f-2 — ONE per scan row, sent by the engine's background probe thread
 * AFTER scan_result: capabilities on success, capabilitiesError on failure
 * (timeout / crash / graceful instantiate refusal). A failure never removes
 * or changes the row — see mergeScanProbe. */
export interface ScanProbeMessage {
  type: "scan_probe";
  classId: string;
  capabilities?: ScanPluginCapabilities;
  capabilitiesError?: string;
}

/** 3f-2 — merge one engine scan_probe into the stored scan rows.
 * Contract: a probe NEVER adds, removes, reorders or re-identifies rows.
 * A matching row gains `capabilities` (success) or `capabilitiesError`
 * (failure, only when it has no capabilities yet). Unknown classIds are
 * ignored (same-array reference returned — callers can skip state churn). */
export function mergeScanProbe(plugins: ScannedPlugin[], msg: ScanProbeMessage): ScannedPlugin[] {
  const idx = plugins.findIndex((p) => p.classId !== undefined && p.classId === msg.classId);
  if (idx < 0) return plugins;
  const next = plugins.slice();
  const row = next[idx];
  if (msg.capabilities) {
    next[idx] = { ...row, capabilities: msg.capabilities, capabilitiesError: undefined };
  } else if (msg.capabilitiesError && !row.capabilities) {
    next[idx] = { ...row, capabilitiesError: msg.capabilitiesError };
  }
  return next;
}

/** Stage 3f-4 — the pill-swap picker's PURE row pipeline: case-insensitive
 * substring filter over name+vendor, then instruments FIRST and name A–Z
 * within each group (deterministic; the dialog only renders this). Rows with
 * a capabilitiesError annotation stay listed — a failed capability PROBE
 * never makes a plugin unswappable (the hosting load is the real judge).
 * PURE: the input array is never reordered or mutated. */
export function swapPickerRows(plugins: ScannedPlugin[], query: string): ScannedPlugin[] {
  const q = query.trim().toLowerCase();
  const pool = q
    ? plugins.filter((p) => `${p.name} ${p.vendor ?? ""}`.toLowerCase().includes(q))
    : plugins.slice();
  return pool.sort((a, b) => {
    const ai = a.isInstrument ? 0 : 1;
    const bi = b.isInstrument ? 0 : 1;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}

/** Stage 3f-5 — the HOSTING fingerprint of a project: every library group's
 * id + pluginId + pluginPath, in project order. This is the plugin set the
 * engine instantiates at load. Note edits, mix edits, renames and state
 * embeds all produce the SAME signature (they may still reload mid-play);
 * a DIFFERENT signature against the last confirmed load means a hosting
 * change, which the engine load_rejects on a rolling transport — the
 * assign-while-playing path must stop first (see planAssignmentLoad). PURE. */
export function pluginSetSignature(
  groups: ReadonlyArray<{ id: string; pluginId: string | null; pluginPath?: string }>,
): string {
  return groups.map((g) => `${g.id}:${g.pluginId ?? ""}:${g.pluginPath ?? ""}`).join("|");
}

/** Stage 3f-5 — the host-on-assign decision (PURE, suite-pinned). An
 * assignment may only become a load when the engine is ready; and while the
 * transport rolls, the engine REJECTS plugin-set loads by design (3c
 * rolling-transport guard) — so playing ⇒ stop first, load after the
 * engine's own playing=false state. "defer-to-connect" sends nothing: the
 * ready-transition's host-on-connect auto-load picks the assignment up the
 * moment the engine arrives. */
export type AssignmentLoadPlan = "load" | "stop-then-load" | "defer-to-connect";
export function planAssignmentLoad(engineReady: boolean, transportPlaying: boolean): AssignmentLoadPlan {
  if (!engineReady) return "defer-to-connect";
  return transportPlaying ? "stop-then-load" : "load";
}

/** Stage 3f-5 — the stop→load release gate. An assignment made while the
 * transport plays queues its load here instead of sending it; the queue
 * releases on the engine's OWN playing=false state message — the proof the
 * transport can no longer load_reject the queued load. Contract: release()
 * is idempotent PER BATCH (the 30Hz state stream must never double-fire a
 * queued load) and every queued callback carries a bounded timeout, so a
 * lost state message can only DELAY the load, never wedge the assignment. */
export interface StoppedGate {
  /** Callbacks queued and not yet released. */
  readonly pending: number;
  /** Queue one load continuation; it runs exactly once — on the next
   * release(), or after timeoutMs if no release ever comes. */
  queue(run: () => void, timeoutMs?: number): void;
  /** Release everything queued (the playing=false state arrived). Returns
   * how many callbacks fired; a second release fires none. */
  release(): number;
}
export function createStoppedGate(): StoppedGate {
  const waiters: Array<() => void> = [];
  return {
    get pending() {
      return waiters.length;
    },
    queue(run: () => void, timeoutMs = 2000): void {
      let done = false;
      const once = () => {
        if (done) return;
        done = true;
        const i = waiters.indexOf(once);
        if (i >= 0) waiters.splice(i, 1);
        run();
      };
      waiters.push(once);
      setTimeout(once, timeoutMs);
    },
    release(): number {
      const n = waiters.length;
      waiters.slice().forEach((w) => w());
      return n;
    },
  };
}

/** Stage 3c-2 — hosting outcome. "loaded" carries the real name/vendor/latency
 * and the hosted channels; "error" carries the detail and means ALL tracks
 * fell back to the engine's built-in test synth (the app never dead-ends).
 * Stage 3d-4: one receipt PER INSTANCE — instanceId addresses it.
 * Stage 3e-1: "loaded" also carries classId — the full VST3 class identifier
 * string the engine PREFERS when matching a load to a plugin binary. */
export interface PluginStateMessage {
  type: "plugin_state";
  state: "loaded" | "error";
  /** Stage 3d-4: the hosted instance this receipt describes. */
  instanceId?: string;
  name?: string;
  vendor?: string;
  /** Stage 3e-1: PluginDescription::createIdentifierString() — the preferred
   * load-matching key (numeric uid remains the fallback). */
  classId?: string;
  /** Total reported latency (plugin + device), milliseconds. */
  latencyMs?: number;
  /** The hosted channels (sorted) — THIS instance's 1–16 namespace. */
  channels?: number[];
  detail?: string;
}

/** Stage 3e-1 — one bus of the hosted plugin (input or output), captured at
 * instantiate time BEFORE any host negotiation: channels/isMain are the
 * plugin's own defaults, and enabledByDefault means the PLUGIN's default
 * (not the host's negotiated state). layoutChangeable is probed honestly —
 * some OTHER channel count is supported. */
export interface PluginBusInfo {
  input: boolean;
  index: number;
  name: string;
  channels: number;
  isMain: boolean;
  enabledByDefault: boolean;
  layoutChangeable: boolean;
}

/** Stage 3e-1 — the capability handshake: exactly one message per hosted
 * instance, sent immediately after its plugin_state "loaded". Read-only
 * facts about the hosted binary, captured right after createPluginInstance
 * (before bus negotiation). Drives the pill's read-only Plugin info panel. */
export interface PluginCapabilitiesMessage {
  type: "plugin_capabilities";
  instanceId: string;
  name: string;
  vendor: string;
  version: string;
  isInstrument: boolean;
  acceptsMidi: boolean;
  producesMidi: boolean;
  isMidiEffect: boolean;
  hasEditor: boolean;
  numPrograms: number;
  latencySamples: number;
  tailSeconds: number;
  supportsDoublePrecision: boolean;
  inputBuses: number;
  outputBuses: number;
  /** PluginDescription::createIdentifierString() — same value plugin_state
   * "loaded" carries (the preferred load-matching key). */
  classId: string;
  buses: PluginBusInfo[];
}

/** Stage 3e-1 — format a capability record as the read-only "Plugin info"
 * text shown on the track pill's hover tooltip (its existing read-only
 * surface — no new UI; see ASSUMPTIONS.md 3e-1). Deterministic, pure. */
export function formatPluginInfo(c: PluginCapabilitiesMessage): string {
  const lines: string[] = [];
  lines.push(`Plugin info — ${c.name}`);
  if (c.vendor) lines.push(`vendor: ${c.vendor}`);
  if (c.version) lines.push(`version: ${c.version}`);
  const flags: string[] = [];
  if (c.isInstrument) flags.push("instrument");
  if (c.acceptsMidi) flags.push("accepts MIDI");
  if (c.producesMidi) flags.push("produces MIDI");
  if (c.isMidiEffect) flags.push("MIDI effect");
  if (c.hasEditor) flags.push("editor");
  if (c.supportsDoublePrecision) flags.push("64-bit");
  if (flags.length) lines.push(`type: ${flags.join(", ")}`);
  lines.push(`programs: ${c.numPrograms} · latency: ${c.latencySamples} samples · tail: ${Number(c.tailSeconds.toFixed(3))}s`);
  lines.push(`buses: ${c.inputBuses} in / ${c.outputBuses} out`);
  for (const b of c.buses) {
    const attrs: string[] = [];
    if (b.isMain) attrs.push("main");
    attrs.push(b.enabledByDefault ? "enabled" : "disabled by default");
    if (b.layoutChangeable) attrs.push("layout changeable");
    lines.push(`  ${b.input ? "in" : "out"}${b.index}: "${b.name}" ${b.channels}ch (${attrs.join(", ")})`);
  }
  if (c.classId) lines.push(`class: ${c.classId}`);
  return lines.join("\n");
}

/** Stage 3d-1 — the hosted plugin's editor window is up. A repeat openEditor
 * request RAISES the existing window (one editor per instance) and re-echoes
 * this message with focused=true instead of opening a second one. */
export interface EditorOpenedMessage {
  type: "editorOpened";
  instanceId: string;
  name?: string;
  width?: number;
  height?: number;
  focused?: boolean;
}

/** Stage 3d-1 — the editor window is gone (protocol close, the window's own
 * X button, or the plugin instance was replaced/unloaded). */
export interface EditorClosedMessage {
  type: "editorClosed";
  instanceId: string;
}

export type EditorEventMessage = EditorOpenedMessage | EditorClosedMessage;

/** Stage 3d-3 — a captured plugin state blob for the project JSON
 * (LibraryGroup.pluginState). Triggers: editor close, instance replacement,
 * explicit captureState. Blobs beyond the ~2 MiB cap arrive with
 * state="too_large" and NO data (the frontend warns; the last embedded
 * state stays authoritative). Stage 3d-4: instanceId names the OWNING
 * instance (= the LibraryGroup id) — the blob embeds into THAT group. */
export interface PluginSavedStateMessage {
  type: "pluginSavedState";
  uid: string;
  path: string;
  instanceId?: string;
  name: string;
  size: number;
  data?: string;
  state?: "too_large";
}

type EngineMessage = HelloMessage | PongMessage | ErrorMessage | StateMessage | ScanResultMessage | ScanProbeMessage | PluginStateMessage | LoadAckMessage | EditorEventMessage | PluginSavedStateMessage | PluginCapabilitiesMessage;

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
  // Stage 3f-2: background probe results (capabilities / capabilitiesError
  // per scan-row classId) — pushed to the app, which merges them into the
  // stored rows via mergeScanProbe.
  private onScanProbeChange: ((msg: ScanProbeMessage) => void) | null = null;
  private onPluginStateChange: ((result: PluginStateMessage) => void) | null = null;
  // Stage 3d-1: editor window open/close events (engine-owned popups).
  private onEditorChange: ((msg: EditorEventMessage) => void) | null = null;
  // Stage 3d-3: captured plugin state blobs (project-JSON embed).
  private onPluginSavedStateChange: ((msg: PluginSavedStateMessage) => void) | null = null;
  // Stage 3e-1: capability records, STORED per instanceId (the pill's Plugin
  // info panel reads them synchronously) and pushed to the app via callback.
  private capabilities = new Map<string, PluginCapabilitiesMessage>();
  private onPluginCapabilitiesChange: ((msg: PluginCapabilitiesMessage) => void) | null = null;
  private onErrorChange: ((code: string, echo: string, detail: string) => void) | null = null;
  // Stage 3c-hotfix: the in-flight load awaiting its loadAck (single slot —
  // a newer load supersedes an older one; see load()).
  private loadSeq = 0;
  private pendingLoad: {
    seq: number;
    sentEvents: number;
    sentBytes: number;
    resolve: (r: LoadReceipt) => void;
    reject: (f: LoadFailure) => void;
    timer: number;
  } | null = null;
  private static readonly LOAD_ACK_TIMEOUT_MS = 4000;

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

  /** Stage 3f-2: register a callback for background scan probe results
   * (capabilities / capabilitiesError per scan-row classId). */
  onScanProbe(cb: (msg: ScanProbeMessage) => void): void {
    this.onScanProbeChange = cb;
  }

  /** Stage 3c-2: register a callback for plugin hosting outcomes. */
  onPluginState(cb: (result: PluginStateMessage) => void): void {
    this.onPluginStateChange = cb;
  }

  /** Stage 3d-1: register a callback for editor window open/close events. */
  onEditor(cb: (msg: EditorEventMessage) => void): void {
    this.onEditorChange = cb;
  }

  /** Stage 3d-3: register a callback for captured plugin state blobs. */
  onPluginSavedState(cb: (msg: PluginSavedStateMessage) => void): void {
    this.onPluginSavedStateChange = cb;
  }

  /** Stage 3e-1: register a callback for plugin capability records (one per
   * hosted instance, right after its loaded receipt). */
  onPluginCapabilities(cb: (msg: PluginCapabilitiesMessage) => void): void {
    this.onPluginCapabilitiesChange = cb;
  }

  /** Stage 3e-1: the stored capability record for a hosted instance (the
   * legacy id "hosted" for single-plugin loads). Undefined = not hosted yet. */
  getPluginCapabilities(instanceId: string): PluginCapabilitiesMessage | undefined {
    return this.capabilities.get(instanceId);
  }

  /**
   * Stage 3c-hotfix: register a callback for ANY engine error message. Every
   * error is also mirrored to error.log — silent engine failures at real
   * project sizes are the bug class this closes. (no_audio_device ALSO fires
   * the audio-error callback above, unchanged.)
   */
  onError(cb: (code: string, echo: string, detail: string) => void): void {
    this.onErrorChange = cb;
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
        } else if (msg.type === "scan_probe") {
          // Stage 3f-2: one per row AFTER scan_result — the app merges it
          // into the stored row by classId (failures never remove rows).
          this.onScanProbeChange?.(msg);
        } else if (msg.type === "plugin_state") {
          this.onPluginStateChange?.(msg);
        } else if (msg.type === "editorOpened" || msg.type === "editorClosed") {
          // Stage 3d-1: engine-owned editor window lifecycle.
          this.onEditorChange?.(msg);
        } else if (msg.type === "pluginSavedState") {
          // Stage 3d-3: the engine captured the plugin's state — the app
          // embeds it in the project JSON (LibraryGroup.pluginState).
          this.onPluginSavedStateChange?.(msg);
        } else if (msg.type === "plugin_capabilities") {
          // Stage 3e-1: capability handshake — store per instance (the
          // reserved legacy id "hosted" for shapeless receipts) and push.
          const iid = msg.instanceId || "hosted";
          this.capabilities.set(iid, msg);
          this.onPluginCapabilitiesChange?.(msg);
        } else if (msg.type === "loadAck") {
          // Stage 3c-hotfix: the engine's load receipt. Resolve the pending load.
          if (this.pendingLoad && (msg.seq === this.pendingLoad.seq || msg.seq === 0)) {
            const pending = this.pendingLoad;
            this.pendingLoad = null;
            window.clearTimeout(pending.timer);
            console.info(`[engine] loadAck: received ${msg.received}, loaded ${msg.loaded}, skipped ${msg.skipped}, byteSize ${msg.byteSize} (seq ${msg.seq})`);
            writeErrorLog("engine", `loadAck: received ${msg.received}, loaded ${msg.loaded}, skipped ${msg.skipped}, firstError ${msg.firstErrorIndex}${msg.firstErrorReason ? ` (${msg.firstErrorReason})` : ""}, byteSize ${msg.byteSize} (seq ${msg.seq}) — sent ${pending.sentEvents} events, ${pending.sentBytes} bytes`);
            pending.resolve({
              ok: true,
              seq: msg.seq,
              received: msg.received,
              loaded: msg.loaded,
              skipped: msg.skipped,
              firstErrorIndex: msg.firstErrorIndex,
              firstErrorReason: msg.firstErrorReason,
              byteSize: msg.byteSize,
            });
          }
        } else if (msg.type === "error") {
          console.warn("[engine] error:", msg.code, msg.echo, msg.detail ?? "");
          // Stage 3c-hotfix: EVERY engine error is receipt-logged and
          // surfaced to the app (toast via onError) — not just no_audio_device.
          writeErrorLog("engine", `error ${msg.code}${msg.detail ? ` — ${msg.detail}` : ""}${msg.echo ? ` (echo ${msg.echo})` : ""}`);
          this.onErrorChange?.(msg.code, msg.echo, msg.detail ?? "");
          // A load rejected by the engine fails FAST — no point waiting for
          // an ack that will never come.
          if (msg.echo === "load" || msg.code === "bad_load") {
            this.rejectPendingLoad(`engine rejected load: ${msg.code}${msg.detail ? ` (${msg.detail})` : ""}`);
          }
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
      // Stage 3c-hotfix: a load in flight can never be acked now.
      this.rejectPendingLoad("connection closed while awaiting loadAck");
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

  /**
   * Stage 3c-2: per-track mute/solo. The engine gates at dispatch BEFORE any
   * channel send (and CC120-flushes channels whose audibility was lost, so
   * the change is immediately audible).
   */
  mix(mutedTrackIds: string[], soloTrackIds: string[]): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "mix", mutedTracks: mutedTrackIds, soloTracks: soloTrackIds }));
    }
  }

  /**
   * Load events + meta into the engine (full replace, idempotent).
   * Stage 3c-2 additive options: `channels` (trackId → 1–16 hosted channel
   * map) and `plugin` (uid+path from the scan — host ONE VST3 for the whole
   * orchestra). Omitted = legacy test-synth load (byte-identical to 3b).
   * Stage 3d-4 (multi-instance): `plugins` (the FULL desired instance set,
   * one per plugin-bearing library group) + `routing` (trackId → {inst, ch}
   * in the instance's 1–16 namespace) REPLACE the legacy pair — the engine
   * still accepts both shapes (additive protocol).
   */
  load(
    events: PhysicalMidiStreamEvent[],
    meta: EngineLoadMeta,
    opts?: {
      channels?: Record<string, number>;
      plugin?: { uid: string; path: string; name?: string; state?: string };
      routing?: Record<string, { inst: string; ch: number }>;
      plugins?: Array<{ instanceId: string; uid: string; path: string; name?: string; state?: string }>;
    },
  ): Promise<LoadReceipt> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        const reason = `engine socket not open (status ${this.status}) — load never sent`;
        writeErrorLog("engine", `load FAILED: ${reason} (${events.length} events)`);
        reject({ ok: false, reason, sentEvents: events.length, sentBytes: 0 });
        return;
      }
      // A newer load supersedes an older in-flight one.
      if (this.pendingLoad) {
        this.rejectPendingLoad("superseded by a newer load");
      }
      const seq = ++this.loadSeq;
      // Serialize ONCE and measure: this is the frontend side of the receipt
      // pair (engine.log logs what the engine received).
      const msg: Record<string, unknown> = { type: "load", seq, events, meta };
      if (opts?.routing && Object.keys(opts.routing).length > 0) msg.routing = opts.routing;
      if (opts?.plugins && opts.plugins.length > 0) msg.plugins = opts.plugins;
      // Legacy single-plugin shape (still accepted by the engine; kept for
      // any caller/test that predates 3d-4).
      if (opts?.channels && Object.keys(opts.channels).length > 0) msg.channels = opts.channels;
      if (opts?.plugin) msg.plugin = opts.plugin;
      const payload = JSON.stringify(msg);
      const bytes = payload.length; // payload is pure ASCII → UTF-16 units == bytes
      console.info(`[engine] load: ${events.length} events, ${bytes} bytes (seq ${seq})`);
      writeErrorLog("engine", `load sent: ${events.length} events, ${bytes} bytes (seq ${seq})`);
      const timer = window.setTimeout(() => {
        if (this.pendingLoad && this.pendingLoad.seq === seq) {
          this.pendingLoad = null;
          const reason = `loadAck timeout after ${EngineClient.LOAD_ACK_TIMEOUT_MS}ms — engine never acknowledged the load`;
          writeErrorLog("engine", `load FAILED: ${reason} (sent ${events.length} events, ${bytes} bytes, seq ${seq})`);
          reject({ ok: false, reason, sentEvents: events.length, sentBytes: bytes });
        }
      }, EngineClient.LOAD_ACK_TIMEOUT_MS);
      this.pendingLoad = { seq, sentEvents: events.length, sentBytes: bytes, resolve, reject, timer };
      this.ws.send(payload);
    });
  }

  /** Stage 3c-hotfix: fail the in-flight load with a reason (ack timeout,
   * engine rejection, disconnect, supersede, dispose). Never throws. */
  private rejectPendingLoad(reason: string): void {
    if (!this.pendingLoad) return;
    const pending = this.pendingLoad;
    this.pendingLoad = null;
    window.clearTimeout(pending.timer);
    writeErrorLog("engine", `load FAILED: ${reason} (sent ${pending.sentEvents} events, ${pending.sentBytes} bytes, seq ${pending.seq})`);
    pending.reject({ ok: false, reason, sentEvents: pending.sentEvents, sentBytes: pending.sentBytes });
  }

  /**
   * Transport control: play, stop, or seek.
   * Stage 3b polish: play MAY carry a start tick. The frontend ALWAYS sends
   * one (the last engine-reported position or a seek target); the engine
   * resumes from its remembered position when the tick is absent and NEVER
   * auto-resets to 0. Stage 3c close-out: stop = MUSICAL RELEASE engine-side
   * (held notes get real note-offs, voices fade ~15ms); instant kill is
   * reserved for the explicit panic message and the play-time pre-panic guard.
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

  /**
   * Stage 3d-1: request the hosted plugin's editor window (an engine-owned
   * popup — see ASSUMPTIONS.md 3d-1). One editor per instance: a repeat
   * request raises the existing window. Failure arrives as an
   * editor_unavailable error (plugins MAY ship no editor).
   */
  openEditor(instanceId = "hosted"): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "openEditor", instanceId }));
    }
  }

  /**
   * Stage 3f-3a: hand the engine the app's main-window HWND (Windows shells
   * only) so engine-owned plugin editor windows are OWNED by the app — no
   * taskbar entries, minimize/close with the app, z-ordered above it. The
   * engine answers hostWindowSet (echo) or a bad_request error; both are
   * fire-and-forget here. A client that never sends (browser dev,
   * non-Windows, older shell) keeps today's floating-window behaviour
   * engine-side — nothing else depends on this message.
   */
  sendHostWindow(hwnd: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "setHostWindow", hwnd }));
    }
  }

  /** Stage 3d-1: close the editor window (idempotent engine-side). */
  closeEditor(instanceId = "hosted"): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "closeEditor", instanceId }));
    }
  }

  /**
   * Stage 3d-3: ask the engine to capture the live plugin's state NOW and
   * push a pluginSavedState blob (the app embeds it in the project JSON).
   * Best-effort: the app fires this on window close — the reliable primary
   * triggers are editor-close and instance-replacement captures.
   */
  captureState(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "captureState" }));
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
    if (this.pendingLoad) {
      this.rejectPendingLoad("client disposed");
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
