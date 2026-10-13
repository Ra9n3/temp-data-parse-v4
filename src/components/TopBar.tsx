import type { ReactNode } from "react";
import { Ph } from "../icons";
import { ScorchMark } from "./ScorchMark";
import {
  MODE_LABELS,
  MODE_NAMES,
  PITCH_CLASS_NAMES,
  type ModeName,
  type PitchClass,
  type Project,
  type TimeSignature,
} from "../shared/schema/types";
import { formatTimecode } from "../shared/schema/time";
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
}: Props) {
  const tsValue = `${project.timeSignature.numerator}/${project.timeSignature.denominator}`;

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-white/10 bg-[#0e1016] px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <ScorchMark className="h-8 w-8 rounded-lg" />
        <div className="mr-2 hidden leading-tight sm:block">
          <div className="text-sm font-semibold tracking-wide text-stone-100">SCORCH</div>
          <div className="font-mono text-[10px] text-stone-500">orchestral midi</div>
        </div>
        <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-[#161922] px-2 py-1">
          <label className="flex items-center gap-1 text-[11px] text-stone-400">
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
            className="rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10"
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
            className="max-w-[9.5rem] rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10"
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
            className="font-mono rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10"
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
            className="max-w-[10rem] rounded-md bg-black/30 px-1.5 py-0.5 text-xs text-stone-100 outline-none ring-1 ring-white/10">
            {["Epic Cinematic", "Classical Symphonic", "Chamber Strings", "Pop/Rock Studio Orchestra", "Jazz Big Band", "Custom"].map((style) => <option key={style}>{style}</option>)}
          </select>
          <button type="button" aria-label="Orchestral configuration and humanization" title="Orchestral configuration and humanization" onClick={onOpenGenerationSettings}
            className="rounded-md bg-orange-500/15 px-2 py-1 text-[11px] text-orange-200 ring-1 ring-orange-400/20 hover:bg-orange-500/25">Orchestration</button>
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
