// Multi-timbral plugin routing v1 — the PURE routing rules (suite-pinned,
// no RNG, deterministic everywhere). This is the app side of the agreed
// routing concept: tracks point at plugin instances by id; a binding is the
// triple {instance, MIDI channel 1–16, output pair}; the app OWNS the
// strip-wiring table and the engine executes it statelessly and atomically
// (engine M3 PR2 — see ASSUMPTIONS.md / main.cpp protocol header).
//
// Concept decisions encoded here (each named at its rule):
//   D2  instances are independent; tracks point by id (already the schema —
//       LibraryGroup id == instanceId; this module only reads it).
//   D4  default binding = next free MIDI channel + the MAIN output pair.
//   D5  output = stereo pair [a, a+1] (bus-aligned, 0-based, the engine's
//       strips contract); one pair feeds one track.
//   D6  bind = activate — every reported pair is PROPOSABLE; the engine
//       claims (activates) the aux bus when the strip wires it. The picker
//       never promises audio from a dormant pair — the levels stream (when
//       the engine ships it) is the only "actually passing audio" truth.
//   D8  conflicts are VISIBLE: used pairs grey out naming their user; the
//       app NEVER silently reassigns a binding.
//   D13 the ceiling is real on BOTH axes: channels 16 per instance, output
//       pairs bounded by the live node's channels. Full states name which
//       ran out and carry the split-by-section advice.
//   D14 auto-setup PROPOSES output bindings only (name match → generic fill
//       in order → never a used pair → nothing applies without confirm).
//   D15 rebinding mid-play is allowed and never touches the transport; the
//       tail note (REBIND_TAIL_NOTE) is part of the rules, not a bug.
//   D16 offline/missing are EDITABLE states: a pair the live node can no
//       longer feed renders MISSING (binding preserved — the view derives
//       it, nothing is stored or destructively edited) and re-resolves by
//       itself when the layout widens again.

import type { LibraryGroup, Project, Track } from "../shared/schema/types";
import { resolveInstanceRouting } from "./engineStream";

/** The engine's strip table is capped at 16 wired strips (kMaxStrips). */
export const STRIP_LIMIT = 16;

/** One hosted instance's LIVE output layout (the engine's own truth — the
 * `layouts` probe reply and the per-commit `instanceLayout` push share the
 * exact same shape: {instanceId, buses, channels, busChannels}). */
export interface InstanceLayout {
  instanceId: string;
  /** Declared output bus count (Falcon's real-world 17 included). */
  buses: number;
  /** Total live output channels (getTotalNumOutputChannels truth). */
  channels: number;
  /** Per-bus channel counts, in bus order (e.g. [2,2,2] = three stereo buses). */
  busChannels: number[];
}

/** One selectable output pair: the engine accepts strips ONLY as [a, a+1]
 * with an EVEN (bus-aligned) start within the live channels — derivePairs
 * never proposes anything the engine's R1 validation would reject. */
export interface PairInfo {
  /** 0-based start channel of the pair [a, a+1]. */
  pair0: number;
  /** Human label, 1-based display ("Out 1/2"). */
  label: string;
  /** The plugin's own bus name when this pair IS a 2-channel output bus
   * (from plugin_capabilities) — e.g. "Violas". Undefined = generic. */
  busName?: string;
  /** pair0 === 0 — the instance's main pair (the default binding). */
  main: boolean;
}

/** "Out 5/6" — the 1-based display of pair [4,5]. PURE. */
export function pairLabel(pair0: number): string {
  return `Out ${pair0 + 1}/${pair0 + 2}`;
}

/**
 * PURE — every selectable pair of an instance, ascending. Walks EVEN starts
 * while [a, a+1] fits the live channels (the engine's exact acceptance
 * rule), annotating the plugin's own 2-channel bus names where the pair
 * coincides with a bus. A layout with no bus detail degrades to plain
 * even pairs across the channel count. An unknown layout yields [] — the
 * picker then shows the offline note instead of a fake list.
 */
export function derivePairs(layout: InstanceLayout | undefined, busNames?: string[]): PairInfo[] {
  if (!layout || layout.channels < 2) return [];
  // Cumulative start offset of each 2-channel output bus (for names).
  const named = new Map<number, string>();
  if (busNames && busNames.length > 0) {
    let offset = 0;
    // busChannels is authoritative when present; without it assume the
    // declared buses are stereo and consecutive (best-effort naming only —
    // the pairs themselves come from `channels`, never from this guess).
    const widths = layout.busChannels.length > 0
      ? layout.busChannels
      : Array.from({ length: layout.buses }, () => 2);
    for (let b = 0; b < widths.length && b < busNames.length; ++b) {
      if (widths[b] === 2) named.set(offset, busNames[b]);
      offset += widths[b];
    }
  }
  const pairs: PairInfo[] = [];
  for (let a = 0; a + 1 < layout.channels; a += 2) {
    const busName = named.get(a);
    pairs.push({
      pair0: a,
      label: pairLabel(a),
      ...(busName !== undefined ? { busName } : {}),
      main: a === 0,
    });
  }
  return pairs;
}

/**
 * PURE — the deterministic instance display name ("Falcon #1"): the nth
 * plugin-bearing group sharing the same pluginId, in project (first-
 * appearance) order. Stable across renames of tracks; stable across
 * reloads (the group id is the instance id; the number is derived, never
 * stored). Falls back to the group's own name when no pluginId is set.
 */
export function instanceDisplayName(
  libraryGroups: LibraryGroup[],
  groupId: string,
  pluginNames?: Record<string, string>,
): string {
  const group = libraryGroups.find((g) => g.id === groupId);
  if (!group) return groupId;
  if (!group.pluginId) return group.name;
  const same = libraryGroups.filter((g) => g.pluginId === group.pluginId);
  const n = same.findIndex((g) => g.id === groupId) + 1;
  const base = pluginNames?.[group.pluginId] ?? group.name;
  return same.length > 1 || n > 1 ? `${base} #${n}` : base;
}

/** The routing view of one track (what the header line and picker render). */
export interface TrackBindingView {
  trackId: string;
  /** The bound instance (= the LibraryGroup id), null when unbound. */
  instanceId: string | null;
  /** Resolved MIDI channel within the instance's 1–16 namespace (null =
   * not routed — no plugin group, or the instance has no free channel). */
  channel: number | null;
  /** The EFFECTIVE output pair: the explicit binding, else the MAIN pair
   * default (D4). null when not routed. */
  pair0: number | null;
  /** Explicit (user-chosen) pair; false = riding the main-pair default. */
  pairExplicit: boolean;
  /** D16 — the bound (or defaulted) pair exceeds the instance's LIVE
   * output channels (a plugin reload came back narrower). Derived, never
   * stored: when the layout widens again the flag clears by itself. */
  missing: boolean;
  /** The live layout is known (instance hosted + layout probed). */
  layoutKnown: boolean;
}

/**
 * PURE — the per-track binding view for the whole project. Layouts are the
 * live truth gathered by the App (layouts probe + instanceLayout pushes +
 * capabilities fallback); an instance absent from the map is simply
 * "layout unknown" (offline or not yet probed — NOT missing, D16).
 */
export function outputPairView(
  project: Project,
  layouts: Record<string, InstanceLayout>,
): Record<string, TrackBindingView> {
  const { routing } = resolveInstanceRouting(project);
  const byTrack = new Map(Object.entries(routing));
  const out: Record<string, TrackBindingView> = {};
  for (const t of project.tracks) {
    const route = byTrack.get(t.id);
    if (!route) {
      out[t.id] = {
        trackId: t.id,
        instanceId: null,
        channel: null,
        pair0: null,
        pairExplicit: false,
        missing: false,
        layoutKnown: false,
      };
      continue;
    }
    const explicit = typeof t.engineOutputPair === "number" && t.engineOutputPair >= 0;
    const pair0 = explicit ? (t.engineOutputPair as number) : 0;
    const layout = layouts[route.inst];
    const layoutKnown = layout !== undefined;
    out[t.id] = {
      trackId: t.id,
      instanceId: route.inst,
      channel: route.ch,
      pair0,
      pairExplicit: explicit,
      missing: layoutKnown ? pair0 + 1 >= layout.channels : false,
      layoutKnown,
    };
  }
  return out;
}

/**
 * PURE — which tracks use each (instance, pair0), across the whole project.
 * The picker's conflict display (D8) renders straight from this: a pair
 * taken by ANOTHER track greys out with "used by <name>". Keyed
 * `${instanceId}:${pair0}` — pairs are per-instance namespaces.
 */
export function pairUsers(
  project: Project,
  layouts: Record<string, InstanceLayout>,
): Map<string, TrackBindingView[]> {
  const view = outputPairView(project, layouts);
  const map = new Map<string, TrackBindingView[]>();
  for (const v of Object.values(view)) {
    if (v.instanceId === null || v.pair0 === null) continue;
    const key = `${v.instanceId}:${v.pair0}`;
    const list = map.get(key);
    if (list) list.push(v);
    else map.set(key, [v]);
  }
  return map;
}

export interface DerivedStrips {
  /** The FULL wiring table the app owns (the engine applies it atomically;
   * instances absent from the message are unwired — so this is always the
   * complete desired state, never a delta). */
  wires: Array<{ strip: string; inst: string; pair0: number }>;
  /** Bound pairs excluded because the live node can no longer feed them
   * (D16 — binding preserved, wire withheld; the engine would reject the
   * whole table otherwise: R1 atomic-or-nothing). */
  skippedMissing: number;
  /** Tracks deduped onto an already-wired pair (first track in project
   * order wins — edit-time rules make this a safety net, not a workflow). */
  deduped: number;
  /** Wires dropped by the engine's 16-strip ceiling (first-come kept). */
  capped: number;
}

/**
 * PURE — the app-owned strip table derived from the project (single source
 * of truth). One wire per (instance, pair); strip ids are deterministic
 * (`s:<instanceId>:<pair0>`). Tracks whose pair is MISSING against the live
 * layout are withheld (never sent) — with their binding intact, so a wider
 * layout re-includes them automatically. Deterministic in track order.
 */
export function deriveStripWires(
  project: Project,
  layouts: Record<string, InstanceLayout>,
): DerivedStrips {
  const view = outputPairView(project, layouts);
  const wires: DerivedStrips["wires"] = [];
  const taken = new Set<string>();
  let skippedMissing = 0;
  let deduped = 0;
  for (const t of project.tracks) {
    const v = view[t.id];
    if (!v || v.instanceId === null || v.pair0 === null) continue;
    const layout = layouts[v.instanceId];
    if (layout && v.pair0 + 1 >= layout.channels) {
      skippedMissing++;
      continue;
    }
    const key = `${v.instanceId}:${v.pair0}`;
    if (taken.has(key)) {
      deduped++;
      continue;
    }
    taken.add(key);
    wires.push({ strip: `s:${v.instanceId}:${v.pair0}`, inst: v.instanceId, pair0: v.pair0 });
  }
  let capped = 0;
  if (wires.length > STRIP_LIMIT) {
    capped = wires.length - STRIP_LIMIT;
    wires.length = STRIP_LIMIT;
  }
  return { wires, skippedMissing, deduped, capped };
}

export interface InstanceCounters {
  /** Distinct MIDI channels in use by this instance's tracks (1–16). */
  channelsUsed: number;
  channelsMax: number;
  /** Distinct output pairs in use (explicit AND default-main alike). */
  outputsUsed: number;
  /** Selectable pairs against the live layout; null when unknown. */
  outputsMax: number | null;
}

// ─── Routing v1.1 — the track AUDIO state (the silence-semantics view) ──────
// The user's fallback rules, as a PURE derivation: a track is either OK or
// in one of four named silent states. NOTHING here ever routes a substitute
// sound — the header chips and the "N tracks still loading" counter render
// straight from this map, and the audio path is silent in exactly these
// states (buildEngineStream emits nothing for unbound tracks; loading/
// offline/missing instances are handled engine-side by the strip table's
// liveness gate and the missing-pair withhold).

export type TrackAudioState =
  | { kind: "ok" }
  /** No plugin bound: silence (or the built-in preview synth when the user
   * explicitly opts in). MIDI export is NEVER affected. */
  | { kind: "unbound" }
  /** The bound instance has no plugin_state receipt yet: spinner state. */
  | { kind: "loading"; pluginName: string }
  /** The engine named this instance as a hosting failure ("!" + name). */
  | { kind: "offline"; pluginName: string }
  /** The bound pair exceeds the live output layout (D16 — derived, never
   * stored; re-resolves by itself when the layout widens again). */
  | { kind: "missing"; pluginName: string; pair: string };

/**
 * PURE — the per-track audio state for the whole project (instrument tracks
 * only; structure/audio carry no notes and are absent from the map).
 *
 * `hostedIds` = instance ids the engine confirmed with plugin_state "loaded";
 * `erroredIds` = instance ids named by a plugin_state error receipt. Precedence
 * (most informative first): unbound → offline (a FAILED hosting is the truth,
 * not "loading") → loading (no receipt yet) → missing (hosted but the bound
 * pair is beyond the live layout) → ok.
 */
export function deriveTrackAudioStates(
  project: Project,
  layouts: Record<string, InstanceLayout>,
  hostedIds: ReadonlySet<string>,
  erroredIds: ReadonlySet<string>,
): Record<string, TrackAudioState> {
  const view = outputPairView(project, layouts);
  const out: Record<string, TrackAudioState> = {};
  for (const t of project.tracks) {
    if (t.role === "audio" || t.role === "structure" || t.family === "structure") continue;
    const v = view[t.id];
    if (!v || v.instanceId === null || v.channel === null) {
      out[t.id] = { kind: "unbound" };
      continue;
    }
    const name = instanceDisplayName(project.libraryGroups, v.instanceId);
    if (erroredIds.has(v.instanceId)) {
      out[t.id] = { kind: "offline", pluginName: name };
      continue;
    }
    if (!hostedIds.has(v.instanceId)) {
      out[t.id] = { kind: "loading", pluginName: name };
      continue;
    }
    if (v.missing) {
      out[t.id] = { kind: "missing", pluginName: name, pair: pairLabel(v.pair0 ?? 0) };
      continue;
    }
    out[t.id] = { kind: "ok" };
  }
  return out;
}

/**
 * PURE — the dual counter (D13): "channels 9/16 · outputs 5/8". Both
 * ceilings are real; outputs drain first on multi-bus plugins (Falcon's
 * 17 buses / 34 channels dwarf the 16-channel MIDI namespace).
 */
export function instanceCounters(
  project: Project,
  groupId: string,
  layouts: Record<string, InstanceLayout>,
): InstanceCounters {
  const { routing } = resolveInstanceRouting(project);
  const channels = new Set<number>();
  const pairs = new Set<number>();
  for (const t of project.tracks) {
    const r = routing[t.id];
    if (!r || r.inst !== groupId) continue;
    channels.add(r.ch);
    pairs.add(typeof t.engineOutputPair === "number" && t.engineOutputPair >= 0 ? t.engineOutputPair : 0);
  }
  const layout = layouts[groupId];
  return {
    channelsUsed: channels.size,
    channelsMax: 16,
    outputsUsed: pairs.size,
    outputsMax: layout ? derivePairs(layout).length : null,
  };
}

/** Normalized name for the auto-setup matcher: lowercase, alphanumeric only,
 * with STANDALONE roman-numeral tokens folded to digits ("Violins II" and
 * "Violins 2" normalize identically — the orchestral naming convention is
 * the matcher's bread and butter). Token-level only: "violas" never folds. */
function normalizeName(s: string): string {
  const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5" };
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((t) => ROMAN[t] ?? t)
    .join("");
}

export interface AutoSetupProposal {
  trackId: string;
  trackName: string;
  pair0: number;
  /** "name" = the plugin's own bus name matched the track's name;
   * "generic" = filled into a free pair in order. */
  basis: "name" | "generic";
}

export interface AutoSetupOutcome {
  proposals: AutoSetupProposal[];
  /** Candidates left on the default main pair (fewer free pairs than
   * candidate tracks — they keep sharing the main pair, visibly). */
  leftOnMain: number;
  /** Pairs skipped because a track is already explicitly bound there. */
  usedPairs: number;
}

/**
 * PURE — the "Assign roles to this plugin's outputs" proposal (D14) for ONE
 * instance. Output bindings ONLY (channels and in-plugin layers are never
 * touched — there is no standard way to automate a plugin's internal
 * mixer). Matching order: (1) normalized bus-name ↔ track-name match;
 * (2) remaining candidates fill free pairs ascending, the FIRST candidate
 * anchoring the main pair. Never proposes a pair another track already
 * binds explicitly. Nothing applies until the user confirms the list.
 */
export function autoSetupProposal(
  project: Project,
  groupId: string,
  layouts: Record<string, InstanceLayout>,
  busNames?: string[],
): AutoSetupOutcome {
  const layout = layouts[groupId];
  const pairs = derivePairs(layout, busNames);
  const { routing } = resolveInstanceRouting(project);
  // Tracks riding THIS instance, in project order.
  const tracks = project.tracks.filter((t) => {
    const r = routing[t.id];
    return r !== undefined && r.inst === groupId;
  });
  // Explicitly bound pairs are USED — never proposed, never moved (D8/D14).
  const used = new Set<number>();
  const candidates: Track[] = [];
  let usedPairs = 0;
  for (const t of tracks) {
    if (typeof t.engineOutputPair === "number" && t.engineOutputPair >= 0) {
      used.add(t.engineOutputPair);
      usedPairs++;
    } else {
      candidates.push(t);
    }
  }
  const free = pairs.filter((p) => !used.has(p.pair0));
  const proposals: AutoSetupProposal[] = [];
  const taken = new Set<number>();
  let leftOnMain = 0;

  // Pass 1 — normalized name matches (bus name ↔ track name; either
  // direction contains the other, so "Violins II" matches "Violins 2 L/R").
  const remaining: Track[] = [];
  for (const t of candidates) {
    const nt = normalizeName(t.name);
    const hit = free.find(
      (p) =>
        p.busName !== undefined &&
        !taken.has(p.pair0) &&
        (normalizeName(p.busName).includes(nt) || nt.includes(normalizeName(p.busName))),
    );
    if (nt.length > 0 && hit) {
      taken.add(hit.pair0);
      proposals.push({ trackId: t.id, trackName: t.name, pair0: hit.pair0, basis: "name" });
    } else {
      remaining.push(t);
    }
  }
  // Pass 2 — generic fill ascending; the first remaining candidate anchors
  // the main pair (it is the default anyway — a visible no-op for it).
  const freeSorted = free.filter((p) => !taken.has(p.pair0)).sort((a, b) => a.pair0 - b.pair0);
  for (let i = 0; i < remaining.length; ++i) {
    const t = remaining[i];
    const anchor = i === 0 ? freeSorted.find((p) => p.main) : undefined;
    const pick = anchor ?? freeSorted.find((p) => !taken.has(p.pair0) && !p.main) ??
      (i === 0 ? undefined : freeSorted.find((p) => !taken.has(p.pair0)));
    if (pick) {
      taken.add(pick.pair0);
      proposals.push({ trackId: t.id, trackName: t.name, pair0: pick.pair0, basis: "generic" });
    } else {
      leftOnMain++;
    }
  }
  return { proposals, leftOnMain, usedPairs };
}

/** D15 — shown wherever a binding changes while the transport rolls. */
export const REBIND_TAIL_NOTE =
  "Rebinding while playing takes effect immediately — the transport never stops. A ringing tail may finish on the old output or be cut as the strip rewires; that is the plugin releasing, not a bug.";

/** D13 — the channels-full state names the ceiling and the cheap fix. */
export function channelsFullAdvice(instanceName: string): string {
  return `${instanceName} is out of MIDI channels — 16/16. Add a second instance of the same plugin and split by section (strings on the first, brass/woodwinds on the second). Sample RAM only doubles if both instances load the same patch.`;
}

/** D13 — the outputs-full state (the counter that bites first). */
export function outputsFullAdvice(instanceName: string): string {
  return `${instanceName} has no free output pairs. Bind another instance's pairs, or split the sections across instances — each track keeps its own pair either way.`;
}
