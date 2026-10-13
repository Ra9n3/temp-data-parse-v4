/**
 * Module 10 — Humanization v2 (role timing, metrical accents, intonation
 * physics, conductor map). DELTA over the existing engine:
 *
 * OWNERSHIP MAP (the whole risk of this module is double-processing):
 *   Effect                                   Sole owner                    M10 role
 *   Repetition velocity/timing jitter (±4,   AMG engine (M4, salt 0xb0b5)  NONE — verify-only
 *     ±2 ms, bow alternation)
 *   Unison anti-flange detune                M6 anti-flanging (0xd0b1)     compose additively, as shipped
 *   Random timing/velocity drift, rubato     existing humanization stage   EXTEND in place (this file's
 *     note-elasticity                        (end of generate())           helpers are called from there)
 *   Intonation drift bound                   intonationCents budget        static spread + velocity drift
 *                                                                          are terms WITHIN the budget
 *   Ostinato metrical accents (beats 1/3)    cell engine (G, salt 0x6066)  metrical weighting SKIPS OSTINATO
 *   Tempo changes                            project.tempoMap (persisted)  conductor map is pure/computed,
 *                                                                          NOT persisted
 *
 * PLACEMENT: everything here is consumed by the EXISTING humanization stage
 * (`transformGeneratedNotes` + `humanizeNotes` in generate.ts) so preview,
 * export and the Module 9 adapter all inherit it. The spec's "intercept
 * Module 9's stream" is satisfied implicitly — the adapter reads baked notes.
 * Documented divergence: the native engine will move latency pre-shift to
 * engine-side scheduling (same note as M4 key-switches). Fermata micro-pauses
 * are DEFERRED to the native engine (a proper pause needs event shifting; a
 * tempo-dip fake is audible-wrong).
 *
 * DETERMINISM: every helper is a pure function except the small intonation
 * jitter, which is fed by the EXISTING humanization stream
 * `mulberry32(options.seed + track.midiChannel + note.startTick + note.pitch)`
 * (the RNG the intonation detune already used — its salt registry entry is
 * "no salt; per-note derived from seed + midiChannel + startTick + pitch").
 * ALL M10 randomness extends THAT stream — no new salts.
 */

import type { Project, TimeSignature } from "../shared/schema/types";
import { ticksPerBar, ticksPerBeat } from "../shared/schema/time";

/** ASSUMPTIONS.md cap — humanize timing is capped under 15 ms equivalent. */
export const MAX_TIMING_OFFSET_MS = 15;

export type RoleFamilyClass = "LEAD" | "INNER" | "BASS";

const LEAD_ROLES: ReadonlySet<string> = new Set(["violins1", "flutes", "oboes", "trumpets"]);
const INNER_ROLES: ReadonlySet<string> = new Set(["violas", "horns", "clarinets"]);
// cellos, bassoons, doubleBass and tuba per spec; everything else (trombones,
// harp, piano, percussion, …) is not classified and takes a 0 ms role offset.
const BASS_ROLES: ReadonlySet<string> = new Set(["cellos", "bassoons", "doubleBass", "tuba"]);

/** Spec section offsets, milliseconds (sits-behind is positive for SECTION alignment). */
const ROLE_OFFSET_MS: Record<RoleFamilyClass, number> = { LEAD: -3.5, INNER: 8.5, BASS: 5.5 };

/** Velocity-dependent late-arrival: soft notes arrive late; slope ms per velocity unit below 127. */
export const VELOCITY_DELAY_SLOPE_MS_PER_UNIT = 0.22;

export function roleClass(role: string): RoleFamilyClass | null {
  if (LEAD_ROLES.has(role)) return "LEAD";
  if (INNER_ROLES.has(role)) return "INNER";
  if (BASS_ROLES.has(role)) return "BASS";
  return null;
}

/** Total per-note timing offset in ms: (role offset + soft-note delay) × intensity.
 * Output CLAMPED to ±MAX_TIMING_OFFSET_MS (ASSUMPTIONS cap; callers still clamp
 * startTick to ≥ 0 and inside the original bar as today). */
export function roleTimingOffsetMs(role: string, technique: string | undefined, velocity: number, intensity: number): number {
  const cls = roleClass(role);
  const roleMs = cls ? ROLE_OFFSET_MS[cls] : 0;
  // Articulation refinement — short/plucked attacks race ahead regardless of role.
  const articulationMs = technique === "SPICCATO" || technique === "STACCATO_STANDARD" ||
    technique === "STACCATO_DOUBLE_TRIPLE" || technique === "PIZZICATO_STD" ? -2 : 0;
  const softNoteMs = Math.max(0, 127 - velocity) * VELOCITY_DELAY_SLOPE_MS_PER_UNIT;
  const raw = (roleMs + articulationMs + softNoteMs) * (Math.max(0, Math.min(100, intensity)) / 100);
  return Math.max(-MAX_TIMING_OFFSET_MS, Math.min(MAX_TIMING_OFFSET_MS, raw));
}

/** Metrical weighting, DETERMINISTIC — NO RNG. Beat 1 +10%, beat 3 +5% (4/4),
 * beats 2/4 0%, off-beat 8ths −6.5%, off-16ths −12.5% (spec midpoints).
 * Position derived from startTime % bar/beat (the M4 bow-direction pattern).
 * SKIPS role OSTINATO — the cell engine (G) owns those accents. Returns the
 * raw multiplier; the caller scales: 1 + (mult − 1) × intensity/100. */
export function metricalVelocityMultiplier(startTimeTicks: number, timeSignature: TimeSignature, role?: string): number {
  if (role === "OSTINATO") return 1;
  const beatTicks = ticksPerBeat(timeSignature);
  const inBarTicks = ticksPerBar(timeSignature);
  const positive = ((startTimeTicks % inBarTicks) + inBarTicks) % inBarTicks;
  const beatIndex = Math.floor(positive / beatTicks);
  const inBeat = positive - beatIndex * beatTicks;
  const onBeat = Math.abs(inBeat) < 1; // M4 bow-direction tolerance
  const onEight = !onBeat && Math.abs(inBeat - beatTicks / 2) < 1;
  if (onBeat) {
    // beat 1 +10%; "beat 3 +5%" in 4/4 (and the equivalent DOWN_WEEK accent in
    // any meter via beatAccent's medium slots); weaker beats 0%.
    if (beatIndex === 0) return 1.1;
    if (timeSignature.numerator === 4 && beatIndex === 2) return 1.05;
    return 1;
  }
  if (onEight) return 0.935; // midpoints: eighth off-beats −6.5%
  return 0.875; // 16th off-positions −12.5%
}

/** Static section-player drift, cents per role (unisons stop phasing; M6
 * anti-flange composes AFTER budget normalization as shipped). */
export function staticDetuneForRole(role: string): number {
  switch (role) {
    case "violins1": return 2.5;
    case "violins2": return -2.0;
    case "violas": return 1.5;
    case "cellos": return -3.0;
    case "horns": return 3.5;
    default: return 0;
  }
}

/** Velocity pitch drift, cents: louder sits sharper. */
export function velocityPitchDriftCents(velocity: number): number {
  return (velocity - 64) * 0.05;
}

/** Small jitter ceiling for the intonation terms, fed by the existing stream. */
export const INTONATION_JITTER_CENTS = 2;

/**
 * Latency-family defaults — used ONLY when `latencyCompensation === true` and
 * the role is ABSENT from latencyCompensationMs. Explicit per-role entries
 * ALWAYS win (pinned semantics). Negative values = pre-shift (earlier),
 * matching the spec's sign convention; conversion: shiftMs = −value.
 */
const LATENCY_FAMILY_DEFAULT_MS: Record<string, number> = {
  strings: -40, woodwinds: -20, horns: -30, trumpets: -25,
  trombones: -45, tuba: -45, percussion: -2, keys: -10,
};

const SHORT_ATTACK_TECHNIQUES: ReadonlySet<string> = new Set([
  "SPICCATO", "STACCATO_STANDARD", "STACCATO_DOUBLE_TRIPLE", "PIZZICATO_STD",
]);

/** Resolve the effective pre-shift magnitude in ms (0 = no shift). Explicit
 * per-role entries win over family defaults; when the role is ABSENT and the
 * flag is on, the family matrix applies; short/plucked articulations refine
 * the default to 8 ms (never an explicit entry — entries ALWAYS win, pinned). */
export function latencyShiftMs(role: string, family: string, technique: string | undefined, explicitSignedMs?: number): number {
  let signed: number;
  if (explicitSignedMs !== undefined) {
    signed = explicitSignedMs; // explicit per-role entry ALWAYS wins (pinned test)
  } else {
    const familyDefault = LATENCY_FAMILY_DEFAULT_MS[role] ?? LATENCY_FAMILY_DEFAULT_MS[family] ?? 0;
    signed = technique !== undefined && SHORT_ATTACK_TECHNIQUES.has(technique) ? -8 : familyDefault;
  }
  // Signed convention: negative = pre-shift (earlier). Legacy explicit values
  // (positive ms) still pre-shift via the same magnitude path.
  return Math.max(0, signed < 0 ? -signed : signed);
}

/* ------------------------------------------------------------------ */
/* Conductor map — pure computed tempo curve, NOT persisted on project */
/* ------------------------------------------------------------------ */

export interface ConductorTempoEvent {
  tick: number;
  bpm: number;
}

/** Spec midpoints shipped as the deterministic choice (no upstream data):
 * verse→chorus +1.0 BPM (exponential ramp over the boundary bar),
 * chorus→breakdown −1.75 rallentando (linear ramp), final cadence / Outro
 * start −4.5 (logarithmic ramp). All scaled × (rubatoSetting/100); rubato 0
 * ⇒ empty array ⇒ byte-identical exporter/playback behavior. */
const CONDUCTOR_MIDPOINTS = {
  verseToChorus: 1.0,
  chorusToBreakdown: -1.75,
  finalCadence: -4.5,
} as const;

const RAMP_STEPS = 8;

function boundaryClass(name: string): "verse" | "chorus" | "breakdown" | "outro" | "other" {
  const key = name.toLowerCase();
  if (key.includes("outro")) return "outro";
  if (key.includes("breakdown")) return "breakdown";
  if (/pre[-. ]?chorus/.test(key)) return "other";
  if (key.includes("chorus")) return "chorus";
  if (key.includes("verse")) return "verse";
  return "other";
}

function rampDelta(shape: "exponential" | "linear" | "logarithmic", total: number, f: number): number {
  // f ∈ (0, 1]; accumulated bpm delta from the section baseline; f=1 ⇒ total.
  if (shape === "exponential") return total * (2 ** f - 1);
  if (shape === "logarithmic") return total * Math.log(1 + (Math.E - 1) * f);
  return total * f;
}

/** Build the conductor tempo curve: deterministic midpoints of the spec ranges
 * × rubato/100. rubato 0 ⇒ [] (byte-identical consumers). Shape across the
 * boundary bar: exponential (+1.0 verse→chorus), linear rallentando (−1.75
 * chorus→breakdown), logarithmic cadence (−4.5 Outro start). The ramped level
 * CARRIES into the following section until the next boundary (documented
 * choice: spread over the boundary bar instead of a snap at it). Events are
 * strictly sorted by tick since boundary bars are disjoint. */
export function buildConductorTempoEvents(project: Project): ConductorTempoEvent[] {
  const rubato = project.generationSettings?.humanization?.rubato ?? 0;
  if (!(rubato > 0) || project.sections.length === 0) return [];
  const scale = rubato / 100;
  const tpBar = ticksPerBar(project.timeSignature);
  const sections = [...project.sections].sort((a, b) => a.startBar - b.startBar);
  const events: ConductorTempoEvent[] = [];
  let level = project.bpm; // carried tempo level walking the form
  for (let index = 0; index < sections.length; index++) {
    const currentKey = boundaryClass(sections[index]!.name);
    const previousKey = index > 0 ? boundaryClass(sections[index - 1]!.name) : null;
    let shape: "exponential" | "linear" | "logarithmic" | null = null;
    let total = 0;
    if (currentKey === "chorus" && previousKey === "verse") {
      shape = "exponential";
      total = CONDUCTOR_MIDPOINTS.verseToChorus * scale;
    } else if (currentKey === "breakdown" && previousKey === "chorus") {
      shape = "linear";
      total = CONDUCTOR_MIDPOINTS.chorusToBreakdown * scale;
    } else if (currentKey === "outro") {
      shape = "logarithmic";
      total = CONDUCTOR_MIDPOINTS.finalCadence * scale;
    }
    if (!shape || total === 0) continue;
    const boundaryTick = (sections[index]!.startBar - 1) * tpBar;
    for (let step = 1; step <= RAMP_STEPS; step++) {
      const f = step / RAMP_STEPS;
      events.push({ tick: boundaryTick + Math.min(tpBar, Math.floor(f * tpBar)), bpm: level + rampDelta(shape, total, f) });
    }
    level += total;
  }
  return events;
}
