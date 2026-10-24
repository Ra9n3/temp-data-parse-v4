// Routing v1 — the instance rack: ONE card per hosted plugin instance
// (a plugin-bearing LibraryGroup), rendering exactly what the concept
// promised the user would always be able to see:
//   D13  the dual counter "channels 9/16 · outputs 5/8" — both ceilings are
//        real, outputs drain first on multi-bus plugins (Falcon: 17 buses).
//   D6   each bound pair carries an activity-meter slot; until the engine
//        ships the per-strip levels push the slot says exactly that (an
//        honest placeholder, never a fake meter).
//   D8   every pair names its user; unused-but-active pairs warn.
//   D14  "Assign roles to this plugin's outputs" PROPOSES output bindings
//        only — name match first, generic fill in order, never a used pair,
//        nothing applies without the confirm dialog.
//   D10  the per-instance measured latency, displayed where the binding
//        lives (the engine measures at prepare and re-detects changes —
//        the app never guesses numbers it was not told).
//   D16  offline instances stay listed and editable; a layout that came
//        back narrower badges its unwired pairs instead of hiding them.

import { useMemo, useState } from "react";
import { Ph } from "../icons";
import type { LibraryGroup, Project } from "../shared/schema/types";
import { cn } from "../utils/cn";
import { Modal } from "./Dialogs";
import type { InstanceLayout } from "../engine/routing";
import {
  autoSetupProposal,
  derivePairs,
  instanceCounters,
  instanceDisplayName,
  outputPairView,
  pairLabel,
} from "../engine/routing";
import type { PluginCapabilitiesMessage } from "../engine/engineClient";

interface Props {
  open: boolean;
  onToggle: () => void;
  project: Project;
  layouts: Record<string, InstanceLayout>;
  capsByInstance: Record<string, PluginCapabilitiesMessage>;
  pluginNames: Record<string, string>;
  hostedIds: Set<string>;
  latencyByInstance: Record<string, number>;
  /** The R3 guard's last push per instance (unwired count + live channels). */
  layoutNotices: Record<string, { unwired: number; liveChannels: number }>;
  /** Show the levels placeholder (true) or hide meters entirely. */
  levelsSupported: boolean;
  onOpenPicker: (trackId: string) => void;
  onApplyAutoSetup: (groupId: string, assignments: Array<{ trackId: string; pair0: number }>) => void;
}

export function InstancesPanel({
  open,
  onToggle,
  project,
  layouts,
  capsByInstance,
  pluginNames,
  hostedIds,
  latencyByInstance,
  layoutNotices,
  levelsSupported,
  onOpenPicker,
  onApplyAutoSetup,
}: Props) {
  // Plugin-bearing groups only (instanceId = group id) — label groups stay out.
  const groups = project.libraryGroups.filter((g) => g.pluginId && g.pluginPath);

  if (!open) {
    return (
      <button
        type="button"
        onClick={onToggle}
        title="Show plugin instances"
        className="flex w-9 shrink-0 flex-col items-center gap-2 border-l border-white/10 bg-[#12141c] py-3 text-stone-500 hover:text-stone-200"
      >
        <Ph name="route" className="h-4 w-4" />
        <span className="[writing-mode:vertical-rl] text-[10px] font-medium uppercase tracking-wider">Instances</span>
        {groups.length > 0 && (
          <span className="rounded bg-white/10 px-1 text-[10px] font-mono text-stone-400">{groups.length}</span>
        )}
      </button>
    );
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-white/10 bg-[#12141c]" aria-label="Plugin instances">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 px-3">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
          <Ph name="route" className="h-3.5 w-3.5" />
          Plugin instances
        </span>
        <button type="button" onClick={onToggle} title="Collapse" className="text-stone-500 hover:text-stone-200">
          <Ph name="x" className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-stone-500">
            No plugin instances yet — assign a VST3 to a track (the track's pill) and its instance
            shows up here with its channels, output pairs and latency.
          </p>
        )}
        {groups.map((g) => (
          <InstanceCard
            key={g.id}
            group={g}
            project={project}
            layouts={layouts}
            caps={capsByInstance[g.id]}
            pluginNames={pluginNames}
            hosted={hostedIds.has(g.id)}
            latency={latencyByInstance[g.id]}
            notice={layoutNotices[g.id]}
            levelsSupported={levelsSupported}
            onOpenPicker={onOpenPicker}
            onApplyAutoSetup={onApplyAutoSetup}
          />
        ))}
      </div>
    </aside>
  );
}

function InstanceCard({
  group,
  project,
  layouts,
  caps,
  pluginNames,
  hosted,
  latency,
  notice,
  levelsSupported,
  onOpenPicker,
  onApplyAutoSetup,
}: {
  group: LibraryGroup;
  project: Project;
  layouts: Record<string, InstanceLayout>;
  caps?: PluginCapabilitiesMessage;
  pluginNames: Record<string, string>;
  hosted: boolean;
  latency?: number;
  notice?: { unwired: number; liveChannels: number };
  levelsSupported: boolean;
  onOpenPicker: (trackId: string) => void;
  onApplyAutoSetup: (groupId: string, assignments: Array<{ trackId: string; pair0: number }>) => void;
}) {
  const [proposalOpen, setProposalOpen] = useState(false);
  const name = instanceDisplayName(project.libraryGroups, group.id, pluginNames);
  const counters = instanceCounters(project, group.id, layouts);
  const busNames = useMemo(
    () => caps?.buses.filter((b) => !b.input).map((b) => b.name) ?? undefined,
    [caps],
  );
  const view = outputPairView(project, layouts);
  const pairs = useMemo(() => derivePairs(layouts[group.id], busNames), [layouts, group.id, busNames]);
  const usersByPair = useMemo(() => {
    const m = new Map<number, Array<{ name: string; trackId: string }>>();
    for (const v of Object.values(view)) {
      if (v.instanceId !== group.id || v.pair0 === null) continue;
      const t = project.tracks.find((tr) => tr.id === v.trackId);
      if (!t) continue;
      const list = m.get(v.pair0);
      const user = { name: t.name, trackId: t.id };
      if (list) list.push(user);
      else m.set(v.pair0, [user]);
    }
    return m;
  }, [view, group.id, project.tracks]);

  const unusedActive = pairs.filter((p) => (usersByPair.get(p.pair0) ?? []).length === 0);
  const missingPairs = pairs.filter(
    (p) => (usersByPair.get(p.pair0) ?? []).length > 0 && p.pair0 + 1 >= (layouts[group.id]?.channels ?? Infinity),
  );
  const tracksHere = project.tracks.filter((t) => view[t.id]?.instanceId === group.id);

  return (
    <div className="rounded-lg bg-black/30 ring-1 ring-white/10">
      <div className="flex items-center justify-between gap-2 px-2.5 pt-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-stone-100">
          <Ph name="plug" className="h-3 w-3 shrink-0 text-orange-300" />
          <span className="truncate">{name}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {typeof latency === "number" && (
            <span title="Measured latency (plugin + device), compensated by the engine at prepare"
              className="rounded bg-white/10 px-1 py-0.5 font-mono text-[10px] text-stone-300">
              {latency.toFixed(1)} ms
            </span>
          )}
          <span
            title={hosted ? "hosted — the engine confirms this instance" : "offline — the binding stays editable; everything re-resolves when the plugin is back"}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-medium",
              hosted ? "bg-emerald-500/15 text-emerald-300" : "bg-white/10 text-stone-400",
            )}
          >
            {hosted ? "live" : "offline"}
          </span>
        </span>
      </div>
      <div className="px-2.5 pb-1 pt-0.5 font-mono text-[10px] text-stone-500">
        channels {counters.channelsUsed}/{counters.channelsMax} · outputs {counters.outputsUsed}/{counters.outputsMax ?? "—"}
      </div>
      {notice && (
        <div className="mx-2.5 mb-1.5 rounded bg-amber-500/10 px-2 py-1 text-[10px] leading-relaxed text-amber-200/90 ring-1 ring-amber-500/20">
          layout changed — {notice.unwired} pair{notice.unwired === 1 ? "" : "s"} unwired (live: {notice.liveChannels} ch). Bindings kept; they re-resolve when the output returns.
        </div>
      )}
      <div className="max-h-44 space-y-0.5 overflow-y-auto px-2.5 pb-1">
        {layouts[group.id] === undefined ? (
          <p className="py-1 text-[10px] leading-relaxed text-stone-500">
            {hosted
              ? "Live — waiting for the engine's layout probe."
              : "No audio right now. The pairs below are the saved bindings."}
          </p>
        ) : (
          pairs.map((p) => {
            const users = usersByPair.get(p.pair0) ?? [];
            const missing = users.length > 0 && p.pair0 + 1 >= layouts[group.id]!.channels;
            const firstUser = users[0]?.trackId;
            const body = (
              <>
                <Ph name="activity" className={cn("h-3 w-3 shrink-0", users.length > 0 && !missing ? "text-emerald-400/80" : "text-stone-600")} />
                <span className={cn("font-mono", missing ? "text-red-300" : "text-stone-300")}>{p.label}</span>
                {p.main && <span className="rounded bg-white/10 px-1 text-[8px] uppercase text-stone-400">main</span>}
                {p.busName && <span className="truncate text-stone-500">{p.busName}</span>}
                <span className="min-w-0 flex-1 truncate text-right">
                  {missing ? (
                    <span className="text-red-300">missing</span>
                  ) : users.length > 0 ? (
                    <span className="text-stone-400">{users.map((u) => u.name).join(", ")}</span>
                  ) : (
                    <span className="text-stone-600" title="This output is active but no track uses it">unused</span>
                  )}
                </span>
                {levelsSupported ? null : (
                  <span className="text-[8px] uppercase tracking-wide text-stone-700" title="Per-output activity meters ride the engine's per-strip levels push (planned wire message) — the slot is ready, the stream is not shipped yet">
                    lvl
                  </span>
                )}
              </>
            );
            return firstUser ? (
              <button key={p.pair0} type="button" onClick={() => onOpenPicker(firstUser)}
                title={`Open the routing picker for ${users.map((u) => u.name).join(", ")}`}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[10px] hover:bg-white/5",
                  missing && "bg-red-500/10 ring-1 ring-red-400/30",
                  !missing && "bg-white/[0.03]",
                )}>
                {body}
              </button>
            ) : (
              <div key={p.pair0}
                className="flex items-center gap-1.5 rounded bg-white/[0.03] px-1.5 py-1 text-[10px]">
                {body}
              </div>
            );
          })
        )}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-white/5 px-2.5 py-1.5">
        <span className="truncate text-[10px] text-stone-500">
          {tracksHere.length === 0
            ? "no tracks bound"
            : `${tracksHere.length} track${tracksHere.length === 1 ? "" : "s"} · ${missingPairs.length > 0 ? `${missingPairs.length} missing · ` : ""}${unusedActive.length > 0 ? `${unusedActive.length} unused` : "all used pairs"}`}
        </span>
        <button
          type="button"
          disabled={!hosted || tracksHere.length === 0}
          title="Propose output bindings for this instance's tracks — name matches first, then free pairs in order. Nothing applies until you confirm."
          onClick={() => setProposalOpen(true)}
          className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-stone-300 ring-1 ring-white/10 hover:bg-white/10 disabled:opacity-40"
        >
          Assign roles
        </button>
      </div>
      {proposalOpen && (
        <AutoSetupDialog
          name={name}
          project={project}
          groupId={group.id}
          layout={layouts[group.id]}
          busNames={busNames}
          onClose={() => setProposalOpen(false)}
          onApply={(assignments) => {
            onApplyAutoSetup(group.id, assignments);
            setProposalOpen(false);
          }}
        />
      )}
    </div>
  );
}

function AutoSetupDialog({
  name,
  project,
  groupId,
  layout,
  busNames,
  onClose,
  onApply,
}: {
  name: string;
  project: Project;
  groupId: string;
  layout?: InstanceLayout;
  busNames?: string[];
  onClose: () => void;
  onApply: (assignments: Array<{ trackId: string; pair0: number }>) => void;
}) {
  const outcome = useMemo(
    () => autoSetupProposal(project, groupId, layout ? { [groupId]: layout } : {}, busNames),
    [project, groupId, layout, busNames],
  );
  return (
    <Modal title={`Assign roles — ${name}`} onClose={onClose}>
      {outcome.proposals.length === 0 ? (
        <p className="text-sm leading-relaxed text-stone-300">
          Nothing to propose. Tracks already explicitly bound keep their pairs, and there are no
          free pairs left to fill.
        </p>
      ) : (
        <div className="space-y-1.5">
          <p className="text-xs leading-relaxed text-stone-400">
            Proposed output bindings only — channels and in-plugin layers are never touched. Applied
            in this order: name matches first, then free pairs in order. Already-used pairs were
            skipped ({outcome.usedPairs}), and {outcome.leftOnMain} track
            {outcome.leftOnMain === 1 ? "" : "s"} stay{outcome.leftOnMain === 1 ? "s" : ""} on the shared main pair.
          </p>
          {outcome.proposals.map((p) => (
            <div key={p.trackId} className="flex items-center gap-2 rounded-md bg-black/30 px-2.5 py-1.5 text-xs ring-1 ring-white/10">
              <Ph name={p.basis === "name" ? "check" : "wand"} className={cn("h-3 w-3 shrink-0", p.basis === "name" ? "text-emerald-300" : "text-stone-500")} />
              <span className="min-w-0 flex-1 truncate text-stone-100">{p.trackName}</span>
              <span className="text-[10px] text-stone-500">{p.basis === "name" ? "name match" : "next free"}</span>
              <span className="font-mono text-orange-200">{pairLabel(p.pair0)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose}
          className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-stone-100 hover:bg-white/15">
          Cancel
        </button>
        <button
          type="button"
          disabled={outcome.proposals.length === 0}
          onClick={() => onApply(outcome.proposals.map((p) => ({ trackId: p.trackId, pair0: p.pair0 })))}
          className="rounded-md bg-orange-400 px-3 py-1.5 text-sm font-medium text-black hover:bg-orange-300 disabled:opacity-40"
        >
          Apply {outcome.proposals.length > 0 ? `(${outcome.proposals.length})` : ""}
        </button>
      </div>
    </Modal>
  );
}
