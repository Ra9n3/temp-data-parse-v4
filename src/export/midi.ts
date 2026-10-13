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

function isInstrument(track: Track): boolean {
  return track.family !== "structure" && track.family !== "audio";
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
    tempos: [{ ticks: 0, bpm: project.bpm }],
    timeSignatures: [
      {
        ticks: 0,
        timeSignature: [project.timeSignature.numerator, project.timeSignature.denominator],
      },
    ],
    keySignatures: ks ? [{ ticks: 0, key: ks.key, scale: ks.scale }] : [],
  });
}

function writeInstrumentTrack(midi: MidiInstance, track: Track, endTick: number, channel: number, libraryGroups: Project["libraryGroups"] = [], bpm = 120): void {
  const expression = track.expressionMapping;
  const mt = midi.addTrack();
  mt.name = track.name;
  mt.channel = channel; // 0–15
  mt.endOfTrackTicks = endTick;
  // CC#7 is a static master fader by acoustic carrying power, deliberately separate
  // from per-note expressionMapping so custom CC assignments remain untouched.
  mt.addCC({ number: 7, value: cc7ForWeight(acousticWeightForTrack(track)) / 127, ticks: 0 });
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
    mt.addCC({ number: expression?.sustainCC ?? 64, value: 1, ticks: start });
    mt.addCC({ number: expression?.sustainCC ?? 64, value: 0, ticks: start + clipped });
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
  tracks.forEach((t, i) => writeInstrumentTrack(midi, t, endTick, i % 16, project.libraryGroups, project.bpm));
  return midi.toArray();
}

export function exportPerTrackMidi(
  project: Project,
  mode: ExportTrackMode = "all",
  selectedIds: string[] = [],
): { filename: string; data: Uint8Array }[] {
  const endTick = projectEndTick(project);
  const tracks = selectedTracks(project, mode, selectedIds);
  return tracks.map((t, i) => {
    const midi = new Midi();
    applyHeader(midi, project, endTick);
    writeInstrumentTrack(midi, t, endTick, 0, project.libraryGroups, project.bpm);
    const idx = String(i + 1).padStart(2, "0");
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
