import { PPQ, type Chord, type Note, type Project, type TimeSignature } from "./types";

export function ticksPerBeat(ts: TimeSignature): number {
  return (PPQ * 4) / ts.denominator;
}

export function ticksPerBar(ts: TimeSignature): number {
  return ts.numerator * ticksPerBeat(ts);
}

export function barToTick(bar: number, ts: TimeSignature): number {
  return (bar - 1) * ticksPerBar(ts);
}

export function tickToBar(tick: number, ts: TimeSignature): number {
  return Math.floor(tick / ticksPerBar(ts)) + 1;
}

export function tickToBarBeat(
  tick: number,
  ts: TimeSignature,
): { bar: number; beat: number; tickInBeat: number } {
  const tpb = ticksPerBeat(ts);
  const tpBar = ticksPerBar(ts);
  const bar = Math.floor(tick / tpBar) + 1;
  const inBar = tick - (bar - 1) * tpBar;
  const beat = Math.floor(inBar / tpb) + 1;
  const tickInBeat = Math.round(inBar - (beat - 1) * tpb);
  return { bar, beat, tickInBeat };
}

export function ticksToSeconds(ticks: number, bpm: number): number {
  return (ticks / PPQ) * (60 / bpm);
}

export function secondsToTicks(seconds: number, bpm: number): number {
  return (seconds / 60) * bpm * PPQ;
}

/** 15ms expressed in ticks at a given BPM (used by humanize). */
export function msToTicks(ms: number, bpm: number): number {
  return (ms / 60000) * bpm * PPQ;
}

/** Module 10 conductor-map tempo helpers (pure; constant map ⇒ numerically
 * identical to the existing constant-BPM formulas). A point is { tick, bpm };
 * bpm at t = last point with point.tick ≤ t, else fallbackBpm. */
export interface TempoMapPoint {
  tick: number;
  bpm: number;
}

function sortedPoints(points: TempoMapPoint[]): TempoMapPoint[] {
  return [...points].sort((a, b) => a.tick - b.tick);
}

export function tempoAtTick(points: TempoMapPoint[], tick: number, fallbackBpm: number): number {
  let bpm = fallbackBpm;
  for (const point of sortedPoints(points)) {
    if (point.tick <= tick) bpm = point.bpm;
    else break;
  }
  return bpm;
}

/** Piecewise seconds between two ticks along a tempo map (constant map ⇒ the
 * exact existing ticksToSeconds difference — verified in m10-check). */
export function ticksToSecondsAlongMap(fromTick: number, toTick: number, points: TempoMapPoint[], fallbackBpm: number): number {
  if (fromTick === toTick) return 0;
  const low = Math.min(fromTick, toTick);
  const high = Math.max(fromTick, toTick);
  const sorted = sortedPoints(points);
  let seconds = 0;
  let cursor = low;
  let bpm = fallbackBpm;
  for (const point of sorted) {
    if (point.tick <= cursor) {
      bpm = point.bpm; // in effect at or before the query point
      continue;
    }
    if (point.tick >= high) break;
    seconds += ((point.tick - cursor) / PPQ) * (60 / bpm);
    cursor = point.tick;
    bpm = point.bpm;
  }
  seconds += ((high - cursor) / PPQ) * (60 / bpm);
  return fromTick <= toTick ? seconds : -seconds;
}

/** Inverse conversion: ticks advanced from startTick after `seconds` along the
 * tempo map (constant map ⇒ secondsToTicks). Linear walk is fine — maps are tiny. */
export function secondsToTicksAlongMap(startTick: number, seconds: number, points: TempoMapPoint[], fallbackBpm: number): number {
  const sorted = sortedPoints(points);
  let cursor = Math.max(0, startTick);
  let bpm = tempoAtTick(sorted, cursor, fallbackBpm);
  let remaining = seconds;
  for (const point of sorted) {
    if (point.tick <= cursor) continue;
    const segSeconds = ((point.tick - cursor) / PPQ) * (60 / bpm);
    if (remaining < segSeconds) break;
    remaining -= segSeconds;
    cursor = point.tick;
    bpm = point.bpm;
  }
  return cursor + (remaining / 60) * bpm * PPQ;
}

export function projectEndTick(project: Project): number {
  const tpBar = ticksPerBar(project.timeSignature);
  let end = 0;
  for (const section of project.sections) {
    end = Math.max(end, barToTick(section.startBar + section.lengthBars, project.timeSignature));
  }
  for (const chord of project.chords) {
    end = Math.max(end, chord.startTick + chord.durationTicks);
  }
  for (const track of project.tracks) {
    for (const note of track.notes) {
      end = Math.max(end, note.startTick + note.durationTicks);
    }
  }
  if (end <= 0) end = 16 * tpBar;
  // Snap up to a whole bar so the grid has a clean right edge.
  const bars = Math.max(1, Math.ceil(end / tpBar));
  return bars * tpBar;
}

export type Accent = "strong" | "medium" | "weak";

export function beatAccent(beatIndex0: number, ts: TimeSignature): Accent {
  const n = ts.numerator;
  const d = ts.denominator;
  if (beatIndex0 === 0) return "strong";
  if (d === 8 && n % 3 === 0) {
    // 6/8, 9/8, 12/8 — compound, accents every 3 eighths.
    return beatIndex0 % 3 === 0 ? "medium" : "weak";
  }
  if (n === 4) return beatIndex0 === 2 ? "medium" : "weak";
  if (n === 5) return beatIndex0 === 2 || beatIndex0 === 3 ? "medium" : "weak";
  if (n === 3) return "weak";
  if (n === 2) return "weak";
  return beatIndex0 % 2 === 0 ? "medium" : "weak";
}

export function accentAtTick(tick: number, ts: TimeSignature): Accent {
  const tpb = ticksPerBeat(ts);
  const tpBar = ticksPerBar(ts);
  const inBar = ((tick % tpBar) + tpBar) % tpBar;
  const beat = Math.floor(inBar / tpb);
  return beatAccent(beat, ts);
}

export function formatTimecode(tick: number, ts: TimeSignature): string {
  const { bar, beat, tickInBeat } = tickToBarBeat(tick, ts);
  return `${String(bar).padStart(3, "0")}.${beat}.${String(tickInBeat).padStart(3, "0")}`;
}

export function snapTick(tick: number, gridTicks: number): number {
  if (gridTicks <= 0) return Math.max(0, tick);
  return Math.max(0, Math.round(tick / gridTicks) * gridTicks);
}

/** Scale chord ticks from one meter to another so bar-relative position and length are preserved. */
export function rescaleChordsForMeter(
  chords: Chord[],
  oldTs: TimeSignature,
  newTs: TimeSignature,
): Chord[] {
  if (ticksPerBar(oldTs) === 0) return chords;
  const ratio = ticksPerBar(newTs) / ticksPerBar(oldTs);
  return chords.map((c) => ({
    ...c,
    startTick: Math.max(0, Math.round(c.startTick * ratio)),
    durationTicks: Math.max(1, Math.round(c.durationTicks * ratio)),
  }));
}

/** Meter changes PROPORTIONALLY RESCALE note ticks so bar-N-beat-B material
 * stays at bar N beat B — the same semantic rescale `rescaleChordsForMeter`
 * applies to chords (identical ratio source: ticksPerBar; identical rounding:
 * integer round of a float ratio, ±1-tick tolerance documented, duration floor
 * 1 so zero-length notes are impossible). Pitches, velocities, dynamics and
 * detune are untouched; every pitchBendPoints[].tick scales with the note.
 * Sections need nothing (bar-indexed reflow inherently); reference-audio
 * offset is ms-based and untouched. */
export function rescaleNotesForMeter(
  notes: Note[],
  oldTs: TimeSignature,
  newTs: TimeSignature,
): Note[] {
  if (notes.length === 0) return notes;
  const oldPerBar = ticksPerBar(oldTs);
  const newPerBar = ticksPerBar(newTs);
  if (oldPerBar <= 0 || newPerBar === oldPerBar) return notes;
  const ratio = newPerBar / oldPerBar;
  const scale = (tick: number) => Math.max(0, Math.round(tick * ratio));
  return notes.map((note) => ({
    ...note,
    startTick: scale(note.startTick),
    durationTicks: Math.max(1, Math.round(note.durationTicks * ratio)),
    ...(note.pitchBendPoints?.length
      ? { pitchBendPoints: note.pitchBendPoints.map((point) => ({ ...point, tick: scale(point.tick) })) }
      : {}),
  }));
}
