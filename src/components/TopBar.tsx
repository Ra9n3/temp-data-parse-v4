import { useEffect, useRef, useState, type ReactNode } from "react";
import { Ph } from "../icons";
import {
  MODE_LABELS,
  MODE_NAMES,
  PITCH_CLASS_NAMES,
  type ModeName,
  type PitchClass,
  type Project,
  type TimeSignature,
  type Chord,
} from "../shared/schema/types";
import { formatTimecode } from "../shared/schema/time";
import { parseChord, type ChordQuality } from "../shared/schema/chords";
import { cn } from "../utils/cn";

const TIME_SIGNATURES: TimeSignature[] = [
  { numerator: 4, denominator: 4 },
  { numerator: 3, denominator: 4 },
  { numerator: 6, denominator: 8 },
  { numerator: 5, denominator: 4 },
  { numerator: 2, denominator: 4 },
  { numerator: 7, denominator: 8 },
  { numerator: 9, denominator: 8 },
  { numerator: 12, denominator: 8 },
];

interface Props {
  project: Project;
  playheadTick: number;
  playing: boolean;
  looping: boolean;
  metronome: boolean;
  onBpm: (n: number) => void;
  onKey: (k: PitchClass) => void;
  onMode: (m: ModeName) => void;
  onTimeSignature: (ts: TimeSignature) => void;
  onOrchestralStyle: (style: NonNullable<Project["generationSettings"]>["orchestralStyle"]) => void;
  onOpenGenerationSettings: () => void;
  onPlay: () => void;
  onStop: () => void;
  onRewind: () => void;
  onToggleLoop: () => void;
  onToggleMetronome: () => void;
  onCompose: () => void;
  onExport: () => void;
  // Chord v2 — the Lifted editing chord id; App owns it so the top-bar panel
  // and the lane editor stay in sync (retarget, Esc, delete all flow here).
  editingChord: string | null;
  editingChordObj: Chord | null;
  onCloseEditingChord: () => void;
  onDeleteEditingChord: () => void;
  onChangeChordSymbol: (id: string, symbol: string) => void;
}

export function TopBar({
  project,
  playheadTick,
  playing,
  looping,
  metronome,
  onBpm,
  onKey,
  onMode,
  onTimeSignature,
  onOrchestralStyle,
  onOpenGenerationSettings,
  onPlay,
  onStop,
  onRewind,
  onToggleLoop,
  onToggleMetronome,
  onCompose,
  onExport,
  editingChord,
  editingChordObj,
  onCloseEditingChord,
  onDeleteEditingChord,
  onChangeChordSymbol,
}: Props) {
  const tsValue = `${project.timeSignature.numerator}/${project.timeSignature.denominator}`;
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0e1016] px-3 py-1">
      {/* Patch 1a: the brand block (ScorchMark + wordmark) is gone; ScorchMark
       * remains used by AboutDialog, so its import survives there. Patch 1b:
       * the settings pill owns the leftover flex region — it must SHRINK: the
       * root cause of the Compose All overlap was the native <select> children's
       * min-width:auto, which kept the pill wider than its flex-1 area. Chosen
       * approach (first preference): crush — pill min-w-0 + overflow-hidden,
       * every select min-w-0 (closed value truncates), Orchestration shrink-0.
       * Compose All is a plain flex sibling AFTER this block, so with the pill
       * clamped it can never be overlapped. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <div className="flex min-w-0 overflow-hidden items-center gap-1.5 rounded-full border border-white/10 bg-[#161922] px-2 py-1">
          <label className="flex shrink-0 items-center gap-1 text-[11px] text-stone-400">
            BPM
            <input
              type="number"
              min={20}
              max={400}
              value={project.bpm}
              onChange={(e) => onBpm(Number(e.target.value) || project.bpm)}
              className="font-mono w-14 rounded-md border-0 bg-black/30 px-1.5 py-0.5 text-xs text-amber-200 outline-none ring-1 ring-white/10 focus:ring-orange-400/50"
            />
          </label>
          <select
            value={project.key}
            onChange={(e) => onKey(Number(e.target.value) as PitchClass)}
            className="min-w-0 rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10"
            title="Key"
          >
            {PITCH_CLASS_NAMES.map((n, i) => (
              <option key={n} value={i}>
                {n}
              </option>
            ))}
          </select>
          <select
            value={project.mode}
            onChange={(e) => onMode(e.target.value as ModeName)}
            className="min-w-0 max-w-[9.5rem] rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10"
            title="Mode"
          >
            {MODE_NAMES.map((m) => (
              <option key={m} value={m}>
                {MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <select
            value={tsValue}
            onChange={(e) => {
              const [n, d] = e.target.value.split("/").map(Number);
              onTimeSignature({ numerator: n, denominator: d });
            }}
            className="font-mono min-w-0 rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10"
            title="Time signature"
          >
            {TIME_SIGNATURES.map((ts) => (
              <option key={`${ts.numerator}/${ts.denominator}`} value={`${ts.numerator}/${ts.denominator}`}>
                {ts.numerator}/{ts.denominator}
              </option>
            ))}
          </select>
          <select aria-label="Orchestral style preset" value={project.generationSettings?.orchestralStyle ?? "Classical Symphonic"}
            onChange={(e) => onOrchestralStyle(e.target.value as NonNullable<Project["generationSettings"]>["orchestralStyle"])}
            className="min-w-0 max-w-[10rem] rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10">
            {["Epic Cinematic", "Classical Symphonic", "Chamber Strings", "Pop/Rock Studio Orchestra", "Jazz Big Band", "Custom"].map((style) => <option key={style}>{style}</option>)}
          </select>
          <button type="button" aria-label="Orchestral configuration and humanization" title="Orchestral configuration and humanization" onClick={onOpenGenerationSettings}
            className="shrink-0 rounded-md bg-orange-500/15 px-2 py-1 text-[11px] text-orange-200 ring-1 ring-orange-400/20 hover:bg-orange-500/25">Orchestration</button>
        </div>
      </div>

      <button
        type="button"
        onClick={onCompose}
        className="rounded-full bg-gradient-to-r from-amber-400 via-orange-500 to-rose-500 px-6 py-1.5 text-sm font-bold tracking-wide text-black shadow-[0_0_24px_rgba(249,115,22,0.35)] hover:brightness-110"
        title="Generate orchestral MIDI for every unlocked instrument"
      >
        Compose All
      </button>

      {/* Chord v2 — top-bar chord editor panel: opens (only) when a chord is
       * selected-for-editing. Same design language as the pill (stone/orange
       * rings, black/30 fields); min-w-0 + wrap so 1200px squeezes instead of
       * overlapping (patch-1 flex lessons). */}
      {editingChord && editingChordObj && (
        <ChordPanel
          key={editingChord}
          chord={editingChordObj}
          onSymbol={(symbol) => onChangeChordSymbol(editingChord, symbol)}
          onClose={onCloseEditingChord}
          onDelete={onDeleteEditingChord}
        />
      )}

      <div className="flex min-w-0 flex-1 items-center justify-end gap-2">
        <div className="font-mono hidden text-[11px] text-stone-500 lg:block">
          {formatTimecode(playheadTick, project.timeSignature)}
        </div>
        <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-[#161922] px-1.5 py-1">
          <Tbtn label="Rewind to start" onClick={onRewind}>
            <Ph name="rewind" className="h-4 w-4" />
          </Tbtn>
          <Tbtn label={playing ? "Pause" : "Play (Space)"} onClick={playing ? onStop : onPlay} accent>
            <Ph name={playing ? "stop" : "play"} className="h-4 w-4" />
          </Tbtn>
          <Tbtn label="Stop" onClick={onStop}>
            <Ph name="stop" className="h-4 w-4" />
          </Tbtn>
          <Tbtn
            label="Record is not available — Scorch generates MIDI, it does not record audio"
            disabled
          >
            <Ph name="record" className="h-4 w-4" />
          </Tbtn>
          <Tbtn label="Loop" onClick={onToggleLoop} active={looping}>
            <Ph name="loop" className="h-4 w-4" />
          </Tbtn>
          <Tbtn label="Metronome" onClick={onToggleMetronome} active={metronome}>
            <Ph name="metronome" className="h-4 w-4" />
          </Tbtn>
        </div>
        <button
          type="button"
          onClick={onExport}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-[#161922] px-3 py-1.5 text-xs font-medium text-stone-200 hover:bg-white/5"
          title="Export JSON or MIDI"
        >
          <Ph name="download" className="h-3.5 w-3.5" />
          Export
        </button>
      </div>
    </header>
  );
}

// Chord Panel Refinement (Commit 2) — the top-bar chord editor, reskinned to
// read as a sibling of the settings pill: same rounded-full container, same
// black/30 field tokens, same font scale; controls inside are pill-style.
// Fields: searchable combobox over a curated chord list (data below — the
// text input accepts anything parseChord validates, so the list never jails
// input), bass dropdown with an explicit "default (root)" option, and a
// chip-grid popover for quality + extensions (the structure-lane density-chip
// pattern). Commit semantics: ONE onboard commit per field change — the
// combobox/type commits on each valid keystroke, chips/bass on each toggle
// (all commit via App's lifted onChangeChordSymbol → patch; each edit is
// undo-able). Popover closes on outside click / Esc; Esc also closes it
// before the panel itself (stopPropagation layered).
const CURATED_CHORDS: string[] = [
  "C", "Cm", "C7", "Cmaj7", "Cm7", "Csus2", "Csus4", "Cdim", "Caug",
  "D", "Dm", "D7", "Dmaj7", "Dm7", "Dsus2", "Dsus4",
  "E", "Em", "E7", "Emaj7", "Em7",
  "F", "Fm", "F7", "Fmaj7", "Fm7",
  "G", "Gm", "G7", "Gmaj7", "Gm7", "Gsus4",
  "A", "Am", "A7", "Amaj7", "Am7",
  "B", "Bm", "B7", "Bm7b5",
  "Dm7/G", "G/B", "C/E", "Am/E",
];

const QUALITY_CHIPS: [string, string][] = [
  ["major", "Maj"], ["minor", "Min"], ["diminished", "Dim"],
  ["augmented", "Aug"], ["sus2", "Sus2"], ["sus4", "Sus4"],
];

const EXTENSION_CHIPS: string[] = ["7", "maj7", "9", "b9", "#9", "11", "#11", "13", "b13"];

function ChordPanel({ chord, onSymbol, onClose, onDelete }: { chord: Chord; onSymbol: (symbol: string) => void; onClose: () => void; onDelete: () => void }) {
  const [v, setV] = useState(chord.symbol);
  const [comboOpen, setComboOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const parsed = parseChord(v);
  const parsedRoot = parsed.ok ? parsed.chord.root : 0;
  const parsedBass = parsed.ok ? parsed.chord.bass : null;
  const rootName = PITCH_CLASS_NAMES[parsedRoot];
  const parsedQuality = parsed.ok ? parsed.chord.quality : "major";
  const quality: ChordQuality | "major" = parsedQuality === "minor" || parsedQuality === "m7" || parsedQuality === "m7b5" || parsedQuality === "m6" || parsedQuality === "m9" ? "minor"
    : parsedQuality === "diminished" || parsedQuality === "dim7" ? "diminished"
    : parsedQuality === "augmented" || parsedQuality === "aug7" ? "augmented"
    : parsedQuality === "sus2" ? "sus2" : parsedQuality === "sus4" || parsedQuality === "7sus4" ? "sus4" : "major";
  const selectedExtensions = parsed.ok ? parsed.chord.extensions : [];

  // Chip/bass updates rebuild the symbol from parts (ported formatter) and
  // commit immediately when the rebuilt symbol parses.
  const update = (nextRoot: string = rootName, nextQuality: ChordQuality | string = quality, nextExtensions: string[] = selectedExtensions, nextBass: PitchClass | null = parsedBass) => {
    const qualityToken = nextQuality === "major" ? "" : nextQuality === "minor" ? "m" : nextQuality === "diminished" ? "dim" : nextQuality === "augmented" ? "aug" : nextQuality === "sus2" || nextQuality === "sus4" ? nextQuality : "";
    const extensionOrder = ["maj7", "7", "b9", "#9", "9", "#11", "11", "b13", "13"];
    const formattedExtensions = [...nextExtensions].sort((left, right) => extensionOrder.indexOf(left) - extensionOrder.indexOf(right));
    let prefix = `${nextRoot}${qualityToken}`;
    if (nextQuality === "major" || nextQuality === "minor") {
      const hasMajorSeventh = formattedExtensions.includes("maj7");
      const hasSeventh = formattedExtensions.includes("7");
      const hasNinth = formattedExtensions.includes("9");
      if (hasMajorSeventh) prefix = `${nextRoot}${nextQuality === "minor" ? "mmaj7" : "maj7"}`;
      else if (hasSeventh) prefix = `${nextRoot}${nextQuality === "minor" ? "m7" : "7"}`;
      else if (hasNinth) prefix = `${nextRoot}${nextQuality === "minor" ? "m9" : "9"}`;
    }
    const consumedExtension = prefix.endsWith("maj7") ? "maj7" : prefix.endsWith("m7") || prefix.endsWith("7") ? "7" : prefix.endsWith("m9") || prefix.endsWith("9") ? "9" : null;
    const extensionSuffix = formattedExtensions.filter((extension) => extension !== consumedExtension).join("");
    const bassSuffix = nextBass === null ? "" : `/${PITCH_CLASS_NAMES[nextBass]}`;
    const next = `${prefix}${extensionSuffix}${bassSuffix}`;
    setV(next);
    if (parseChord(next).ok) onSymbol(next);
  };

  // Outside click closes ONLY the popover (panel itself stays open; the ✕ /
  // Esc path owns that).
  useEffect(() => {
    if (!gridOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!gridRef.current?.contains(e.target as Node)) setGridOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [gridOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (gridOpen) { setGridOpen(false); return; }
      if (comboOpen) { setComboOpen(false); return; }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, gridOpen, comboOpen]);

  const filter = v.trim().toLowerCase();
  const options = CURATED_CHORDS.filter((sym) => sym.toLowerCase().includes(filter));

  return (
    <div
      data-chord-panel
      className="flex min-h-8 min-w-0 shrink-0 items-center gap-1 rounded-full border border-white/10 bg-[#161922] px-2 py-1"
    >
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-orange-300">Chord</span>
      {/* Combobox: input + curated dropdown; any parseChord-valid text wins. */}
      <div className="relative min-w-0 w-28">
        <input
          aria-label="Chord symbol"
          autoComplete="off"
          value={v}
          onFocus={() => setComboOpen(true)}
          onChange={(e) => {
            const next = e.target.value;
            setV(next);
            setComboOpen(true);
            // Parse-validate live: invalid = red ring, no commit.
            if (parseChord(next).ok) onSymbol(next.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && parsed.ok) { onSymbol(v.trim() || chord.symbol); setComboOpen(false); }
            if (e.key === "Escape") { setComboOpen(false); e.stopPropagation(); }
            e.stopPropagation();
          }}
          onBlur={() => setComboOpen(false)}
          className={cn(
            "w-full rounded-md bg-black/30 px-1.5 py-0.5 font-mono text-xs outline-none ring-1",
            parsed.ok ? "text-sky-100 ring-white/10 focus:ring-orange-400/50" : "text-red-300 ring-red-500",
          )}
        />
        {comboOpen && options.length > 0 && (
          <div
            data-chord-combobox
            className="absolute left-0 top-full z-[70] mt-1 max-h-56 w-44 overflow-auto rounded-md border border-white/10 bg-[#161922] py-1 shadow-xl"
          >
            {options.map((sym) => (
              <button
                key={sym}
                type="button"
                className="block w-full px-2 py-0.5 text-left font-mono text-[11px] text-stone-200 hover:bg-orange-500/20"
                onMouseDown={(e) => { e.preventDefault(); setV(sym); onSymbol(sym); setComboOpen(false); }}
              >
                {sym}
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Quality + extensions popover (chip-grid pattern). */}
      <div className="relative shrink-0" ref={gridRef}>
        <button
          type="button"
          aria-label="Open quality and extensions grid"
          aria-expanded={gridOpen}
          title="Quality & extensions"
          className={cn(
            "rounded-md bg-black/30 px-1.5 py-0.5 text-[10px] text-stone-200 ring-1 ring-white/10 hover:bg-white/5",
            gridOpen && "ring-orange-400/50",
          )}
          onClick={() => setGridOpen((o) => !o)}
        >
          {QUALITY_CHIPS.find(([q]) => q === quality)?.[1]}{selectedExtensions.length > 0 ? `+${selectedExtensions.length}` : ""} ▾
        </button>
        {gridOpen && (
          <div
            data-chord-grid
            className="absolute left-0 top-full z-[70] mt-1 w-64 rounded-md border border-white/10 bg-[#161922] p-2 shadow-xl"
          >
            <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-stone-500">Quality</div>
            <div role="group" aria-label="Chord quality" className="grid grid-cols-3 gap-0.5">
              {QUALITY_CHIPS.map(([value, label]) => (
                <button key={value} type="button" aria-pressed={quality === value} className={cn("rounded px-1 py-0.5 text-[9px]", quality === value ? "bg-sky-500/40 text-white" : "bg-white/5 text-stone-400 hover:text-stone-200")} onClick={() => update(rootName, value)}>{label}</button>
              ))}
            </div>
            <div className="mb-1 mt-2 text-[9px] font-semibold uppercase tracking-wider text-stone-500">Extensions</div>
            <div role="group" aria-label="Chord extensions" className="grid grid-cols-3 gap-0.5">
              {EXTENSION_CHIPS.map((extension) => {
                const active = selectedExtensions.includes(extension);
                return (
                  <button key={extension} type="button" aria-pressed={active} className={cn("rounded px-1 py-0.5 text-[9px]", active ? "bg-orange-500/40 text-orange-100" : "bg-white/5 text-stone-400 hover:text-stone-200")} onClick={() => update(rootName, quality, active ? selectedExtensions.filter((item) => item !== extension) : [...selectedExtensions, extension])}>{extension}</button>
                );
              })}
            </div>
            <div className="mt-1.5 text-[9px] text-stone-500">Preview: <span className="font-mono text-sky-100">{v}</span></div>
          </div>
        )}
      </div>
      {/* Bass dropdown: explicit default option + 12 pitch classes. */}
      <select
        aria-label="Bass note"
        title="Bass note"
        className="min-w-0 rounded-md bg-black/30 px-1 py-0.5 text-[10px] text-stone-200 outline-none ring-1 ring-white/10"
        value={parsedBass === null ? "root" : parsedBass}
        onChange={(e) => update(rootName, quality, selectedExtensions, e.target.value === "root" ? null : Number(e.target.value) as PitchClass)}
      >
        <option value="root">default (root)</option>
        {PITCH_CLASS_NAMES.map((name, index) => <option key={name} value={index}>/{name}</option>)}
      </select>
      <button type="button" aria-label="Delete this chord" title="Delete chord (Del)" className="shrink-0 rounded-md bg-red-500/15 px-2 py-0.5 text-[10px] text-red-200 ring-1 ring-red-400/20 hover:bg-red-500/25" onClick={onDelete}>Delete</button>
      <button type="button" aria-label="Close chord editor (Esc)" title="Close (Esc)" className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] text-stone-300 hover:bg-white/10" onClick={onClose}>✕</button>
    </div>
  );
}

function Tbtn({
  children,
  label,
  onClick,
  disabled,
  active,
  accent,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-full text-stone-300 hover:bg-white/5",
        active && "bg-orange-500/20 text-orange-300",
        accent && "bg-white/10 text-white",
        disabled && "opacity-35",
      )}
    >
      {children}
    </button>
  );
}
