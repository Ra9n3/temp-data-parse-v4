// Stage 3c → 3d-4 — engine stream builder: the ONE pure, deterministic
// function that turns a Project into the engine load payload (events +
// per-instance routing + the plugin instance set).
//
// Stage 3c (live M9 profile path): tracks bound to a library group WITH an
// expression-map profile render through the hosted VST3 via vst3EventAdapter
// — the EXACT same semantic→physical translation the MIDI exporter uses, so
// the profile JSON (UACC CC#32 values, 20ms pre-trigger, cc74Scale 0.5)
// drives real sound through the same mapping truth source as export.
//
// Stage 3d-4 (MULTI-INSTANCE — the universal-hosting completion): the old
// "ONE hosted plugin for the whole orchestra" model collapsed every
// plugin-bearing group into the FIRST one (a second library was silently
// never hosted — the user's "no sound from the VSTs other than BBCSO" +
// "every pill reopens the BBCSO editor" forensics). Now EACH plugin-bearing
// library group gets its OWN instance (instanceId = the group id — stable
// across reloads and the rebind key for editors/state), and its tracks ride
// that instance's 16-channel namespace. A multi-timbral library (BBCSO)
// keeps the channel-routing model inside its single instance; a
// single-patch library gets a dedicated instance whose patch state is its
// own. profileId is now OPTIONAL: a group with pluginId+pluginPath but no
// built-in expression map hosts as RAW NOTES (notes + static CC7 — no UACC
// translation, no keyswitch handling), which is what makes ANY well-behaved
// VST3 instrument assignable without shipping a map for it.
//
// Channel assignment (per instance namespace): explicit `track.engineChannel`
// (1–16) wins; otherwise first-come by track order. No family gate any more —
// the user's explicit plugin assignment IS the intent (documented 3d-4
// decision; the old keys/percussion exclusion belonged to the BBCSO-era
// single-instance model).
//
// NO RNG anywhere: same project ⇒ byte-identical events (suite-pinned).

import { acousticWeightForTrack, cc7ForWeight } from "../generation/balance";
import {
  builtInProfileById,
  vst3EventAdapter,
  type PhysicalMidiStreamEvent,
} from "../plugins/expressionMaps";
import { projectEndTick } from "../shared/schema/time";
import type { LibraryGroup, Project, Track } from "../shared/schema/types";

/** Families the BBCSO orchestra covered by default in the 3c model. Kept
 * exported for the suite's census asserts; routing no longer gates on it
 * (3d-4: any plugin-bound track routes — universal hosting). */
export const ENGINE_ELIGIBLE_FAMILIES: ReadonlySet<string> = new Set([
  "strings",
  "woodwinds",
  "brass",
]);

export interface EnginePluginRef {
  /** Scan uid (JUCE uniqueId string). */
  uid: string;
  /** On-disk .vst3 path from the engine scan. */
  path: string;
  /** Display name (from the scan; informational). */
  name?: string;
  /** Stage 3d-4 — the instance id (= the owning LibraryGroup id). Stable
   * across reloads; the address for openEditor and state capture/restore. */
  instanceId: string;
  /** Stage 3d-3 — the project JSON's embedded plugin state (base64,
   * LibraryGroup.pluginState). Restored by the engine after instantiate
   * (before the real-device prepare) so patches + mixer settings survive
   * app restarts. Omitted = plugin default state. */
  state?: string;
}

export interface EngineStream {
  events: PhysicalMidiStreamEvent[];
  /** trackId → {inst, ch} — the plugin-routed tracks only. ch is the track's
   * channel WITHIN its instance's 1–16 namespace (the engine widens it). */
  routing: Record<string, { inst: string; ch: number }>;
  /** The instance set: one entry per plugin-bearing library group, in
   * first-appearance order (deterministic). Empty = test-synth-only load. */
  plugins: EnginePluginRef[];
}

/** The library group that routes this track into a hosted instance, or null.
 * Stage 3d-4: pluginId + pluginPath are the hosting binding; profileId is
 * OPTIONAL (present = M9 profile path, absent = raw-notes path). A group
 * with neither is a plain (unhosted) label group. */
export function pluginGroupForTrack(
  track: Track,
  libraryGroups: LibraryGroup[],
): LibraryGroup | null {
  const group = libraryGroups.find((g) => g.id === track.libraryGroupId);
  if (!group) return null;
  if (!group.pluginId || !group.pluginPath) return null;
  return group;
}

/**
 * PURE — resolve the instance set + per-track routing for every
 * plugin-routed track. Instance id = the track's LibraryGroup id; channels
 * live in that instance's private 1–16 namespace: explicit
 * `track.engineChannel` wins (first track in order keeps it on a collision —
 * deterministic), otherwise first-come by track order.
 */
export function resolveInstanceRouting(project: Project): {
  routing: Record<string, { inst: string; ch: number }>;
  plugins: EnginePluginRef[];
} {
  const routing: Record<string, { inst: string; ch: number }> = {};
  const taken = new Map<string, Set<number>>();   // instanceId → taken channels
  const order: string[] = [];                      // instance first-appearance order
  const groupById = new Map<string, LibraryGroup>();
  const pending: Track[] = [];

  const instanceOf = (t: Track): string | null => {
    const group = pluginGroupForTrack(t, project.libraryGroups);
    if (!group) return null;
    if (!taken.has(group.id)) {
      taken.set(group.id, new Set());
      order.push(group.id);
      groupById.set(group.id, group);
    }
    return group.id;
  };

  // Pass 1 — explicit engineChannel assignments (1–16, per-instance scope).
  // Structure/chords/audio carry no instrument notes (same rule everywhere).
  for (const t of project.tracks) {
    if (t.role === "structure" || t.family === "structure" || t.family === "audio") continue;
    const inst = instanceOf(t);
    if (!inst) continue;
    const explicit = t.engineChannel;
    if (typeof explicit === "number" && explicit >= 1 && explicit <= 16) {
      const takenSet = taken.get(inst)!;
      if (!takenSet.has(explicit)) {
        routing[t.id] = { inst, ch: explicit };
        takenSet.add(explicit);
      }
      // A collision on an explicit channel → the later track falls through
      // to the auto pass (deterministic: track order decides).
      else pending.push(t);
    } else {
      pending.push(t);
    }
  }
  // Pass 2 — first-come auto-assignment by track order.
  for (const t of pending) {
    if (routing[t.id]) continue;
    const inst = instanceOf(t);
    if (!inst) continue;
    const takenSet = taken.get(inst)!;
    for (let ch = 1; ch <= 16; ++ch) {
      if (!takenSet.has(ch)) {
        routing[t.id] = { inst, ch };
        takenSet.add(ch);
        break;
      }
    }
    // No free channel in this instance's namespace → the track stays
    // unrouted (test synth); deterministic, receipt-visible.
  }

  // Instance set in first-appearance order (state rides its group embed).
  const plugins: EnginePluginRef[] = order.map((id) => {
    const g = groupById.get(id)!;
    return {
      instanceId: id,
      uid: g.pluginId!,
      path: g.pluginPath!,
      name: g.name,
      ...(g.pluginState ? { state: g.pluginState } : {}),
    };
  });
  return { routing, plugins };
}

/**
 * PURE — the TrackHeader channel-selector VIEW (3d-4): the track's channel
 * WITHIN its instance's 1–16 namespace (empty for test-synth tracks). The
 * selector remains per-track; the pill label names the owning instance.
 */
export function resolveEngineChannelView(project: Project): Record<string, number> {
  const { routing } = resolveInstanceRouting(project);
  const out: Record<string, number> = {};
  for (const [trackId, r] of Object.entries(routing)) out[trackId] = r.ch;
  return out;
}

// ─── Stage 3g — sharing one hosted instance between several tracks ──────────
// The engine's 3d-4 model ALREADY supports several tracks riding one library
// group (instanceId = the group id; each rider gets a channel in that
// instance's private 1–16 namespace). What 3g adds is the FRONTEND offer:
// the pick flow may REUSE an existing group instead of always creating one,
// plus the per-group channel bookkeeping (lowest free channel, dropdown
// filtering, unlink-without-teardown). All of it is PURE below the dialog.

/** One shareable existing group: the group plus the names of the tracks
 * currently using it (the dialog lists matches BY those names). */
export interface ShareCandidate {
  group: LibraryGroup;
  trackNames: string[];
}

/**
 * PURE — the existing groups that host the SAME plugin binary the user just
 * picked (pluginId AND pluginPath equal — the hosting identity), each with
 * ≥1 bound track (an orphan group hosts nothing; offering it would name no
 * tracks and gain nothing over creating a fresh instance). When `profileId`
 * is given (the onPickProfile path), only groups carrying the SAME profile
 * match — a profile pick must keep its export/hosting semantics, so a raw
 * same-binary group is NOT offered. First-appearance order (deterministic).
 */
export function shareCandidatesForPlugin(
  libraryGroups: LibraryGroup[],
  tracks: Track[],
  pluginId: string,
  pluginPath: string,
  profileId?: string,
): ShareCandidate[] {
  const out: ShareCandidate[] = [];
  for (const g of libraryGroups) {
    if (g.pluginId !== pluginId) continue;
    if (!g.pluginPath || g.pluginPath !== pluginPath) continue;
    if (profileId !== undefined && g.profileId !== profileId) continue;
    const trackNames = tracks.filter((t) => t.libraryGroupId === g.id).map((t) => t.name);
    if (trackNames.length === 0) continue;
    out.push({ group: g, trackNames });
  }
  return out;
}

/**
 * PURE — the lowest engine channel (1–16) of `groupId`'s namespace that NO
 * other track currently uses (explicit AND first-come auto both count — the
 * resolved routing is the truth). null = all 16 taken (the caller shows the
 * spec's "this instance has no free channel" and does nothing).
 */
export function lowestFreeEngineChannel(project: Project, groupId: string, excludeTrackId?: string): number | null {
  const { routing } = resolveInstanceRouting(project);
  const taken = new Set<number>();
  for (const [trackId, r] of Object.entries(routing)) {
    if (r.inst === groupId && trackId !== excludeTrackId) taken.add(r.ch);
  }
  for (let ch = 1; ch <= 16; ++ch) if (!taken.has(ch)) return ch;
  return null;
}

/**
 * PURE — the Share commit: point `trackId` at `groupId` and give it an
 * EXPLICIT engineChannel = the lowest channel no other track of that group
 * uses (spec step 2). Returns null (and changes nothing) when the group is
 * not a hosting group or all 16 of its channels are taken. The track's
 * previous engineChannel belonged to its previous group's namespace and is
 * overwritten — it has no meaning in the new namespace.
 */
export function applyTrackShare(
  project: Project,
  trackId: string,
  groupId: string,
): { project: Project; channel: number } | null {
  const track = project.tracks.find((t) => t.id === trackId);
  const group = project.libraryGroups.find((g) => g.id === groupId);
  if (!track || !group || !group.pluginId || !group.pluginPath) return null;
  const channel = lowestFreeEngineChannel(project, groupId, trackId);
  if (channel === null) return null;
  return {
    project: {
      ...project,
      tracks: project.tracks.map((t) =>
        t.id === trackId ? { ...t, libraryGroupId: groupId, engineChannel: channel } : t,
      ),
    },
    channel,
  };
}

/**
 * PURE — the shared-group unlink (spec step 4): ONLY this track detaches
 * (libraryGroupId + engineChannel cleared — the channel belonged to the
 * shared namespace); the group and every other rider keep their binding and
 * hosting. The caller decides group teardown (only when NO other track
 * remains) and the engine update.
 */
export function applyTrackUnlink(project: Project, trackId: string): Project {
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      t.id === trackId ? { ...t, libraryGroupId: null, engineChannel: undefined } : t,
    ),
  };
}

/**
 * PURE — the TrackHeader channel-dropdown filter data (spec step 6): for
 * every track that rides a group, the channels used by the group's OTHER
 * tracks (resolved routing — explicit and auto alike). The dropdown must
 * offer only the free channels plus the track's own (never in this set by
 * construction). Tracks without a group (or with no siblings) are absent.
 */
export function takenEngineChannelsByTrack(project: Project): Record<string, number[]> {
  const { routing } = resolveInstanceRouting(project);
  const byGroup = new Map<string, Set<number>>();
  for (const r of Object.values(routing)) {
    let s = byGroup.get(r.inst);
    if (!s) { s = new Set(); byGroup.set(r.inst, s); }
    s.add(r.ch);
  }
  const out: Record<string, number[]> = {};
  for (const t of project.tracks) {
    const s = t.libraryGroupId ? byGroup.get(t.libraryGroupId) : undefined;
    if (!s) continue;
    const mine = routing[t.id]?.ch;
    const others = [...s].filter((ch) => ch !== mine).sort((a, b) => a - b);
    if (others.length > 0) out[t.id] = others;
  }
  return out;
}

/**
 * PURE, DETERMINISTIC — Project → engine load payload.
 * Plugin-routed tracks: WITH a built-in profile → the full M9 profile path
 * (adapter events remapped to the track's channel + trackId, plus a static
 * CC7 fader at tick 0 from the same acoustic-weight balance the exporter
 * uses). WITHOUT a profile → the RAW-NOTES path (universal hosting): notes
 * only (keyswitches skipped — they are profile semantics), same CC7 fader.
 *
 * Silence semantics (Routing v1.1 — the user's fallback rules): tracks
 * WITHOUT a hosted plugin are SILENT by default — the built-in test synth
 * is never an automatic substitute. `builtinPreview: true` (the explicit
 * "Preview with built-in sounds" opt-in, default OFF) restores the legacy
 * notes-only test-synth events (tagged with trackId for engine-side
 * mute/solo gating). MIDI export never touches this builder and is never
 * affected either way. Sorted by tick with the established
 * NOTE_OFF-before-NOTE_ON tie-break.
 */
export function buildEngineStream(project: Project, opts?: { builtinPreview?: boolean }): EngineStream {
  const { routing, plugins } = resolveInstanceRouting(project);
  const events: PhysicalMidiStreamEvent[] = [];
  const endTick = projectEndTick(project);
  const builtinPreview = opts?.builtinPreview === true;

  for (const t of project.tracks) {
    // Structure/chords/audio carry no instrument notes (same rule everywhere).
    if (t.role === "structure" || t.family === "structure" || t.family === "audio") continue;
    const route = routing[t.id];
    const group = pluginGroupForTrack(t, project.libraryGroups);
    if (route && group) {
      const channel = route.ch;
      const profile = group.profileId ? builtInProfileById(group.profileId) : null;
      if (profile) {
        // THE M9 PROFILE PATH — identical mapping to the MIDI exporter.
        const trackEvents = vst3EventAdapter(t.notes, profile, project.bpm, { endTick });
        for (const ev of trackEvents) {
          events.push({ ...ev, channel, trackId: t.id });
        }
      } else {
        // RAW-NOTES PATH (3d-4 universal hosting): no UACC translation, no
        // keyswitch handling — the plugin receives plain notes on the
        // track's channel and the user picks its patch in its own editor.
        for (const note of t.notes) {
          if (note.isKeySwitch) continue;
          if (note.durationTicks <= 0) continue;
          events.push({
            eventType: "NOTE_ON",
            channel,
            data1: note.pitch,
            data2: note.velocity,
            timestampTicks: note.startTick,
            trackId: t.id,
          });
          events.push({
            eventType: "NOTE_OFF",
            channel,
            data1: note.pitch,
            data2: 0,
            timestampTicks: note.startTick + note.durationTicks,
            trackId: t.id,
          });
        }
      }
      // Static CC7 fader (the exporter sends the same value via cc7ForWeight).
      events.push({
        eventType: "CONTROL_CHANGE",
        channel,
        data1: 7,
        data2: cc7ForWeight(acousticWeightForTrack(t)),
        timestampTicks: 0,
        trackId: t.id,
      });
    } else if (builtinPreview) {
      // Built-in preview (EXPLICIT opt-in, Routing v1.1): the legacy test-synth
      // path — notes only, tagged for per-track gating. Default is silence:
      // the built-in synth is never an automatic substitute for a plugin.
      for (const note of t.notes) {
        if (note.isKeySwitch) continue;
        if (note.durationTicks <= 0) continue;
        events.push({
          eventType: "NOTE_ON",
          channel: t.midiChannel ?? 1,
          data1: note.pitch,
          data2: note.velocity,
          timestampTicks: note.startTick,
          trackId: t.id,
        });
        events.push({
          eventType: "NOTE_OFF",
          channel: t.midiChannel ?? 1,
          data1: note.pitch,
          data2: 0,
          timestampTicks: note.startTick + note.durationTicks,
          trackId: t.id,
        });
      }
    }
    // else: unbound + preview off → SILENCE (the fallback rules: no plugin,
    // no loading substitute, no sound — MIDI export is a separate path).
  }

  events.sort((a, b) => a.timestampTicks - b.timestampTicks ||
    (a.eventType === "NOTE_OFF" ? -1 : 1) - (b.eventType === "NOTE_OFF" ? -1 : 1));
  return { events, routing, plugins };
}
