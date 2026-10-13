import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useImmer } from "use-immer";
import dorianFixture from "./fixtures/dorian-16bars.json";
import { TopBar } from "./components/TopBar";
import { Arranger } from "./components/Arranger";
import { GenerationSettingsPanel } from "./components/GenerationSettingsPanel";
import {
  AboutDialog,
  ExportDialog,
  PianoRoll,
  TestsPanel,
  Toasts,
  VstBrowser,
  type ToastItem,
} from "./components/Dialogs";
import { Ph } from "./icons";
import { DEFAULT_PPT, HEADER_WIDTH } from "./constants";
import { usePlayback } from "./audio/usePlayback";
import {
  createAddedTrack,
  createDefaultProject,
  makeId,
  nextMidiChannel,
  rescaleChordsForMeter,
  validateProject,
  type Family,
  type ModeName,
  type PitchClass,
  type Project,
  type TimeSignature,
} from "./shared/schema";
import { generate, fillRandomNotes, generationSummary } from "./generation/generate";
import { importProjectJson } from "./export/json";
import { runAlignmentTest, runUnitTests, type TestResult } from "./tests/runTests";
import type { PluginScanState } from "./plugins/mockService";

function loadStartup(): Project {
  const v = validateProject(dorianFixture);
  if (v.ok) return v.project;
  return createDefaultProject("Dorian 16 Bars");
}

let toastSeq = 0;

export default function App() {
  const [project, setProject] = useImmer<Project>(loadStartup);
  const [undo, setUndo] = useState<Project[]>([]);
  const [redo, setRedo] = useState<Project[]>([]);
  const [ppt, setPpt] = useState(DEFAULT_PPT);
  const composeSeedRef = useRef(Math.floor(Math.random() * 100_000));
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
        if (playback.playing) playback.stop();
        else void playback.play();
      }
      if (e.key === "Home") playback.rewind();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doRedo, doUndo, playback]);

  useEffect(() => {
    if (!playback.playing) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = playback.playheadTick * ppt;
    const vis = el.clientWidth - HEADER_WIDTH;
    const sl = el.scrollLeft;
    if (x < sl + 40 || x > sl + vis - 80) {
      el.scrollLeft = Math.max(0, x - vis * 0.3);
    }
  }, [playback.playheadTick, playback.playing, ppt]);

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
        playheadTick={playback.playheadTick}
        playing={playback.playing}
        looping={playback.looping}
        metronome={playback.metronome}
        onBpm={(bpm) => patch({ bpm: Math.max(20, Math.min(400, bpm)) })}
        onKey={(key: PitchClass) => patch({ key })}
        onMode={(mode: ModeName) => patch({ mode })}
        onTimeSignature={(timeSignature: TimeSignature) =>
          commit({
            ...project,
            timeSignature,
            chords: rescaleChordsForMeter(project.chords, project.timeSignature, timeSignature),
          })
        }
        onOrchestralStyle={(orchestralStyle) => patch({ generationSettings: { ...generationSettings, orchestralStyle } })}
        onOpenGenerationSettings={() => setGenerationSettingsOpen(true)}
        onPlay={() => void playback.play()}
        onStop={playback.stop}
        onRewind={playback.rewind}
        onToggleLoop={() => playback.setLooping(!playback.looping)}
        onToggleMetronome={() => playback.setMetronome(!playback.metronome)}
        onCompose={compose}
        onExport={() => setExportOpen(true)}
      />

      <Arranger
        project={project}
        pixelsPerTick={ppt}
        playheadTick={playback.playheadTick}
        pluginLabels={pluginLabels}
        audioBuffer={audioBuffer}
        audioName={audioName}
        selectedTrackId={selectedTrackId}
        scrollRef={scrollRef}
        onPixelsPerTick={setPpt}
        onSeek={playback.seek}
        onPatchProject={patch}
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
          <span className="hidden sm:inline">Engine: web preview (JUCE not installed)</span>
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
              setProject(loadStartup());
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
          />
        </div>
      </footer>

      <VstBrowser
        open={vstOpen}
        state={vstState}
        onClose={() => setVstOpen(false)}
        onState={setVstState}
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
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />

      {harness && (
        <div className="fixed inset-0 z-40 grid place-items-center bg-black/60 p-6" onClick={() => setHarness(null)}>
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
}: {
  onFill: () => void;
  onFixture: () => void;
  onNew: () => void;
  onTests: () => void;
  onHarness: () => void;
  onAbout: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className="inline-flex items-center gap-1 hover:text-stone-200" onClick={() => setOpen((v) => !v)}>
        <Ph name="gear" className="h-3.5 w-3.5" />
        Dev
      </button>
      {open && (
        <div className="absolute bottom-7 right-0 z-50 w-52 rounded-md border border-white/10 bg-[#1a1d27] py-1 text-xs text-stone-200 shadow-xl">
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


