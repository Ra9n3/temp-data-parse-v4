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

/**
 * PURE, DETERMINISTIC — Project → engine load payload.
 * Plugin-routed tracks: WITH a built-in profile → the full M9 profile path
 * (adapter events remapped to the track's channel + trackId, plus a static
 * CC7 fader at tick 0 from the same acoustic-weight balance the exporter
 * uses). WITHOUT a profile → the RAW-NOTES path (universal hosting): notes
 * only (keyswitches skipped — they are profile semantics), same CC7 fader.
 * All other tracks: notes-only events (test synth), tagged with trackId so
 * the engine can gate mute/solo per track. Sorted by tick with the
 * established NOTE_OFF-before-NOTE_ON tie-break.
 */
export function buildEngineStream(project: Project): EngineStream {
  const { routing, plugins } = resolveInstanceRouting(project);
  const events: PhysicalMidiStreamEvent[] = [];
  const endTick = projectEndTick(project);

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
    } else {
      // Test-synth path: notes only, tagged for per-track gating.
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
  }

  events.sort((a, b) => a.timestampTicks - b.timestampTicks ||
    (a.eventType === "NOTE_OFF" ? -1 : 1) - (b.eventType === "NOTE_OFF" ? -1 : 1));
  return { events, routing, plugins };
}
