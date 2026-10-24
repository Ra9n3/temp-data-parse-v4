import type { ReactNode } from "react";
import { Ph } from "../icons";
import { type Track } from "../shared/schema/types";
import { cn } from "../utils/cn";

interface Props {
  track: Track;
  pluginLabel: string;
  /** Stage 3e-1 — the hosted plugin's read-only capability summary (from
   * the engine's plugin_capabilities record). Rendered on the pill's
   * existing hover tooltip (its read-only surface — no new UI). */
  pluginInfo?: string;
  onMute: () => void;
  onSolo: () => void;
  onLock: () => void;
  onOpenVst: () => void;
  /** Stage 3d-1 — present only when a plugin is actually hosted: the plugin
   * button then opens the engine-owned editor window (the hosted library's
   * own UI) instead of the VST browser. Absent → browser (assignment). */
  onOpenEditor?: () => void;
  /** Stage 3d-1 — the hosted editor window is currently open. */
  editorOpen?: boolean;
  /** Stage 3f-4 — open the SWAP picker for this track's plugin (only
   * rendered for plugin-bound tracks; the caller owns the dialog). */
  onSwapPlugin?: () => void;
  /** Stage 3f-5 — this track's plugin instance is mid-hosting (the engine
   * has not sent its plugin_state receipt yet): the pill reads "loading…"
   * and pulses. plugin_state "loaded" → the pill becomes clickable (its
   * editor opens); "error" → the label returns and the toast carries the
   * engine's error text. No new engine messages — derived receipts only. */
  pluginLoading?: boolean;
  onLoadAudio?: () => void;
  /** Stage 3c-3 — resolved engine channel (explicit or first-come auto),
   * undefined = test synth. */
  engineChannelResolved?: number;
  /** True when track.engineChannel is an EXPLICIT assignment. */
  engineChannelExplicit?: boolean;
  /** Channel-assignment handler: null clears the explicit assignment (back to
   * auto); 1–16 sets it. The caller owns collision validation. */
  onEngineChannel?: (ch: number | null) => void;
  /** Stage 3g — channels used by ANOTHER track of the same group (resolved
   * routing). The dropdown only offers the channels NOT in this set, plus the
   * track's own (never in the set by construction). Absent/empty = all 16
   * offered (test-synth tracks, sole riders). */
  engineChannelTaken?: number[];
  /** Routing v1 — the binding line under the pill: the triple at a glance
   * ("Falcon #1 · Ch 3 · Out 5/6"), with the state tone (missing/offline).
   * Absent for audio/structure tracks. Click → the binding picker. */
  routingLine?: { text: string; tone: "ok" | "missing" | "offline" | "unbound" };
  onOpenRouting?: () => void;
  /** Routing v1 — the per-bound-output preview volume (0–1.5, engine strip
   * gain). Only rendered when the track is bound to an output pair. */
  previewVolume?: number;
  onPreviewVolume?: (v: number) => void;
}

export function TrackHeader({
  track,
  pluginLabel,
  pluginInfo,
  onMute,
  onSolo,
  onLock,
  onOpenVst,
  onOpenEditor,
  editorOpen,
  onSwapPlugin,
  pluginLoading,
  onLoadAudio,
  engineChannelResolved,
  engineChannelExplicit,
  onEngineChannel,
  engineChannelTaken,
  routingLine,
  onOpenRouting,
  previewVolume,
  onPreviewVolume,
}: Props) {
  // Patch 4 — the "CC" button, its popup and the expression-editor callback
  // are REMOVED from the UI. track.expressionMapping itself stays in the
  // schema, in exporter defaults/fallbacks and in import/export — only the
  // manual editor is gone (the pinned custom-CC exporter test is untouched).
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
              onClick={vstDisabled ? undefined : (onOpenEditor ?? onOpenVst)}
              disabled={vstDisabled}
              title={
                (vstDisabled
                  ? "VST hosting is for instrument tracks"
                  : pluginLoading
                    ? `Hosting ${pluginLabel} — the editor opens when the engine confirms the load`
                    : onOpenEditor
                      ? editorOpen
                        ? `${pluginLabel} editor is open — click to focus it`
                        : `Open the ${pluginLabel} editor (choose sounds, tweak settings)`
                      : pluginLabel === "No plugin"
                        ? "Assign a VST3 (preview browser)"
                        : pluginLabel)
                // Stage 3e-1 — the read-only "Plugin info" panel (engine
                // capability record) rides the pill's existing tooltip.
                + (pluginInfo ? `\n\n${pluginInfo}` : "")
              }
              className={cn(
                "mt-1 inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1",
                vstDisabled
                  ? "cursor-not-allowed bg-white/5 text-stone-500 ring-white/10"
                  : pluginLoading
                    ? "animate-pulse bg-orange-500/15 text-orange-200/80 ring-orange-400/20"
                    : editorOpen && onOpenEditor
                      ? "bg-orange-500/35 text-orange-100 ring-orange-300/50 hover:bg-orange-500/45"
                      : "bg-orange-500/20 text-orange-200 ring-orange-400/30 hover:bg-orange-500/30",
              )}
            >
              <Ph name="plug" className="h-3 w-3 shrink-0" />
              <span className="truncate">{vstDisabled ? "—" : pluginLoading ? "loading…" : onOpenEditor ? `${pluginLabel} · editor` : pluginLabel}</span>
            </button>
          )}
          {/* Stage 3f-4 — the pill's SWAP affordance: plugin-bound tracks only
              (onOpenEditor present = bound; the caller gates per track).
              Separate click target — the pill itself still opens the editor. */}
          {!isAudio && onSwapPlugin && onOpenEditor && !vstDisabled && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onSwapPlugin();
              }}
              title={`Swap or remove ${pluginLabel} — pick another scanned plugin, or back to the test synth`}
              className="mt-1 ml-1 inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-orange-500/20 text-orange-200 ring-1 ring-orange-400/30 hover:bg-orange-500/30"
            >
              <Ph name="loop" className="h-3 w-3" />
            </button>
          )}
          {/* Routing v1 — the binding line: instance · channel · pair, with
              the state tone. The whole line is the picker affordance. */}
          {!isAudio && !isStructure && routingLine && onOpenRouting && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={onOpenRouting}
                title="Edit the routing binding — instance, MIDI channel and output pair"
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-1 rounded px-1 py-px text-[10px] ring-1 hover:brightness-125",
                  routingLine.tone === "ok" && "bg-sky-500/10 text-sky-300/90 ring-sky-400/20",
                  routingLine.tone === "missing" && "bg-red-500/15 text-red-300 ring-red-400/30",
                  routingLine.tone === "offline" && "bg-white/5 text-stone-400 ring-white/10",
                  routingLine.tone === "unbound" && "bg-white/[0.03] text-stone-500 ring-white/5",
                )}
              >
                <Ph name="route" className="h-2.5 w-2.5 shrink-0" />
                <span className="truncate">{routingLine.text}</span>
              </button>
              {onPreviewVolume && routingLine.tone !== "unbound" && (
                <input
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.05}
                  value={previewVolume ?? 1}
                  onChange={(e) => onPreviewVolume(Number(e.target.value))}
                  title="Preview volume (this track's bound output pair)"
                  aria-label="Preview volume"
                  className="h-1 w-14 shrink-0 cursor-pointer accent-orange-400"
                />
              )}
            </div>
          )}
        </div>
        <div className="relative flex shrink-0 items-center gap-0.5">
          {/* Stage 3c-3 — per-track engine-channel selector (compact, per the
              brief). "·" = auto/unrouted (test synth); numbers are hosted
              channels. The caller validates collisions at assignment time. */}
          {!isAudio && !isStructure && onEngineChannel && (
            <select
              value={engineChannelExplicit && engineChannelResolved ? engineChannelResolved : ""}
              onChange={(e) => onEngineChannel(e.target.value === "" ? null : Number(e.target.value))}
              title={
                engineChannelResolved
                  ? `Engine channel ${engineChannelResolved}${engineChannelExplicit ? " (explicit)" : " (auto)"} — hosted VST3`
                  : "Engine channel: auto (test synth) — pick 1–16 to host on the plugin"
              }
              className={cn(
                "h-7 w-[38px] rounded-md text-[11px] outline-none ring-1",
                engineChannelResolved
                  ? engineChannelExplicit
                    ? "bg-sky-500/20 text-sky-200 ring-sky-400/40"
                    : "bg-sky-500/10 text-sky-300/90 ring-sky-400/20"
                  : "bg-white/5 text-stone-500 ring-white/10",
              )}
            >
              <option value="" title="Auto (test synth unless plugin-routed)">·</option>
              {/* Stage 3g — only channels no other track of this group uses
                  (the track's own resolved channel is never in the set). */}
              {Array.from({ length: 16 }, (_, i) => i + 1)
                .filter((ch) => !engineChannelTaken?.includes(ch))
                .map((ch) => (
                  <option key={ch} value={ch}>{ch}</option>
                ))}
            </select>
          )}
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
