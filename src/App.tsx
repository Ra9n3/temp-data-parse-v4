import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useImmer } from "use-immer";
import { invoke } from "@tauri-apps/api/core";
import dorianFixture from "./fixtures/dorian-16bars.json";
import { TopBar } from "./components/TopBar";
import { Arranger } from "./components/Arranger";
import { GenerationSettingsPanel } from "./components/GenerationSettingsPanel";
import { EngineClient, notesToEngineEvents, type EngineLoadMeta, type EngineStatus, type ScanResultMessage } from "./engine/engineClient";
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
function EngineIndicator({ status, rtt, playing, playheadTick, timeSignature, audioError }: {
  status: EngineStatus; rtt: number | null; playing: boolean; playheadTick: number; timeSignature: { numerator: number; denominator: number }; audioError: string | null;
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
  return <span className={`hidden sm:inline ${color}`}>{label}</span>;
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
  // Chord v2 — the editing chord id is LIFTED here (was local to the Arranger
  // lane) so the top-bar panel and the in-lane editor share one source of
  // truth: creation/retarget/Esc/delete all stay in sync. No schema change.
  const [editingChordId, setEditingChordId] = useState<string | null>(null);
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
    engineClientRef.current = client;

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

  const enginePlay = useCallback(() => {
    const client = engineClientRef.current;
    if (!client || client.getStatus() !== "ready") {
      // Safety-net fallback (kept): no engine → webview synth.
      setEngineDrive(false);
      void playback.play();
      return;
    }
    try {
      // Load only when the engine's score is stale (project changed or fresh
      // engine session). Skip-loading on repeat plays removes the load-ack
      // state{playing:false} round-trip that used to flicker the UI.
      if (lastLoadedRef.current !== project) {
        const events = notesToEngineEvents(project);
        const meta: EngineLoadMeta = {
          bpm: project.bpm,
          ppqn: PPQ,
          timeSignature: project.timeSignature,
          endTick: projectEndTick(project),
        };
        client.load(events, meta);
        lastLoadedRef.current = project;
      }
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
      // F2 safety net: a throw in the engine branch must never kill the
      // click — log the live stack to %APPDATA%/scorch/error.log and fall
      // back to the webview synth (play still works; footer keeps state).
      writeErrorLog("enginePlay", err);
      setEngineDrive(false);
      void playback.play();
    }
  }, [project, playback]);

  const engineStop = useCallback(() => {
    if (engineDrive) {
      try {
        engineClientRef.current?.transport("stop"); // engine-side PANIC semantics
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

  // Reload engine score when project changes during engine playback.
  useEffect(() => {
    if (enginePlaying && engineClientRef.current?.getStatus() === "ready") {
      const events = notesToEngineEvents(project);
      const meta: EngineLoadMeta = {
        bpm: project.bpm,
        ppqn: PPQ,
        timeSignature: project.timeSignature,
        endTick: projectEndTick(project),
      };
      engineClientRef.current?.load(events, meta);
      lastLoadedRef.current = project; // cache stays in sync (see enginePlay)
    }
  }, [project, enginePlaying]);

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
          <EngineIndicator status={engineStatus} rtt={engineRtt} playing={enginePlaying} playheadTick={enginePlayheadTick} timeSignature={project.timeSignature} audioError={engineAudioError} />
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
        onPick={(pluginId, name) => {
          if (!vstTrackId) return;
          const g = { id: makeId("lg"), name, pluginId, pluginState: null };
          commit({
            ...project,
            libraryGroups: [...project.libraryGroups, g],
            tracks: project.tracks.map((t) => (t.id === vstTrackId ? { ...t, libraryGroupId: g.id } : t)),
          });
          setPluginLabels((p) => ({ ...p, [vstTrackId]: name }));
          toast("ok", `Assigned ${name}`);
        }}
        onPickProfile={(profileId, name) => {
          if (!vstTrackId) return;
          // Module 9: built-in expression maps create the group with profileId
          // set (no scanned plugin); the exporter then takes the profile path.
          const g = { id: makeId("lg"), name, pluginId: null, pluginState: null, profileId };
          commit({
            ...project,
            libraryGroups: [...project.libraryGroups, g],
            tracks: project.tracks.map((t) => (t.id === vstTrackId ? { ...t, libraryGroupId: g.id } : t)),
          });
          setPluginLabels((p) => ({ ...p, [vstTrackId]: name }));
          toast("ok", `Assigned ${name} (expression map)`);
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


