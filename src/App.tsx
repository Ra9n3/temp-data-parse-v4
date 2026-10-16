import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useImmer } from "use-immer";
import { invoke } from "@tauri-apps/api/core";
import dorianFixture from "./fixtures/dorian-16bars.json";
import { TopBar } from "./components/TopBar";
import { Arranger } from "./components/Arranger";
import { GenerationSettingsPanel } from "./components/GenerationSettingsPanel";
import { EngineClient, formatPluginInfo, type EngineLoadMeta, type EngineStatus, type EditorEventMessage, type LoadFailure, type PluginCapabilitiesMessage, type PluginSavedStateMessage, type PluginStateMessage, type ScanResultMessage } from "./engine/engineClient";
import { buildEngineStream, resolveEngineChannelView } from "./engine/engineStream";
import { PPQ, projectEndTick, tickToBar } from "./shared/schema";
import {
  AboutDialog,
  ExportDialog,
  MixDialog,
  PianoRoll,
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
import { loadAutosave, saveAutosave } from "./state/persistence";
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
  // Latest project value for imperative callbacks (status transition, engine
  // receipts) that outlive renders and must read the CURRENT project.
  const projectRef = useRef<Project | null>(null);
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
          const stream = buildEngineStream(p);
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
              if (receipt.skipped > 0) {
                writeErrorLog("engineAutoLoad", `startup load incomplete: ${receipt.loaded}/${receipt.received} loaded, ${receipt.skipped} skipped`);
              }
              client.mix(
                p.tracks.filter((t) => t.muted).map((t) => t.id),
                p.tracks.filter((t) => t.soloed).map((t) => t.id),
              );
              lastLoadedRef.current = p; // confirmed load — play fast-path eligible
            }).catch((failure: LoadFailure) => {
              // Visible but NOT play-path: the user's first play retries the
              // load itself and owns the web-synth fallback decision.
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
        toast("ok", `${result.name ?? "Plugin"} hosted (latency ${result.latencyMs?.toFixed(1) ?? "?"}ms, channels ${(result.channels ?? []).join(",")})`);
      } else {
        // Stage 3d-3: a plugin the project references but the machine lacks
        // is a NAMED, non-breaking case — the track rides the test synth
        // and the project keeps its embedded state for the next install.
        if (/no plugin types found at|createPluginInstance failed/i.test(result.detail ?? "")) {
          toast("error", "plugin not found — install to restore");
        } else {
          toast("error", `${result.name ?? "Plugin"} failed to load — falling back to test synth: ${result.detail ?? "unknown"}`);
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
        writeErrorLog("engine", `editor closed: ${msg.instanceId}`);
      }
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
  const desktopVst = useMemo(() => {
    if (engineStatus !== "ready") return null;
    return {
      result: desktopScan ? { plugins: desktopScan.plugins, failed: desktopScan.failed } : null,
      onScan: () => {
        setDesktopScan(null);
        setVstState("scanning");
        void (async () => {
          const dirs = await invoke<string[]>("vst3_paths").catch(() => undefined);
          engineClientRef.current?.scan(dirs && dirs.length ? dirs : undefined);
        })();
      },
    };
  }, [engineStatus, desktopScan]);

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
      // Safety-net fallback (kept): no engine → webview synth.
      setEngineDrive(false);
      void playback.play();
      return;
    }
    // The play mechanics, run ONLY after the engine confirms the load
    // (Stage 3c-hotfix: the source switch gates on loadAck).
    const runEnginePlay = () => {
      try {
        // FULL disengagement of the webview synth before the engine renders —
        // if the fallback was ever running (rare drive flip), its voices and
        // RAF loop die here. No doubled rendering, ever.
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
        writeErrorLog("enginePlay", err);
        setEngineDrive(false);
        void playback.play();
      }
    };
    try {
      // Load only when the engine's score is stale (project changed or fresh
      // engine session). Skip-loading on repeat plays removes the load-ack
      // state{playing:false} round-trip that used to flicker the UI.
      if (lastLoadedRef.current !== project) {
        // Stage 3c-2: the M9 profile path builds the stream — profiled tracks
        // ride the hosted plugin (UACC CC#32 pre-trigger, CC7/11/74), the rest
        // stay on the engine's test synth. Deterministic; no RNG.
        const stream = buildEngineStream(project);
        const meta: EngineLoadMeta = {
          bpm: project.bpm,
          ppqn: PPQ,
          timeSignature: project.timeSignature,
          endTick: projectEndTick(project),
        };
        // Stage 3c-hotfix: the source switch is GATED on the engine's loadAck
        // receipt. No more optimistic fire-and-forget at real project sizes —
        // if the load never arrives, is rejected, or parses with skipped
        // events, the failure is visible (toast + error.log) and the webview
        // synth covers the play instead of a silent empty engine score.
        void client.load(stream.events, meta, {
          routing: stream.routing,
          plugins: stream.plugins,
        }).then((receipt) => {
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
          runEnginePlay();
        }).catch((failure: LoadFailure) => {
          setEngineDrive(false);
          setEnginePlaying(false);
          toast("error", `engine load failed — using web synth (${failure.reason})`);
          void playback.play();
        });
        return;
      }
      runEnginePlay();
    } catch (err) {
      // F2 safety net: a throw in the engine branch must never kill the
      // click — log the live stack to %APPDATA%/scorch/error.log and fall
      // back to the webview synth (play still works; footer keeps state).
      writeErrorLog("enginePlay", err);
      setEngineDrive(false);
      void playback.play();
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
      if (lastLoadedRef.current === project) return; // already confirmed by loadAck
      const client = engineClientRef.current;
      const stream = buildEngineStream(project);
      const meta: EngineLoadMeta = {
        bpm: project.bpm,
        ppqn: PPQ,
        timeSignature: project.timeSignature,
        endTick: projectEndTick(project),
      };
      void client.load(stream.events, meta, {
        routing: stream.routing,
        plugins: stream.plugins,
      }).then((receipt) => {
        if (receipt.skipped > 0) {
          writeErrorLog("engineReload", `mid-play reload incomplete: ${receipt.skipped}/${receipt.received} skipped (first at index ${receipt.firstErrorIndex}${receipt.firstErrorReason ? ": " + receipt.firstErrorReason : ""})`);
          toast("error", `engine reload incomplete: ${receipt.skipped} events rejected — see error.log`);
        }
        client.mix(
          project.tracks.filter((t) => t.muted).map((t) => t.id),
          project.tracks.filter((t) => t.soloed).map((t) => t.id),
        );
        lastLoadedRef.current = project; // cache stays in sync (confirmed load)
      }).catch((failure: LoadFailure) => {
        toast("error", `engine reload failed — playing a stale score (${failure.reason})`);
      });
    }
  }, [project, enginePlaying, toast]);

  // Stage 3c-2 — live mute/solo: while the engine drives, every toggle ships
  // a mix message so the engine re-gates BEFORE any channel send (and flushes
  // lost channels — the change is audible immediately).
  const mixSignature =
    project.tracks.map((t) => `${t.id}:${t.muted ? 1 : 0}${t.soloed ? 1 : 0}`).join("|");
  useEffect(() => {
    if (!engineDrive || engineClientRef.current?.getStatus() !== "ready") return;
    engineClientRef.current?.mix(
      project.tracks.filter((t) => t.muted).map((t) => t.id),
      project.tracks.filter((t) => t.soloed).map((t) => t.id),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mixSignature, engineDrive]);

  // Stage 3c-3 — channel assignment UI: the resolved map (explicit + first-come
  // auto) drives the per-track selectors; explicit assignment validates
  // collisions AT ASSIGNMENT TIME (the engine double-checks at load).
  const resolvedEngineChannels = useMemo(() => resolveEngineChannelView(project), [project]);
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
      const owner = project.tracks.find(
        (t) => t.id !== trackId && t.engineChannel === ch,
      );
      if (owner) {
        toast(
          "error",
          `Engine channel ${ch} is already assigned to ${owner.name} (engine channel collision)`,
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

      <Arranger
        project={project}
        pixelsPerTick={ppt}
        playheadTick={effectivePlayheadTick}
        pluginLabels={pluginLabels}
        pluginInfoByTrack={pluginInfoByTrack}
        engineChannels={resolvedEngineChannels}
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
        onLoadAudio={() => audioInputRef.current?.click()}
        onAddTrack={(family: Family) => {
          const t = createAddedTrack(family);
          t.midiChannel = nextMidiChannel(project.tracks);
          commit({ ...project, tracks: [...project.tracks, t] });
        }}
        onSelectTrack={setSelectedTrackId}
        onOpenPianoRoll={setPianoTrackId}
      />

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
        </div>
        <div className="flex items-center gap-2">
          <EngineIndicator status={engineStatus} rtt={engineRtt} playing={enginePlaying} playheadTick={enginePlayheadTick} timeSignature={project.timeSignature} audioError={engineAudioError} pluginState={pluginState} />
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
          const g = {
            id: makeId("lg"),
            name,
            pluginId,
            pluginState: null,
            ...(pluginPath ? { pluginPath } : {}),
            ...(profileId ? { profileId } : {}),
          };
          commit({
            ...project,
            libraryGroups: [...project.libraryGroups, g],
            tracks: project.tracks.map((t) => (t.id === vstTrackId ? { ...t, libraryGroupId: g.id } : t)),
          });
          setPluginLabels((p) => ({ ...p, [vstTrackId]: name }));
          toast("ok", `Assigned ${name}${profileId ? " (expression map bound — tracks route to its engine channels)" : ""}`);
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
          const g = {
            id: makeId("lg"),
            name,
            pluginId: needsBbcso && match ? match.uid : null,
            pluginState: null,
            profileId,
            ...(needsBbcso && match ? { pluginPath: match.path } : {}),
          };
          commit({
            ...project,
            libraryGroups: [...project.libraryGroups, g],
            tracks: project.tracks.map((t) => (t.id === vstTrackId ? { ...t, libraryGroupId: g.id } : t)),
          });
          setPluginLabels((p) => ({ ...p, [vstTrackId]: name }));
          toast("ok", `Assigned ${name} (expression map)${needsBbcso && match ? " + hosted plugin" : ""}`);
        }}
      />
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


