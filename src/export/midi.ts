import * as MidiModule from "@tonejs/midi";
import type { Midi as MidiInstance } from "@tonejs/midi";

// @tonejs/midi ships CommonJS without an ESM namespace bridge in Node, while
// bundlers expose the named class; support both so browser export and Node checks agree.
const Midi = ((MidiModule as unknown as { Midi?: typeof MidiInstance; default?: { Midi?: typeof MidiInstance } }).Midi
  ?? (MidiModule as unknown as { default?: { Midi?: typeof MidiInstance } }).default?.Midi)!;
import { PITCH_CLASS_NAMES, type ModeName, type Project, type Track } from "../shared/schema/types";
import { barToTick, msToTicks, projectEndTick } from "../shared/schema/time";
import { CC74_OFFSETS } from "../generation/articulation";
import { acousticWeightForTrack, cc7ForWeight } from "../generation/balance";
import { builtInProfileById, vst3EventAdapter, type PhysicalMidiStreamEvent } from "../plugins/expressionMaps";
import { buildConductorTempoEvents } from "../generation/humanizeV2";
import { keyboardPedalAutomation, PAN_CENTERED_ROLES, type PedalCcEvent } from "../generation/rhythm";

function isInstrument(track: Track): boolean {
  return track.family !== "structure" && track.family !== "audio";
}

/** Module 9 decision #1 — track → group → profileId. Group has BOTH profileId
 * and legacy keySwitchMap ⇒ profileId wins (warn once, deterministic). Groups
 * with only keySwitchMap keep the byte-identical legacy path below. */
function profileForTrack(track: Track, libraryGroups: Project["libraryGroups"]): string | null {
  const group = libraryGroups.find((g) => g.id === track.libraryGroupId);
  if (!group?.profileId) return null;
  if (group.keySwitchMap) console.warn(`[scorch] profile overrides legacy keySwitchMap`, group.id);
  if (!builtInProfileById(group.profileId)) {
    console.warn(`[scorch] libraryGroup profile "${group.profileId}" not found — falling back to legacy writer`, group.id);
    return null;
  }
  return group.profileId;
}

interface PhysicalWriterOptions {
  trackName: string;
  endTick: number;
  /** 0–1 normalized CC#7 written at tick 0 on EVERY emitted channel-track. */
  cc7Value: number;
}

/** Module 9 reconciliation #9 — write a physical event stream via @tonejs.
 * One track's physical events split into one tonejs track per USED channel
 * (named "trackName · ch n" when more than one); a single-channel profile
 * keeps the plain legacy track name. Note pairs are matched FIFO per pitch.
 * Returns the number of tonejs tracks created so the merged exporter can
 * advance its channel index correctly. */
function physicalToTonejs(midi: MidiInstance, events: PhysicalMidiStreamEvent[], opts: PhysicalWriterOptions): number {
  const byChannel = new Map<number, PhysicalMidiStreamEvent[]>();
  for (const event of events) {
    const list = byChannel.get(event.channel);
    if (list) list.push(event);
    else byChannel.set(event.channel, [event]);
  }
  const used = [...byChannel.keys()].sort((a, b) => a - b);
  for (const channel of used) {
    const mt = midi.addTrack();
    mt.name = used.length > 1 ? `${opts.trackName} · ch ${channel}` : opts.trackName;
    mt.channel = channel - 1; // @tonejs uses 0–15
    mt.endOfTrackTicks = opts.endTick;
    // CC#7 at tick 0 (acoustic balance) applies to BOTH export paths (#1).
    mt.addCC({ number: 7, value: opts.cc7Value, ticks: 0 });
    const openOns = new Map<number, Array<{ tick: number; velocity: number }>>(); // pitch → ordered note-ons
    for (const event of byChannel.get(channel)!) {
      const ticks = Math.max(0, event.timestampTicks);
      if (event.eventType === "NOTE_ON") {
        const stack = openOns.get(event.data1);
        if (stack) stack.push({ tick: ticks, velocity: event.data2 });
        else openOns.set(event.data1, [{ tick: ticks, velocity: event.data2 }]);
      } else if (event.eventType === "NOTE_OFF") {
        const stack = openOns.get(event.data1);
        const on = stack?.shift();
        if (on !== undefined) {
          // Velocity comes from the NOTE_ON (the adapter sends NOTE_OFF with data2 = 0).
          mt.addNote({ midi: event.data1, ticks: on.tick, durationTicks: Math.max(1, Math.round(ticks - on.tick)), velocity: Math.max(0, Math.min(127, on.velocity || 64)) / 127 });
          if (stack && stack.length === 0) openOns.delete(event.data1);
        }
        // An unmatched NOTE_OFF (defensive; the adapter always pairs) is dropped.
      } else if (event.eventType === "CONTROL_CHANGE") {
        mt.addCC({ number: event.data1, value: Math.max(0, Math.min(127, event.data2)) / 127, ticks });
      } else if (event.eventType === "PITCH_BEND") {
        mt.addPitchBend({ value: (Math.max(0, Math.min(127, event.data2)) - 64) / 64, ticks });
      } else if (event.eventType === "PROGRAM_CHANGE") {
        // Reconciliation #8 — feature-detect @tonejs/midi program-change support.
        const writeProgram = (mt as unknown as { addProgramChange?: (args: { value: number; ticks: number }) => unknown }).addProgramChange;
        if (typeof writeProgram === "function") {
          writeProgram.call(mt, { value: event.data1, ticks });
        } else {
          console.warn("[scorch] program change not renderable by @tonejs/midi; consumed by adapter stream only");
        }
      }
    }
    // Close any still-open note at the end of track (pairing safety net).
    for (const [pitch, stack] of openOns) {
      for (const on of stack) {
        mt.addNote({ midi: pitch, ticks: on.tick, durationTicks: Math.max(1, opts.endTick - on.tick), velocity: 0.5 });
      }
    }
  }
  return used.length;
}

function relativeMajorPc(key: number, mode: ModeName): number {
  const offset: Record<ModeName, number> = {
    ionian: 0,
    dorian: 10,
    phrygian: 8,
    lydian: 7,
    mixolydian: 5,
    aeolian: 3,
    locrian: 1,
    "harmonic-minor": 3,
    "melodic-minor": 3,
    "whole-tone": 0,
    "diminished-half-whole": 0,
    "diminished-whole-half": 0,
  };
  return (key + offset[mode]) % 12;
}

/**
 * Key signature for the header meta. Whole-tone and the two diminished modes are
 * symmetric/octatonic and have no meaningful major/minor relative key, so they
 * emit no key signature (returns null).
 */
function keySignatureFor(project: Project): { key: string; scale: string } | null {
  if (
    project.mode === "whole-tone" ||
    project.mode === "diminished-half-whole" ||
    project.mode === "diminished-whole-half"
  ) {
    return null;
  }
  const minorThird =
    project.mode === "aeolian" ||
    project.mode === "dorian" ||
    project.mode === "phrygian" ||
    project.mode === "locrian" ||
    project.mode === "harmonic-minor" ||
    project.mode === "melodic-minor";
  if (minorThird) {
    return { key: PITCH_CLASS_NAMES[project.key], scale: "minor" };
  }
  const maj = relativeMajorPc(project.key, project.mode);
  return { key: PITCH_CLASS_NAMES[maj], scale: "major" };
}

function selectedTracks(project: Project, mode: ExportTrackMode, selectedIds: string[]): Track[] {
  const inst = project.tracks.filter(isInstrument);
  if (mode === "selected") return inst.filter((t) => selectedIds.includes(t.id));
  if (mode === "unlocked") return inst.filter((t) => !t.locked);
  return inst;
}

export type ExportTrackMode = "all" | "selected" | "unlocked";

/** Module 10 conductor map — when the computed tempo events are non-empty the
 * header writes ALL of them (ramps at section boundaries, rubato-scaled);
 * otherwise the pre-M10 single-tempo header is byte-identical. The map is a
 * pure computed function — NOT persisted on the project (patch/persistence
 * untouched). */
function conductorTempos(project: Project): Array<{ ticks: number; bpm: number }> {
  const events = buildConductorTempoEvents(project);
  if (events.length === 0) return [{ ticks: 0, bpm: project.bpm }];
  // Baseline at tick 0 is required — without it a DAW would fall back to its
  // default 120 BPM for everything before the first boundary ramp. The carried
  // level after the last ramp persists to the end (consistent with the map).
  return [{ ticks: 0, bpm: project.bpm }, ...events.map((event) => ({ ticks: event.tick, bpm: event.bpm }))];
}

function applyHeader(midi: MidiInstance, project: Project, endTick: number): void {
  const ks = keySignatureFor(project);
  midi.header.fromJSON({
    name: project.name,
    ppq: 960,
    meta: [
      ...project.sections.map((s) => ({
        type: "marker",
        text: s.name,
        ticks: barToTick(s.startBar, project.timeSignature),
      })),
      { type: "marker", text: "End", ticks: endTick },
    ],
    tempos: conductorTempos(project),
    timeSignatures: [
      {
        ticks: 0,
        timeSignature: [project.timeSignature.numerator, project.timeSignature.denominator],
      },
    ],
    keySignatures: ks ? [{ ticks: 0, key: ks.key, scale: ks.scale }] : [],
  });
}

function writeInstrumentTrack(midi: MidiInstance, track: Track, endTick: number, channel: number, libraryGroups: Project["libraryGroups"] = [], bpm = 120, pedalEvents?: PedalCcEvent[]): void {
  const expression = track.expressionMapping;
  const mt = midi.addTrack();
  mt.name = track.name;
  mt.channel = channel; // 0–15
  mt.endOfTrackTicks = endTick;
  // CC#7 is a static master fader by acoustic carrying power, deliberately separate
  // from per-note expressionMapping so custom CC assignments remain untouched.
  mt.addCC({ number: 7, value: cc7ForWeight(acousticWeightForTrack(track)) / 127, ticks: 0 });
  // Module 13 decision 4 — pan centering (sub-150 Hz rule): bass-carrying
  // tracks get CC10 = 64 at tick 0. No other pan automation (section stereo
  // spread is native-era mixing). Deterministic, one event, tick 0.
  if (PAN_CENTERED_ROLES.has(track.role ?? "")) mt.addCC({ number: 10, value: 64 / 127, ticks: 0 });
  // Module 13 decision 3 — keyboard pedal catch on KEYS-family tracks only:
  // chord-boundary CC64 streams (127 at start, 0 at the next start, 127 again
  // +10 ms — "the catch"), replacing per-note sustain THERE. Non-keys tracks
  // keep the M4 legacy per-note path byte-identically (pinned). When no pedal
  // data exists (no chords) the legacy path stays in charge.
  const usePedalCatch = track.family === "keys" && (pedalEvents?.length ?? 0) > 0;
  for (const event of usePedalCatch ? pedalEvents! : []) {
    mt.addCC({ number: event.cc, value: event.value / 127, ticks: Math.max(0, event.tick) });
  }
  const group = libraryGroups.find((g) => g.id === track.libraryGroupId);
  const keySwitchMap = group?.keySwitchMap;
  const preTriggerMs = group?.preTriggerDelayMs ?? 15;
  const emittedKeySwitches = new Set<string>();
  for (const n of track.notes) {
    if (n.durationTicks <= 0) continue;
    const start = Math.max(0, n.startTick);
    const dur = Math.max(1, n.durationTicks);
    if (start >= endTick) continue;
    const clipped = Math.min(dur, endTick - start);
    if (clipped <= 0) continue;
    if (n.isKeySwitch) continue; // never stored here, but defensively skip
    const normalizedVelocity = Math.max(0, Math.min(127, n.velocity)) / 127;
    mt.addCC({ number: expression?.dynamicCC ?? 1, value: normalizedVelocity, ticks: start });
    mt.addCC({ number: expression?.expressionCC ?? 11, value: (n.dynamics?.cc11Value ?? n.velocity) / 127, ticks: start });
    if (n.technique && keySwitchMap?.[n.technique] !== undefined) {
      const ksNote = keySwitchMap[n.technique]!;
      const ksKey = `${Math.round(start)}:${n.technique}`;
      if (!emittedKeySwitches.has(ksKey)) {
        emittedKeySwitches.add(ksKey);
        // VST3-forward seam: MIDI files have no negative time, so the pre-trigger clamps
        // to 0 at file start. The native JUCE engine honors true negative offsets
        // against its transport scheduling instead of clamping here.
        const ksStart = Math.max(0, start - Math.round(msToTicks(preTriggerMs, bpm)));
        mt.addNote({ midi: ksNote, ticks: ksStart, durationTicks: Math.round(msToTicks(60, bpm)), velocity: 0.5 });
      }
    }
    const cc74Value = (n.dynamics?.cc74Value ?? Math.max(0, Math.min(127, Math.round(64 + (n.technique ? CC74_OFFSETS[n.technique as keyof typeof CC74_OFFSETS] ?? 0 : 0) + (n.cc74Offset ?? 0))))) / 127;
    mt.addCC({ number: expression?.brightnessCC ?? 74, value: cc74Value, ticks: start });
    if (n.pitchBendPoints?.length) {
      for (const point of n.pitchBendPoints) {
        const bend = Math.max(-1, Math.min(1, point.cents / 200));
        mt.addPitchBend({ value: bend, ticks: Math.min(Math.max(0, point.tick), start + clipped) });
      }
      mt.addPitchBend({ value: 0, ticks: start + clipped }); // reset after the ramp
    } else if (n.detuneCents) {
      const bend = Math.max(-1, Math.min(1, n.detuneCents / 200));
      mt.addPitchBend({ value: bend, ticks: start });
      mt.addPitchBend({ value: 0, ticks: start + clipped });
    }
    if (!usePedalCatch) {
      mt.addCC({ number: expression?.sustainCC ?? 64, value: 1, ticks: start });
      mt.addCC({ number: expression?.sustainCC ?? 64, value: 0, ticks: start + clipped });
    }
    mt.addNote({
      midi: n.pitch,
      ticks: start,
      durationTicks: clipped,
      velocity: n.velocity / 127,
    });
  }
  // All-notes-off at the project end so every file shares the same length.
  mt.addCC({ number: 123, value: 0, ticks: endTick });
}

export function exportMergedMidi(
  project: Project,
  mode: ExportTrackMode = "all",
  selectedIds: string[] = [],
): Uint8Array {
  const midi = new Midi();
  const endTick = projectEndTick(project);
  applyHeader(midi, project, endTick);
  const tracks = selectedTracks(project, mode, selectedIds);
  // Module 9: profile tracks emit one-or-more tonejs tracks (channel split), so
  // the legacy channel index advances per emitted tonejs track, not per input.
  let nextChannel = 0;
  for (const t of tracks) {
    const profileId = profileForTrack(t, project.libraryGroups);
    if (profileId) {
      const profile = builtInProfileById(profileId)!;
      const events = vst3EventAdapter(t.notes, profile, project.bpm, { endTick });
      nextChannel += physicalToTonejs(midi, events, { trackName: t.name, endTick, cc7Value: cc7ForWeight(acousticWeightForTrack(t)) / 127 });
    } else {
      writeInstrumentTrack(midi, t, endTick, nextChannel % 16, project.libraryGroups, project.bpm, pedalEventsFor(t, project, endTick));
      nextChannel += 1;
    }
  }
  return midi.toArray();
}

/** Module 13 decision 3 — keys-family pedal data (from project.chords + the
 * track's own sustainCC constant); keys tracks without chords keep legacy. */
function pedalEventsFor(track: Track, project: Project, endTick: number): PedalCcEvent[] | undefined {
  if (track.family !== "keys") return undefined;
  return keyboardPedalAutomation(project.chords, project.bpm, endTick, track.expressionMapping?.sustainCC ?? 64);
}

export function exportPerTrackMidi(
  project: Project,
  mode: ExportTrackMode = "all",
  selectedIds: string[] = [],
): { filename: string; data: Uint8Array }[] {
  const endTick = projectEndTick(project);
  const tracks = selectedTracks(project, mode, selectedIds);
  let nextChannel = 0;
  return tracks.map((t) => {
    const midi = new Midi();
    applyHeader(midi, project, endTick);
    const profileId = profileForTrack(t, project.libraryGroups);
    if (profileId) {
      const profile = builtInProfileById(profileId)!;
      const events = vst3EventAdapter(t.notes, profile, project.bpm, { endTick });
      physicalToTonejs(midi, events, { trackName: t.name, endTick, cc7Value: cc7ForWeight(acousticWeightForTrack(t)) / 127 });
    } else {
      writeInstrumentTrack(midi, t, endTick, 0, project.libraryGroups, project.bpm, pedalEventsFor(t, project, endTick));
    }
    const idx = String(nextChannel + 1).padStart(2, "0");
    nextChannel += 1;
    const safe = t.name.replace(/[\\/:*?"<>|]/g, "_");
    return { filename: `${idx} ${safe}.mid`, data: midi.toArray() };
  });
}

export function parseMidiNotes(data: Uint8Array): {
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
  trackName: string;
}[] {
  const midi = new Midi(data);
  const out: {
    pitch: number;
    startTick: number;
    durationTicks: number;
    velocity: number;
    trackName: string;
  }[] = [];
  for (const t of midi.tracks) {
    for (const n of t.notes) {
      out.push({
        pitch: n.midi,
        startTick: n.ticks,
        durationTicks: n.durationTicks,
        velocity: Math.max(1, Math.min(127, Math.round(n.velocity * 127))),
        trackName: t.name,
      });
    }
  }
  return out;
}

export function midiDurationTicks(data: Uint8Array): number {
  const midi = new Midi(data);
  // @tonejs/midi's durationTicks only accounts for note-ends; include the
  // end-of-track marker so files that end with an all-notes-off/end meta report
  // their true length.
  const eot = midi.tracks.reduce((m, t) => Math.max(m, t.endOfTrackTicks ?? 0), 0);
  return Math.max(midi.durationTicks, eot);
}
