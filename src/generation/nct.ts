import { MODE_INTERVALS, PPQ, type ModeName } from "../shared/schema/types";
import type { AbstractNoteEvent } from "./generate";
import { mulberry32 } from "./prng";

/**
 * Addendum F — NCT engine (Stage 6.45, after the theme engine, before cells).
 * Operates only on the LEAD stream produced by Addendum E (structural notes).
 *
 * SPEC DEVIATION (F.1, documented): the addendum pseudocode tests `semitoneGap in
 * [19, 20]` for the passing-tone trigger — those are octave+fifth/aug-fifth gaps
 * that never occur between consecutive lead notes, so the rule could never fire.
 * The musically correct trigger is a *third* (3 or 4 semitones), optionally a
 * *tenth* (15 or 16 semitones). This implementation gates on 3/4 with optional
 * 15/16, per the "correct trigger" note in the task spec.
 *
 * Forces F.7 (documentary): suspensions and appoggiaturas are deliberately
 * DEFERRED — the spec matrix lists them, but the checklist scope for this
 * milestone is passing tones + neighbor tones only. Do not add them ad-hoc here.
 */

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;

export interface NctOptions {
  /** Passing-tone insertion probability multiplier (0..1); default 1. */
  passingRate?: number;
  /** Neighbor-tone base probability at full local energy; default 0.45. */
  neighborRate?: number;
  /** Optionally include tenths (15/16 semitone gaps) as passing-tone triggers. */
  includeTenths?: boolean;
  /** Optional deterministic intensity probe (W.2 additive pattern). */
  intensityAt?: (startTime: number) => number;
}

export interface NctContext {
  mode: ModeName;
  keyRoot: number;
  /** Configurable NCT knob block (mirrors ThemesSettingsPartial extensibly). */
  nct?: { passingRate?: number; neighborRate?: number; includeTenths?: boolean };
}

/** Diatonic pitch classes of the project mode. */
export function scalePitchClasses(mode: ModeName, keyRoot: number): number[] {
  return MODE_INTERVALS[mode].map((interval) => pc(keyRoot + interval));
}

/** F.2 — find the diatonic pitch strictly between `low` and `high` when they
 * form a third (or tenth). Walks scale degrees, never midpoint-rounds. */
export function diatonicPassingPitch(low: number, high: number, scale: number[]): number | undefined {
  const gap = Math.abs(high - low);
  const isThird = gap === 3 || gap === 4;
  const isTenth = gap === 15 || gap === 16;
  if (!isThird && !isTenth) return undefined;
  const direction = high > low ? 1 : -1;
  // Walk the scale from the lower bound upward (pc-space) collecting the diatonic
  // pcs strictly between the two bounds; the FIRST one past `low` that sums its
  // arms to the (octave-reduced) gap is the passing tone's pc. Direction of
  // motion matters for which concrete octave the tone lands in, not for the pc.
  const lower = Math.min(low, high);
  const upper = Math.max(low, high);
  const octaveGap = isTenth ? gap - 12 : gap;
  const betweenPc = scale.find((pitchClass) => {
    const a = ((pitchClass - pc(lower)) + 12) % 12;
    const b = ((pc(upper) - pitchClass) + 12) % 12;
    return a + b === octaveGap && a > 0 && b > 0;
  });
  if (betweenPc === undefined) return undefined;
  const base = Math.min(low, high);
  const candidates: number[] = [];
  for (let pitch = base + 1; pitch < Math.max(low, high); pitch++) {
    if (pc(pitch) === betweenPc) candidates.push(pitch);
  }
  if (!candidates.length) {
    // Wrap: the passing tone may live an octave beyond when gap is a tenth.
    const extended = direction > 0 ? lower + gap : upper - gap;
    if (betweenPc !== undefined && pc(extended) === betweenPc) return extended;
    return undefined;
  }
  return candidates[0];
}

/** F.3 — neighbor candidates a single scale step out from `pitch`. */
export function neighborCandidates(pitch: number, scale: number[]): number[] {
  const pitchClass = pc(pitch);
  const out: number[] = [];
  for (const candidate of scale) {
    if (candidate === pitchClass) continue;
    const step = ((candidate - pitchClass) + 12) % 12;
    if (step === 1 || step === 2 || step === 10 || step === 11) out.push(candidate);
  }
  return out;
}

/** F.4 — the above-C3 zone guard: both bounding pitches must be ≥ 48. */
export function aboveC3Guard(a: number, b: number): boolean {
  return a >= 48 && b >= 48;
}

export interface NctInserted {
  pitchConcert: number;
  pitchWritten: number;
  startTime: number;
  duration: number;
  /** Velocity = bounding chord-tone velocity × 0.85 (F.5). */
  velocityFactor: number;
  kind: "passing" | "neighbor";
}

/** F.6 — leap recovery over a finished lead stream: after any leap ≥ 5 semitones,
 * the next motion is nudged stepwise in the opposite direction — ALWAYS a step of
 * ±1–2 semitones (never an octave jump); it is a repair, not a rejection, and it
 * never destroys pitch class. */
export function leapRecoveryFilter(events: Array<{ pitchConcert: number; startTime: number }>): Array<{ pitchConcert: number; startTime: number }> {
  const out = events.map((event) => ({ ...event }));
  for (let i = 1; i < out.length - 1; i++) {
    const current = out[i]!;
    const leap = current.pitchConcert - out[i - 1]!.pitchConcert;
    if (Math.abs(leap) < 5) continue;
    const next = out[i + 1]!;
    const nextMotion = next.pitchConcert - current.pitchConcert;
    const opposite = -Math.sign(leap);
    if (Math.sign(nextMotion) === opposite && Math.abs(nextMotion) <= 2) continue;
    // Repair: step the recovery note one or two semitones in the opposite direction.
    const step = Math.abs(nextMotion) <= 2 ? Math.abs(nextMotion) || 1 : 1;
    next.pitchConcert = current.pitchConcert + opposite * step;
  }
  return out;
}

/** Main entry (F.2–F.6): insert passing + neighbor tones into the LEAD stream.
 * Mutates copies, returns new events alongside unchanged originals. */
export function applyNctPass(
  leadEvents: AbstractNoteEvent[],
  ctx: NctContext & { bpm: number },
  seed: number,
  options: NctOptions = {},
): { events: AbstractNoteEvent[]; inserted: NctInserted[] } {
  const scale = scalePitchClasses(ctx.mode, ctx.keyRoot);
  const inserted: NctInserted[] = [];
  if (!leadEvents.length) return { events: leadEvents, inserted };
  const insertedEventRefs: Array<{ ref: AbstractNoteEvent; record: NctInserted }> = [];
  const rng = mulberry32(seed + 0xf0c8);
  const energy = options.intensityAt ?? (() => 0.6);
  const sorted = [...leadEvents].sort((a, b) => a.startTime - b.startTime);
  const out: AbstractNoteEvent[] = [];
  const beatTicks = (PPQ * 4) / 4; // quarter-note beat reference for sustain threshold

  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i]!);
    const current = sorted[i]!;
    const next = sorted[i + 1];
    if (!next) {
      // F.3 — neighbor on sustained trailing note; same rate draw as the paired
      // branch so rates-off (A/B) inserts nothing and byte-passthrough holds.
      if (current.duration >= beatTicks && aboveC3Guard(current.pitchConcert, current.pitchConcert)
        && energy(current.startTime) > 0
        && rng() < (options.neighborRate ?? ctx.nct?.neighborRate ?? 0.45) * (0.4 + energy(current.startTime) * 0.6)) {
        tryNeighbor(current, current.startTime + current.duration, rng, scale);
      }
      continue;
    }
    // F.4 — non-negotiable: no NCT insertion where either bounding pitch is below C3.
    if (!aboveC3Guard(current.pitchConcert, next.pitchConcert)) continue;
    // F.2 — passing tone between consecutive structural notes a 3rd (or tenth) apart.
    const contiguous = Math.abs(next.startTime - (current.startTime + current.duration)) < 1;
    let passingInserted = false;
    if (contiguous) {
      const passingPitch = diatonicPassingPitch(current.pitchConcert, next.pitchConcert, scale);
      if (passingPitch !== undefined && rng() < (options.passingRate ?? ctx.nct?.passingRate ?? 1)) {
        const mid = (current.startTime + current.duration) / 2;
        pushNct("passing", passingPitch, Math.round(mid), Math.max(1, Math.round(current.duration / 2)), current, next);
        passingInserted = true;
      }
    }
    // F.3 — neighbor on sustained notes (≥ 1 beat). Skip when a passing tone
    // already fills this interval — the weak beat is taken.
    if (!passingInserted && current.duration >= beatTicks) {
      const localEnergy = energy(current.startTime);
      if (rng() < (options.neighborRate ?? ctx.nct?.neighborRate ?? 0.45) * (0.4 + localEnergy * 0.6)) {
        tryNeighbor(current, next.startTime, rng, scale);
      }
    }
  }

  function pushNct(kind: "passing" | "neighbor", concertPitch: number, startTime: number, duration: number, before: AbstractNoteEvent, after?: AbstractNoteEvent) {
    // F.5 — NCT velocity = bounding chord-tone velocity × 0.85.
    const bounding = after?.normalizedDynamic ?? before.normalizedDynamic;
    const factor = 0.85;
    const record: NctInserted = {
      pitchConcert: concertPitch,
      pitchWritten: concertPitch + (before.pitchWritten - before.pitchConcert),
      startTime,
      duration,
      velocityFactor: factor,
      kind,
    };
    inserted.push(record);
    const event: AbstractNoteEvent = {
      ...before,
      pitchConcert: concertPitch,
      pitchWritten: clamp(concertPitch + (before.pitchWritten - before.pitchConcert), 0, 127),
      startTime,
      duration,
      normalizedDynamic: clamp(bounding * factor, 0, 1),
      semanticArticulation: before.semanticArticulation,
      role: "LEAD",
    };
    insertedEventRefs.push({ ref: event, record });
    out.push(event);
  }

  function tryNeighbor(current: AbstractNoteEvent, nextStart: number, _rngRef: () => number, scaleRef: number[]) {
    // Weak-beat: place the neighbor on the second half of the sustained note.
    const half = current.startTime + current.duration / 2;
    if (half + 1 >= nextStart) return;
    if (!aboveC3Guard(current.pitchConcert, current.pitchConcert)) return; // F.4 non-negotiable
    const candidates = neighborCandidates(current.pitchConcert, scaleRef);
    if (!candidates.length) return;
    // Choose the concrete octave so the neighbor is truly one step away and
    // comes back: prefer the candidate nearest `current.pitchConcert`.
    const pitch = candidates
      .map((pitchClass) => {
        const below = pitchClass + 12 * Math.floor((current.pitchConcert - pitchClass) / 12);
        return Math.abs(below - current.pitchConcert) <= 6 ? below : below + 12;
      })
      .sort((a, b) => Math.abs(a - current.pitchConcert) - Math.abs(b - current.pitchConcert))[0]!;
    if (pitch < 48) return; // F.4: the inserted neighbor itself must stay above C3
    pushNct("neighbor", pitch, Math.round(half), Math.max(1, Math.round(current.duration / 2)), current);
  }

  if (inserted.length) {
    // F.6 — leap recovery over the finished lead stream (repair, not rejection),
    // INDEX-ALIGNED so an inserted NCT is never confused with a structural note
    // sharing a startTick. Repairs (±1–2 semitones by construction — never octave
    // jumps) are accepted only for notes this pass inserted; a structural note is
    // left at its original pitch, so the pass can never push structure below C3
    // by mutation, and never octave-jumps a structural note to "fix" the floor.
    const recovery = leapRecoveryFilter(out.map((event) => ({ pitchConcert: event.pitchConcert, startTime: event.startTime })));
    for (let index = 0; index < out.length; index++) {
      const ref = insertedEventRefs.find((entry) => entry.ref === out[index]);
      const repaired = recovery[index]!.pitchConcert;
      if (repaired === out[index]!.pitchConcert) continue;
      if (ref) {
        const delta = repaired - out[index]!.pitchConcert;
        out[index]!.pitchConcert = repaired;
        out[index]!.pitchWritten = clamp(out[index]!.pitchWritten + delta, 0, 127);
        ref.record.pitchConcert = repaired;
        ref.record.pitchWritten = clamp(ref.record.pitchWritten + delta, 0, 127);
      }
      // structural notes: repair discarded; original pitch preserved.
    }
    // F.4 backstop: every inserted NCT — INCLUDING after leap-repair — must stay
    // above C3. Octave-raise the NCT only; structural events are never moved here.
    for (const entry of insertedEventRefs) {
      if (entry.ref.pitchConcert < 48 && entry.ref.pitchConcert + 12 <= 127) {
        entry.ref.pitchConcert += 12;
        entry.ref.pitchWritten = clamp(entry.ref.pitchWritten + 12, 0, 127);
        entry.record.pitchConcert = entry.ref.pitchConcert;
      }
    }
  }

  return { events: out.sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert), inserted };
}

/** Reused zone-compliance check pattern (G.4): both pitches below C3 must form an
 octave, P4, or P5 — mirrors generate.ts isZoneCompliantInterval. */
export function zoneCompliant(low: number, high: number): boolean {
  if (low >= 48) return true;
  const intervalPc = (((high - low) % 12) + 12) % 12;
  if (low < 36) return intervalPc === 0;
  return intervalPc === 0 || intervalPc === 5 || intervalPc === 7;
}
