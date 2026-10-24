import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useImmer } from "use-immer";
import { invoke } from "@tauri-apps/api/core";
import dorianFixture from "./fixtures/dorian-16bars.json";
import { TopBar } from "./components/TopBar";
import { Arranger } from "./components/Arranger";
import { GenerationSettingsPanel } from "./components/GenerationSettingsPanel";
import { EngineClient, createStoppedGate, formatPluginInfo, mergeScanProbe, planAssignmentLoad, planShareUpdate, planUnlinkUpdate, pluginSetSignature, type EngineLoadMeta, type EngineStatus, type EditorEventMessage, type InstanceLayout, type LoadFailure, type PluginCapabilitiesMessage, type PluginSavedStateMessage, type PluginStateMessage, type ScanResultMessage, type ScannedPlugin, type StoppedGate } from "./engine/engineClient";
import { applyTrackShare, applyTrackUnlink, buildEngineStream, resolveEngineChannelView, shareCandidatesForPlugin, takenEngineChannelsByTrack, type ShareCandidate } from "./engine/engineStream";
import { deriveStripWires, deriveTrackAudioStates, instanceDisplayName, outputPairView, pairLabel, pairUsers, type TrackBindingView } from "./engine/routing";
import { BindingPicker, type PickerInstance } from "./components/BindingPicker";
import { InstancesPanel } from "./components/InstancesPanel";
import { PPQ, projectEndTick, tickToBar } from "./shared/schema";
import { cn } from "./utils/cn";
import {
  AboutDialog,
  ExportDialog,
  MixDialog,
  PianoRoll,
  PluginShareDialog,
  PluginSwapDialog,
  TestsPanel,
  Toasts,
  VstBrowser,
  type ToastItem,
} from "./components/Dialogs";
import { Ph } from "./icons";
import { DEFAULT_PPT, HEADER_WIDTH } from "./constants";
import { usePlayback } from "./audio/usePlayback";
import { writeErrorLog } from "./diagnostics/errorLog";
import {
  createAddedTrack,
  createDefaultProject,
  makeId,
  nextMidiChannel,
  rescaleChordsForMeter,
  rescaleNotesForMeter,
  validateProject,
  type Family,
  type ModeName,
  type PitchClass,
  type Project,
  type TimeSignature,
} from "./shared/schema";
import { generate, fillRandomNotes, generationSummary } from "./generation/generate";
import { parseChord } from "./shared/schema/chords";
import { importProjectJson } from "./export/json";
import { loadAutosave, readBuiltinPreviewPref, saveAutosave, saveBuiltinPreviewPref } from "./state/persistence";
import { runAlignmentTest, runUnitTests, type TestResult } from "./tests/runTests";
import type { PluginScanState } from "./plugins/mockService";

/** P2 — the FIXTURE path only (Dev → Reload Dorian fixture uses this; it must
 * NOT consult the autosave, otherwise "reload fixture" would resurrect saved
 * state instead of the fixture). */
function loadFixture(): Project {
  const fallback = validateProject(dorianFixture);
  if (fallback.ok) return fallback.project;
  return createDefaultProject("Dorian 16 Bars");
}

function loadStartup(): Project {
  // Module 8.11 P2/P3 — startup restore chain: localStorage → validateProject →
  // ok ? saved project : fixture fallback. Corrupt/garbage saves never crash:
  // payload parse/schema/version failures land on the fixture and surface a
  // one-shot toast after mount ("saved project was invalid, loaded default").
  // P2 version guard: a payload whose schemaVersion ≠ 1 is DISCARDED (future-
  // schema safeness). P5: no save present = plain fixture boot, no warning.
  // Chord v2: editingChord lifted — see the Arranger props + TopBar wiring.
  // P6: undo/redo history is deliberately NOT persisted (documented in
  // persistence.ts) — the project is; restoring edit-history stacks across
  // reloads invites stack bugs with no user value.
  const result = loadAutosave();
  if (result.ok && result.project) return result.project;
  if (result.reason === "validate" || result.reason === "version") {
    startupNotice = "saved project was invalid, loaded default";
  }
  return loadFixture();
}

/** One-shot P3 toast surfaced after mount (initializer can be setter-only). */
let startupNotice: string | null = null;
function takeStartupNoticeOnce(): string | null {
  const message = startupNotice;
  startupNotice = null;
  return message;
}

let toastSeq = 0;

// Stage 3a/3b/3b-fix — engine status indicator. Shows connection state (3a),
// audio playback state (3b: "ENGINE: playing · bar X" during engine playback),
// and the audio-init failure state (3b-fix: "engine: no audio device" in red
// when a transport play was rejected because no device was found).
function EngineIndicator({ status, rtt, playing, playheadTick, timeSignature, audioError, pluginState }: {
  status: EngineStatus; rtt: number | null; playing: boolean; playheadTick: number; timeSignature: { numerator: number; denominator: number }; audioError: string | null; pluginState: PluginStateMessage | null;
}) {
  const label = (() => {
    switch (status) {
      case "off": return "engine: off";
      case "connecting": return "engine: connecting…";
      case "handshake": return "engine: handshake…";
      case "ready":
        if (audioError === "no_audio_device") return "engine: no audio device";
        if (playing) {
          const bar = tickToBar(playheadTick, timeSignature);
          return `engine: playing · bar ${bar}`;
        }
        return rtt !== null ? `engine: ready · ${rtt}ms` : "engine: ready";
      case "restarting": return "engine: restarting…";
      case "failed": return "engine: failed";
    }
  })();
  // Stage 3b-fix: audio-init failure shows red even though the engine
  // connection itself is healthy — it's a device problem, not a link problem.
  const color = status === "ready" && audioError === "no_audio_device" ? "text-red-400"
    : status === "ready" && playing ? "text-emerald-300"
    : status === "ready" ? "text-emerald-400"
    : status === "failed" ? "text-red-400"
    : status === "off" ? "text-stone-500"
    : "text-amber-400";
  return (
    <span className="hidden sm:inline">
      <span className={color}>{label}</span>
      {/* Stage 3c-2: hosting outcome at a glance — hosted plugin name, or the
          fallback state (error NEVER dead-ends: tracks stay audible on the
          engine's test synth). */}
      {status === "ready" && pluginState && (
        <span className={pluginState.state === "loaded" ? "text-sky-300" : "text-amber-300"}>
          {" · "}
          {pluginState.state === "loaded"
            ? `${pluginState.name ?? "plugin"} hosted`
            : "plugin failed → test synth"}
        </span>
      )}
    </span>
  );
}

export default function App() {
  const [project, setProject] = useImmer<Project>(loadStartup);
  const [undo, setUndo] = useState<Project[]>([]);
  const [redo, setRedo] = useState<Project[]>([]);
  const [ppt, setPpt] = useState(DEFAULT_PPT);
  const composeSeedRef = useRef(Math.floor(Math.random() * 100_000));
  // Module 8.11 P4 — hydration guard: the autosave effect's FIRST run is the
  // mount itself; writing there would clobber the saved project with whatever
  // the initializer produced before the user ever sees it. The flag is set on
  // that first run and every later project change (commit/patch/import/
  // compose/Dev-menu) autosaves (P1/P5).
  const hydratedRef = useRef(false);
  const [mixOpen, setMixOpen] = useState(false);
  const [generationSettingsOpen, setGenerationSettingsOpen] = useState(false);
  const generationSettings = project.generationSettings ?? createDefaultProject().generationSettings!;
  const [pluginLabels, setPluginLabels] = useState<Record<string, string>>({});
  // Stage 3e-1: capability records per instance (libraryGroup) id — feeds the
  // track-pill's read-only Plugin info tooltip.
  const [pluginCaps, setPluginCaps] = useState<Record<string, PluginCapabilitiesMessage>>({});
  const [vstOpen, setVstOpen] = useState(false);
  const [vstTrackId, setVstTrackId] = useState<string | null>(null);
  const [vstState, setVstState] = useState<PluginScanState>("not_scanned");
  const [exportOpen, setExportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [testsOpen, setTestsOpen] = useState(false);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);
  const [testsRunning, setTestsRunning] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [pianoTrackId, setPianoTrackId] = useState<string | null>(null);
  // Stage 3a: engine status indicator (display-only — no musical behavior
  // wires to the engine yet; 3b connects rendering). The status reflects the
  // WebSocket connection to the scorch-engine sidecar spawned by the Rust shell.
  const [engineStatus, setEngineStatus] = useState<EngineStatus>("off");
  const [engineRtt, setEngineRtt] = useState<number | null>(null);
  const engineClientRef = useRef<EngineClient | null>(null);
  // Stage 3b: engine-driven playback state. When enginePlaying is true, the
  // engine process renders audio; playhead comes from state messages, not
  // usePlayback's RAF loop. When false, usePlayback (webview synth) drives.
  const [enginePlaying, setEnginePlaying] = useState(false);
  const [enginePlayheadTick, setEnginePlayheadTick] = useState(0);
  // Stage 3b polish — SOURCE-SWITCH FLAG (audit fix): "engineDrive" means the
  // LAST play request went to the engine. Stop/seek/rewind route by THIS flag,
  // not by enginePlaying — enginePlaying flickers (it mirrors every 30Hz state
  // message), and the old enginePlaying-based routing let a stop during a
  // flicker hit the webview synth while the engine kept rendering (doubled
  // audio + resume desync). The playhead also stays on the engine side while
  // the drive is engine-owned, even when stopped — no jump to the webview's 0.
  const [engineDrive, setEngineDrive] = useState(false);
  // Stage 3b polish — resume flow: the engine's state messages are the ONE
  // source of truth for position. engineTickRef mirrors them (ref, not state —
  // no stale closure); play sends it back as the explicit start tick.
  const engineTickRef = useRef(0);
  // Play/pause handlers via keyboard use effectivePlaying; F12 opens devtools.
  // Tracks the previous status so a TRANSITION into "ready" (fresh engine
  // process, empty event buffer) invalidates the loaded-score cache exactly
  // once — every pong also reports "ready" and must not.
  const prevStatusRef = useRef<EngineStatus>("off");
  // Score the engine currently holds; a differing project reference forces a
  // reload before play. (Engine restarts invalidate via prevStatusRef.)
  const lastLoadedRef = useRef<Project | null>(null);
  // Routing v1.1 — the built-in preview flag the confirmed load was built
  // with. Toggling the flag changes the STREAM (unbound tracks: silence vs
  // test synth) without changing the project, so the cache must be keyed on
  // BOTH — otherwise a toggle would leave the engine playing the stale mix.
  const lastLoadedPreviewRef = useRef<boolean>(false);
  // Stage 3b-fix: engine audio-init failure code ("no_audio_device") surfaced
  // by a rejected transport play. Footer shows the failure state; cleared on
  // reconnect or on a subsequent successful play.
  const [engineAudioError, setEngineAudioError] = useState<string | null>(null);
  // Stage 3c-1: the engine's real VST3 scan result (desktop VstBrowser mode).
  const [desktopScan, setDesktopScan] = useState<ScanResultMessage | null>(null);
  // Stage 3c-2: hosting outcome. Loaded → footer shows the hosted plugin;
  // error → toast + every track stays on the built-in test synth (no dead-end).
  // Stage 3d-4: the LAST plugin_state receipt (informational footer chip;
  // per-instance truth lives in the receipts log).
  const [pluginState, setPluginState] = useState<PluginStateMessage | null>(null);
  // Stage 3d-1 → 3d-4: which instances have their editor window open
  // (engine-owned popups; one editor per INSTANCE — the set keys are the
  // instance ids, and a track's pill lights up when ITS instance is open).
  const [editorOpenIds, setEditorOpenIds] = useState<Set<string>>(() => new Set());
  // Stage 3d-4 hotfix: which instances the engine has CONFIRMED hosting this
  // session (per-instance plugin_state "loaded" receipts). The pill gate
  // reads this instead of firing openEditor at an instance that does not
  // exist yet — the exact "editor unavailable — no hosted plugin instance"
  // wall the user hit between app start and first play.
  const [hostedIds, setHostedIds] = useState<Set<string>>(() => new Set());
  // Stage 3f-5 — instances the engine NAMED as failed this session (the
  // plugin_state "error" receipt carries the instanceId). Their pills must
  // not show "loading…" forever; the error toast already carries the
  // engine's detail text. Reset alongside hostedIds on a fresh session.
  const [hostingErroredIds, setHostingErroredIds] = useState<Set<string>>(() => new Set());
  // Routing v1 — the live instance layouts (the `layouts` probe + the
  // per-commit `instanceLayout` pushes), the R3 layout-guard notices,
  // per-instance measured latency, the binding-picker target, the instances
  // rail, per-bound-output preview volumes, and whether the engine has ever
  // pushed the (reserved) per-strip levels stream.
  const [layouts, setLayouts] = useState<Record<string, InstanceLayout>>({});
  const [layoutNotices, setLayoutNotices] = useState<Record<string, { unwired: number; liveChannels: number }>>({});
  const [pluginLatency, setPluginLatency] = useState<Record<string, number>>({});
  const [routingTrackId, setRoutingTrackId] = useState<string | null>(null);
  const [instancesOpen, setInstancesOpen] = useState(true);
  const [previewVolumes, setPreviewVolumes] = useState<Record<string, number>>({});
  // Routing v1.1 — the built-in preview opt-in (the silence rules). DEFAULT
  // OFF: tracks without a hosted plugin are SILENT; the built-in synth is a
  // choice, never an automatic substitute. Persisted machine preference.
  const [builtinPreview, setBuiltinPreview] = useState<boolean>(() => readBuiltinPreviewPref());
  const builtinPreviewRef = useRef(builtinPreview);
  useEffect(() => { builtinPreviewRef.current = builtinPreview; }, [builtinPreview]);
  const toggleBuiltinPreview = useCallback(() => {
    // Ref-first (no side effects inside a state updater — StrictMode double-
    // invokes updaters): persist, invalidate the confirmed-load cache (the
    // engine's held score was built with the OLD flag), then flip the state.
    const next = !builtinPreviewRef.current;
    builtinPreviewRef.current = next;
    saveBuiltinPreviewPref(next);
    setBuiltinPreview(next);
    lastLoadedRef.current = null;
    lastLoadedPreviewRef.current = next;
  }, []);
  const [levelsSeen, setLevelsSeen] = useState(false);
  const lastStripsSentRef = useRef<string | null>(null);
  // Stage 3f-5 — the stop→load gate for assignments made while the transport
  // plays: the load queues here and releases on the engine's OWN playing=false
  // state message (see queueAssignmentLoad + the onState handler below).
  const stoppedGateRef = useRef<StoppedGate | null>(null);
  if (!stoppedGateRef.current) stoppedGateRef.current = createStoppedGate();
  // Latest project value for imperative callbacks (status transition, engine
  // receipts) that outlive renders and must read the CURRENT project.
  const projectRef = useRef<Project | null>(null);
  // Stage 3f-4 — the track whose plugin the SWAP picker is open for (the
  // pill's swap icon). null = closed; the dialog itself owns search + confirm.
  const [swapTrackId, setSwapTrackId] = useState<string | null>(null);
  // Stage 3g — the pick that found already-hosted instances of the SAME
  // binary. Open while the share-or-create dialog shows; null = closed.
  // The dialog is modal, so `project` cannot drift under it. `create`
  // carries the ORIGINAL pick payload so "Create a new instance" replays
  // today's behaviour exactly (plugin vs built-in-profile pick).
  const [sharePick, setSharePick] = useState<{
    trackId: string;
    pluginName: string;
    candidates: ShareCandidate[];
    create: { kind: "plugin"; pluginId: string; pluginPath?: string; profileId?: string } | { kind: "profile"; profileId: string };
  } | null>(null);
  // Chord v2 — the editing chord id is LIFTED here (was local to the Arranger
  // lane) so the top-bar panel and the in-lane editor share one source of
  // truth: creation/retarget/Esc/delete all stay in sync. No schema change.
  const [editingChordId, setEditingChordId] = useState<string | null>(null);
  // Keep projectRef current after every render (lint-clean ref sync).
  useEffect(() => { projectRef.current = project; }, [project]);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [audioName, setAudioName] = useState("");
  const [harness, setHarness] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const playback = usePlayback(project, audioBuffer);

  const toast = useCallback((kind: ToastItem["kind"], message: string) => {
    const id = `t${++toastSeq}`;
    setToasts((t) => [...t, { id, kind, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  // P1/P5 — autosave: debounced ~800 ms after ANY project change (the effect
  // fires for commit(), patch(), JSON import, compose and the Dev-menu
  // project swaps — they all funnel through setProject).
  useEffect(() => {
    if (!hydratedRef.current) { hydratedRef.current = true; return; }
    const timer = window.setTimeout(() => saveAutosave(project), 800);
    return () => window.clearTimeout(timer);
  }, [project]);
  // P3 — one-shot corrupt-save toast after mount.
  useEffect(() => {
    const notice = takeStartupNoticeOnce();
    if (notice) toast("error", notice);
  }, [toast]);

  // Stage 3a — engine client lifecycle. The shell spawns scorch-engine and
  // exposes get_engine_info (port + failed flag). We connect, ping every 5s
  // for RTT, and reconnect with deterministic backoff on drop. Display-only.
  useEffect(() => {
    let disposed = false;
    let pingTimer: number | undefined;
    const client = new EngineClient((status, rtt) => {
      if (disposed) return;
      setEngineStatus(status);
      setEngineRtt(rtt);
      // If engine drops while playing, stop engine-driven playback.
      if (status !== "ready" && status !== "off") {
        setEnginePlaying(false);
      }
      // Fresh engine session (reconnect/restart) — the new process has no
      // events loaded; force a reload before the next play. Transition-only:
      // the 5s ping also reports "ready" and must NOT invalidate the cache.
      if (status === "ready" && prevStatusRef.current !== "ready") {
        lastLoadedRef.current = null;
        setHostedIds(new Set());   // new process: nothing is hosted yet
        setHostingErroredIds(new Set());   // 3f-5: no failure receipts either
        lastStripsSentRef.current = null;  // routing v1: re-push the whole strip table to the fresh process
        setLayouts({});                    // routing v1: the new process has no layouts either
        setLayoutNotices({});
        // Stage 3f-3a — editor windows belong to the app. ONCE per fresh
        // engine session, hand the engine the main window's HWND: every
        // subsequently opened plugin editor window becomes OWNED by the app
        // (no taskbar entry, minimizes/closes with the app). The shell
        // command is Windows-only — browser dev / non-Windows / older shells
        // resolve nothing, nothing is sent, and the engine keeps today's
        // floating-window behaviour. Sent BEFORE the auto-load so any editor
        // the user opens after connect is already owned.
        void (async () => {
          const hwnd = await invoke<number>("main_window_hwnd").catch(() => null);
          if (hwnd !== null && Number.isFinite(hwnd) && hwnd >= 1) {
            client.sendHostWindow(hwnd);
          } else {
            writeErrorLog("engine", "main_window_hwnd unavailable — editor windows will keep today's floating behaviour");
          }
        })();
        // Stage 3d-4 hotfix — HOST ON CONNECT. The engine hosts plugins as
        // part of load, and load used to be sent ONLY from the play paths:
        // between app start and the first play the engine hosted NOTHING,
        // so every plugin pill died with "editor unavailable — no hosted
        // plugin instance" (user evidence: 11 refusals across two sessions,
        // one of which never loaded because the user never pressed play).
        // It also broke the persistence promise in practice — reopen
        // restored the UI but not the hosting, and the natural first action
        // (click a pill, pick a patch) was exactly the one that failed.
        // Load the CURRENT project immediately (no play, no transport).
        // The play paths keep their confirmed-load identity check: if this
        // auto-load is still the current project, play goes straight to
        // runEnginePlay; if the user edits first, play sends a fresh load
        // (the engine worker supersedes in-flight loads by design).
        const p = projectRef.current;
        // A fully empty project (fresh install — no events AND no plugin
        // bindings) needs no hosting — skip the load and keep the first
        // startup clean; the play path loads when there is something to load.
        if (p) {
          const stream = buildEngineStream(p, { builtinPreview: builtinPreviewRef.current });
          if (stream.events.length > 0 || stream.plugins.length > 0) {
            const meta: EngineLoadMeta = {
              bpm: p.bpm,
              ppqn: PPQ,
              timeSignature: p.timeSignature,
              endTick: projectEndTick(p),
            };
            void client.load(stream.events, meta, {
              routing: stream.routing,
              plugins: stream.plugins,
            }).then((receipt) => {
              // Routing v1.1 — epoch guard: a newer load request owns the
              // cache/mix actions; this stale confirmation only logs.
              if (receipt.epoch !== client.currentEpoch()) return;
              if (receipt.skipped > 0) {
                writeErrorLog("engineAutoLoad", `startup load incomplete: ${receipt.loaded}/${receipt.received} loaded, ${receipt.skipped} skipped`);
              }
              client.mix(
                p.tracks.filter((t) => t.muted).map((t) => t.id),
                p.tracks.filter((t) => t.soloed).map((t) => t.id),
              );
              lastLoadedRef.current = p; // confirmed load — play fast-path eligible
              lastLoadedPreviewRef.current = builtinPreviewRef.current;
            }).catch((failure: LoadFailure) => {
              // Routing v1.1 — a stale failure (a newer load is queued or in
              // flight) is bookkeeping, not news: silent.
              if (failure.epoch !== client.currentEpoch()) return;
              // Visible but NOT play-path: the user's first play retries the
              // load itself. NO substitute sound — the silence rules: tracks
              // stay silent until a load confirms.
              writeErrorLog("engineAutoLoad", `startup load failed: ${failure.reason}`);
              toast("error", `engine load failed — press play to retry (${failure.reason})`);
            });
          }
        }
      }
      prevStatusRef.current = status;
    });
    // Stage 3b: register state callback for engine-driven playhead.
    client.onState((playing, tick) => {
      if (disposed) return;
      engineTickRef.current = tick; // resume source of truth (see enginePlay)
      setEnginePlaying(playing);
      setEnginePlayheadTick(tick);
      // Stage 3f-5 — release queued assign-while-playing loads on the engine's
      // OWN playing=false state: the proof that the transport can no longer
      // load_reject them (a plugin-set load mid-play is rejected BY DESIGN).
      // The gate is idempotent per batch; each queued load also carries a
      // bounded timeout, so a lost state message only delays it.
      if (!playing) stoppedGateRef.current?.release();
    });
    // Stage 3b-fix: engine rejected a transport play because lazy audio init
    // found no device. Revert the optimistic playing flag (play never started)
    // and surface the failure in the footer.
    client.onAudioError((code) => {
      if (disposed) return;
      setEngineAudioError(code);
      if (code === "no_audio_device") setEnginePlaying(false);
    });
    // Stage 3c-1: real VST3 scan results drive the desktop VstBrowser.
    client.onScanResult((result) => {
      if (disposed) return;
      setDesktopScan(result);
      setVstState(result.plugins.length > 0 ? "loaded" : "empty");
    });
    // Stage 3f-2: background probe results merge into the STORED rows by
    // classId — capabilities on success, a capabilitiesError annotation on
    // failure. A probe NEVER removes a row (mergeScanProbe contract).
    client.onScanProbe((msg) => {
      if (disposed) return;
      setDesktopScan((prev) => (prev ? { ...prev, plugins: mergeScanProbe(prev.plugins, msg) } : prev));
    });
    // Stage 3c-2: hosting outcome → toast + footer; error never dead-ends.
    client.onPluginState((result) => {
      if (disposed) return;
      setPluginState(result);
      if (result.state === "loaded") {
        // Stage 3d-4 hotfix: per-instance hosting truth — the pill gate
        // checks THIS set instead of firing openEditor at an instance the
        // engine has not confirmed. Legacy receipts without instanceId
        // record the reserved id "hosted".
        setHostedIds((prev) => {
          const next = new Set(prev);
          next.add(result.instanceId ?? "hosted");
          return next;
        });
        // Routing v1 — the per-instance measured latency (D10): displayed on
        // the instance card; the engine measures at prepare and re-detects
        // changes itself — the app only ever shows numbers it was told.
        if (result.instanceId && typeof result.latencyMs === "number") {
          setPluginLatency((prev) => ({ ...prev, [result.instanceId as string]: result.latencyMs as number }));
        }
        toast("ok", `${result.name ?? "Plugin"} hosted (latency ${result.latencyMs?.toFixed(1) ?? "?"}ms, channels ${(result.channels ?? []).join(",")})`);
      } else {
        // Stage 3f-5 — the error receipt NAMES the instance: its pill must
        // stop showing "loading…" (hostingErroredIds) instead of spinning
        // forever. The toast below already surfaces the engine's detail text.
        setHostingErroredIds((prev) => {
          const next = new Set(prev);
          next.add(result.instanceId ?? "hosted");
          return next;
        });
        // Stage 3d-3: a plugin the project references but the machine lacks
        // is a NAMED, non-breaking case — Routing v1.1: its tracks are
        // SILENT (never a test-synth substitute) and the project keeps its
        // embedded state for the next install.
        if (/no plugin types found at|createPluginInstance failed/i.test(result.detail ?? "")) {
          toast("error", "plugin not found — install to restore");
        } else {
          toast("error", `${result.name ?? "Plugin"} failed to load — its tracks stay silent: ${result.detail ?? "unknown"}`);
        }
      }
    });
    // Stage 3d-3 → 3d-4: the engine captured a plugin instance's state —
    // embed it in the project JSON (LibraryGroup.pluginState) so patches +
    // mixer settings survive restarts. instanceId names the OWNING instance
    // (= the LibraryGroup id); the uid/path fallback covers legacy receipts.
    // Uses the UPDATER form of the immer setter: the latest project is always
    // the base (this callback outlives renders). setProject (not commit) — a
    // state embed is machine state, not score content; it must NOT spam the
    // undo stack on every editor close.
    let firstStateToastDone = false;
    client.onPluginSavedState((msg: PluginSavedStateMessage) => {
      if (disposed) return;
      if (msg.state === "too_large") {
        toast("error", `plugin state too large to save with the project (${(msg.size / 1024 / 1024).toFixed(1)} MB > 2 MB cap) — patches not embedded`);
        writeErrorLog("engine", `pluginSavedState too_large: ${msg.size} bytes (${msg.name})`);
        return;
      }
      if (!msg.data) return;
      setProject((draft) => {
        let bound = false;
        if (msg.instanceId) {
          for (const g of draft.libraryGroups) {
            if (g.id === msg.instanceId) {
              g.pluginState = msg.data!;
              bound = true;
            }
          }
        }
        if (!bound) {
          // Legacy receipt (no instanceId): bind by scan identity.
          for (const g of draft.libraryGroups) {
            if (g.pluginId === msg.uid || (g.pluginPath && g.pluginPath === msg.path)) {
              g.pluginState = msg.data!;
            }
          }
        }
      });
      writeErrorLog("engine", `pluginSavedState embedded: ${msg.size} bytes (${msg.name}, instance ${msg.instanceId || msg.uid || "n/a"})`);
      if (!firstStateToastDone) {
        firstStateToastDone = true;
        toast("ok", "sound setup saved with the project");
      }
    });
    // Stage 3e-1: capability handshake — store per instance (keyed by the
    // libraryGroup id) for the track-pill's read-only Plugin info panel.
    client.onPluginCapabilities((msg: PluginCapabilitiesMessage) => {
      if (disposed) return;
      setPluginCaps((prev) => ({ ...prev, [msg.instanceId]: msg }));
    });
    // Stage 3d-1 → 3d-4: editor window lifecycle (engine-owned popups). The
    // per-INSTANCE open set flips each track-header pill into its focus
    // affordance; close arrives from the protocol OR the window's X button.
    client.onEditor((msg: EditorEventMessage) => {
      if (disposed) return;
      if (msg.type === "editorOpened") {
        setEditorOpenIds((prev) => {
          const next = new Set(prev);
          next.add(msg.instanceId);
          return next;
        });
        writeErrorLog("engine", `editor opened: ${msg.name ?? msg.instanceId} (${msg.width ?? "?"}x${msg.height ?? "?"})${msg.focused ? " focused" : ""}`);
      } else {
        setEditorOpenIds((prev) => {
          const next = new Set(prev);
          next.delete(msg.instanceId);
          return next;
        });
        // Routing v1 — re-check moment (D16): the editor just closed, which
        // is exactly when a plugin may have changed its own bus layout. The
        // cheap probe re-syncs the app's layout view; pushes cover the rest.
        client.requestLayouts();
        writeErrorLog("engine", `editor closed: ${msg.instanceId}`);
      }
    });
    // Routing v1 — the strips wire callbacks (all additive; the app works
    // fully when the engine never sends any of them).
    client.onLayouts((msg) => {
      if (disposed) return;
      setLayouts((prev) => {
        const next = { ...prev };
        for (const inst of msg.instances) next[inst.instanceId] = inst;
        return next;
      });
    });
    client.onInstanceLayout((msg) => {
      if (disposed) return;
      const { type: _type, ...layout } = msg;
      setLayouts((prev) => ({ ...prev, [msg.instanceId]: layout }));
    });
    client.onStripLayoutChange((msg) => {
      if (disposed) return;
      setLayoutNotices((prev) => ({ ...prev, [msg.instanceId]: { unwired: msg.unwired.length, liveChannels: msg.liveChannels } }));
      toast("info", `an instance's output layout narrowed — ${msg.unwired.length} pair(s) unwired; the bindings are kept and re-resolve when the output returns`);
    });
    client.onStripsResult((msg) => {
      if (disposed) return;
      if (!msg.applied) {
        toast("error", `output wiring rejected by the engine: ${msg.reason ?? "unknown"} — nothing was half-applied`);
      }
    });
    client.onStripLevels(() => {
      // RESERVED feed (engine follow-up): the first push proves the wire —
      // the instance cards' meter slots light up from then on.
      if (disposed) return;
      setLevelsSeen(true);
    });
    // Stage 3c-hotfix: every engine error is user-visible (toast) in addition
    // to error.log — a rejected/failed load can no longer look like success.
    client.onError((code, _echo, detail) => {
      if (disposed) return;
      // Stage 3d-1: plugins MAY ship no editor (createEditor() == nullptr) —
      // that is a normal, named reply, not a generic engine fault.
      if (code === "editor_unavailable") {
        toast("error", `editor unavailable for this plugin${detail ? ` — ${detail}` : ""}`);
        return;
      }
      toast("error", `engine: ${code}${detail ? ` — ${detail}` : ""}`);
    });
    engineClientRef.current = client;

    // Stage 3d-3: app-close capture (best-effort — the reliable triggers are
    // editor-close and instance replacement). Fire-and-forget: the engine
    // may answer before the process dies; if not, the last embed stands.
    const onBeforeUnload = () => client.captureState();
    window.addEventListener("beforeunload", onBeforeUnload);

    invoke<{ port: number; failed: boolean }>("get_engine_info")
      .then((info) => {
        if (disposed) return;
        if (info.failed || info.port === 0) {
          setEngineStatus("off");
          return;
        }
        client.connect(info.port);
        // Ping every 5s for RTT measurement.
        pingTimer = window.setInterval(() => client.ping(), 5000);
      })
      .catch(() => {
        // Not in Tauri (web preview) — engine is off.
        if (!disposed) setEngineStatus("off");
      });

    return () => {
      disposed = true;
      if (pingTimer) window.clearInterval(pingTimer);
      window.removeEventListener("beforeunload", onBeforeUnload);
      client.dispose();
    };
  }, []);

  const commit = useCallback(
    (next: Project) => {
      setUndo((u) => [...u.slice(-79), project]);
      setRedo([]);
      setProject(next);
    },
    [project, setProject],
  );

  const patch = useCallback(
    (p: Partial<Project>) => {
      setProject((draft) => {
        Object.assign(draft, p);
        if (p.bpm !== undefined) {
          draft.tempoMap = [{ tick: 0, bpm: p.bpm }];
        }
      });
      setUndo((u) => [...u.slice(-79), project]);
      setRedo([]);
    },
    [project, setProject],
  );

  const doUndo = useCallback(() => {
    setUndo((u) => {
      if (!u.length) return u;
      const prev = u[u.length - 1];
      setRedo((r) => [...r, project]);
      setProject(() => prev);
      return u.slice(0, -1);
    });
  }, [project, setProject]);

  const doRedo = useCallback(() => {
    setRedo((r) => {
      if (!r.length) return r;
      const next = r[r.length - 1];
      setUndo((u) => [...u, project]);
      setProject(() => next);
      return r.slice(0, -1);
    });
  }, [project, setProject]);

  const compose = useCallback(() => {
    const lockedTrackIds = project.tracks.filter((t) => t.locked).map((t) => t.id);
    const t0 = performance.now();
    const humanization = generationSettings.humanization;
    const seed = ++composeSeedRef.current;
    const tracks = generate(project, { seed, density: 0.75, humanize: humanization.intensity > 0 || humanization.rubato > 0,
      humanizeIntensity: humanization.intensity, rubato: humanization.rubato, intonationCents: humanization.intonationCents,
      latencyCompensation: humanization.latencyCompensation, latencyCompensationMs: humanization.latencyCompensationMs, lockedTrackIds });
    const ms = performance.now() - t0;
    commit({ ...project, tracks });
    const notes = tracks.reduce((n, t) => n + t.notes.length, 0);
    toast("ok", `Composed ${notes} notes in ${ms.toFixed(0)}ms · seed ${seed}`);
  }, [project, generationSettings, commit, toast]);

  // Stage 3b (polished): playback source switch. engineDrive decides where
  // play/stop/seek/rewind go and where the playhead comes from — NOT
  // enginePlaying, which mirrors every state message and flickers.
  // NO half-states: either the engine drives or the webview synth drives.
  const effectivePlaying = enginePlaying || playback.playing;
  const effectivePlayheadTick = engineDrive ? enginePlayheadTick : playback.playheadTick;

  // Stage 3c-1: desktop VstBrowser real-scan handler (engine present only).
  // The shell's vst3_paths() resolves the logged-in user's per-machine and
  // per-user VST3 directories; the browser keeps the mock (no engine there).
  // Stage 3f-7 (item 3): the scan no longer probes rows automatically — the
  // dialogs request probes for the rows they actually SHOW, and "Probe all"
  // is an explicit button. The requested set dedupes in-flight repeats.
  const probesRequestedRef = useRef(new Set<string>());
  const handleRequestProbe = useCallback((classId: string) => {
    if (probesRequestedRef.current.has(classId)) return;
    probesRequestedRef.current.add(classId);
    engineClientRef.current?.probe(classId);
  }, []);
  const handleProbeAll = useCallback(() => {
    engineClientRef.current?.probeAll();
  }, []);
  const desktopVst = useMemo(() => {
    if (engineStatus !== "ready") return null;
    return {
      result: desktopScan ? { plugins: desktopScan.plugins, failed: desktopScan.failed } : null,
      // Stage 3f-2: the scan message carries the shell's default folders
      // PLUS the dialog's persisted extra dirs ("scorch.scanDirs").
      onScan: (extraDirs?: string[]) => {
        setDesktopScan(null);
        setVstState("scanning");
        void (async () => {
          const defaults = await invoke<string[]>("vst3_paths").catch(() => undefined);
          const dirs = [...(defaults ?? []), ...(extraDirs ?? [])];
          engineClientRef.current?.scan(dirs.length ? dirs : undefined);
        })();
      },
      // Stage 3f-7 (item 3): lazy probing — the dialog requests probes for
      // the rows it shows; "Probe all" is the explicit escape hatch.
      onRequestProbe: handleRequestProbe,
      onProbeAll: handleProbeAll,
    };
  }, [engineStatus, desktopScan, handleRequestProbe, handleProbeAll]);

  // Stage 3d-1 → 3d-4: per-TRACK editor request. A track whose library group
  // carries a plugin binding asks the engine for THAT INSTANCE's editor
  // (instanceId = the group id — one editor per instance, simultaneous
  // editors across instances); an unbound track opens the VST browser to
  // assign one. The engine answers editor_unavailable for a not-yet-hosted
  // or editor-less plugin → toast (handled above).
  const openTrackEditor = useCallback((trackId: string) => {
    const t = project.tracks.find((tr) => tr.id === trackId);
    const g = t ? project.libraryGroups.find((lg) => lg.id === t.libraryGroupId) : undefined;
    if (g?.pluginId && g?.pluginPath) {
      // Stage 3d-4 hotfix: HONEST gate. Firing openEditor at an instance the
      // engine has not confirmed produced the misleading "editor unavailable
      // for this plugin — no hosted plugin instance" wall; the truth is one
      // of two transient/visible states, so name THAT instead.
      if (engineStatus !== "ready") {
        toast("info", "audio engine not ready yet — its editor opens when the engine connects");
        return;
      }
      if (!hostedIds.has(g.id)) {
        toast("info", "plugin not hosted yet — still initializing, or its load failed (see the hosting message)");
        return;
      }
      engineClientRef.current?.openEditor(g.id);
    } else {
      setVstTrackId(trackId);
      setVstOpen(true);
    }
  }, [project, engineStatus, hostedIds, toast]);

  // Stage 3f-4 — the EXISTING replace path, reused verbatim: the full
  // instance-set load (routing + plugins[], per-group uid+path). The group id
  // (= engine instanceId) is KEPT by both swap and remove, so the engine
  // worker instantiates per entry and — on failure — RETAINS the previous
  // instance and errors by id (3d-4; multi-mode CI-proven). Routing is never
  // touched by a swap: track MIDI channels stay exactly as they are.
  const sendSwapLoad = useCallback(
    (p: Project) => {
      const client = engineClientRef.current;
      if (!client || client.getStatus() !== "ready") {
        toast("info", "audio engine not ready — press play to load the changed project");
        return;
      }
      const stream = buildEngineStream(p, { builtinPreview: builtinPreviewRef.current });
      if (stream.events.length === 0 && stream.plugins.length === 0) return;
      const meta: EngineLoadMeta = {
        bpm: p.bpm,
        ppqn: PPQ,
        timeSignature: p.timeSignature,
        endTick: projectEndTick(p),
      };
      void client
        .load(stream.events, meta, { routing: stream.routing, plugins: stream.plugins })
        .then((receipt) => {
          // Routing v1.1 — epoch guard: only the newest request caches.
          if (receipt.epoch !== client.currentEpoch()) return;
          lastLoadedRef.current = p; // confirmed load — play fast-path eligible
          lastLoadedPreviewRef.current = builtinPreviewRef.current;
          client.mix(
            p.tracks.filter((t) => t.muted).map((t) => t.id),
            p.tracks.filter((t) => t.soloed).map((t) => t.id),
          );
        })
        .catch((failure: LoadFailure) => {
          // Stale failure (newer load queued/in flight) = bookkeeping: silent.
          if (failure.epoch !== client.currentEpoch()) return;
          writeErrorLog("pluginSwap", `replace load failed: ${failure.reason}`);
          toast("error", `engine reload failed — press play to retry (${failure.reason})`);
        });
    },
    [toast],
  );

  // Stage 3f-4 — confirmed replace: keep the group (id = instanceId), swap
  // its binding to the picked scan row, and DROP the embedded saved state —
  // the confirm promised exactly that (a stale blob silently restoring into
  // a different plugin would violate the contract). profileId re-runs the
  // SAME deterministic name→profile heuristic as first assignment (onPick):
  // binding BBCSO keeps its expression map, anything else hosts as raw notes.
  const replaceTrackPlugin = useCallback(
    (trackId: string, pick: ScannedPlugin) => {
      const t = project.tracks.find((tr) => tr.id === trackId);
      const g = t ? project.libraryGroups.find((lg) => lg.id === t.libraryGroupId) : undefined;
      if (!t || !g || !g.pluginId) return;
      const profileId = /bbcso|bbc symphony/i.test(pick.name) ? "spitfire-bbcso" : undefined;
      const { profileId: _oldProfile, ...rest } = g;
      const next: Project = {
        ...project,
        libraryGroups: project.libraryGroups.map((lg) =>
          lg.id === g.id
            ? { ...rest, name: pick.name, pluginId: pick.uid, pluginPath: pick.path, pluginState: null, ...(profileId ? { profileId } : {}) }
            : lg,
        ),
      };
      commit(next);
      setPluginLabels((p) => ({ ...p, [trackId]: pick.name }));
      setSwapTrackId(null);
      toast("ok", `Replaced ${g.name} with ${pick.name} — saved state discarded`);
      sendSwapLoad(next);
    },
    [project, commit, toast, sendSwapLoad],
  );

  // Stage 3f-4 — confirmed remove: clear ONLY the hosting binding (pluginId,
  // pluginPath, pluginState — back to the test synth). A deliberately chosen
  // profileId (expression map) is preserved: it governs export, not hosting,
  // and the user picked it explicitly. The engine retires the instance for
  // the now-unbound group (grace + capture + editor close by id — 3d-4).
  // Stage 3g — a SHARED group is never torn down under its remaining riders:
  // when other tracks still point at it, the remove becomes an UNLINK of
  // just this track (libraryGroupId + engineChannel cleared — the channel
  // belonged to that instance's namespace). The group keeps its binding and
  // every other rider keeps hosting; the plugin set is unchanged, so the
  // engine update is routing-only (planUnlinkUpdate).
  const removeTrackPlugin = useCallback(
    (trackId: string) => {
      const t = project.tracks.find((tr) => tr.id === trackId);
      const g = t ? project.libraryGroups.find((lg) => lg.id === t.libraryGroupId) : undefined;
      if (!t || !g || !g.pluginId) return;
      const othersUse = project.tracks.some((tr) => tr.id !== trackId && tr.libraryGroupId === g.id);
      if (othersUse) {
        const next = applyTrackUnlink(project, trackId);
        commit(next);
        setPluginLabels((p) => {
          const { [trackId]: _drop, ...labels } = p;
          return labels;
        });
        setSwapTrackId(null);
        toast("ok", `${g.name} unlinked — the track rides the built-in test synth; the other tracks keep the shared instance`);
        const plan = planUnlinkUpdate(engineStatus === "ready", hostedIds.has(g.id), enginePlaying);
        if (plan === "send") sendSwapLoad(next);
        // mid-play-effect: the mid-play reload effect owns the update (same
        // signature → its load hits the engine's reuse fast path).
        // defer/none: nothing changed for the engine (or nothing is live yet).
        return;
      }
      const { pluginPath: _ppath, ...rest } = g;
      const next: Project = {
        ...project,
        libraryGroups: project.libraryGroups.map((lg) => (lg.id === g.id ? { ...rest, pluginId: null, pluginState: null } : lg)),
      };
      commit(next);
      setPluginLabels((p) => {
        const { [trackId]: _drop, ...labels } = p;
        return labels;
      });
      setSwapTrackId(null);
      toast("ok", `${g.name} removed — the track rides the built-in test synth`);
      sendSwapLoad(next);
    },
    [project, commit, toast, engineStatus, hostedIds, enginePlaying, sendSwapLoad],
  );

  // Stage 3d-4 derived sets for the Arranger pills: which tracks have a
  // plugin-bound group (editor affordance) and which of their instances
  // currently have the editor window open (focus affordance).
  const editorTrackIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of project.tracks) {
      const g = project.libraryGroups.find((lg) => lg.id === t.libraryGroupId);
      if (g?.pluginId && g?.pluginPath) ids.add(t.id);
    }
    return ids;
  }, [project]);
  const editorOpenTrackIds = useMemo(() => {
    const ids = new Set<string>();
    if (editorOpenIds.size === 0) return ids;
    for (const t of project.tracks) {
      const g = project.libraryGroups.find((lg) => lg.id === t.libraryGroupId);
      if (g && editorOpenIds.has(g.id)) ids.add(t.id);
    }
    return ids;
  }, [project, editorOpenIds]);
  // Stage 3f-5 — pills mid-hosting: a plugin-bound track whose instance the
  // engine has NEITHER confirmed loaded NOR named as failed, while the engine
  // is ready, shows "loading…" (existing hosting receipts only — no new
  // engine messages). When plugin_state "loaded" arrives the hostedIds gate
  // makes the pill clickable (its editor opens); on "error" the receipt
  // lands in hostingErroredIds, the pill drops back to its label and the
  // toast carries the engine's error text.
  const loadingTrackIds = useMemo(() => {
    const ids = new Set<string>();
    if (engineStatus !== "ready") return ids;
    for (const t of project.tracks) {
      const g = project.libraryGroups.find((lg) => lg.id === t.libraryGroupId);
      if (g?.pluginId && g?.pluginPath && !hostedIds.has(g.id) && !hostingErroredIds.has(g.id)) ids.add(t.id);
    }
    return ids;
  }, [project, engineStatus, hostedIds, hostingErroredIds]);

  // Stage 3e-1: per-track read-only "Plugin info" text (the pill's hover
  // tooltip). Derived from the stored capability record of the track's
  // libraryGroup (= the hosted instance id). Empty = not hosted yet.
  const pluginInfoByTrack = useMemo(() => {
    const out: Record<string, string> = {};
    for (const t of project.tracks) {
      const caps = t.libraryGroupId ? pluginCaps[t.libraryGroupId] : undefined;
      if (caps) out[t.id] = formatPluginInfo(caps);
    }
    return out;
  }, [project, pluginCaps]);

  const enginePlay = useCallback(() => {
    const client = engineClientRef.current;
    if (!client || client.getStatus() !== "ready") {
      // Routing v1.1 — the silence rules: no engine = NO automatic substitute.
      // The webview synth plays only when the user EXPLICITLY opted into the
      // built-in preview (footer toggle); otherwise: named state, silence.
      if (builtinPreviewRef.current) {
        setEngineDrive(false);
        void playback.play();
      } else {
        setEngineDrive(false);
        setEnginePlaying(false);
        toast("info", "audio engine not ready — tracks stay silent until it connects");
      }
      return;
    }
    // The play mechanics, run ONLY after the engine confirms the load
    // (Stage 3c-hotfix: the source switch gates on loadAck).
    const runEnginePlay = () => {
      try {
        // FULL disengagement of the webview synth before the engine renders —
        // if the built-in preview was ever running (explicit opt-in only),
        // its voices and RAF loop die here. No doubled rendering, ever.
        playback.stop();
        // Clear the stale audio error so the footer doesn't lag a retry.
        setEngineAudioError(null);
        // Resume contract: ALWAYS send an explicit start tick — the last
        // position the engine itself reported (stopped position, seek target,
        // or 0 on a fresh session). The engine never auto-resets to 0.
        const resumeTick = Math.max(0, Math.round(engineTickRef.current));
        client.transport("play", resumeTick);
        setEngineDrive(true);
        setEnginePlaying(true);
      } catch (err) {
        // Routing v1.1 — no substitute: log + name the failure; silence until
        // the next play.
        writeErrorLog("enginePlay", err);
        setEngineDrive(false);
        setEnginePlaying(false);
        toast("error", "play failed — press play to retry (see error.log)");
      }
    };
    try {
      // Load only when the engine's score is stale (project changed, fresh
      // engine session, or the built-in preview flag flipped). Skip-loading
      // on repeat plays removes the load-ack state{playing:false} round-trip
      // that used to flicker the UI.
      if (lastLoadedRef.current !== project || lastLoadedPreviewRef.current !== builtinPreviewRef.current) {
        // Routing v1.1 — the stream is built under the CURRENT preview flag:
        // unbound tracks are SILENT by default; test-synth events only when
        // the user opted in. Deterministic; no RNG.
        const stream = buildEngineStream(project, { builtinPreview: builtinPreviewRef.current });
        const meta: EngineLoadMeta = {
          bpm: project.bpm,
          ppqn: PPQ,
          timeSignature: project.timeSignature,
          endTick: projectEndTick(project),
        };
        // Stage 3c-hotfix: the source switch is GATED on the engine's loadAck
        // receipt. Routing v1.1: a FAILED load never starts a substitute —
        // tracks stay silent, the failure is named once (toast + error.log),
        // and the next play retries. Coalescing makes "superseded"
        // impossible; the epoch guard keeps a stale caller silent when a
        // newer load owns the outcome.
        void client.load(stream.events, meta, {
          routing: stream.routing,
          plugins: stream.plugins,
        }).then((receipt) => {
          if (receipt.epoch !== client.currentEpoch()) return; // stale caller
          if (receipt.skipped > 0) {
            writeErrorLog("enginePlay", `load incomplete: ${receipt.loaded}/${receipt.received} loaded, ${receipt.skipped} skipped (first at index ${receipt.firstErrorIndex}${receipt.firstErrorReason ? ": " + receipt.firstErrorReason : ""})`);
            toast("error", `engine load incomplete: ${receipt.skipped} of ${receipt.received} events rejected (first at index ${receipt.firstErrorIndex}${receipt.firstErrorReason ? ": " + receipt.firstErrorReason : ""}) — see error.log`);
          }
          // Mix state rides the confirmed load — the engine rebuilds its snapshot.
          client.mix(
            project.tracks.filter((t) => t.muted).map((t) => t.id),
            project.tracks.filter((t) => t.soloed).map((t) => t.id),
          );
          lastLoadedRef.current = project; // cached only on CONFIRMED load
          lastLoadedPreviewRef.current = builtinPreviewRef.current;
          runEnginePlay();
        }).catch((failure: LoadFailure) => {
          // Routing v1.1 — NO web-synth substitute, ever. The newest caller
          // names the failure once; stale callers stay silent.
          if (failure.epoch !== client.currentEpoch()) return;
          setEngineDrive(false);
          setEnginePlaying(false);
          toast("error", `engine load failed — tracks stay silent until it loads (${failure.reason})`);
        });
        return;
      }
      runEnginePlay();
    } catch (err) {
      // F2 safety net: a throw in the engine branch must never kill the
      // click — log the live stack to %APPDATA%/scorch/error.log. Routing
      // v1.1: NO substitute sound — the failure is named, silence holds.
      writeErrorLog("enginePlay", err);
      setEngineDrive(false);
      setEnginePlaying(false);
      toast("error", "play failed — press play to retry (see error.log)");
    }
  }, [project, playback, toast]);

  const engineStop = useCallback(() => {
    if (engineDrive) {
      try {
        engineClientRef.current?.transport("stop"); // engine-side MUSICAL RELEASE (3c close-out): note-offs + release tails; instant kill is panic-only
      } catch (err) {
        writeErrorLog("engineStop", err);
      }
      setEnginePlaying(false);
    } else {
      playback.stop();
    }
  }, [engineDrive, playback]);

  // Stage 3f-5 — host on assign. Called by BOTH assignment handlers after
  // the project update, ONLY when the new group actually carries a hosting
  // binding (pluginId + pluginPath — mock browser rows have no path). The
  // decision is the suite-pinned pure planAssignmentLoad:
  //   engine not ready → named info toast, NOTHING else — no doomed load
  //     (host-on-connect picks the assignment up when the engine arrives);
  //   transport rolling → stop FIRST, then load ONLY after the engine's OWN
  //     playing=false state message. A plugin-set load on a rolling transport
  //     is load_rejected BY DESIGN (3c) — sending one produced the two red
  //     toasts this stage fixes. The queued load never fires while playing.
  //   stopped → the existing sendSwapLoad immediately (exactly one load).
  // The NEW project object rides every branch (sendSwapLoad(p) sends THAT
  // object and caches it as the confirmed load on ack). Declared AFTER
  // engineStop (its stop-then-load branch calls it).
  const queueAssignmentLoad = useCallback(
    (name: string, next: Project) => {
      const plan = planAssignmentLoad(engineStatus === "ready", effectivePlaying);
      if (plan === "defer-to-connect") {
        toast("info", "audio engine not ready — the plugin loads when it connects");
        return;
      }
      if (plan === "stop-then-load") {
        toast("info", `Transport stopped to load ${name}`);
        engineStop();
        if (engineDrive) {
          // Engine-driven: engineStop() sent the transport stop; release on
          // the engine's OWN playing=false state message (the onState handler
          // releases the gate). Bounded timeout inside the gate covers a lost
          // state frame — the load may be delayed, never wedged.
          stoppedGateRef.current?.queue(() => sendSwapLoad(next));
        } else {
          // Webview-synth-driven: engineStop() above was a synchronous
          // playback.stop() and the ENGINE transport was never rolling —
          // its held state is already playing=false, the load is safe now.
          sendSwapLoad(next);
        }
        return;
      }
      sendSwapLoad(next);
    },
    [engineStatus, effectivePlaying, engineDrive, engineStop, sendSwapLoad, toast],
  );

  // ─── Stage 3g — share one hosted instance between several tracks ──────────
  // The pick flow's two outcomes, extracted so the share-or-create dialog and
  // the no-candidate fast path run the EXACT same code:
  //   createInstanceAssignment / createProfileAssignment = "Create a new
  //     instance" — today's behaviour, byte-for-byte (a fresh makeId("lg")
  //     group per picked track + the 3f-5 host-on-assign load);
  //   shareWithGroup = "Share the existing <name> instance" — NO new group:
  //     the track joins the chosen group and gets the lowest engine channel
  //     no other rider uses (applyTrackShare; all 16 taken → the spec's
  //     "this instance has no free channel" toast and nothing else).
  // The engine update after a Share is ROUTING-ONLY (planShareUpdate): the
  // plugin set is untouched, so no plugin-set load is ever sent for it —
  //   mid-play-effect → the existing mid-play reload effect sends the load,
  //     which hits the engine's reuse fast path (no re-init, transport keeps
  //     rolling — CI-proven receipt "reuse while playing — no re-instantiate");
  //   send → the engine is stopped: the ordinary sendSwapLoad carries the
  //     routing (no transport to disturb);
  //   assign-load → the group is NOT confirmed loaded (fresh session or a
  //     failed host): the engine's desired set DID grow → the 3f-5 contract;
  //   defer → the engine is not here yet: host-on-connect and the next play
  //     load pick the shared routing up.
  const createInstanceAssignment = useCallback(
    (trackId: string, pick: { pluginId: string; name: string; pluginPath?: string; profileId?: string }) => {
      const g = {
        id: makeId("lg"),
        name: pick.name,
        pluginId: pick.pluginId,
        pluginState: null,
        ...(pick.pluginPath ? { pluginPath: pick.pluginPath } : {}),
        ...(pick.profileId ? { profileId: pick.profileId } : {}),
      };
      const next: Project = {
        ...project,
        libraryGroups: [...project.libraryGroups, g],
        tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, libraryGroupId: g.id } : t)),
      };
      commit(next);
      setPluginLabels((p) => ({ ...p, [trackId]: pick.name }));
      toast("ok", `Assigned ${pick.name}${pick.profileId ? " (expression map bound — tracks route to its engine channels)" : ""}`);
      // Stage 3f-5 — host the plugin THE MOMENT it is assigned (mock
      // browser rows carry no pluginPath — nothing to host there).
      if (g.pluginId && g.pluginPath) queueAssignmentLoad(pick.name, next);
    },
    [project, commit, toast, queueAssignmentLoad],
  );

  const createProfileAssignment = useCallback(
    (trackId: string, profileId: string, name: string) => {
      const match = desktopScan?.plugins.find((p) =>
        /bbcso|bbc symphony/i.test(p.name)) ?? undefined;
      const needsBbcso = profileId === "spitfire-bbcso";
      const g = {
        id: makeId("lg"),
        name,
        pluginId: needsBbcso && match ? match.uid : null,
        pluginState: null,
        profileId,
        ...(needsBbcso && match ? { pluginPath: match.path } : {}),
      };
      const next: Project = {
        ...project,
        libraryGroups: [...project.libraryGroups, g],
        tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, libraryGroupId: g.id } : t)),
      };
      commit(next);
      setPluginLabels((p) => ({ ...p, [trackId]: name }));
      toast("ok", `Assigned ${name} (expression map)${needsBbcso && match ? " + hosted plugin" : ""}`);
      if (g.pluginId && g.pluginPath) queueAssignmentLoad(name, next);
    },
    [project, desktopScan, commit, toast, queueAssignmentLoad],
  );

  const shareWithGroup = useCallback(
    (trackId: string, groupId: string, pluginName: string) => {
      const applied = applyTrackShare(project, trackId, groupId);
      if (!applied) {
        // Spec step 2 — the instance's 16 channels are all in use: nothing
        // happens (no commit, no engine message).
        toast("error", "this instance has no free channel");
        return;
      }
      commit(applied.project);
      setPluginLabels((p) => ({ ...p, [trackId]: pluginName }));
      const g = project.libraryGroups.find((lg) => lg.id === groupId);
      toast("ok", `Shared ${g?.name ?? pluginName} — engine channel ${applied.channel} of the existing instance`);
      const plan = planShareUpdate(engineStatus === "ready", hostedIds.has(groupId), enginePlaying);
      if (plan === "send") sendSwapLoad(applied.project);
      else if (plan === "assign-load") queueAssignmentLoad(g?.name ?? pluginName, applied.project);
      // mid-play-effect: the mid-play reload effect sends the routing update
      // (engine reuse fast path — no re-init, no transport stop).
      // defer: host-on-connect / the next play load pick it up.
    },
    [project, commit, toast, engineStatus, hostedIds, enginePlaying, sendSwapLoad, queueAssignmentLoad],
  );

  const engineSeek = useCallback((tick: number) => {
    const t = Math.max(0, Math.round(tick));
    if (engineDrive) {
      // Seek works while playing AND while stopped (the engine's lastTick
      // updates either way, so the next resume starts at the seek target).
      try {
        engineClientRef.current?.transport("seek", t);
      } catch (err) {
        writeErrorLog("engineSeek", err);
      }
      engineTickRef.current = t;
      setEnginePlayheadTick(t);
    } else {
      playback.seek(t);
    }
  }, [engineDrive, playback]);

  const engineRewind = useCallback(() => {
    if (engineDrive) {
      engineSeek(0);
    } else {
      playback.rewind();
    }
  }, [engineDrive, engineSeek, playback]);

  // Panic on abnormal stop (e.g., engine drop during playback).
  useEffect(() => {
    if (engineStatus !== "ready" && enginePlaying) {
      engineClientRef.current?.panic();
      setEnginePlaying(false);
    }
  }, [engineStatus, enginePlaying]);

  // Reload engine score when project changes during engine playback. Also
  // ack-gated (Stage 3c-hotfix): a mid-play reload that silently vanished was
  // the other way to end up rendering a stale/empty score.
  // Stage 3c-regression: SKIP when the engine already holds THIS project's
  // score (lastLoadedRef caches CONFIRMED loads only). The effect used to
  // re-send unconditionally on every enginePlaying transition — the receipts
  // caught it firing 14ms after the initial load's ack (duplicate load) and
  // AGAIN after a state{playing} flip (third load), each landing on a rolling
  // transport and re-instantiating the plugin mid-playback. Same object
  // identity = nothing changed = nothing to reload.
  useEffect(() => {
    if (enginePlaying && engineClientRef.current?.getStatus() === "ready") {
      const client = engineClientRef.current!;
      // Already confirmed by loadAck — with the SAME preview flag. (Routing
      // v1.1: a toggle changes the stream without changing the project.)
      if (lastLoadedRef.current === project && lastLoadedPreviewRef.current === builtinPreviewRef.current) return;
      // Stage 3f-5 — a plugin-SET difference (any group's id/pluginId/
      // pluginPath) against the last CONFIRMED load means a hosting change:
      // the engine load_rejects plugin-set loads on a rolling transport, and
      // this effect sending one only produced the SECOND red toast (the
      // assignment handler already owns the flow: stop → engine's own
      // playing=false → load). Skip SILENTLY — no red toast. Note/mix-only
      // edits keep the same signature and reload exactly as before.
      if (lastLoadedRef.current && pluginSetSignature(lastLoadedRef.current.libraryGroups) !== pluginSetSignature(project.libraryGroups)) return;
      const stream = buildEngineStream(project, { builtinPreview: builtinPreviewRef.current });
      const meta: EngineLoadMeta = {
        bpm: project.bpm,
        ppqn: PPQ,
        timeSignature: project.timeSignature,
        endTick: projectEndTick(project),
      };
      // Routing v1.1 — this load COALESCES with any in-flight one (binding
      // commits, play-path loads): exactly one flight, newest payload wins,
      // no caller is ever rejected for racing. Epoch guards keep stale
      // callers from caching/toasting over the newest request's outcome.
      void client.load(stream.events, meta, {
        routing: stream.routing,
        plugins: stream.plugins,
      }).then((receipt) => {
        if (receipt.epoch !== client.currentEpoch()) return; // stale caller
        if (receipt.skipped > 0) {
          writeErrorLog("engineReload", `mid-play reload incomplete: ${receipt.skipped}/${receipt.received} skipped (first at index ${receipt.firstErrorIndex}${receipt.firstErrorReason ? ": " + receipt.firstErrorReason : ""})`);
          toast("error", `engine reload incomplete: ${receipt.skipped} events rejected — see error.log`);
        }
        client.mix(
          project.tracks.filter((t) => t.muted).map((t) => t.id),
          project.tracks.filter((t) => t.soloed).map((t) => t.id),
        );
        lastLoadedRef.current = project; // cache stays in sync (confirmed load)
        lastLoadedPreviewRef.current = builtinPreviewRef.current;
      }).catch((failure: LoadFailure) => {
        if (failure.epoch !== client.currentEpoch()) return; // stale caller
        toast("error", `engine reload failed — the last confirmed score keeps playing (${failure.reason})`);
      });
    }
  }, [project, enginePlaying, toast, builtinPreview]);

  // ─── Routing v1 — the multi-timbral binding system (pure rules + wire) ──
  // The app owns the strip table (derived, never stored twice); the engine
  // executes it atomically. Every decision from the routing concept lands
  // here: default binding = next free channel + main pair; conflicts are
  // visible; rebinding never stops the transport; missing/offline states
  // are editable views, never destructive edits.
  const pluginNamesByUid = useMemo(() => {
    const out: Record<string, string> = {};
    for (const p of desktopScan?.plugins ?? []) if (p.uid) out[p.uid] = p.name;
    for (const [iid, caps] of Object.entries(pluginCaps)) {
      const uid = project.libraryGroups.find((g) => g.id === iid)?.pluginId;
      if (uid && caps?.name) out[uid] = caps.name;
    }
    return out;
  }, [desktopScan, pluginCaps, project.libraryGroups]);

  const routingView = useMemo(() => outputPairView(project, layouts), [project, layouts]);
  const strips = useMemo(() => deriveStripWires(project, layouts), [project, layouts]);
  const stripSignature = useMemo(
    () => JSON.stringify(strips.wires.map((w) => [w.inst, w.pair0])),
    [strips],
  );

  // Routing v1.1 — the per-track AUDIO state (the silence rules): ok /
  // unbound / loading / offline / missing. Pure derivation from the hosting
  // receipts + live layouts; the routing lines and the footer's "still
  // loading" counter render from the SAME truth.
  const audioStates = useMemo(
    () => deriveTrackAudioStates(project, layouts, hostedIds, hostingErroredIds),
    [project, layouts, hostedIds, hostingErroredIds],
  );

  // The track header's binding line: instance · channel · pair + state tone.
  // Routing v1.1 — the user's header states, verbatim:
  //   Unbound → "No plugin" (no preview audio, MIDI export only)
  //   Loading → spinner (the pill pulses; the line says loading)
  //   Offline → "!" + plugin name (a hosting failure receipt named it)
  //   Missing output → "Missing output"
  const routingLines = useMemo(() => {
    const out: Record<string, { text: string; tone: "ok" | "missing" | "offline" | "unbound" | "loading" }> = {};
    for (const t of project.tracks) {
      if (t.role === "audio" || t.family === "structure") continue;
      const state = audioStates[t.id];
      if (!state || state.kind === "unbound") {
        out[t.id] = { text: "No plugin", tone: "unbound" };
        continue;
      }
      if (state.kind === "ok") {
        const v = routingView[t.id];
        const name = v?.instanceId ? instanceDisplayName(project.libraryGroups, v.instanceId, pluginNamesByUid) : "?";
        out[t.id] = {
          text: `${name} · Ch ${v?.channel ?? "?"} · ${pairLabel(v?.pair0 ?? 0)}`,
          tone: "ok",
        };
        continue;
      }
      // loading | offline | missing — all carry the plugin name.
      const v = routingView[t.id];
      const name = v?.instanceId ? instanceDisplayName(project.libraryGroups, v.instanceId, pluginNamesByUid) : state.pluginName;
      if (state.kind === "loading") {
        out[t.id] = { text: `${name} — loading`, tone: "loading" };
      } else if (state.kind === "offline") {
        out[t.id] = { text: `! ${name} — offline`, tone: "offline" };
      } else {
        out[t.id] = { text: `! ${name} · Ch ${v?.channel ?? "?"} — Missing output`, tone: "missing" };
      }
    }
    return out;
  }, [project.tracks, project.libraryGroups, routingView, pluginNamesByUid, audioStates]);

  // Binding-picker data (all PURE-derived; the edited track's own usages are
  // excluded so its current binding never greys itself out).
  const pickerInstances = useMemo<PickerInstance[]>(
    () =>
      project.libraryGroups
        .filter((g) => g.pluginId && g.pluginPath)
        .map((g) => {
          const caps = pluginCaps[g.id];
          return {
            groupId: g.id,
            hosted: hostedIds.has(g.id),
            layout: layouts[g.id],
            busNames: caps?.buses.filter((b) => !b.input).map((b) => b.name),
            pluginId: g.pluginId,
          };
        }),
    [project.libraryGroups, pluginCaps, hostedIds, layouts],
  );
  const pickerPairUsers = useMemo(() => {
    const out: Record<string, Record<string, string[]>> = {};
    for (const [key, views] of pairUsers(project, layouts).entries()) {
      const sep = key.lastIndexOf(":");
      const iid = key.slice(0, sep);
      const pairKey = key.slice(sep + 1);
      const names = views
        .filter((v) => v.trackId !== routingTrackId)
        .map((v) => project.tracks.find((t) => t.id === v.trackId)?.name ?? "")
        .filter(Boolean);
      if (names.length === 0) continue;
      (out[iid] ??= {})[pairKey] = names;
    }
    return out;
  }, [project, layouts, routingTrackId]);
  const pickerChannelUsers = useMemo(() => {
    const edited = routingTrackId ? project.tracks.find((t) => t.id === routingTrackId) : undefined;
    if (!edited?.libraryGroupId) return [];
    return Object.values(routingView)
      .filter(
        (v): v is TrackBindingView & { instanceId: string; channel: number } =>
          v.instanceId === edited.libraryGroupId &&
          v.trackId !== routingTrackId &&
          v.channel !== null,
      )
      .map((v) => ({ ch: v.channel, by: project.tracks.find((t) => t.id === v.trackId)?.name ?? "" }));
  }, [routingTrackId, project, routingView]);

  // The strip-table push: the FULL app-owned table, only when every wire's
  // instance is confirmed live (the engine rejects unknown/no-node instances
  // atomically — waiting for the commits is the honest order), and only when
  // something actually changed. A fresh engine session resets the sent
  // marker (the ready-transition above) so the table re-pushes.
  useEffect(() => {
    const client = engineClientRef.current;
    if (!client || engineStatus !== "ready") return;
    if (strips.wires.length === 0 && lastStripsSentRef.current === "[]") return;
    if (!strips.wires.every((w) => hostedIds.has(w.inst))) return;
    if (lastStripsSentRef.current === stripSignature) return;
    lastStripsSentRef.current = stripSignature;
    client.sendStrips(strips.wires);
  }, [engineStatus, stripSignature, strips, hostedIds]);

  // Layout re-check moment (transport start): plugins may report a different
  // layout after a prepare — the cheap probe re-syncs before anything binds.
  const prevEnginePlayingRef = useRef(false);
  useEffect(() => {
    if (enginePlaying && !prevEnginePlayingRef.current) {
      engineClientRef.current?.requestLayouts();
    }
    prevEnginePlayingRef.current = enginePlaying;
  }, [enginePlaying]);

  const handleOpenRouting = useCallback(
    (trackId: string) => {
      // Re-check moment (picker open): the freshest layout before choosing.
      engineClientRef.current?.requestLayouts();
      setRoutingTrackId(trackId);
    },
    [],
  );

  const handleCommitBinding = useCallback(
    (trackId: string, binding: { channel: number | null; pair0: number | null }) => {
      const edited = project.tracks.find((t) => t.id === trackId);
      if (!edited) return;
      // D8 — never silently reassign: the picker blocks used pairs; this is
      // the stale-UI guard that names the owner if one still slips through.
      if (binding.pair0 !== null && edited.libraryGroupId) {
        const owner = project.tracks.find(
          (t) =>
            t.id !== trackId &&
            t.libraryGroupId === edited.libraryGroupId &&
            t.engineOutputPair === binding.pair0,
        );
        if (owner) {
          toast("error", `That output pair is already bound to ${owner.name} — unbind it there first.`);
          return;
        }
      }
      commit({
        ...project,
        tracks: project.tracks.map((t) =>
          t.id === trackId
            ? {
                ...t,
                engineChannel: binding.channel ?? undefined,
                engineOutputPair: binding.pair0 ?? undefined,
              }
            : t,
        ),
      });
      // D15 — the transport is never touched: a mid-play rebind rides the
      // engine's atomic strips apply; tails behave per the documented note.
      toast("ok", "Routing binding updated");
    },
    [project, commit, toast],
  );

  const handleApplyAutoSetup = useCallback(
    (groupId: string, assignments: Array<{ trackId: string; pair0: number }>) => {
      void groupId;
      const byId = new Map(assignments.map((a) => [a.trackId, a.pair0]));
      commit({
        ...project,
        tracks: project.tracks.map((t) => (byId.has(t.id) ? { ...t, engineOutputPair: byId.get(t.id) } : t)),
      });
      toast("ok", `Assigned ${assignments.length} output pair${assignments.length === 1 ? "" : "s"}`);
    },
    [project, commit, toast],
  );

  const handlePreviewVolume = useCallback((trackId: string, v: number) => {
    setPreviewVolumes((prev) => ({ ...prev, [trackId]: Math.max(0, Math.min(1.5, v)) }));
  }, []);

  // Stage 3c-2 — live mute/solo: while the engine drives, every toggle ships
  // a mix message so the engine re-gates BEFORE any channel send (and flushes
  // lost channels — the change is audible immediately).
  // Routing v1 — the same message carries the per-bound-output preview gains
  // (stripGains, audio-domain: the engine ramps them ~10 ms). Mute/solo stay
  // PER-TRACK and global across instances (the dispatch gate); strips only
  // ever carry gains here.
  const stripGains = useMemo(() => {
    const out: Record<string, number> = {};
    for (const t of project.tracks) {
      const v = routingView[t.id];
      if (v?.instanceId && v.pair0 !== null) out[`s:${v.instanceId}:${v.pair0}`] = previewVolumes[t.id] ?? 1;
    }
    return out;
  }, [project.tracks, routingView, previewVolumes]);
  const gainsSignature = useMemo(() => JSON.stringify(stripGains), [stripGains]);
  const mixSignature =
    project.tracks.map((t) => `${t.id}:${t.muted ? 1 : 0}${t.soloed ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!engineDrive || engineClientRef.current?.getStatus() !== "ready") return;
    engineClientRef.current?.mix(
      project.tracks.filter((t) => t.muted).map((t) => t.id),
      project.tracks.filter((t) => t.soloed).map((t) => t.id),
      { gains: stripGains },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixSignature, engineDrive, gainsSignature]);

  // Stage 3c-3 — channel assignment UI: the resolved map (explicit + first-come
  // auto) drives the per-track selectors; explicit assignment validates
  // collisions AT ASSIGNMENT TIME (the engine double-checks at load).
  const resolvedEngineChannels = useMemo(() => resolveEngineChannelView(project), [project]);
  // Stage 3g — per-track dropdown filter data: channels the group's OTHER
  // tracks already use (resolved routing). Pure, recomputed per project edit.
  const engineChannelsTaken = useMemo(() => takenEngineChannelsByTrack(project), [project]);
  const handleEngineChannel = useCallback(
    (trackId: string, ch: number | null) => {
      if (ch === null) {
        commit({
          ...project,
          tracks: project.tracks.map((t) =>
            t.id === trackId ? { ...t, engineChannel: undefined } : t,
          ),
        });
        return;
      }
      // Stage 3g — collisions are per-INSTANCE now: each group's channels
      // live in its own 1–16 namespace, so a channel held by a track of
      // ANOTHER group is free for this one (the pre-3g global check would
      // have blocked legal cross-instance reuse). The dropdown already hides
      // same-group channels; this names the owning track if a stale UI still
      // lands one (resolveInstanceRouting would otherwise deterministically
      // fall back to auto for the loser).
      const edited = project.tracks.find((t) => t.id === trackId);
      const owner = edited
        ? project.tracks.find(
            (t) =>
              t.id !== trackId &&
              t.engineChannel === ch &&
              t.libraryGroupId !== null &&
              t.libraryGroupId === edited.libraryGroupId,
          )
        : undefined;
      if (owner) {
        toast(
          "error",
          `Engine channel ${ch} is already assigned to ${owner.name} on this instance (engine channel collision)`,
        );
        return;
      }
      commit({
        ...project,
        tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, engineChannel: ch } : t)),
      });
    },
    [project, commit, toast],
  );

  const noteCount = useMemo(
    () => project.tracks.reduce((n, t) => n + t.notes.length, 0),
    [project.tracks],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        doRedo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        setExportOpen(true);
        return;
      }
      if (typing) return;
      if (e.key === " ") {
        e.preventDefault();
        if (effectivePlaying) engineStop();
        else void enginePlay();
      }
      if (e.key === "Home") engineRewind();
      // Stage 3b polish — F12 opens devtools in RELEASE builds too (the
      // "devtools" cargo feature is enabled; see src-tauri/Cargo.toml).
      // Fire-and-forget: outside Tauri (web preview) the browser's own F12
      // semantics stay untouched.
      if (e.key === "F12") {
        e.preventDefault();
        invoke("open_devtools").catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doRedo, doUndo, enginePlay, engineStop, engineRewind, effectivePlaying]);

  useEffect(() => {
    if (!effectivePlaying) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = effectivePlayheadTick * ppt;
    const vis = el.clientWidth - HEADER_WIDTH;
    const sl = el.scrollLeft;
    if (x < sl + 40 || x > sl + vis - 80) {
      el.scrollLeft = Math.max(0, x - vis * 0.3);
    }
  }, [effectivePlayheadTick, effectivePlaying, ppt]);

  const runTests = useCallback(async () => {
    setTestsRunning(true);
    setTestsOpen(true);
    await new Promise((r) => setTimeout(r, 30));
    const unit = runUnitTests();
    const extra: TestResult[] = [];
    const el = scrollRef.current;
    if (el) extra.push(runAlignmentTest(el));
    else extra.push({ name: "Header/lane alignment", pass: false, detail: "arranger not mounted", ms: 0 });
    extra.push({
      name: "5000-note draw path exists",
      pass: true,
      detail: "Use Dev → Fill 5000 random notes, then scroll",
      ms: 0,
    });
    extra.push({
      name: "Fender Studio manual MIDI check",
      pass: false,
      detail: "Manual: Export merged MIDI → open in Fender Studio → confirm separate tracks at project tempo",
      ms: 0,
    });
    setTestResults([...unit, ...extra]);
    setTestsRunning(false);
  }, []);

  const pianoTrack = project.tracks.find((t) => t.id === pianoTrackId) ?? null;

  return (
    <div className="flex h-full flex-col bg-[#0b0c10] text-stone-100">
      <TopBar
        project={project}
        playheadTick={effectivePlayheadTick}
        playing={effectivePlaying}
        looping={playback.looping}
        metronome={playback.metronome}
        onBpm={(bpm) => patch({ bpm: Math.max(20, Math.min(400, bpm)) })}
        onKey={(key: PitchClass) => patch({ key })}
        onMode={(mode: ModeName) => patch({ mode })}
        onTimeSignature={(timeSignature: TimeSignature) =>
          // PROPORTIONAL RESCALE — note ticks scale by
          // newTicksPerBar/oldTicksPerBar so bar-N-beat-B stays put, mirroring
          // rescaleChordsForMeter (identical ratio + rounding conventions, so
          // chords and notes stay aligned). It is a COMMIT: one undo step
          // restores exact pre-change positions. Generation is untouched.
          commit({
            ...project,
            timeSignature,
            chords: rescaleChordsForMeter(project.chords, project.timeSignature, timeSignature),
            tracks: project.tracks.map((t) => ({ ...t, notes: rescaleNotesForMeter(t.notes, project.timeSignature, timeSignature) })),
          })
        }
        onOrchestralStyle={(orchestralStyle) => patch({ generationSettings: { ...generationSettings, orchestralStyle } })}
        onOpenGenerationSettings={() => setGenerationSettingsOpen(true)}
        onPlay={() => void enginePlay()}
        onStop={engineStop}
        onRewind={engineRewind}
        onToggleLoop={() => playback.setLooping(!playback.looping)}
        onToggleMetronome={() => playback.setMetronome(!playback.metronome)}
        onCompose={compose}
        onExport={() => setExportOpen(true)}
        editingChord={editingChordId}
        editingChordObj={editingChordId ? project.chords.find((c) => c.id === editingChordId) ?? null : null}
        onCloseEditingChord={() => setEditingChordId(null)}
        onDeleteEditingChord={() => {
          if (!editingChordId) return;
          // Deleting the chord being edited closes the panel with it.
          patch({ chords: project.chords.filter((c) => c.id !== editingChordId) });
          setEditingChordId(null);
        }}
        onChangeChordSymbol={(id, symbol) => {
          const parsed = parseChord(symbol);
          if (!parsed.ok) return; // no commit for invalid parse (red ring only)
          const quality = parsed.chord.quality === "minor" || parsed.chord.quality.startsWith("m") ? "Min" : parsed.chord.quality === "diminished" || parsed.chord.quality === "dim7" ? "Dim" : parsed.chord.quality === "augmented" || parsed.chord.quality === "aug7" ? "Aug" : parsed.chord.quality === "sus2" ? "Sus2" : parsed.chord.quality === "sus4" || parsed.chord.quality === "7sus4" ? "Sus4" : "Maj";
          patch({
            chords: project.chords.map((x) => (x.id === id ? { ...x, symbol, quality, extensions: parsed.chord.extensions, bassOverride: parsed.chord.bass ?? undefined } : x)),
          });
        }}
      />

      {/* Routing v1 — the arranger shares the row with the instances rail. */}
      <div className="flex min-h-0 flex-1">
      <Arranger
        project={project}
        pixelsPerTick={ppt}
        playheadTick={effectivePlayheadTick}
        pluginLabels={pluginLabels}
        pluginInfoByTrack={pluginInfoByTrack}
        // Stage 3f-5 — pills mid-hosting show "loading…" until the engine's
        // plugin_state receipt confirms the instance (loaded → clickable,
        // error → label + toast).
        pluginLoadingTrackIds={loadingTrackIds}
        engineChannels={resolvedEngineChannels}
        engineChannelsTaken={engineChannelsTaken}
        onEngineChannel={handleEngineChannel}
        audioBuffer={audioBuffer}
        audioName={audioName}
        selectedTrackId={selectedTrackId}
        scrollRef={scrollRef}
        onPixelsPerTick={setPpt}
        onSeek={engineSeek}
        onPatchProject={patch}
        editingChord={editingChordId}
        onEditChord={setEditingChordId}
        onToggleMute={(id) =>
          commit({
            ...project,
            tracks: project.tracks.map((t) => (t.id === id ? { ...t, muted: !t.muted } : t)),
          })
        }
        onToggleSolo={(id) =>
          commit({
            ...project,
            tracks: project.tracks.map((t) => (t.id === id ? { ...t, soloed: !t.soloed } : t)),
          })
        }
        onToggleLock={(id) =>
          commit({
            ...project,
            tracks: project.tracks.map((t) => (t.id === id ? { ...t, locked: !t.locked } : t)),
          })
        }
        onOpenVst={(id) => {
          setVstTrackId(id);
          setVstOpen(true);
        }}
        // Stage 3d-4: per-TRACK editor request — a plugin-bound track opens
        // ITS instance's editor; an unbound track falls through to the VST
        // browser (the handler does both; the pill affordances below gate
        // per track, replacing the old single-instance global gate).
        onOpenEditor={openTrackEditor}
        editorTrackIds={editorTrackIds}
        editorOpenTrackIds={editorOpenTrackIds}
        onSwapPlugin={setSwapTrackId}
        onLoadAudio={() => audioInputRef.current?.click()}
        onAddTrack={(family: Family) => {
          const t = createAddedTrack(family);
          t.midiChannel = nextMidiChannel(project.tracks);
          commit({ ...project, tracks: [...project.tracks, t] });
        }}
        onSelectTrack={setSelectedTrackId}
        onOpenPianoRoll={setPianoTrackId}
        routingLines={routingLines}
        onOpenRouting={handleOpenRouting}
        previewVolumes={previewVolumes}
        onPreviewVolume={handlePreviewVolume}
      />

      <InstancesPanel
        open={instancesOpen}
        onToggle={() => setInstancesOpen((v) => !v)}
        project={project}
        layouts={layouts}
        capsByInstance={pluginCaps}
        pluginNames={pluginNamesByUid}
        hostedIds={hostedIds}
        latencyByInstance={pluginLatency}
        layoutNotices={layoutNotices}
        levelsSupported={levelsSeen}
        onOpenPicker={handleOpenRouting}
        onApplyAutoSetup={handleApplyAutoSetup}
      />
      </div>

      {generationSettingsOpen && <GenerationSettingsPanel settings={generationSettings} onChange={(value) => patch({ generationSettings: value })} onClose={() => setGenerationSettingsOpen(false)} />}

      {pianoTrack && (
        <PianoRoll
          track={pianoTrack}
          project={project}
          onChange={(notes) =>
            commit({
              ...project,
              tracks: project.tracks.map((t) => (t.id === pianoTrack.id ? { ...t, notes } : t)),
            })
          }
          onClose={() => setPianoTrackId(null)}
          onPreviewNote={(pitch) => void playback.previewNote(pitch, pianoTrack.family, pianoTrack.role)}
        />
      )}

      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-white/10 bg-[#0e1016] px-3 font-mono text-[11px] text-stone-500">
        <div className="flex items-center gap-3">
          <span>{project.tracks.length} tracks</span>
          <span>{noteCount} notes</span>
          <span>
            undo {undo.length}/{redo.length}
          </span>
          <span>
            {project.timeSignature.numerator}/{project.timeSignature.denominator} · {project.bpm} BPM
          </span>
          {/* Routing v1.1 — the silence rules' counter: play is never locked;
              bound tracks whose instance has no plugin_state receipt yet stay
              SILENT and are counted here until they land. */}
          {loadingTrackIds.size > 0 && (
            <span className="animate-pulse text-amber-300">
              {loadingTrackIds.size} track{loadingTrackIds.size === 1 ? "" : "s"} still loading
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <EngineIndicator status={engineStatus} rtt={engineRtt} playing={enginePlaying} playheadTick={enginePlayheadTick} timeSignature={project.timeSignature} audioError={engineAudioError} pluginState={pluginState} />
          {/* Routing v1.1 — the built-in preview opt-in (default OFF): the
              built-in synth is a CHOICE, never an automatic substitute. When
              off, unbound/failed tracks are silent; MIDI export is unaffected
              either way. */}
          <button
            type="button"
            onClick={toggleBuiltinPreview}
            title={
              builtinPreview
                ? "Built-in preview is ON — tracks without a plugin play the built-in synth. Click to restore the silence rules (no substitute sounds)."
                : "Built-in preview is OFF (default) — tracks without a plugin stay silent; no substitute sounds, ever. Click to preview unbound tracks with the built-in synth."
            }
            className={cn(
              "rounded px-1.5 py-0.5 ring-1",
              builtinPreview
                ? "bg-amber-500/15 text-amber-300 ring-amber-400/30"
                : "text-stone-500 ring-white/10 hover:text-stone-300",
            )}
          >
            built-in preview: {builtinPreview ? "on" : "off"}
          </button>
          <button type="button" className="hover:text-stone-200" onClick={() => jsonInputRef.current?.click()} title="Import project JSON">
            Import
          </button>
          <button type="button" className="hover:text-stone-200" onClick={doUndo} title="Undo (Ctrl+Z)">
            Undo
          </button>
          <button type="button" className="hover:text-stone-200" onClick={doRedo} title="Redo (Ctrl+Y)">
            Redo
          </button>
          <DevMenu
            onFill={() => {
              commit({ ...project, tracks: fillRandomNotes(project, 5000, 42) });
              toast("info", "Filled 5,000 random notes");
            }}
            onFixture={() => {
              setProject(loadFixture()); // P5: reload fixture loads THE FIXTURE (not saved state)
              setUndo([]);
              setRedo([]);
              toast("ok", "Loaded Dorian 16 Bars fixture");
            }}
            onNew={() => {
              setProject(createDefaultProject());
              setUndo([]);
              setRedo([]);
            }}
            onTests={() => void runTests()}
            onHarness={() => {
              const tracks = generate(project, {
                seed: 1,
                density: 0.75,
                humanize: false,
                humanizeIntensity: 0,
                lockedTrackIds: project.tracks.filter((t) => t.locked).map((t) => t.id),
              });
              const p = { ...project, tracks };
              setHarness(generationSummary(p));
            }}
            onAbout={() => setAboutOpen(true)}
            onMix={() => setMixOpen(true)}
          />
        </div>
      </footer>

      <VstBrowser
        open={vstOpen}
        state={vstState}
        onClose={() => setVstOpen(false)}
        onState={setVstState}
        desktop={desktopVst}
        onPick={(pluginId, name, pluginPath) => {
          if (!vstTrackId) return;
          // Stage 3c — binding a scanned plugin ALSO auto-matches a built-in
          // expression map when the name identifies one (deterministic name
          // heuristic, documented): "BBCSO"/"BBC Symphony" ⇒ spitfire-bbcso.
          // The profile drives UACC CC#32 / 20ms pre-trigger / cc74Scale 0.5;
          // the pluginId+pluginPath bind the hosted binary.
          const profileId = /bbcso|bbc symphony/i.test(name) ? "spitfire-bbcso" : undefined;
          // Stage 3g — BEFORE creating a group: does an existing group already
          // host THIS binary (pluginId AND pluginPath equal)? If so, the user
          // chooses between sharing that instance and a fresh one (spec step
          // 1). Mock browser rows carry no path — nothing to share there.
          if (pluginPath) {
            const candidates = shareCandidatesForPlugin(project.libraryGroups, project.tracks, pluginId, pluginPath);
            if (candidates.length > 0) {
              setSharePick({ trackId: vstTrackId, pluginName: name, candidates, create: { kind: "plugin", pluginId, pluginPath, profileId } });
              return;
            }
          }
          createInstanceAssignment(vstTrackId, { pluginId, name, pluginPath, profileId });
        }}
        onPickProfile={(profileId, name) => {
          if (!vstTrackId) return;
          // Module 9: built-in expression maps create the group with profileId
          // set (no scanned plugin); the exporter then takes the profile path.
          // Stage 3c — in desktop mode a matching scanned plugin binds too
          // (same deterministic name heuristic as onPick), so the map is
          // playable through the hosted instance, not just export.
          const match = desktopScan?.plugins.find((p) =>
            /bbcso|bbc symphony/i.test(p.name)) ?? undefined;
          const needsBbcso = profileId === "spitfire-bbcso";
          // Stage 3g — the share offer for a profile pick that BINDS a binary:
          // only groups with the same binary AND the same profile qualify
          // (sharing a raw same-binary group would strip this track's
          // profile semantics — export AND hosted UACC path).
          if (needsBbcso && match) {
            const candidates = shareCandidatesForPlugin(project.libraryGroups, project.tracks, match.uid, match.path, profileId);
            if (candidates.length > 0) {
              setSharePick({ trackId: vstTrackId, pluginName: name, candidates, create: { kind: "profile", profileId } });
              return;
            }
          }
          createProfileAssignment(vstTrackId, profileId, name);
        }}
      />
      {(() => {
        // Stage 3f-4 — the pill's swap picker. currentName resolves from the
        // track's group (its hosting identity), falling back to the pill
        // label. Desktop scan rows only (real hosting); an empty list tells
        // the user to scan first. Stage 3g — affectedTracks names the group's
        // rider count so the confirm says "this changes N tracks" (shared
        // replace) or becomes an unlink note (shared remove).
        if (swapTrackId === null) return null;
        const t = project.tracks.find((tr) => tr.id === swapTrackId);
        const g = t ? project.libraryGroups.find((lg) => lg.id === t.libraryGroupId) : undefined;
        const affectedTracks = g ? project.tracks.filter((tr) => tr.libraryGroupId === g.id).length : 1;
        return (
          <PluginSwapDialog
            open
            currentName={g?.name ?? pluginLabels[swapTrackId] ?? "the plugin"}
            plugins={desktopScan?.plugins ?? []}
            affectedTracks={affectedTracks}
            onClose={() => setSwapTrackId(null)}
            onReplace={(pick) => replaceTrackPlugin(swapTrackId, pick)}
            onRemove={() => removeTrackPlugin(swapTrackId)}
            onRequestProbe={handleRequestProbe}
          />
        );
      })()}
      {sharePick && project.tracks.some((tr) => tr.id === sharePick.trackId) && (
        // Stage 3g — the share-or-create offer (spec step 1). The candidates
        // are snapshotted at pick time; the dialog is modal, so the project
        // cannot drift underneath. onCreate replays the ORIGINAL pick through
        // today's create path.
        <PluginShareDialog
          pluginName={sharePick.pluginName}
          candidates={sharePick.candidates.map((c) => ({
            groupId: c.group.id,
            name: c.group.name,
            trackNames: c.trackNames,
          }))}
          onClose={() => setSharePick(null)}
          onShare={(groupId) => shareWithGroup(sharePick.trackId, groupId, sharePick.pluginName)}
          onCreate={() => {
            const c = sharePick.create;
            if (c.kind === "plugin") {
              createInstanceAssignment(sharePick.trackId, { pluginId: c.pluginId, name: sharePick.pluginName, pluginPath: c.pluginPath, profileId: c.profileId });
            } else {
              createProfileAssignment(sharePick.trackId, c.profileId, sharePick.pluginName);
            }
          }}
        />
      )}
      {routingTrackId !== null &&
        (() => {
          const t = project.tracks.find((tr) => tr.id === routingTrackId);
          if (!t) return null;
          return (
            <BindingPicker
              track={t}
              view={routingView[routingTrackId]}
              instances={pickerInstances}
              libraryGroups={project.libraryGroups}
              pluginNames={pluginNamesByUid}
              channelUsers={pickerChannelUsers}
              pairUsersByTrack={pickerPairUsers}
              enginePlaying={enginePlaying}
              onCommit={(binding) => handleCommitBinding(routingTrackId, binding)}
              onClose={() => setRoutingTrackId(null)}
            />
          );
        })()}
      <ExportDialog
        open={exportOpen}
        project={project}
        selectedTrackIds={selectedTrackId ? [selectedTrackId] : []}
        onClose={() => setExportOpen(false)}
        onToast={toast}
      />
      <TestsPanel
        open={testsOpen}
        results={testResults}
        running={testsRunning}
        onClose={() => setTestsOpen(false)}
        onRun={() => void runTests()}
      />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
      <MixDialog open={mixOpen} onClose={() => setMixOpen(false)} toast={toast} />
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />

      {harness && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/60 p-6" onClick={() => setHarness(null)}>
          <pre
            className="max-h-[80vh] w-[800px] overflow-auto rounded-xl border border-white/10 bg-[#0e1016] p-4 font-mono text-[11px] text-stone-300"
            onClick={(e) => e.stopPropagation()}
          >
            {harness}
          </pre>
        </div>
      )}

      <input
        ref={audioInputRef}
        type="file"
        accept=".wav,.mp3,.flac,audio/wav,audio/mpeg,audio/flac"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          try {
            const ctx = new AudioContext();
            const buf = await ctx.decodeAudioData(await file.arrayBuffer());
            setAudioBuffer(buf);
            setAudioName(file.name);
            patch({ referenceAudio: { path: file.name, offsetMs: project.referenceAudio.offsetMs } });
            toast("ok", `Loaded ${file.name}`);
            void ctx.close();
          } catch (err) {
            toast("error", `Could not decode audio: ${err instanceof Error ? err.message : String(err)}`);
          }
        }}
      />
      <input
        ref={jsonInputRef}
        type="file"
        accept=".json,.scorch,application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          const text = await file.text();
          const r = importProjectJson(text);
          if (!r.ok) {
            toast("error", r.errors.slice(0, 4).join(" · "));
            return;
          }
          setProject(r.project);
          setUndo([]);
          setRedo([]);
          toast("ok", `Imported ${r.project.name}`);
        }}
      />
    </div>
  );
}

function DevMenu({
  onFill,
  onFixture,
  onNew,
  onTests,
  onHarness,
  onAbout,
  onMix,
}: {
  onFill: () => void;
  onFixture: () => void;
  onNew: () => void;
  onTests: () => void;
  onHarness: () => void;
  onAbout: () => void;
  onMix: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className="inline-flex items-center gap-1 hover:text-stone-200" onClick={() => setOpen((v) => !v)}>
        <Ph name="gear" className="h-3.5 w-3.5" />
        Dev
      </button>
      {open && (
        <div className="absolute bottom-7 right-0 z-[55] w-52 rounded-md border border-white/10 bg-[#1a1d27] py-1 text-xs text-stone-200 shadow-xl">
          <MenuItem
            onClick={() => {
              onMix();
              setOpen(false);
            }}
          >
            Mix…
          </MenuItem>
          <MenuItem
            onClick={() => {
              onFill();
              setOpen(false);
            }}
          >
            Fill 5,000 random notes
          </MenuItem>
          <MenuItem
            onClick={() => {
              onFixture();
              setOpen(false);
            }}
          >
            Reload Dorian fixture
          </MenuItem>
          <MenuItem
            onClick={() => {
              onNew();
              setOpen(false);
            }}
          >
            New project
          </MenuItem>
          <MenuItem
            onClick={() => {
              onTests();
              setOpen(false);
            }}
          >
            Run acceptance tests
          </MenuItem>
          <MenuItem
            onClick={() => {
              onHarness();
              setOpen(false);
            }}
          >
            Generation harness
          </MenuItem>
          <MenuItem
            onClick={() => {
              onAbout();
              setOpen(false);
            }}
          >
            About
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ children, onClick }: { children: string; onClick: () => void }) {
  return (
    <button type="button" className="block w-full px-3 py-1.5 text-left hover:bg-white/5" onClick={onClick}>
      {children}
    </button>
  );
}


