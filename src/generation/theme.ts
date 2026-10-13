/**
 * Addendum E — Theme engine (Stage 6.4, before rhythm realization).
 *
 * Replaces the semantic pipeline's per-beat LEAD grid with motive phrases built
 * from curated "germ" pools (relative rhythm ratios + scale-step contours), per
 * Schoenberg's Grundgestalt: a small set of basic shapes, stated, sequenced,
 * developed and liquidated across aligned phrases. Everything derives from one
 * seeded stream (salt 0xe551): same seed ⇒ byte-identical output.
 *
 * Rhythm ownership: LEAD never passes through realizeRhythm when this engine is
 * enabled (Phase 0 roles contract); motif rhythm comes from the germs, not the
 * chord grid. Pitch is rendered against the real chord timeline: anchor beats
 * are locked to chord tones; contour steps walk the project mode's scale.
 */
import { MODE_INTERVALS, PPQ, type ModeName } from "../shared/schema/types";
import type { AbstractNoteEvent, ChordBlock, InstrumentProfile, ProjectConfig, StructureSection } from "./generate";
import { mulberry32 } from "./prng";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;

/** E.1 — curated germ pools (DATA, not generated): Schoenbergian Grundgestalt.
 * Rhythms are relative beat ratios (quarter=1); contours are scale-step deltas. */
export interface MotiveGerm {
  /** Relative note durations in quarter notes, summing to the germ length. */
  rhythm: number[];
  /** Scale-step motions between consecutive notes (+1 = up a scale degree). */
  contour: number[];
}
export const GERM_RHYTHMS: number[][] = [
  [1, 0.5, 0.5, 2],   // classic statement: quarter, two eighths, half
  [0.5, 0.5, 1, 2],   // upbeat pair into two longer tones
  [1, 1, 0.5, 0.5, 1],// even quarters then a pair of eighths back to a quarter
  [2, 0.5, 0.5, 1],   // long initial tone then quick pair
];
export const GERM_CONTOURS: number[][] = [
  [1, 1, -2, 3],      // ascending push, drop, wide leap up
  [2, -1, 1, -1],     // rising turn that settles
  [1, 2, -1, -1],     // two up-steps then stepwise descent
  [-1, 1, 2, -2],     // dip, rise, fall back
];
/** E.3 — response transformations for the second phrase segment. */
export const RESPONSE_SHIFTS = [-2, -1, 1, 2] as const;
/** E.5 — wave contour: climax sits in this window of the phrase duration. */
export const PEAK_WINDOW = [0.65, 0.75] as const;


export interface ThemeContext {
  config: ProjectConfig;
  chords: ChordBlock[];
  sections: StructureSection[];
  /** Per-beat energy values aligned to the chord timeline (stage-2 output). */
  energies: number[];
  /**stage-2 grid: chord boundary times in ticks with their tension. */
  chordStartTimes: number[];
  profiles: InstrumentProfile[];
  /** The LEAD layer's instrument ids and comfortable range from stage 3. */
  leadInstrumentIds: string[];
  leadRange: { low: number; high: number };
  enabled?: { germ: boolean };
  /** Minimal ThemeOptions shape: optional handoff for unit-level A/B. */
  intensityAt?: (startTime: number) => number;
  subdivisionCapAt?: (startTime: number) => number;
}

export interface ThemeResult {
  /** Replacement LEAD events (one instrument per phrase-beat slice). */
  events: AbstractNoteEvent[];
  /** true when ANY phrase was actually regenerated (engine did work). */
  regenerated: boolean;
}

interface PhrasePlan {
  startTime: number;
  duration: number; // ticks
  bars: number;
  /** Stage: statement/response/development/liquidation — used for contour choices. */
  stages: Array<"statement" | "response" | "development" | "liquidation">;
  germ: MotiveGerm;
}

/** E.1 — pivot back to absolute pitches through the project mode. */
function scaleIntervals(mode: ModeName): number[] {
  return MODE_INTERVALS[mode] ?? MODE_INTERVALS.ionian;
}

/** E.2 — seeded pick of 2-3 germs for the piece. */
function pickGerms(rng: () => number): MotiveGerm[] {
  const count = 2 + Math.floor(rng() * 2); // 2 or 3
  const picked: MotiveGerm[] = [];
  for (let i = 0; i < count; i++) {
    picked.push({
      rhythm: GERM_RHYTHMS[Math.floor(rng() * GERM_RHYTHMS.length)]!,
      contour: GERM_CONTOURS[Math.floor(rng() * GERM_CONTOURS.length)]!,
    });
  }
  return picked;
}

/** E.3 — align 4- or 8-bar phrases to section boundaries, truncating leftovers. */
export function planPhrases(sections: StructureSection[], rng: () => number, ticksPerBar: number): PhrasePlan[] {
  const plans: PhrasePlan[] = [];
  for (const section of sections) {
    const totalBars = Math.max(1, section.duration / ticksPerBar);
    const phraseBars = rng() < 0.5 ? 4 : 8;
    if (totalBars <= phraseBars) {
      plans.push(makePlan(section.startTime, totalBars, ticksPerBar, section.type));
      continue;
    }
    let cursor = section.startTime;
    let remaining = totalBars;
    while (remaining >= phraseBars) {
      plans.push(makePlan(cursor, phraseBars, ticksPerBar, section.type));
      cursor += phraseBars * ticksPerBar;
      remaining -= phraseBars;
    }
    if (remaining > 0) {
      // Truncate the leftover into a final (shorter) phrase.
      plans.push(makePlan(cursor, remaining, ticksPerBar, section.type));
    }
  }
  return plans;
}

function makePlan(startTime: number, bars: number, ticksPerBar: number, _type: string): PhrasePlan {
  return {
    startTime,
    duration: bars * ticksPerBar,
    bars,
    // Sentence stages present in every phrase; climax-time picks live in realizeGerm.
    stages: ["statement", "response", "development", "liquidation"],
    germ: { rhythm: [1, 0.5, 0.5, 2], contour: [1, 1, -2, 3] }, // placeholder; replaced per-stage in realization
  };
}

/** E.3 — per-stage contour transforms. */
function transformContour(contour: number[], stage: PhrasePlan["stages"][number], rng: () => number): number[] {
  switch (stage) {
    case "statement":
      return [...contour];
    case "response": {
      const shift = RESPONSE_SHIFTS[Math.floor(rng() * RESPONSE_SHIFTS.length)]!;
      return contour.map((step) => (rng() < 0.5 ? step + shift : step * 2)); // sequence ±2 OR interval expansion
    }
    case "development": {
      // Inversion (negate) OR retrograde (reverse); either may gain rhythmic diminution downstream.
      return rng() < 0.5 ? contour.map((step) => -step) : [...contour].reverse();
    }
    case "liquidation":
      // E.6: strip motif identity — scalar steps replacing leaps.
      return contour.map((step) => Math.sign(step) * 1);
  }
}



/** Map a scale degree (possibly outside 0..scale.length) to a concert pitch near `preferred`. */
function degreeToPitch(degree: number, scale: number[], range: { low: number; high: number }, preferred: number, tonicPc = 0): number {
  const length = scale.length;
  const octave = Math.floor(degree / length);
  const within = ((degree % length) + length) % length;
  const baseOctave = 12 * octave;
  const pitchClass = pc(tonicPc + scale[within]! + baseOctave);
  const candidates: number[] = [];
  for (let pitch = Math.ceil(range.low); pitch <= range.high; pitch++) {
    if (pc(pitch) === pitchClass) candidates.push(pitch);
  }
  if (!candidates.length) return clamp(preferred, range.low, range.high);
  return candidates.reduce((best, pitch) => Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, candidates[0]!);
}

/** Degree index whose scale pitch class matches targetPc; register kept near `nearPitch`. */
function degreeNearPc(targetPc: number, scale: number[], tonicPc: number, nearPitch: number): number {
  const length = scale.length;
  let within = scale.findIndex((interval) => pc(tonicPc + interval) === pc(targetPc));
  if (within < 0) within = 0; // chromatic anchor tone: nearest diatonic degree stays
  let degree = within;
  for (let guard = 0; guard < 6; guard++) {
    const probe = degreeToPitch(degree, scale, { low: nearPitch - 24, high: nearPitch + 24 }, nearPitch, tonicPc);
    if (Math.abs(probe - nearPitch) <= 6) break;
    degree += probe < nearPitch ? length : -length;
  }
  return degree;
}

/** E.6 — is this chord a tonic-type (root ≡ key) or dominant-type (root ≡ key+7) in this mode? */
function chordFunctionType(chord: ChordBlock | undefined, config: ProjectConfig): "tonic" | "dominant" | "other" {
  if (!chord) return "other";
  const root = pc(chord.rootPitchClass);
  const key = pc(config.keyRoot);
  if (root === key) return "tonic";
  if (root === pc(key + 7)) return "dominant";
  return "other";
}

/** E.6 — target pitch class for the cadence landing note. */
export function cadenceTargetPc(chord: ChordBlock | undefined, config: ProjectConfig): number | undefined {
  if (!chord) return undefined;
  const root = pc(chord.rootPitchClass);
  const resolved = (chord as ResolvedChordBlock).resolvedPcs;
  const third = resolved && resolved.length ? resolved.find((tone) => pc(tone - root) === 3 || pc(tone - root) === 4) : undefined;
  const func = chordFunctionType(chord, config);
  if (func === "tonic") return root; // root/3rd over tonic harmony; root preferred
  if (func === "dominant") return pc(root + 7); // 5th over dominant
  // Other: prefer the chord's third when resolvable, else root.
  return third ? pc(third) : root;
}

// ChordBlock carries resolved pitch classes upstream when the caller pre-parses them.
/** ChordBlock augmentation carries the *resolved* pitch classes (thrd included); the
 * wiring layer (generate.ts) pre-parses symbols and stamps this field on each block
 * so anchor/cadence selection sees thirds without re-parsing. */
export interface ResolvedChordBlock extends ChordBlock {
  resolvedPcs?: number[];
}

/** E.4 — anchor pitch classes a germ beat must honor (root/3rd/5th). */
export function anchorPitchClasses(chord: ChordBlock | undefined): number[] {
  if (!chord) return [];
  const root = pc(chord.rootPitchClass);
  const resolved = (chord as ResolvedChordBlock).resolvedPcs;
  if (resolved && resolved.length) {
    // Prefer root, 3rd (pc distance 3 or 4 from root), then 5th.
    const third = resolved.find((tone) => pc(tone - root) === 3 || pc(tone - root) === 4);
    const fifth = resolved.find((tone) => pc(tone - root) === 7);
    return [root, third !== undefined ? pc(third) : root, fifth !== undefined ? pc(fifth) : pc(root + 7)];
  }
  return [root, pc(root + 4), pc(root + 7)];
}

/** E.4+E.5 — render one phrase from its plan: anchors, contour walk, wave contour. */
export function realizePhrase(
  plan: PhrasePlan,
  ctx: ThemeContext,
  rng: () => number,
  germs: MotiveGerm[],
): Array<{ concertPitch: number; startTime: number; duration: number; isCadence: boolean }> {
  const scale = scaleIntervals(ctx.config.scaleMode as ModeName);
  const range = ctx.leadRange;
  const beatTicks = (PPQ * 4) / ctx.config.timeSignature[1];
  const barTicks = ctx.config.timeSignature[0] * beatTicks;
  const produced: Array<{ concertPitch: number; startTime: number; duration: number; isCadence: boolean }> = [];

  // Stage splits: statement + response get the first half, development the next
  // quarter, liquidation the last quarter (clause-style sentence, not strict).
  const statementEnd = plan.startTime + plan.duration * 0.5;
  const developmentStart = statementEnd;
  const liquidationStart = plan.startTime + plan.duration * 0.75;

  // Chords overlapping the phrase: anchor selection below.
  const phraseChords = ctx.chords
    .filter((block) => block.startTime < plan.startTime + plan.duration && block.startTime + block.duration > plan.startTime);

  // Germ rhythm picked per phrase; contour transformed per stage.
  const baseGerm = germs[Math.floor(rng() * germs.length)]!;
  const stages: Array<{ stage: PhrasePlan["stages"][number]; windowStart: number; windowEnd: number }> = [
    { stage: "statement", windowStart: plan.startTime, windowEnd: statementEnd },
    { stage: "response", windowStart: plan.startTime + (statementEnd - plan.startTime) / 2, windowEnd: developmentStart },
    { stage: "development", windowStart: developmentStart, windowEnd: liquidationStart },
    { stage: "liquidation", windowStart: liquidationStart, windowEnd: plan.startTime + plan.duration },
  ];

  // E.5 — target peak placement inside the 65-75% window of the phrase.
  const peakTime = plan.startTime + plan.duration * (PEAK_WINDOW[0] + rng() * (PEAK_WINDOW[1] - PEAK_WINDOW[0]));
  // Preferred absolute climax pitch: near the top of the lead comfortable range.
  const preferredPeak = range.high - 2;
  const baseDegree = 0; // start the contour walk at the tonic degree

  let cursor = plan.startTime;
  const stageWindows = stages;
  const pitchesByStage: number[] = [];
  // Walk through stages; each renders notes until its window is exhausted.
  for (const window of stageWindows) {
    const contour = transformContour(baseGerm.contour, window.stage, rng);
    // Diminution is applied in the development stage only (E.3).
    const diminution = window.stage === "development";
    const rhythm = diminution
      ? baseGerm.rhythm.map((value) => value * 0.5)
      : baseGerm.rhythm;
    const windowStart = window.windowStart;
    const windowEnd = window.windowEnd;
    if (cursor >= windowEnd - 1) break;
    if (cursor < windowStart) cursor = windowStart;
    let degree = baseDegree + transformContourStepOffset(stageWindows.indexOf(window), contour, rng);
    let localIndex = 0;
    while (cursor < windowEnd - 1 && localIndex < rhythm.length * 4) {
      const unit = rhythm[localIndex % rhythm.length] ?? 1;
      const duration = unit * beatTicks;
      // Anchor the bar downbeats to chord tones (E.4).
      const isAnchor = (cursor - plan.startTime) % barTicks === 0;
      const chord = chordAt(phraseChords, cursor);
      let pitch: number;
      const tonicPc = pc(ctx.config.keyRoot);
      if (isAnchor) {
        const anchors = anchorPitchClasses(chord);
        // Anchor chord tone chosen NEAREST THE CURRENT LINE (not the abstract wave
        // peak) so bar downbeats do not force leaps into chord tones.
        const linePitch = pitchesByStage.at(-1) ?? pitchPeakFor(cursor, peakTime, preferredPeak, pitchesByStage);
        pitch = anchors.length
          ? pitchInClassAmong(anchors.map((value) => pc(value)), range, linePitch)
          : degreeToPitch(degree, scale, range, preferredPitch(cursor, peakTime, preferredPeak, pitchesByStage), tonicPc);
        // Rebase the walk on the sounded anchor pitch class so the phrase resumes
        // stepwise from that note instead of leaping back to the old degree.
        degree = degreeNearPc(pc(pitch), scale, tonicPc, pitch);
      } else {
        pitch = degreeToPitch(degree, scale, range, preferredPitch(cursor, peakTime, preferredPeak, pitchesByStage), tonicPc);
      }
      // E.5 — bias ascending fragments before the peak and descending after by
      // nudging the walk toward the preferred peak pitch on the other side.
      pitchesByStage.push(pitch);
      produced.push({
        concertPitch: pitch,
        startTime: cursor,
        duration: Math.min(duration, plan.startTime + plan.duration - cursor),
        isCadence: false,
      });
      cursor += duration;
      // Advance the walk by one contour step PER NOTE (germ contours are
      // note-to-note motions). The earlier once-per-germ-cycle increment stalled
      // repeated germ cycles on the same pitch — the melody must keep moving.
      degree += contour[localIndex % contour.length] ?? 1;
      localIndex++;
    }
  }
  // E.6 — liquidation already applied to contour; replace final 2 bars.
  applyLiquidation(produced, plan, ctx, rng, scale);
  return produced;
}

function preferredPitch(cursor: number, peakTime: number, preferredPeak: number, history: number[]): number {
  // Direction bias: before the peak reach up, after the peak settle down.
  const recent = history.at(-1);
  if (recent === undefined) return preferredPeak - 7;
  const beforePeak = cursor <= peakTime;
  return beforePeak ? Math.min(preferredPeak, recent + 4) : Math.max(range_floor, recent - 4);
}
// floor used inside preferredPitch; module-level constant for readability.
const range_floor = 60;

function pitchPeakFor(cursor: number, peakTime: number, preferredPeak: number, history: number[]): number {
  return preferredPitch(cursor, peakTime, preferredPeak, history);
}

function pitchInClassAmong(pitchClasses: number[], range: { low: number; high: number }, preferred: number): number {
  const candidates: number[] = [];
  for (let pitch = Math.ceil(range.low); pitch <= range.high; pitch++) {
    if (pitchClasses.includes(pc(pitch))) candidates.push(pitch);
  }
  if (!candidates.length) return clamp(preferred, range.low, range.high);
  return candidates.reduce((best, pitch) => Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, candidates[0]!);
}

function transformContourStepOffset(stageIndex: number, _contour: number[], rng: () => number): number {
  // Response shifts the starting degree for variety; deterministic via rng.
  if (stageIndex === 1) return Math.round((rng() - 0.5) * 4);
  return 0;
}

function chordAt(chords: ChordBlock[], time: number): ChordBlock | undefined {
  return chords.find((block) => block.startTime <= time && time < block.startTime + block.duration);
}

/** E.6 — liquidation + cadence: strip motif identity in the final 2 bars and land
 *  the last note on a chord tone of the downbeat chord. */
export function applyLiquidation(
  produced: Array<{ concertPitch: number; startTime: number; duration: number; isCadence: boolean }>,
  plan: PhrasePlan,
  ctx: ThemeContext,
  rng: () => number,
  scale: number[],
): void {
  const beatTicks = (PPQ * 4) / ctx.config.timeSignature[1];
  const liquidationStart = plan.startTime + plan.duration - 2 * beatTicks * ctx.config.timeSignature[0];
  for (const note of produced) {
    if (note.startTime >= liquidationStart) {
      // Strip identity: replace with sustained notes or scalar steps only.
      const chord = chordAt(ctx.chords, note.startTime);
      const anchors = anchorPitchClasses(chord);
      if (anchors.length && produced.indexOf(note) % 2 === 0) {
        note.concertPitch = pitchInClassAmong(anchors.map((value) => pc(value)), ctx.leadRange, note.concertPitch);
      }
      // Sustained feel: leave the duration as-is (germ rhythm already short here).
    }
  }
  // Cadence: guarantee a note ON the phrase-end downbeat whose pitch is a chord
  // tone of the chord at that downbeat (100% check downstream). Anything that
  // started at/after the downbeat is replaced by a single sustained cadence note
  // so the requirement holds strictly, even when the walk misaligns.
  const beatTicks2 = (PPQ * 4) / ctx.config.timeSignature[1];
  const barTicks = ctx.config.timeSignature[0] * beatTicks2;
  const downbeat = plan.startTime + plan.duration - barTicks;
  const index = produced.findIndex((note) => note.startTime >= downbeat);
  if (index >= 0) produced.splice(index);
  produced.forEach((note) => {
    if (note.startTime + note.duration > downbeat) note.duration = downbeat - note.startTime;
  });
  const chordAtDownbeat = chordAt(ctx.chords, downbeat);
  const cadenceChord = chordAtDownbeat ?? chordAt(ctx.chords, plan.startTime + plan.duration - 1);
  const targetPc = cadenceTargetPc(cadenceChord, ctx.config) ?? pc(ctx.config.keyRoot);
  const cadenceDuration = plan.startTime + plan.duration - downbeat;
  if (cadenceDuration > 0) {
    produced.push({
      concertPitch: pitchInClassAmong([targetPc], ctx.leadRange, produced.at(-1)?.concertPitch ?? ctx.leadRange.high - 2),
      startTime: downbeat,
      duration: cadenceDuration,
      isCadence: true,
    });
  }
  void rng; // liquidation is contour-deterministic; rng reserved for future weighting
  void scale;
  void beatTicks;
}

/** E.7 — main entry: replace LEAD events for all sections. */
export function applyThemeEngine(events: AbstractNoteEvent[], ctx: ThemeContext, seed: number): ThemeResult {
  if (ctx.enabled && !ctx.enabled.germ) {
    return { events, regenerated: false };
  }
  if (!ctx.sections.length || !ctx.leadInstrumentIds.length || !ctx.chords.length) {
    return { events, regenerated: false };
  }
  const rng = mulberry32(seed + 0xe551);
  const beatTicks = (PPQ * 4) / ctx.config.timeSignature[1];
  const ticksPerBar = ctx.config.timeSignature[0] * beatTicks;
  const germs = pickGerms(rng);
  const plans = planPhrases(ctx.sections, rng, ticksPerBar);

  // E.7 — instrument assignment: the motif phrases rotate across the PRE-EXISTING
  // lead layer (the distinct instrumentIds currently carrying LEAD), in phrase
  // order, so no lead instrument is emptied (one instrument per phrase slice).
  const leadInstrumentCycle = [...new Set(events.filter((event) => event.role === "LEAD").map((event) => event.instrumentId))];
  const fallbackInstrument = leadInstrumentCycle[0] ?? ctx.leadInstrumentIds[0]!;
  const fallbackProfile = ctx.profiles.find((candidate) => candidate.id === fallbackInstrument)
    ?? ctx.profiles.find((candidate) => candidate.id === ctx.leadInstrumentIds[0]);

  const produced: AbstractNoteEvent[] = [];
  for (let planIndex = 0; planIndex < plans.length; planIndex++) {
    const plan = plans[planIndex]!;
    const instrumentId = leadInstrumentCycle.length
      ? leadInstrumentCycle[planIndex % leadInstrumentCycle.length]!
      : fallbackInstrument;
    const planProfile = ctx.profiles.find((candidate) => candidate.id === instrumentId) ?? fallbackProfile;
    const offset = planProfile?.transpositionSemitones ?? 0;
    const writtenLow = planProfile?.comfortableRange?.low ?? planProfile?.writtenRange.low ?? ctx.leadRange.low;
    const writtenHigh = planProfile?.comfortableRange?.high ?? planProfile?.writtenRange.high ?? ctx.leadRange.high;
    const notes = realizePhrase(plan, ctx, rng, germs);
    for (const note of notes) {
      const energy = energyAt(ctx, note.startTime);
      const registerOffset = note.concertPitch < 48 ? -0.03 : note.concertPitch > 84 ? 0.025 : 0;
      produced.push({
        instrumentId,
        pitchConcert: note.concertPitch,
        pitchWritten: clamp(note.concertPitch + offset, writtenLow, writtenHigh),
        startTime: Math.round(note.startTime),
        duration: Math.max(1, Math.round(note.duration)),
        normalizedDynamic: clamp(energy + (planProfile?.dynamicOffset ?? 0) + registerOffset, 0, 1),
        semanticArticulation: "LEGATO",
        role: "LEAD",
      });
    }
  }
  if (!produced.length) return { events, regenerated: false };
  const others = events.filter((event) => event.role !== "LEAD");
  const merged = [...others, ...produced].sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
  return { events: merged, regenerated: true };
}

function energyAt(ctx: ThemeContext, time: number): number {
  const beatTicks = (PPQ * 4) / ctx.config.timeSignature[1];
  const index = Math.floor(time / beatTicks);
  return clamp(ctx.energies[index] ?? 0.5, 0, 1);
}
