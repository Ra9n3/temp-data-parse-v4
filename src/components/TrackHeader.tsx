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
              {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => (
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
