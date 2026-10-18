import { PPQ } from "../shared/schema/types";
import type { AbstractNoteEvent, InstrumentProfile } from "./generate";
import { mulberry32 } from "./prng";
import { zoneCompliant, aboveC3Guard } from "./nct";

/**
 * Addendum G — counterline + ostinato cell engine (Stage 6.45b, after E/F, before
 * realizeRhythm). Owns COUNTERLINE and OSTINATO wholesale (they never pass through
 * realizeRhythm — Phase 0 roles contract). Reads the *finished* LEAD stream
 * (post theme+NCT, pre-windowing: windowing runs later by design, and M7's tutti
 * onset shifts may displace motif onsets afterwards — accepted behavior).
 */

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;

export interface CounterlineContext {
  timeSignature: [number, number];
  keyRoot: number;
  mode: string;
  /** Chord blocks with resolved pitch classes (from the wiring layer). */
  chords: Array<{ startTime: number; duration: number; rootPitchClass: number; resolvedPcs?: number[] }>;
  /** Sections already converted to tick ranges by the wiring layer. */
  sections: Array<{ startTime: number; duration: number; energy: number }>;
  /** Instrument profiles for COUNTERLINE mid-register instruments. */
  counterlineProfiles: InstrumentProfile[];
  ostinatoProfiles: InstrumentProfile[];
  bassProfile?: InstrumentProfile;
  /** Existing semantic events (COUNTERLINE/OSTINATO/BASS) for instrument-id reuse. */
  events: AbstractNoteEvent[];
  /** Lead stream as [startTime, pitch] pairs for contrary-motion analysis. */
  leadNotes: Array<{ startTime: number; pitch: number; duration: number }>;
  /** Per-sub-engine A/B switches: counterline entries, ostinato cells and bass
   * approach tones can each be gated independently; when all three are off the
   * engine is a byte-for-byte passthrough. */
  counterlineEnabled: boolean;
  ostinatoEnabled: boolean;
  bassApproachEnabled: boolean;
  /** W.2 additive intensity probes (default to stage-2 energy lookups). */
  intensityAt?: (startTime: number) => number;
  subdivisionCapAt?: (startTime: number) => number;
}

export type OstinatoCellType = "ARPEGGIATED" | "TREMOLO" | "SYNCOPATED";

/** G.2 — mid register band (C3–G4), matching viola/cello/horn/clarinet comfort. */
const COUNTERLINE_LOW = 48;
const COUNTERLINE_HIGH = 67;
/** G.4 — ostinato safe band, preferred 43–64, clamped to the layer range. */
const OSTINATO_PREFERRED_LOW = 43;
const OSTINATO_PREFERRED_HIGH = 64;

/** G.1 — scan the finished LEAD for sustained-note/rest windows ≥ 1 beat. */
export function detectWindows(
  leadNotes: Array<{ startTime: number; duration: number }>,
  beatTicks: number,
  totalDuration: number,
): Array<{ start: number; end: number }> {
  const sorted = [...leadNotes].sort((a, b) => a.startTime - b.startTime);
  const windows: Array<{ start: number; end: number }> = [];
  let lastEnd = 0;
  for (const note of sorted) {
    // Rest window between notes.
    if (note.startTime - lastEnd >= beatTicks) windows.push({ start: lastEnd, end: note.startTime });
    // Sustained window inside long notes.
    if (note.duration >= 2 * beatTicks) windows.push({ start: note.startTime + beatTicks, end: note.startTime + note.duration });
    lastEnd = Math.max(lastEnd, note.startTime + note.duration);
  }
  if (totalDuration > lastEnd + beatTicks) windows.push({ start: lastEnd, end: totalDuration });
  return windows;
}

/** G.2 — contrary-motion entry inside the detected window. Windows are entered
 * with the contour inverted vs the lead where possible; guide tones hold during
 * rapid lead passages. Entries below C3 are forbidden by construction (band ≥ 48). */
function contraryPitch(previousPitch: number, leadMotion: number, range: { low: number; high: number }, chordPcs: number[]): number {
  const opposite = leadMotion !== 0 ? -Math.sign(leadMotion) : (previousPitch <= (range.low + range.high) / 2 ? 1 : -1);
  const target = previousPitch + opposite * Math.min(Math.abs(leadMotion) || 1, 3);
  const candidates: number[] = [];
  for (let pitch = Math.max(COUNTERLINE_LOW, range.low); pitch <= Math.min(COUNTERLINE_HIGH, range.high); pitch++) {
    if (chordPcs.length === 0 || chordPcs.includes(pc(pitch))) candidates.push(pitch);
  }
  if (!candidates.length) return clamp(60, range.low, range.high);
  // Prefer chord tones on the CONTRARY side of the previous line; only fall back
  // to the full set when the band direction leaves no chord tone (keeps the
  // contrary-motion contract whenever the register allows it).
  const sameSide = candidates.filter((pitch) => opposite > 0 ? pitch >= previousPitch : pitch <= previousPitch);
  const pool = sameSide.length ? sameSide : candidates;
  return pool.reduce((best, pitch) => Math.abs(pitch - target) < Math.abs(best - target) ? pitch : best, pool[0]!);
}

/** G.3 — curated 1-bar rhythm seeds: relative units of a beat (1 = quarter). */
export const OSTINATO_RHYTHM_SEEDS: Record<OstinatoCellType, number[][]> = {
  ARPEGGIATED: [[1, 1, 1, 1], [0.5, 0.5, 1, 1, 1], [1, 0.5, 0.5, 1, 1]],
  TREMOLO: [[0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25], [0.5, 0.5, 0.5, 0.5]],
  SYNCOPATED: [[0.5, 1, 0.5, 1, 1], [1, 0.5, 0.5, 0.5, 1, 0.5]],
};

/** G.6 — bass approach-tone pass: at chord changes (target root ≥ 36), the bass
 * may approach the next root by step or fifth from the previous beat. */
export function bassApproachTones(
  bassEvents: AbstractNoteEvent[],
  chords: CounterlineContext["chords"],
  profile: InstrumentProfile | undefined,
  rng: () => number,
): AbstractNoteEvent[] {
  if (!bassEvents.length || !profile) return bassEvents;
  const eligible: Array<{ index: number; targetRoot: number; previousBeat: number }> = [];
  const beatTicks = (PPQ * 4) / 4;
  for (let i = 1; i < chords.length; i++) {
    const targetRoot = pc(chords[i]!.rootPitchClass);
    const boundary = chords[i]!.startTime;
    const previous = chords[i - 1]!;
    if (previous.startTime + previous.duration !== boundary) continue;
    if (targetRoot < 36) continue;
    eligible.push({ index: i, targetRoot, previousBeat: boundary - beatTicks });
  }
  const out = [...bassEvents];
  const selectionCap = Math.ceil(eligible.length * 0.5);
  const chosen = new Set<number>();
  for (let taken = 0; taken < selectionCap && eligible.length > taken; taken++) {
    const candidate = eligible[Math.floor(rng() * eligible.length)]!;
    if (chosen.has(candidate.index)) continue;
    chosen.add(candidate.index);
    insertApproach(out, candidate, profile, rng);
  }
  return out.sort((a, b) => a.startTime - b.startTime);
}

function insertApproach(
  events: AbstractNoteEvent[],
  candidate: { targetRoot: number; previousBeat: number },
  profile: InstrumentProfile,
  rng: () => number,
): void {
  const targetRoot = candidate.targetRoot;
  // Approach by step below (root-1/root-2) or a fifth below (root-7); pick once.
  const byStep = targetRoot - (rng() < 0.6 ? 1 : 2);
  const byFifth = targetRoot - 7;
  const approach = rng() < 0.7 ? byStep : byFifth;
  const range = profile.writtenRange;
  const pitch = approach >= range.low ? approach : approach + 12;
  if (pitch < 24) return;
  // Zone compliance against the bass's nearest neighbor events.
  const index = events.findIndex((event) => event.startTime >= candidate.previousBeat);
  const neighbor = events[index];
  const companion = neighbor?.pitchConcert ?? pitch - 12;
  const lower = Math.min(pitch, companion);
  const upper = Math.max(pitch, companion);
  if (lower < 48 && !zoneCompliant(lower, upper)) return;
  const insert: AbstractNoteEvent = {
    ...(events.find((event) => event.role === "BASS") ?? { instrumentId: profile.id, pitchConcert: pitch, pitchWritten: pitch, normalizedDynamic: 0.4, semanticArticulation: "LEGATO" as const, role: "BASS" as const, startTime: candidate.previousBeat, duration: (PPQ * 4) / 4 }),
    pitchConcert: pitch,
    pitchWritten: pitch,
    startTime: candidate.previousBeat,
    duration: Math.max(1, Math.round((PPQ * 4) / 4)),
  };
  const at = events.findIndex((event) => event.startTime >= candidate.previousBeat);
  if (at >= 0) events.splice(at, 0, insert);
}

/** Main entry: replace COUNTERLINE + OSTINATO events; run the bass approach pass. */
export function applyCounterlineEngine(events: AbstractNoteEvent[], ctx: CounterlineContext, seed: number): AbstractNoteEvent[] {
  if (!ctx.counterlineEnabled && !ctx.ostinatoEnabled && !ctx.bassApproachEnabled) return events;
  const rng = mulberry32(seed + 0x6066);
  const out: AbstractNoteEvent[] = [];
  const others = events.filter((event) => event.role !== "COUNTERLINE" && event.role !== "OSTINATO" && event.role !== "BASS");
  const bassEvents = events.filter((event) => event.role === "BASS");

  if (ctx.counterlineEnabled && ctx.counterlineProfiles.length) {
    out.push(...generateCounterline(ctx, rng));
  }
  if (ctx.ostinatoEnabled && ctx.ostinatoProfiles.length) {
    out.push(...generateOstinato(ctx, rng));
  }
  if (ctx.bassApproachEnabled && bassEvents.length) {
    out.push(...bassApproachTones(bassEvents, ctx.chords, ctx.bassProfile, rng));
  } else {
    out.push(...bassEvents);
  }
  return [...others, ...out].sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
}

function generateCounterline(ctx: CounterlineContext, rng: () => number): AbstractNoteEvent[] {
  const produced: AbstractNoteEvent[] = [];
  const profile = ctx.counterlineProfiles[Math.floor(rng() * ctx.counterlineProfiles.length)]!;
  const range = {
    low: Math.max(COUNTERLINE_LOW, profile.comfortableRange?.low ?? profile.writtenRange.low),
    high: Math.min(COUNTERLINE_HIGH, profile.comfortableRange?.high ?? profile.writtenRange.high),
  };
  if (range.low > range.high) return produced;
  const beatTicks = (PPQ * 4) / ctx.timeSignature[1];
  // Finite timeline: the LAST section end bounds the trailing rest window — calling
  // detectWindows with Infinity leaked an open-ended (duration = Infinity) window
  // starting at the project end, which baked as durationTicks NaN/null.
  const totalDuration = ctx.sections.reduce((acc, section) => Math.max(acc, section.startTime + section.duration), 0)
    || ctx.chords.reduce((acc, block) => Math.max(acc, block.startTime + block.duration), 0);
  const windows = totalDuration > 0 ? detectWindows(ctx.leadNotes, beatTicks, totalDuration) : [];
  const sortedLead = [...ctx.leadNotes].sort((a, b) => a.startTime - b.startTime);
  const leadPitchAt = (time: number): number | undefined =>
    sortedLead.find((note) => note.startTime <= time && time < note.startTime + note.duration)?.pitch;

  let prevLeadAtEntry: number | undefined;
  for (const window of windows) {
    const duration = window.end - window.start;
    const chord = ctx.chords.find((block) => block.startTime <= window.start && window.start < block.startTime + block.duration);
    const chordPcs = chord?.resolvedPcs ?? [chord ? pc(chord.rootPitchClass) : undefined].filter((value): value is number => value !== undefined);
    // Contrary entry defined on the lead's REAL melodic motion BETWEEN entries
    // (sounding pitch here vs sounding pitch at the previous entry) — fully causal
    // (both pitches are known at entry time) and robust to rests/sustains.
    const leadPitchHere = leadPitchAt(window.start);
    let motion: number | undefined;
    if (prevLeadAtEntry !== undefined && leadPitchHere !== undefined) {
      motion = leadPitchHere - prevLeadAtEntry;
    } else {
      // Fallback: motion inside the window; for rest windows oppose the lead's
      // impending continuation (next sounding pitch vs last one).
      motion = leadMotionOf(sortedLead, window);
      if (motion === 0) {
        const before = [...sortedLead].reverse().find((note) => note.startTime < window.start);
        const upcoming = sortedLead.find((note) => note.startTime >= window.end);
        if (before && upcoming) motion = upcoming.pitch - before.pitch;
      }
    }
    const previous = produced.at(-1)?.pitchConcert ?? 60;
    // Contrary entry in EVERY window: the held chord tone is the contrary-side
    // chord tone (a guide-tone hold with direction).
    const pitch = contraryPitch(previous, motion ?? 0, range, chordPcs);
    produced.push(makeEvent(profile.id, pitch, window.start, duration, "DETACHE", "COUNTERLINE", chord?.resolvedPcs, ctx, rng, window.start));
    if (leadPitchHere !== undefined) prevLeadAtEntry = leadPitchHere;
  }
  return produced;
}

function leadMotionOf(sortedLead: Array<{ startTime: number; pitch: number }>, window: { start: number; end: number }): number {
  const before = [...sortedLead].reverse().find((note) => note.startTime < window.start);
  const during = sortedLead.find((note) => note.startTime >= window.start && note.startTime < window.end);
  if (!before || !during) return 0;
  return during.pitch - before.pitch;
}

function generateOstinato(ctx: CounterlineContext, rng: () => number): AbstractNoteEvent[] {
  const produced: AbstractNoteEvent[] = [];
  const profile = ctx.ostinatoProfiles[Math.floor(rng() * ctx.ostinatoProfiles.length)]!;
  const layerLow = profile.comfortableRange?.low ?? profile.writtenRange.low;
  const layerHigh = profile.comfortableRange?.high ?? profile.writtenRange.high;
  const low = Math.max(layerLow, OSTINATO_PREFERRED_LOW);
  const high = Math.min(layerHigh, OSTINATO_PREFERRED_HIGH);
  if (low > high) return produced;
  const beatTicks = (PPQ * 4) / ctx.timeSignature[1];
  const barTicks = ctx.timeSignature[0] * beatTicks;
  const intensityAt = ctx.intensityAt ?? ((time: number) => ctx.sections.find((section) => section.startTime <= time && time < section.startTime + section.duration)?.energy ?? 0.5);

  for (const section of ctx.sections) {
    const energy = intensityAt(section.startTime);
    const type: OstinatoCellType = energy >= 0.75 ? "TREMOLO" : energy >= 0.5 ? (rng() < 0.6 ? "SYNCOPATED" : "ARPEGGIATED") : "ARPEGGIATED";
    if (type === "TREMOLO" && energy < 0.75) continue; // tremolo only at higher energy
    const seeds = OSTINATO_RHYTHM_SEEDS[type];
    const seed = seeds[Math.floor(rng() * seeds.length)]!;
    let cursor = section.startTime;
    while (cursor < section.startTime + section.duration) {
      const chord = ctx.chords.find((block) => block.startTime <= cursor && cursor < block.startTime + block.duration);
      if (!chord) { cursor += barTicks; continue; }
      const pcs = (chord.resolvedPcs ?? [pc(chord.rootPitchClass)]).map((value) => pc(value));
      let cellStep = 0;
      let time = cursor;
      for (const unit of seed) {
        if (time >= section.startTime + section.duration) break;
        const duration = Math.round(unit * beatTicks);
        // G.4 — broken chord tones inside the safe band; zone-compliant.
        let pitch = pickBandPitch(pcs, low, high, cellStep++);
        const previous = produced.at(-1);
        if (previous && pitch < 48 && previous.pitchConcert < 48 && !zoneCompliant(Math.min(previous.pitchConcert, pitch), Math.max(previous.pitchConcert, pitch))) {
          pitch = pitch + 12 > high ? pickBandPitch(pcs, low, high, cellStep) : pitch + 12;
        }
        if (pitch < 48 && pitch >= 36) {
          const previousPitch = previous?.pitchConcert ?? pitch;
          if (!aboveC3Guard(pitch, pitch) && Math.abs(previousPitch - pitch) % 12 !== 0) pitch = Math.min(high, pitch + 12);
        }
        const tags = type === "TREMOLO" ? "TREMOLO" : type === "SYNCOPATED" ? "SPICCATO" : "LEGATO";
        produced.push(makeEvent(profile.id, pitch, time, duration, tags, "OSTINATO", pcs, ctx, rng, time));
        // G.5 — metrical accenting via normalizedDynamic (pure arithmetic, no RNG):
        // rigged below by adjusting the event after creation.
        const inserted = produced.at(-1)!;
        const beatPosition = (time % beatTicks === 0) ? (Math.floor(time / beatTicks) % ctx.timeSignature[0]) : -1;
        const accent = beatPosition === 0 || beatPosition === 2 ? 0.08 : beatPosition >= 0 ? -0.1 : 0;
        inserted.normalizedDynamic = clamp(inserted.normalizedDynamic + accent, 0, 1);
        time += duration;
      }
      cursor += barTicks;
    }
  }
  return produced;
}

/** Seeded band pick (no Math.random — determinism contract): walks the candidates
 * cyclically per elapsed beat so chord re-maps stay inside the safe band. */
function pickBandPitch(pcs: number[], low: number, high: number, step: number): number {
  const candidates: number[] = [];
  for (let pitch = low; pitch <= high; pitch++) {
    if (pcs.includes(pc(pitch))) candidates.push(pitch);
  }
  if (!candidates.length) return clamp(52, low, high);
  return candidates[step % candidates.length]!;
}

function makeEvent(
  instrumentId: string,
  pitchConcert: number,
  startTime: number,
  duration: number,
  articulation: AbstractNoteEvent["semanticArticulation"],
  role: AbstractNoteEvent["role"],
  _chordPcs: number[] | undefined,
  ctx: CounterlineContext,
  _rng: () => number,
  time: number,
): AbstractNoteEvent {
  const intensityAt = ctx.intensityAt ?? ((probeTime: number) => ctx.sections.find((section) => section.startTime <= probeTime && probeTime < section.startTime + section.duration)?.energy ?? 0.5);
  return {
    instrumentId,
    pitchConcert,
    pitchWritten: pitchConcert,
    startTime: Math.round(startTime),
    duration: Math.max(1, Math.round(duration)),
    normalizedDynamic: clamp(0.35 + intensityAt(time) * 0.35, 0, 1),
    semanticArticulation: articulation,
    role,
  };
}

export { zoneCompliant, aboveC3Guard };
