import type { ReactNode } from "react";
import { Ph } from "../icons";
import { useState } from "react";
import { DEFAULT_EXPRESSION_MAPPING, type ExpressionMapping, type Track } from "../shared/schema/types";
import { cn } from "../utils/cn";

interface Props {
  track: Track;
  pluginLabel: string;
  onMute: () => void;
  onSolo: () => void;
  onLock: () => void;
  onOpenVst: () => void;
  onLoadAudio?: () => void;
  onExpressionMapping: (mapping: ExpressionMapping) => void;
}

export function TrackHeader({
  track,
  pluginLabel,
  onMute,
  onSolo,
  onLock,
  onOpenVst,
  onLoadAudio,
  onExpressionMapping,
}: Props) {
  const [expressionOpen, setExpressionOpen] = useState(false);
  const mapping = track.expressionMapping ?? DEFAULT_EXPRESSION_MAPPING;
  const isAudio = track.role === "audio";
  const isStructure = track.family === "structure";
  const vstDisabled = isStructure || isAudio;

  return (
    <div className="flex h-full items-stretch border-b border-white/5 bg-[#12141c]">
      <div className="w-1 shrink-0 self-stretch" style={{ background: track.color }} />
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-stone-100">{track.name}</div>
          {isAudio ? (
            <button
              type="button"
              onClick={onLoadAudio}
              className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 ring-1 ring-amber-500/30 hover:bg-amber-500/25"
              title="Load wav, mp3, or flac"
            >
              <Ph name="folder" className="h-3 w-3 shrink-0" />
              <span className="truncate">{pluginLabel || "Load audio"}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={vstDisabled ? undefined : onOpenVst}
              disabled={vstDisabled}
              title={
                vstDisabled
                  ? "VST hosting is for instrument tracks"
                  : pluginLabel === "No plugin"
                    ? "Assign a VST3 (preview browser)"
                    : pluginLabel
              }
              className={cn(
                "mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1",
                vstDisabled
                  ? "cursor-not-allowed bg-white/5 text-stone-500 ring-white/10"
                  : "bg-orange-500/20 text-orange-200 ring-orange-400/30 hover:bg-orange-500/30",
              )}
            >
              <Ph name="plug" className="h-3 w-3 shrink-0" />
              <span className="truncate">{vstDisabled ? "—" : pluginLabel}</span>
            </button>
          )}
          {!vstDisabled && <button type="button" aria-label={`Expression mapping for ${track.name}`} title="Expression map and CC assignments" onClick={() => setExpressionOpen((open) => !open)} className="mt-1 ml-1 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-stone-300 ring-1 ring-white/10 hover:bg-white/10">CC</button>}
          {expressionOpen && !vstDisabled && <div role="dialog" aria-label={`Expression mapping for ${track.name}`} className="absolute left-2 top-11 z-[80] w-64 rounded-lg border border-white/10 bg-[#191c26] p-3 text-stone-200 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <div className="mb-2 flex items-center justify-between"><strong className="text-xs">Expression map</strong><button type="button" aria-label="Close expression mapping" onClick={() => setExpressionOpen(false)}>×</button></div>
            <select aria-label="Expression map preset" className="mb-2 w-full rounded bg-black/40 p-1.5 text-xs" value={mapping.preset} onChange={(event) => onExpressionMapping({ ...mapping, preset: event.target.value as ExpressionMapping["preset"] })}>{["Spitfire UACC", "VSL Synchron", "SINE", "Kontakt Standard", "Custom"].map((preset) => <option key={preset}>{preset}</option>)}</select>
            {([["dynamicCC", "Dynamic CC"], ["expressionCC", "Expression CC"], ["brightnessCC", "Brightness / Cutoff CC"], ["sustainCC", "Sustain Pedal CC"]] as const).map(([key, label]) => <label key={key} className="mb-1.5 flex items-center justify-between gap-2 text-[11px] text-stone-400">{label}<input aria-label={label} className="w-16 rounded bg-black/40 px-1.5 py-1 text-right text-xs text-stone-100" type="number" min={0} max={127} value={mapping[key]} onChange={(event) => onExpressionMapping({ ...mapping, [key]: Math.max(0, Math.min(127, Number(event.target.value) || 0)) })} /></label>)}
          </div>}
        </div>
        <div className="relative flex shrink-0 items-center gap-0.5">
          <IconBtn
            label={track.locked ? "Unlock track" : "Lock track"}
            active={track.locked}
            onClick={onLock}
          >
            <Ph name={track.locked ? "lock" : "unlock"} className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label={track.muted ? "Unmute" : "Mute"} active={track.muted} danger onClick={onMute}>
            <Ph name={track.muted ? "mute" : "speaker"} className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn label={track.soloed ? "Unsolo" : "Solo"} active={track.soloed} warn onClick={onSolo}>
            <Ph name="solo" className="h-3.5 w-3.5" />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  label,
  active,
  danger,
  warn,
  onClick,
}: {
  children: ReactNode;
  label: string;
  active?: boolean;
  danger?: boolean;
  warn?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md text-stone-400 hover:bg-white/5 hover:text-stone-100",
        active && !danger && !warn && "bg-white/10 text-amber-300",
        active && danger && "bg-red-500/20 text-red-400",
        active && warn && "bg-yellow-500/20 text-yellow-300",
      )}
    >
      {children}
    </button>
  );
}
