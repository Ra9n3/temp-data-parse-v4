// Stage 3c — engine stream builder: the ONE pure, deterministic function that
// turns a Project into the engine load payload (events + channel map + plugin
// reference). This is the LIVE M9 profile path: tracks bound to a library
// group with an expression-map profile AND a scanned plugin (pluginId +
// pluginPath) render through the hosted VST3 (BBCSO standalone, multi-timbral
// one-instance architecture); their events come from vst3EventAdapter — the
// EXACT same semantic→physical translation the MIDI exporter uses, so the
// profile JSON (UACC CC#32 values, 20ms pre-trigger, cc74Scale 0.5) drives
// real sound through the same mapping truth source as export. Everything else
// (percussion/keys, unbound tracks) rides the engine's built-in test synth.
//
// Architecture decision (Stage 3c brief, authoritative): NOT one-instance-per-
// track. ONE hosted plugin; tracks are routed by MIDI CHANNEL (1–16) within
// that instance; per-track mute/solo is gated engine-side before any channel
// send (mix message). Channel assignment: explicit `track.engineChannel` wins;
// otherwise first-come by track order among plugin-routed STRING/WIND/BRASS
// tracks (keys/percussion need an explicit engine channel by design — they
// stay on the test synth unless the user deliberately routes them).
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

/** Families the BBCSO orchestra covers by default (Stage 3c-3 mapping). */
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
  /** Stage 3d-3 — the project JSON's embedded plugin state (base64,
   * LibraryGroup.pluginState). Restored by the engine after instantiate
   * (before the real-device prepare) so patches + mixer settings survive
   * app restarts. Omitted = plugin default state. */
  state?: string;
}

export interface EngineStream {
  events: PhysicalMidiStreamEvent[];
  /** trackId → engine channel (1–16), the plugin-routed tracks only. */
  channels: Record<string, number>;
  /** The ONE hosted plugin (null = test-synth-only load, legacy behavior). */
  plugin: EnginePluginRef | null;
}

/** The library group that routes this track into the hosted plugin, or null.
 * All three bindings must be present: profileId (mapping), pluginId (scan
 * identity), pluginPath (binary). A group with only profileId is the M9
 * export-only mapping — playback stays on the test synth. */
export function pluginGroupForTrack(
  track: Track,
  libraryGroups: LibraryGroup[],
): LibraryGroup | null {
  const group = libraryGroups.find((g) => g.id === track.libraryGroupId);
  if (!group) return null;
  if (!group.profileId || !group.pluginId || !group.pluginPath) return null;
  if (!builtInProfileById(group.profileId)) return null;
  return group;
}

/**
 * PURE — resolve engine channels for every plugin-routed track.
 * Explicit `track.engineChannel` (1–16) wins; then first-come by track order
 * over the remaining plugin-routed STRING/WIND/BRASS tracks, skipping channels
 * already taken. Keys/percussion are NOT auto-assigned (documented decision:
 * they stay on the test synth unless explicitly routed).
 */
export function resolveEngineChannels(project: Project): Record<string, number> {
  const channels: Record<string, number> = {};
  const taken = new Set<number>();
  const pending: Track[] = [];
  for (const t of project.tracks) {
    const group = pluginGroupForTrack(t, project.libraryGroups);
    if (!group) continue;
    const explicit = t.engineChannel;
    if (typeof explicit === "number" && explicit >= 1 && explicit <= 16) {
      channels[t.id] = explicit;
      taken.add(explicit);
    } else if (ENGINE_ELIGIBLE_FAMILIES.has(t.family)) {
      pending.push(t);
    }
  }
  for (const t of pending) {
    for (let ch = 1; ch <= 16; ++ch) {
      if (!taken.has(ch)) {
        channels[t.id] = ch;
        taken.add(ch);
        break;
      }
    }
    // No free channel → the track stays unrouted (test synth); documented.
  }
  return channels;
}

/**
 * PURE, DETERMINISTIC — Project → engine load payload.
 * Plugin-routed tracks: full M9 profile path (adapter events remapped to the
 * track's engine channel + trackId, plus a static CC7 fader at tick 0 from
 * the same acoustic-weight balance the exporter uses). All other instrument
 * tracks: notes-only events (test synth), tagged with trackId so the engine
 * can gate mute/solo per track. Sorted by tick with the established
 * NOTE_OFF-before-NOTE_ON tie-break (same comparator as notesToEngineEvents).
 */
export function buildEngineStream(project: Project): EngineStream {
  const channels = resolveEngineChannels(project);
  const events: PhysicalMidiStreamEvent[] = [];
  let plugin: EnginePluginRef | null = null;
  const endTick = projectEndTick(project);

  for (const t of project.tracks) {
    // Structure/chords/audio carry no instrument notes (same rule everywhere).
    if (t.role === "structure" || t.family === "structure" || t.family === "audio") continue;
    const channel = channels[t.id];
    const group = pluginGroupForTrack(t, project.libraryGroups);
    if (channel !== undefined && group) {
      const profile = builtInProfileById(group.profileId!)!;
      // THE M9 PROFILE PATH — identical mapping to the MIDI exporter.
      const trackEvents = vst3EventAdapter(t.notes, profile, project.bpm, { endTick });
      for (const ev of trackEvents) {
        events.push({ ...ev, channel, trackId: t.id });
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
      if (!plugin) {
        plugin = {
          uid: group.pluginId!,
          path: group.pluginPath!,
          name: group.name,
          ...(group.pluginState ? { state: group.pluginState } : {}),
        };
      }
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
  return { events, channels, plugin };
}
