// Routing v1 — the binding picker (the concept's central surface): ONE
// dialog where a track's binding triple is edited — the MIDI channel and
// the output pair of its hosted instance. Every rule from the concept is
// visible here rather than buried in behavior:
//   D4  the default binding is the next free channel + the main pair.
//   D5  an output is a stereo pair; one pair feeds one track.
//   D6  bind = activate — every reported pair is selectable (the engine
//       claims the aux bus when the strip wires it); nothing here promises
//       audio from a dormant pair (the levels note says exactly that).
//   D8  conflicts are VISIBLE: pairs and channels used by another track
//       grey out naming their user; nothing is ever silently reassigned.
//   D13 full states carry the split-by-section advice (channels) or the
//       bind-elsewhere advice (outputs).
//   D15 the transport never stops for a rebind; the tail note shows while
//       playback rolls so the behavior is part of the rules, not a bug.
//   D16 offline / missing are editable states — the binding survives, the
//       picker says what is happening, everything re-resolves on return.

import { useEffect, useMemo, useState } from "react";
import { Ph } from "../icons";
import type { Track } from "../shared/schema/types";
import { cn } from "../utils/cn";
import { Modal } from "./Dialogs";
import type { InstanceLayout, TrackBindingView } from "../engine/routing";
import {
  REBIND_TAIL_NOTE,
  channelsFullAdvice,
  derivePairs,
  instanceDisplayName,
  outputsFullAdvice,
  pairLabel,
} from "../engine/routing";

export interface PickerInstance {
  groupId: string;
  hosted: boolean;
  layout?: InstanceLayout;
  /** The plugin's own output-bus names, bus order (from capabilities). */
  busNames?: string[];
  pluginId?: string | null;
}

interface Props {
  track: Track;
  /** The track's resolved binding view (channel/pair/missing). */
  view: TrackBindingView;
  /** Plugin-bearing groups of the project (the instance choices). */
  instances: PickerInstance[];
  /** libraryGroups — for the deterministic display name. */
  libraryGroups: import("../shared/schema/types").LibraryGroup[];
  pluginNames: Record<string, string>;
  /** Channels used by OTHER tracks of the SAME instance (resolved routing),
   * NAMED — the conflict display quotes the user (D8: conflicts visible). */
  channelUsers: Array<{ ch: number; by: string }>;
  /** `${instanceId}:${pair0}` → the NAMES of the OTHER tracks using that
   * pair (the App resolves and excludes the edited track itself). */
  pairUsersByTrack: Record<string, Record<string, string[]>>;
  enginePlaying: boolean;
  onCommit: (binding: { channel: number | null; pair0: number | null }) => void;
  onClose: () => void;
}

export function BindingPicker({
  track,
  view,
  instances,
  libraryGroups,
  pluginNames,
  channelUsers,
  pairUsersByTrack,
  enginePlaying,
  onCommit,
  onClose,
}: Props) {
  const current = instances.find((i) => i.groupId === view.instanceId);
  // Local edit state: null = auto/default (channel auto, pair = main).
  const [channel, setChannel] = useState<number | null>(
    typeof track.engineChannel === "number" ? track.engineChannel : null,
  );
  const [pair0, setPair0] = useState<number | null>(
    typeof track.engineOutputPair === "number" ? track.engineOutputPair : null,
  );
  // Keep the edit state honest if the view changes underneath (undo, load).
  useEffect(() => {
    setChannel(typeof track.engineChannel === "number" ? track.engineChannel : null);
    setPair0(typeof track.engineOutputPair === "number" ? track.engineOutputPair : null);
  }, [track.engineChannel, track.engineOutputPair, track.id]);

  const offline = current !== undefined && !current.hosted;
  const noLayout = current !== undefined && current.hosted && current.layout === undefined;
  const layout = current?.layout;
  const pairs = useMemo(
    () => derivePairs(layout, current?.busNames),
    [layout, current?.busNames],
  );
  const instanceName = view.instanceId
    ? instanceDisplayName(libraryGroups, view.instanceId, pluginNames)
    : "";

  const othersUsers = (key: string): string[] => (pairUsersByTrack[view.instanceId ?? ""] ?? {})[key] ?? [];
  const channelTakenBy = (ch: number): string | null =>
    channelUsers.find((u) => u.ch === ch)?.by ?? null;

  const channelsExhausted = channelUsers.length >= 16 && channel === null;
  const freePairs = pairs.filter((p) => (othersUsers(`${p.pair0}`) ?? []).length === 0 || p.pair0 === pair0);
  const outputsExhausted =
    layout !== undefined && freePairs.length === 0 && pair0 === null;

  const dirty =
    channel !== (typeof track.engineChannel === "number" ? track.engineChannel : null) ||
    pair0 !== (typeof track.engineOutputPair === "number" ? track.engineOutputPair : null);

  return (
    <Modal title={`Routing — ${track.name}`} onClose={onClose} wide>
      {!view.instanceId ? (
        <div className="space-y-3">
          <p className="text-sm leading-relaxed text-stone-300">
            This track has no plugin instance yet. Assign a VST3 first (the track's pill button) —
            routing binds a track to an <span className="font-semibold text-orange-300">instance</span>,
            a <span className="font-semibold text-orange-300">MIDI channel</span> and an
            <span className="font-semibold text-orange-300"> output pair</span>.
          </p>
          <p className="text-[11px] leading-relaxed text-stone-500">
            Until then the track previews through the built-in synth and its MIDI exports exactly
            the same — nothing here blocks writing music.
          </p>
          <div className="flex justify-end">
            <button type="button" onClick={onClose}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-stone-100 hover:bg-white/15">
              Close
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Instance line + live state */}
          <div className="flex items-center justify-between gap-2 rounded-md bg-black/30 px-3 py-2 ring-1 ring-white/10">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Ph name="plug" className="h-3.5 w-3.5 shrink-0 text-orange-300" />
              <span className="truncate font-medium text-stone-100">{instanceName}</span>
              {offline ? (
                <span className="shrink-0 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-medium text-stone-400">offline</span>
              ) : (
                <span className="shrink-0 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">live</span>
              )}
            </div>
            <span className="shrink-0 font-mono text-[11px] text-stone-500">
              channel {view.channel ?? "—"} · {view.pair0 !== null ? pairLabel(view.pair0) : "Out 1/2"}
            </span>
          </div>

          {offline && (
            <p className="rounded-md bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200/90 ring-1 ring-amber-500/20">
              The plugin is not hosted right now ("no audio right now" — nothing is locked). Edit and
              save the binding freely; when the plugin is back everything re-resolves by itself.
            </p>
          )}
          {noLayout && !offline && (
            <p className="rounded-md bg-white/5 px-3 py-2 text-[11px] leading-relaxed text-stone-400 ring-1 ring-white/10">
              The instance is live but its output layout has not been probed yet — the pair list
              below is the engine's own truth the moment the probe lands.
            </p>
          )}

          {/* Channel grid */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">MIDI channel</span>
              {channelsExhausted && (
                <span className="text-[10px] text-amber-300">channels full — 16/16</span>
              )}
            </div>
            <div className="grid grid-cols-8 gap-1">
              <button
                type="button"
                title="Auto — the first free channel of this instance (the default)"
                onClick={() => setChannel(null)}
                className={cn(
                  "h-8 rounded-md text-[11px] ring-1",
                  channel === null
                    ? "bg-orange-500/30 text-orange-100 ring-orange-400/50"
                    : "bg-white/5 text-stone-400 ring-white/10 hover:bg-white/10",
                )}
              >
                auto
              </button>
              {Array.from({ length: 16 }, (_, i) => i + 1).map((ch) => {
                const takenBy = channelTakenBy(ch);
                const mine = channel === ch;
                return (
                  <button
                    key={ch}
                    type="button"
                    disabled={takenBy !== null && !mine}
                    title={
                      mine ? `Channel ${ch} — this track`
                        : takenBy !== null ? `Channel ${ch} — used by ${takenBy}`
                        : `Channel ${ch}`
                    }
                    onClick={() => setChannel(ch)}
                    className={cn(
                      "h-8 rounded-md font-mono text-[11px] ring-1",
                      mine
                        ? "bg-orange-500/30 text-orange-100 ring-orange-400/50"
                        : takenBy !== null
                          ? "cursor-not-allowed bg-white/[0.03] text-stone-600 ring-white/5 line-through"
                          : "bg-white/5 text-stone-300 ring-white/10 hover:bg-white/10",
                    )}
                  >
                    {ch}
                  </button>
                );
              })}
            </div>
            {channelsExhausted && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-amber-200/90">
                {channelsFullAdvice(instanceName)}
              </p>
            )}
            <p className="mt-1.5 text-[11px] text-stone-500">
              Whatever layers you set up inside the plugin must listen on this same channel — that
              part stays manual, in the plugin's own editor.
            </p>
          </div>

          {/* Pair list */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">Output pair</span>
              {outputsExhausted && (
                <span className="text-[10px] text-amber-300">no free pairs</span>
              )}
            </div>
            {layout === undefined ? (
              <p className="rounded-md bg-white/5 px-3 py-2 text-[11px] text-stone-400 ring-1 ring-white/10">
                {offline
                  ? "The pair list returns when the plugin is hosted again — your binding is kept either way."
                  : "Waiting for the engine's layout probe."}
              </p>
            ) : (
              <div className="max-h-52 space-y-1 overflow-y-auto pr-1">
                {pairs.map((p) => {
                  const users = othersUsers(`${p.pair0}`).filter((n) => n !== track.name);
                  const mine = pair0 === p.pair0 || (pair0 === null && p.main);
                  const used = users.length > 0;
                  const missing = view.missing && view.pair0 === p.pair0;
                  return (
                    <button
                      key={p.pair0}
                      type="button"
                      disabled={used && !mine}
                      onClick={() => setPair0(p.main && pair0 === null ? null : p.pair0)}
                      title={
                        mine ? `${p.label} — this track`
                          : used ? `${p.label} — used by ${users.join(", ")}`
                          : `Bind ${p.label}${p.busName ? ` (${p.busName})` : ""}`
                      }
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs ring-1",
                        mine
                          ? missing
                            ? "bg-red-500/15 ring-red-400/40"
                            : "bg-orange-500/15 ring-orange-400/40"
                          : used
                            ? "cursor-not-allowed bg-white/[0.03] ring-white/5"
                            : "bg-black/30 ring-white/10 hover:bg-white/5",
                      )}
                    >
                      <Ph
                        name={mine ? (missing ? "warning" : "check") : used ? "lock" : "plus"}
                        className={cn(
                          "h-3 w-3 shrink-0",
                          mine ? (missing ? "text-red-300" : "text-orange-300") : "text-stone-500",
                        )}
                      />
                      <span className={cn("font-mono", mine ? "text-stone-100" : used ? "text-stone-600 line-through" : "text-stone-300")}>
                        {p.label}
                      </span>
                      {p.main && (
                        <span className="rounded bg-white/10 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wide text-stone-400">main</span>
                      )}
                      {p.busName && <span className="truncate text-stone-500">{p.busName}</span>}
                      <span className="min-w-0 flex-1 truncate text-right text-[10px]">
                        {missing ? (
                          <span className="text-red-300">missing — plugin reports fewer channels</span>
                        ) : mine ? (
                          <span className="text-orange-200/80">this track</span>
                        ) : used ? (
                          <span className="text-stone-500">used by {users.join(", ")}</span>
                        ) : (
                          <span className="text-stone-600">bind = activates this output</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {outputsExhausted && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-amber-200/90">
                {outputsFullAdvice(instanceName)}
              </p>
            )}
            <p className="mt-1.5 text-[11px] leading-relaxed text-stone-500">
              Binding a pair asks the plugin to wake that output (bind = activate); the pair's
              activity meter shows what is actually passing audio. Pairs already used by another
              track never get taken silently — unbind there first.
            </p>
          </div>

          {enginePlaying && (
            <p className="rounded-md bg-sky-500/10 px-3 py-2 text-[11px] leading-relaxed text-sky-200/90 ring-1 ring-sky-500/20">
              {REBIND_TAIL_NOTE}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-stone-100 hover:bg-white/15">
              Cancel
            </button>
            <button
              type="button"
              disabled={!dirty}
              onClick={() => {
                onCommit({ channel, pair0 });
                onClose();
              }}
              className="rounded-md bg-orange-400 px-3 py-1.5 text-sm font-medium text-black hover:bg-orange-300 disabled:opacity-40"
            >
              Apply binding
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
