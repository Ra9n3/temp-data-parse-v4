/**
 * Module 12 — Percussion Sub-Engine (SOLE content source for the battery).
 *
 * Supersedes M8's transition-gesture percussion (the gesture code has been
 * deleted from arrangement.ts). M8 wrote hand-rolled timpani rolls + cymbal
 * swells as fixed gestures only at Build→Chorus boundaries; M12 is the
 * generalized engine driven by M8's measure profiles (per-measure Es),
 * section spans and project.chords:
 *
 *   rolls during BUILD — swells into CHORUS downbeats — crashes at tutti
 *   beat 1 — cadence accents at section ends.
 *
 * DETERMINISM LAW: no RNG anywhere in this module (see the generate.ts RNG
 * registry). Roll "jitter" (spec: ±2 ms timing / ±3 velocity) is implemented
 * as DETERMINISTIC ALTERNATION — an index-based sign alternation instead of a
 * randomized one (same law that banned Math.random in Module G; a period-2
 * alternation reads as "a tight player", which is right for orchestral
 * percussion).
 *
 * Balance does NOT process percussion (the battery sits outside the semantic
 * pipeline), so this engine bakes its own dynamics (cc11/cc74) at note
 * creation. Wiring position: post-bake, pre-MonophonyGuard — the guard remains
 * the FINAL invariant. Non-percussion tracks pass through untouched
 * (byte-identity is field-diff-proven per the M8.8/M10/M11 precedent).
 *
 * Home tracks (bowl/range validation lives HERE at the pure level — generation
 * never emits an out-of-range note; Task 12.7 range errors throw at compile-free
 * call sites, not in generated output):
 *   trk_timpani  pitch 38–57 (validated against the bowl table)
 *   trk_snare    pitch 38 (one pitch, by construction)
 *   trk_cymbals  pitch 49 (one pitch, by construction)
 *   trk_aux      36–81 (multi-percussion chair, GM-style pitch map)
 *
 * Deferred ON PURPOSE (no mallet home tracks exist — see ASSUMPTIONS):
 * Marimba/vibraphone/glockenspiel/xylophone/celesta CONTENT generation waits
 * for the native era. Their machinery (transposition adapter, vibraphone
 * controllers, decay-roll rules, bowl/range validation) ships NOW as pure
 * functions + data — library-ready, content-ready, unexercised by generation.
 */
import { msToTicks, ticksPerBar, ticksPerBeat } from "../shared/schema/time";
import type { Note, Project, Track } from "../shared/schema/types";
import type { MeasureProfile } from "./arrangement";
import { sectionTypeFor } from "./arrangement";
import { parseChord } from "../shared/schema/chords";
import { INSTRUMENT_DATABASE } from "./instrumentDB";

// ---------------------------------------------------------------- types

export type VelocityTier = "GHOST" | "GROOVE" | "ACCENT";
export type MalletHardness = "SOFT_FELT" | "HARD_WOOD";

/** Spec-adapted: pitched percussion rides the regular Note (additive optional
 * malletType/velocityTier/isRoll metadata — see shared/schema/types.ts). */
export type PitchedPercussionNote = Note;

export interface TimpaniBowlConfig {
  /** Machine-bowl diameter in inches (32", 29", 26", 23"). */
  size: 32 | 29 | 26 | 23;
  /** MIDI range the bowl supports. Overlaps (42–44, 47–49, 52–54) resolve
   * lowest-bowl-first: bands are FIRST-MATCHED in BOWLS declaration order. */
  range: [number, number];
}

export interface NonPitchedPercussionEvent {
  trackId: string;
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
  tier: VelocityTier;
  cc11Value: number;
  cc74Value: number;
}

export interface PercussionCcEvent { cc: number; tick: number; value: number }

export interface PercussionContext {
  project: Project;
  measures: MeasureProfile[];
  config: { enableAutoBuildStaggering: boolean; enableTransitionGestures: boolean; breakdownExposedLayer: string };
}

/** GM-style multi-percussion chair map (trk_aux, range 36–81 — every entry is
 * inside the aux track's range by construction). */
export const AUX_PITCH_MAP = { kick: 36, hiHat: 42, tomMid: 45, ride: 51, triangle: 81 } as const;
export type AuxPercussionKey = keyof typeof AUX_PITCH_MAP;

// ---------------------------------------------------------------- bowls

export const TIMPANI_RANGE = { low: 38, high: 57 } as const;

/** Spec bowl table. The 32" lowest machine spans 38–44; the 23" spans 52–57.
 * Out-of-range pitches (≤37, ≥58) are EXPLICIT range errors (Task 12.7). */
export const BOWLS: readonly TimpaniBowlConfig[] = [
  { size: 32, range: [38, 44] },
  { size: 29, range: [42, 49] },
  { size: 26, range: [47, 54] },
  { size: 23, range: [52, 57] },
];

export type BowlAllocation = { ok: true; bowl: TimpaniBowlConfig } | { ok: false; error: string };

/** Validate a requested pitch ∈ bowl table and report the bowl. Tie rule:
 * overlapping bands resolve LOWEST-BOWL-FIRST via the first-match scan order. */
export function allocateBowl(pitch: number): BowlAllocation {
  for (const bowl of BOWLS) {
    if (pitch >= bowl.range[0] && pitch <= bowl.range[1]) return { ok: true, bowl };
  }
  return { ok: false, error: `timpani pitch ${pitch} sits outside every bowl range (38–57)` };
}

/** Pitch selection chain (decision 4): chord root → 5th → nearest bowl-compliant
 * pitch via a pitch-in-class scan of [38, 57]. pitchInClass resolves any pitch
 * class into range, so the 5th/clamp fallbacks fire only for undefined roots. */
export function timpaniTargetPitch(rootPitchClass: number | undefined, preferred: number): number {
  const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;
  if (rootPitchClass !== undefined) {
    const root = pc(rootPitchClass);
    const members: number[] = [];
    for (let pitch = TIMPANI_RANGE.low; pitch <= TIMPANI_RANGE.high; pitch++) {
      if (pc(pitch) === root) members.push(pitch);
    }
    if (members.length) {
      return members.reduce((best, pitch) => Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, members[0]!);
    }
    // Root class unrepresentable → the 5th of the same chord.
    const fifth = root + 7;
    const fifthMembers: number[] = [];
    for (let pitch = TIMPANI_RANGE.low; pitch <= TIMPANI_RANGE.high; pitch++) {
      if (pc(pitch) === pc(fifth)) fifthMembers.push(pitch);
    }
    if (fifthMembers.length) {
      return fifthMembers.reduce((best, pitch) => Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, fifthMembers[0]!);
    }
  }
  // Else: nearest bowl-compliant pitch (straight clamp into the bowl gamut).
  return Math.max(TIMPANI_RANGE.low, Math.min(TIMPANI_RANGE.high, preferred));
}

// ---------------------------------------------------------------- pure helpers

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;

export function tierForVelocity(velocity: number): VelocityTier {
  if (velocity < 40) return "GHOST";
  if (velocity <= 90) return "GROOVE";
  return "ACCENT";
}

/** Decision 9: pp–mf → SOFT_FELT, f–ff → HARD_WOOD (thresholds mirror the
 * velocity tiers: up to the GROOVE ceiling is felt, the ACCENT band is wood). */
export function malletForDynamic(velocity: number): MalletHardness {
  return velocity <= 90 ? "SOFT_FELT" : "HARD_WOOD";
}

/** Decision 10: CC74 baked into dynamics.cc74Value for percussion notes. */
export function percussionCc74(velocity: number): number {
  return clamp(Math.round(40 + velocity * 0.45), 0, 127);
}

/** Log CC11 ramp along a roll: 30 → 118, strictly monotonic. */
export function rollCc11Along(t: number): number {
  const fraction = clamp(t, 0, 1);
  return Math.round(30 + (118 - 30) * (Math.log(1 + 9 * fraction) / Math.log(10)));
}

/** Mallet written transposition, read straight from the instrument database
 * (xylophone +12, glockenspiel +24, celesta +12 — DB-native, unit-tested). */
export function malletTransposition(id: string): { ok: boolean; semitones?: number; error?: string } {
  const profile = INSTRUMENT_DATABASE.find((entry) => entry.id === id);
  if (!profile) return { ok: false, error: `mallet instrument ${id} is not in the instrument database` };
  return { ok: true, semitones: profile.transpositionSemitones };
}

/** Vibraphone controller stream (deferred content, pure). Pedal-sustain holds
 * the decay for the note span; the motor pulses on at onset. CC numbers follow
 * the documented big-freeze convention (sustain = M4's CC64). */
export const VIBRAPHONE_SUSTAIN_CC = 64;
export const VIBRAPHONE_MOTOR_CC = 95;
export function vibraphoneControllers(note: { startTick: number; durationTicks: number }): PercussionCcEvent[] {
  const end = note.startTick + Math.max(1, note.durationTicks);
  return [
    { cc: VIBRAPHONE_SUSTAIN_CC, tick: note.startTick, value: 127 },
    { cc: VIBRAPHONE_MOTOR_CC, tick: note.startTick, value: 60 },
    { cc: VIBRAPHONE_SUSTAIN_CC, tick: end, value: 0 },
  ];
}

/** Mallet decay-roll table (library estimates pending native samples). A single
 * struck note that would sound longer than maxUnstruckMs must become a roll. */
export const MALLET_DECAY: readonly { id: string; maxUnstruckMs: number }[] = [
  { id: "xylophone", maxUnstruckMs: 900 },
  { id: "marimba", maxUnstruckMs: 1300 },
  { id: "glockenspiel", maxUnstruckMs: 2200 },
  { id: "celesta", maxUnstruckMs: 3000 },
  { id: "vibraphone", maxUnstruckMs: 4000 },
];
export function needsDecayRoll(id: string, durationMs: number): boolean {
  const entry = MALLET_DECAY.find((candidate) => candidate.id === id);
  return entry !== undefined && durationMs > entry.maxUnstruckMs;
}

// ---------------------------------------------------------------- roll conversion

export interface RollSource {
  pitch: number;
  startTick: number;
  /** Long-note span (>0.5 s ⇒ unmeasured roll, decision 5). */
  durationTicks: number;
  velocity?: number;
}

export interface RollOptions {
  bpm: number;
  /** Sixteenth-note length in ticks (the engine derives it from the time signature). */
  stepTicks: number;
  /** Hard end the roll must never cross: section edges (M8 drop semantics). */
  truncateAt?: number;
  /** Terminating accent velocity (default 112, the M8 heritage accent). */
  accentVelocity?: number;
  /** ff rolls hit 32nds. */
  thirtySeconds?: boolean;
}

export interface RollResult { notes: Note[]; span: { start: number; end: number } }

/** Detect roll INTENT: duration > 0.5 s ⇒ explicit roll conversion. */
export function isRollIntent(source: RollSource, bpm: number): boolean {
  return source.durationTicks > msToTicks(500, bpm);
}

/** Decision 5 — unmeasured-roll conversion. Any timpani/snare long note whose
 * duration exceeds 0.5 s (or carries explicit roll intent) becomes a SIXTEENTH
 * stream (THIRTY-SECONDS at ff) with a velocity ramp 40→95 and a log CC11 ramp
 * 30→118, terminated by an ACCENT at the span end.
 *
 * The roll TOTAL SPAN is the source long note's span and never crosses section
 * boundaries (truncateAt preserves M8's drop semantics at breakdown/build
 * edges). Jitter is DETERMINISTIC ALTERNATION, period 2: timing ±(2 ms→ticks),
 * velocity ±3 on regular hits; the terminating accent lands exactly and carries
 * no jitter drift. Because the velocity jitter has period 2, monotonicity of the
 * ramp holds on every second hit (the checker asserts the period-2 envelope). */
export function convertRoll(source: RollSource, options: RollOptions): RollResult {
  const hardEnd = options.truncateAt !== undefined
    ? Math.min(source.startTick + source.durationTicks, options.truncateAt)
    : source.startTick + source.durationTicks;
  const spanTicks = Math.max(0, hardEnd - source.startTick);
  if (spanTicks <= 0) return { notes: [], span: { start: source.startTick, end: hardEnd } };
  const baseStep = Math.max(1, Math.round(options.stepTicks / (options.thirtySeconds ? 2 : 1)));
  const accentVelocity = clamp(options.accentVelocity ?? 112, 1, 127);
  const accentTicks = Math.max(1, Math.round(baseStep * 0.9));
  const jitterTicks = Math.max(1, Math.round(msToTicks(2, options.bpm)));
  const regularEnd = Math.min(hardEnd, Math.max(0, hardEnd - accentTicks));
  // Degenerate spans below one full hit: a single early accent carries the roll.
  if (regularEnd <= source.startTick) {
    const velocity = accentVelocity;
    return {
      notes: [percNoteShape({ pitch: source.pitch, startTick: Math.max(0, source.startTick), durationTicks: Math.max(1, Math.round(spanTicks)), velocity, isRoll: true, cc11: 118 })],
      span: { start: source.startTick, end: hardEnd },
    };
  }
  const count = Math.max(2, Math.ceil((regularEnd - source.startTick) / baseStep) + 1);
  const rampAt = (index: number, total: number) => clamp(Math.round(40 + (95 - 40) * (index / Math.max(1, total - 1))), 1, 127);
  const notes: Note[] = [];
  for (let index = 0; index < count; index++) {
    const isTerminator = index === count - 1;
    if (isTerminator) {
      notes.push(percNoteShape({ pitch: source.pitch, startTick: regularEnd, durationTicks: accentTicks, velocity: accentVelocity, isRoll: true, cc11: 118 }));
      break;
    }
    const startTick = Math.round(source.startTick + index * baseStep);
    if (startTick > regularEnd - 1) break;
    const jitterSign = index % 2 === 0 ? 1 : -1;
    const velocity = clamp(rampAt(index, count) + jitterSign * 3, 1, 127);
    notes.push(percNoteShape({
      pitch: source.pitch,
      startTick: Math.max(0, startTick + jitterSign * jitterTicks),
      durationTicks: Math.max(1, Math.round(baseStep * 0.85)),
      velocity,
      isRoll: true,
      cc11: rollCc11Along(index / Math.max(1, count - 1)),
      thirtySecondsStep: baseStep,
    }));
  }
  return { notes, span: { start: source.startTick, end: hardEnd } };
}

// ---------------------------------------------------------------- pedal glissando

export interface PedalGlissLeg {
  pitch: number;
  /** M4-clamped bend points (±200 cents) gliding toward the next leg's pitch. */
  points: Array<{ tick: number; cents: number }>;
  /** End of this leg's glide window (the next leg's notes start here). */
  legEndTick: number;
}

/** Decision 6 — PEDAL GLISSANDO (library-ready; generation-time retunes only
 * happen at ≥2-measure rests where no roll is active, decided by the engine):
 * a retune DURING an active roll glides via M4's pitchBendPoints over ≤1 bar.
 * Documented choice for >200-cent retunes: they SPLIT into chained legs — each
 * leg's bend stays within M4's ±200 clamp and legs step ≤2 semitones through
 * intermediate bowl-compliant pitches — rather than clamping. The sound is a
 * real timpani pedal sweep chunked across the spinning roll. */
export function pedalGliss(oldPitch: number, newPitch: number, startTick: number, endTick: number, bpm: number): PedalGlissLeg[] {
  const span = Math.max(1, Math.min(msToTicks(960, bpm), endTick - startTick)); // ≤1-bar glide window
  const legs: PedalGlissLeg[] = [];
  let current = oldPitch;
  let cursor = startTick;
  let guard = 0;
  while (Math.abs(newPitch - current) > 2 && guard++ < 12) {
    const direction = Math.sign(newPitch - current);
    const legEnd = Math.min(startTick + span, Math.max(cursor + 1, cursor + Math.round(span / 3)));
    legs.push({ pitch: current, points: [ { tick: cursor, cents: 0 }, { tick: legEnd, cents: direction * 200 } ], legEndTick: legEnd });
    current += direction * 2;
    cursor = legEnd;
  }
  legs.push({ pitch: current, points: [ { tick: cursor, cents: 0 }, { tick: Math.max(cursor, startTick + span), cents: (newPitch - current) * 100 } ], legEndTick: Math.max(cursor, startTick + span) });
  return legs;
}

/** Library path for mid-roll retunes: hits after the glide window sound at the
 * new pitch; the last hit inside each leg carries that leg's bend ramp. */
export function applyPedalRetune(hits: Note[], oldPitch: number, newPitch: number, bpm: number, glideStartTick?: number): Note[] {
  if (oldPitch === newPitch || hits.length === 0) return hits;
  const startTick = Math.max(0, glideStartTick ?? hits[0]!.startTick);
  const endTick = Math.max(...hits.map((hit) => hit.startTick + hit.durationTicks));
  const legs = pedalGliss(oldPitch, newPitch, startTick, endTick, bpm);
  const finalLegEnd = legs.at(-1)!.legEndTick;
  const out: Note[] = [];
  for (const hit of hits) {
    if (hit.startTick >= finalLegEnd) {
      out.push({ ...hit, pitch: newPitch });
      continue;
    }
    const leg = legs.find((candidate) => hit.startTick >= candidate.points[0]!.tick && hit.startTick < candidate.legEndTick) ?? legs.at(-1)!;
    const legMembers = hits.filter((candidate) => candidate.startTick >= leg.points[0]!.tick && candidate.startTick < leg.legEndTick);
    const lastInLeg = legMembers.at(-1)!.startTick === hit.startTick;
    out.push(lastInLeg || hit.startTick >= legs[0]!.points[0]!.tick + 1
      ? { ...hit, pitch: leg.pitch, pitchBendPoints: leg.points }
      : { ...hit, pitch: leg.pitch });
  }
  return out;
}

// ---------------------------------------------------------------- ledger

/** Per-track ledger: distinct gestures may never overlap (one player per chair —
 * the engine must not roll AND crash the same instrument at the same instant). */
class GestureLedger {
  private entries: Array<{ start: number; end: number }> = [];
  tryAdd(entry: { start: number; end: number }): boolean {
    const clash = this.entries.some((candidate) => candidate.start < entry.end && entry.start < candidate.end);
    if (clash) return false;
    this.entries.push(entry);
    return true;
  }
  overlaps(start: number, end: number): boolean {
    return this.entries.some((candidate) => candidate.start < end && start < candidate.end);
  }
  get windowCount(): number { return this.entries.length; }
}

// ---------------------------------------------------------------- spans & chords

interface PercSpan {
  type: string;
  start: number;
  end: number;
  peakEnergy: number;
  /** Any measure in the Dense band (subdivision cap 4 ⇔ energy ≥ 0.70). */
  highEnergy: boolean;
  index: number;
}

function spansFromMeasures(measures: MeasureProfile[]): PercSpan[] {
  const out: PercSpan[] = [];
  for (const measure of measures) {
    const previous = out.at(-1);
    if (previous && previous.type === measure.sectionType) {
      previous.end = measure.endTick;
      previous.peakEnergy = Math.max(previous.peakEnergy, measure.energy);
      previous.highEnergy = previous.highEnergy || measure.maxSubdivisionsPerBeat >= 4;
      continue;
    }
    out.push({ type: measure.sectionType, start: measure.startTick, end: measure.endTick, peakEnergy: measure.energy, highEnergy: measure.maxSubdivisionsPerBeat >= 4, index: out.length });
  }
  return out;
}

/** Chord root pitch class at a tick, from the REAL chord parser (no second
 * mapper). Falls back to the project key when no parsed chord covers the tick. */
function chordRootAt(project: Project, tick: number): number {
  const covering = project.chords
    .filter((block) => block.startTick <= tick && tick < block.startTick + block.durationTicks)
    .sort((a, b) => a.startTick - b.startTick)
    .at(-1);
  if (covering) {
    const parsed = parseChord(covering.symbol);
    if (parsed.ok) return parsed.chord.root;
  }
  return project.key;
}

// ---------------------------------------------------------------- note factory

/** Build one engine Note with baked dynamics (balance never touches these).
 * Timing discipline: no offset beyond the ±2 ms roll jitter (≪ the ±15 ms cap);
 * startTick ≥ 0 and durationTicks ≥ 1 enforced here. */
function percNote(args: { pitch: number; startTick: number; durationTicks: number; velocity: number; isRoll?: boolean; cc11?: number }): Note {
  const velocity = clamp(Math.round(args.velocity), 1, 127);
  return {
    pitch: args.pitch,
    startTick: Math.max(0, Math.round(args.startTick)),
    durationTicks: Math.max(1, Math.round(args.durationTicks)),
    velocity,
    dynamics: {
      cc11Value: clamp(Math.round(args.cc11 ?? velocity * 0.9), 0, 127),
      cc74Value: percussionCc74(velocity),
      attenuationActive: false,
    },
    velocityTier: tierForVelocity(velocity),
    ...(args.isRoll ? { isRoll: true } : {}),
  };
}
function percNoteShape(args: { pitch: number; startTick: number; durationTicks: number; velocity: number; isRoll?: boolean; cc11?: number; thirtySecondsStep?: number }): Note {
  const note = percNote(args);
  void args.thirtySecondsStep;
  return note;
}

// ---------------------------------------------------------------- engine

interface TimpaniWindow { start: number; end: number; kind: "roll" | "hit"; peakEnergy: number }

/** Module 12 entry point — replaces applyArrangementGestures at the same wiring
 * position (post-bake, pre-MonophonyGuard). Percussion-track content is FULLY
 * OWNED by this engine (supersede: M8's gesture percussion is deleted); every
 * other track passes through untouched. */
export function generatePercussion(tracks: Track[], ctx: PercussionContext): Track[] {
  const { project, measures } = ctx;
  void ctx.config; // arrangement config stays data-only: M12 supersedes its flags
  if (!measures.length) return tracks;
  if (project.generationSettings?.orchestration?.enabledGroups?.percussion === false) return tracks;
  const idOf = (id: string) => tracks.find((track) => track.id === id && track.family === "percussion");
  const timpaniTrack = idOf("trk_timpani");
  const snareTrack = idOf("trk_snare");
  const cymbalTrack = idOf("trk_cymbals");
  const auxTrack = idOf("trk_aux");
  if (!timpaniTrack && !snareTrack && !cymbalTrack && !auxTrack) return tracks;

  const barTicks = ticksPerBar(project.timeSignature);
  const beatTicks = ticksPerBeat(project.timeSignature);
  const stepTicks = Math.max(1, Math.round(beatTicks / 4)); // the 16th
  const bpm = project.bpm;
  const spans = spansFromMeasures(measures);
  const timpaniLedger = new GestureLedger();
  const snareLedger = new GestureLedger();
  const cymbalLedger = new GestureLedger();
  const auxLedger = new GestureLedger();

  // ---------------- Timpani: window PLAN first, then tuning, then notes.
  const timpaniPlan: TimpaniWindow[] = [];
  for (const span of spans) {
    if (span.type === "Build") {
      // Roll into the boundary: the final 2 bars of the build (the M8 gesture,
      // generalized to every Build and driven by measure energy).
      const rollStart = Math.max(span.start, span.end - 2 * barTicks);
      const accentResidue = Math.round(beatTicks * 0.25);
      if (timpaniLedger.tryAdd({ start: rollStart, end: span.end + accentResidue })) {
        timpaniPlan.push({ start: rollStart, end: span.end, kind: "roll", peakEnergy: span.peakEnergy });
        // The terminating accent lives ON the chorus downbeat; it blocks the
        // chorus downbeat hit (one player at one instant — the ledger holds).
        timpaniLedger.tryAdd({ start: span.end, end: span.end + accentResidue });
      }
    }
    if (span.type === "Chorus") {
      const hitStart = span.start;
      if (timpaniLedger.tryAdd({ start: hitStart, end: hitStart + Math.round(beatTicks / 2) })) {
        timpaniPlan.push({ start: hitStart, end: hitStart + Math.round(beatTicks / 2), kind: "hit", peakEnergy: span.peakEnergy });
      }
    }
    if (span.type !== "Breakdown" && span.start > 0) {
      // Cadence accent at section ends: the last beat, gated by ledger and
      // energy (kept tasteful — skip under-soft sections).
      const cadenceTick = span.end - beatTicks;
      if (cadenceTick > 0 && span.peakEnergy >= 0.45 && timpaniLedger.tryAdd({ start: cadenceTick, end: span.end })) {
        timpaniPlan.push({ start: cadenceTick, end: span.end, kind: "hit", peakEnergy: span.peakEnergy });
      }
    }
  }
  // Tuning (decisions 4+8): every window that begins AFTER a ≥2-measure silence
  // (gap between the previous window's END and this tick, or project start) may
  // retune to the chord root AT that tick; otherwise the previous tuning holds
  // (a real timpanist doesn't pedal mid-phrase). One pitch per gesture.
  const timpaniNotes: Note[] = [];
  let tuning = timpaniTargetPitch(chordRootAt(project, 0), 45);
  let previousEnd = -Infinity;
  const sortedPlan = [...timpaniPlan].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const window of sortedPlan) {
    if (previousEnd === -Infinity || window.start - previousEnd >= 2 * barTicks) {
      const root = chordRootAt(project, Math.max(0, window.start));
      const target = timpaniTargetPitch(root, 45);
      if (pc(target) !== pc(tuning)) tuning = target; // retune inside the rest
    }
    previousEnd = Math.max(previousEnd, window.end);
    const bowl = allocateBowl(tuning);
    if (!bowl.ok) console.warn("[scorch] timpani pitch outside bowl gamut (clamped)", tuning, bowl.error);
    if (window.kind === "roll") {
      const result = convertRoll(
        { pitch: tuning, startTick: window.start, durationTicks: window.end - window.start },
        { bpm, stepTicks, thirtySeconds: window.peakEnergy >= 0.9, accentVelocity: 112 },
      );
      timpaniNotes.push(...result.notes);
    } else {
      timpaniNotes.push({ ...percNote({ pitch: tuning, startTick: window.start, durationTicks: window.end - window.start, velocity: clamp(Math.round(70 + 40 * window.peakEnergy), 1, 127) }), malletType: malletForDynamic(clamp(Math.round(70 + 40 * window.peakEnergy), 1, 127)) });
    }
  }

  // ---------------- Snare: rolls at BUILD + cadence approach, GHOST 16ths
  // under high-energy choruses (sparse — one 16th per beat), tutti downbeat
  // accents. Pitch is ALWAYS 38 (the home track's single pitch).
  const snareNotes: Note[] = [];
  for (const span of spans) {
    if (span.type === "Build") {
      const rollStart = Math.max(span.start, span.end - 2 * barTicks);
      const accentResidue = Math.round(beatTicks * 0.25);
      if (snareLedger.tryAdd({ start: rollStart, end: span.end + accentResidue })) {
        snareNotes.push(...convertRoll(
          { pitch: 38, startTick: rollStart, durationTicks: span.end - rollStart },
          { bpm, stepTicks, thirtySeconds: span.peakEnergy >= 0.9, accentVelocity: 112 },
        ).notes);
      }
    }
    if (span.type === "PreChorus") {
      // Cadence approach: a one-bar sixteenth roll into the next section.
      const rollStart = Math.max(span.start, span.end - barTicks);
      const accentResidue = Math.round(beatTicks * 0.25);
      if (snareLedger.tryAdd({ start: rollStart, end: span.end + accentResidue })) {
        snareNotes.push(...convertRoll(
          { pitch: 38, startTick: rollStart, durationTicks: span.end - rollStart },
          { bpm, stepTicks, thirtySeconds: false, accentVelocity: 100 },
        ).notes);
      }
    }
    if (span.type === "Chorus") {
      if (snareLedger.tryAdd({ start: span.start, end: span.start + Math.round(beatTicks / 2) })) {
        snareNotes.push(percNote({ pitch: 38, startTick: span.start, durationTicks: Math.round(beatTicks / 2), velocity: 105 }));
      }
      let ghostIndex = 0;
      for (let tick = span.start + beatTicks; tick + stepTicks <= span.end; tick += beatTicks) {
        if (!span.highEnergy) break;
        // Sparse: every 4th sixteenth i.e. one ghost per BEAT, off the downbeat.
        ghostIndex++;
        if (snareLedger.tryAdd({ start: tick, end: tick + stepTicks })) {
          snareNotes.push(percNote({ pitch: 38, startTick: tick, durationTicks: Math.max(1, Math.round(stepTicks * 0.5)), velocity: ghostIndex % 2 === 0 ? 26 : 22 }));
        }
      }
      const cadenceTick = span.end - beatTicks;
      if (cadenceTick > span.start && snapLedger(snareLedger, cadenceTick, span.end)) {
        snareNotes.push(percNote({ pitch: 38, startTick: cadenceTick, durationTicks: Math.round(beatTicks), velocity: 92 }));
      }
    }
  }

  // ---------------- Cymbals: swells (2–4 bar log-CC11 build, length from the
  // incoming measure energy) terminating in a crash at the Chorus downbeat;
  // crash also at tutti beat 1 for non-chorus tutti spans. No damp. Pitch 49.
  const cymbalNotes: Note[] = [];
  for (const span of spans) {
    if (span.type !== "Chorus" && !span.highEnergy) continue;
    if (span.type === "Chorus") {
      const previous = spans[span.index - 1];
      const bars = !previous ? 3 : previous.peakEnergy >= 0.85 ? 2 : previous.peakEnergy >= 0.6 ? 3 : 4;
      const swellStart = Math.max(0, span.start - bars * barTicks);
      if (span.start - swellStart < barTicks) continue; // no runway → skip (ledger keeps this honest)
      if (!cymbalLedger.tryAdd({ start: swellStart, end: span.start + 2 * beatTicks })) continue;
      const quarterTicks = Math.max(1, Math.round(beatTicks));
      const swellHitCount = Math.max(1, Math.floor((span.start - swellStart) / quarterTicks));
      for (let index = 0; index < swellHitCount; index++) {
        const t = Math.max(0, Math.round(swellStart + index * quarterTicks));
        if (t >= span.start - 1) break;
        const progress = index / Math.max(1, swellHitCount - 1);
        cymbalNotes.push(percNote({ pitch: 49, startTick: t, durationTicks: Math.round(quarterTicks * 0.7), velocity: Math.round(30 + 40 * progress), cc11: Math.round(25 + (112 - 25) * progress) }));
      }
      // The terminating crash at the chorus downbeat (no damp, ACCENT tier).
      cymbalNotes.push(percNote({ pitch: 49, startTick: span.start, durationTicks: 2 * beatTicks, velocity: 116, cc11: 118 }));
    } else {
      // Crash at tutti beat 1 for non-chorus tutti spans (energy ≥ Dense band).
      if (cymbalLedger.tryAdd({ start: span.start, end: span.start + 2 * beatTicks })) {
        cymbalNotes.push(percNote({ pitch: 49, startTick: span.start, durationTicks: 2 * beatTicks, velocity: 114, cc11: 118 }));
      }
    }
  }

  // ---------------- Aux (multi-percussion chair): deliberately SHY in v1 —
  // cadence accents at Chorus ends + one pulse figure (ride on beats 1&3) at
  // high energy. First content on an empty-since-forever track must not
  // become a tic; the full auxiliary palette waits for the native era.
  const auxNotes: Note[] = [];
  for (const span of spans) {
    if (span.type !== "Chorus") continue;
    const kickTick = span.end - beatTicks;
    if (kickTick > span.start && auxLedger.tryAdd({ start: kickTick, end: kickTick + beatTicks })) {
      auxNotes.push(percNote({ pitch: AUX_PITCH_MAP.kick, startTick: kickTick, durationTicks: Math.round(beatTicks * 0.5), velocity: 96 }));
    }
    if (span.highEnergy) {
      for (let tick = span.start; tick + 1 <= span.end; tick += barTicks) {
        for (const offset of [0, 2 * beatTicks]) {
          const t = tick + offset;
          if (t >= span.end - 1) continue;
          if (auxLedger.tryAdd({ start: t, end: t + Math.round(beatTicks * 0.35) })) {
            auxNotes.push(percNote({ pitch: AUX_PITCH_MAP.ride, startTick: t, durationTicks: Math.round(beatTicks * 0.35), velocity: 54 }));
          }
        }
      }
    }
  }

  const sortNotes = (notes: Note[]) => notes.sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  return tracks.map((track) => {
    if (track === timpaniTrack) return { ...track, notes: sortNotes(timpaniNotes.map((note) => ({ ...note, malletType: malletForDynamic(note.velocity) }))) };
    if (track === snareTrack) return { ...track, notes: [...snareNotes, ...track.notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch) };
    if (track === cymbalTrack) return { ...track, notes: sortNotes([...cymbalNotes]) };
    if (track === auxTrack) return { ...track, notes: sortNotes([...auxNotes, ...track.notes]) };
    return track; // non-percussion tracks untouched
  });
}

/** Scoped ledger add used by the snare cadence path (kept tiny for readability). */
function snapLedger(ledger: GestureLedger, start: number, end: number): boolean {
  return ledger.tryAdd({ start, end });
}
void sectionTypeFor;
