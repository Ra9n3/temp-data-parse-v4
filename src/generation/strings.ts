/**
 * Module STRINGS — double-stop physical validation, section panning & size data.
 *
 * LIVE (this build):
 *   1. `validateDoubleStop` — physically impossible double-stops are rejected
 *      WITH a reason; the MonophonyGuard (decision 2) uses it inside its string
 *      resolution so only PLAYABLE pairs keep both notes (impossible ones
 *      resolve per existing role priority). The sibling cap stays ≤2 and the
 *      guard stays the FINAL invariant — this module adds a PHYSICS check, it
 *      never raises the cap.
 *   2. `PANNING_PROFILES` — the classical seating in both export (CC10@tick-0
 *      per string track) and preview (StereoPannerNode, pan = (cc10−64)/63).
 *      CLASSICAL is the default. Module 13's unconditional bass-carrier
 *      CC10=64 write is SUPERSEDED: the STUDIO_CENTERED_BASS profile carries
 *      the centered-bass rule (doubleBass 64) as a PROFILE ROW instead.
 *
 * SHELVED (pure + tested here, unexercised by generation — native-engine scope):
 *   - section-size profiles (desk counts + sectionGain; wiring to native mix),
 *   - `divisiOrDoubleStop` desk-split resolver (needs chairs for desk identity),
 *   - triple/quad stops + arpeggiation helper, `HARMONIC_TOUCH4TH` (+24,
 *     touch-4th harmonics), portamento CC65/5/84 helper, sul-string CC74
 *     offsets, overdub layering (anti-flanging stays the web approximation),
 *     fingered-tremolo realization (M4 tag-only awaiting native key-switches).
 *
 * DETERMINISM LAW: no RNG anywhere (census + guard integration are pure
 * functions of pitches; no salts, no streams). No dependencies.
 *
 * SPEC RECONCILIATION NOTES (authoritative, encoded below):
 *   (a) String assignment: `assignString` = the HIGHEST open string ≤ pitch
 *       (real hand scale — a note below the lowest string is out of range).
 *   (b) Double-stop validity: two DISTINCT ADJACENT strings AND (shortcut: the
 *       hand interval ≤ 16 semitones OR either note rings an open string).
 *       Same string ⇒ physically impossible; non-adjacent ⇒ impossible stretch.
 *   (c) Intonation warning is a SOFT flag (never a rejection): adjacent-string
 *       fingered pairs whose STRING-PAIR interval is a 4th/5th (pitch-class
 *       set {5, 7}). This is the spec's [2, 15] bug fixed — [2,15] read the
 *       interval axis wrong; every classical adjacent string pair is 5 or 7
 *       semitones apart (4ths-tuned basses: 5; 5ths-tuned violin family: 7),
 *       and a fingered (non-open) pair on such strings is exactly where
 *       intonation needs care (pinned vector: violin 60+64 on G+D).
 */
import type { Note } from "../shared/schema/types";

// ---------------------------------------------------------------- instruments

export type StringInstrument = "violins1" | "violins2" | "violas" | "cellos" | "doubleBass";

export const STRING_INSTRUMENTS: readonly StringInstrument[] = ["violins1", "violins2", "violas", "cellos", "doubleBass"];

/** Open strings per instrument (MIDI pitches, ascending). Violin 55/62/69/76,
 * viola 48/55/62/69, cello 36/43/50/57, double bass 28/33/38/43 (spec table). */
export const OPEN_STRINGS: Record<StringInstrument, readonly number[]> = {
  violins1: [55, 62, 69, 76],
  violins2: [55, 62, 69, 76],
  violas: [48, 55, 62, 69],
  cellos: [36, 43, 50, 57],
  doubleBass: [28, 33, 38, 43],
};

export const STRING_ROLE_TO_TRACK: Record<StringInstrument, string> = {
  violins1: "trk_violins_i",
  violins2: "trk_violins_ii",
  violas: "trk_violas",
  cellos: "trk_cellos",
  doubleBass: "trk_double_bass",
};

/** Decision 1 — string assignment: the HIGHEST open string ≤ the pitch. */
export function assignString(
  pitch: number,
  instrument: StringInstrument,
): { ok: true; openIndex: number; openPitch: number } | { ok: false; reason: string } {
  const opens = OPEN_STRINGS[instrument];
  for (let index = opens.length - 1; index >= 0; index--) {
    if (opens[index]! <= pitch) return { ok: true, openIndex: index, openPitch: opens[index]! };
  }
  return { ok: false, reason: `pitch ${pitch} is below the lowest ${instrument} string (${opens[0]})` };
}

const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;
const STRETCH_SEMITONES = 16;
/** S.7 pinned intonation classes: 4ths-tuned bass (5) and 5ths-tuned violin/viola/cello (7). */
const INTONATION_CLASSES: ReadonlySet<number> = new Set([5, 7]);

/** Spec interface (adapted): the validator's full verdict for one pair. */
export interface DoubleStopValidationResult {
  /** Physically playable as a real double-stop. */
  playable: boolean;
  /** When playable === false: machine-readable rejection reason. */
  reason?: "same-string" | "non-adjacent" | "hand-stretch" | "below-open-string-floor";
  /** Soft intonation flag (informational, never a rejection). */
  intonationWarning?: boolean;
  instrument: StringInstrument;
  /** Assigned open-string pitches (ascending order = [lower note, higher note]). */
  strings?: [number, number];
  /** The semitone interval between the two notes. */
  interval: number;
}

/** Decision 1 — validate ONE double-stop pair on one instrument. Exact S.7
 * vectors (pinned): violin 60+57 → same-string INVALID; violin 60+69 →
 * non-adjacent INVALID; violin 55+62 (open G+D) → VALID; cello 36+43 → VALID;
 * violin 60+64 (G+D strings, 4-semitone note interval, no open) → VALID +
 * intonation warning. */
export function validateDoubleStop(pitch1: number, pitch2: number, instrument: StringInstrument): DoubleStopValidationResult {
  const interval = Math.abs(pitch2 - pitch1);
  const [low, high] = pitch1 <= pitch2 ? [pitch1, pitch2] : [pitch2, pitch1];
  const assignedLow = assignString(low, instrument);
  if (!assignedLow.ok) return { playable: false, reason: "below-open-string-floor", instrument, interval };
  const assignedHigh = assignString(high, instrument);
  if (!assignedHigh.ok) return { playable: false, reason: "below-open-string-floor", instrument, interval };
  if (assignedLow.openIndex === assignedHigh.openIndex) {
    return { playable: false, reason: "same-string", instrument, interval };
  }
  if (assignedHigh.openIndex - assignedLow.openIndex !== 1) {
    return { playable: false, reason: "non-adjacent", instrument, interval };
  }
  const openEither = assignedLow.openPitch === low || assignedHigh.openPitch === high;
  if (!(interval <= STRETCH_SEMITONES || openEither)) {
    return { playable: false, reason: "hand-stretch", instrument, interval };
  }
  // Soft intonation flag: fingered (neither note open) pairs whose string pair
  // sits a 4th/5th apart — see the S.7 note in the module header.
  const stringPcInterval = pc(assignedHigh.openPitch - assignedLow.openPitch);
  const intonationWarning = !openEither && INTONATION_CLASSES.has(stringPcInterval);
  return {
    playable: true,
    ...(intonationWarning ? { intonationWarning: true } : {}),
    instrument,
    strings: [assignedLow.openPitch, assignedHigh.openPitch],
    interval,
  };
}

// ---------------------------------------------------------------- shelved resolvers (pure, unexercised)

export interface DivisiOutcome {
  kind: "DOUBLE_STOP" | "DIVISI";
  /** Pitches the section physically plays together. */
  retained: number[];
  /** Pitches handed to a desk split or the native engine's divisi pass. */
  deferred: number[];
  rationale: string;
}

/** SHELVED — divisi-or-double-stop resolver (pure). Two playable pitches stay
 * together as a double-stop; larger stacks defer the extras in pitch order
 * (lowest pair retained, ascending). The native era's desk-split logic needs
 * chair identity, so generation never calls this today. */
export function divisiOrDoubleStop(
  pitches: number[],
  instrument: StringInstrument,
  maxTogether = 2,
): DivisiOutcome {
  const ordered = [...pitches].sort((a, b) => a - b);
  const retained: number[] = [];
  const deferred: number[] = [];
  for (const pitch of ordered) {
    if (retained.length < maxTogether
      && (retained.length === 0 || validateDoubleStop(retained[0]!, pitch, instrument).playable)) {
      retained.push(pitch);
    } else {
      deferred.push(pitch);
    }
  }
  return {
    kind: deferred.length > 0 ? "DIVISI" : "DOUBLE_STOP",
    retained,
    deferred,
    rationale: deferred.length > 0
      ? `desks split: ${retained.length} together as a double-stop, ${deferred.length} desks deferred`
      : `plays together as a double-stop on ${instrument}`,
  };
}

/** SHELVED — artificial harmonic calculator: touch the string a 4TH above and
 * sound two octaves up (touch-4th table). Pure; native realization pending. */
export const HARMONIC_TOUCH4TH = {
  /** Touch-4th fundamental interval from the highest open string, semitones. */
  touchIntervalSemitones: 5,
  /** The sounding pitch: node pitch + 24 (two octaves). */
  calculate: (openPitch: number): number => openPitch + 24,
};

// ---------------------------------------------------------------- section-size profiles (shelved data)

export type SectionProfileId = "SYMPHONIC_60" | "STUDIO_34" | "CHAMBER_12" | "QUARTET_4";

export interface SectionSizeProfile {
  id: SectionProfileId;
  /** Desk counts per section (violins1/violins2/violas/cellos/bass). */
  desks: { violins1: number; violins2: number; violas: number; cellos: number; doubleBass: number };
  /** Stage-mix gain per section role (0..1; native mix era). */
  sectionGain: number;
  label: string;
}

export const SECTION_PROFILES: Record<SectionProfileId, SectionSizeProfile> = {
  SYMPHONIC_60: { id: "SYMPHONIC_60", desks: { violins1: 16, violins2: 14, violas: 12, cellos: 10, doubleBass: 8 }, sectionGain: 1, label: "Full symphonic 60" },
  STUDIO_34: { id: "STUDIO_34", desks: { violins1: 10, violins2: 8, violas: 6, cellos: 6, doubleBass: 4 }, sectionGain: 0.92, label: "Studio strings 34" },
  CHAMBER_12: { id: "CHAMBER_12", desks: { violins1: 4, violins2: 3, violas: 3, cellos: 1, doubleBass: 1 }, sectionGain: 0.8, label: "Chamber strings 12" },
  QUARTET_4: { id: "QUARTET_4", desks: { violins1: 1, violins2: 1, violas: 1, cellos: 1, doubleBass: 0 }, sectionGain: 0.66, label: "Quartet 4" },
};

/** Validator for the shelved section-profile config (used by the schema layer
 * when generationSettings.strings.sectionProfile is present). */
export function validateSectionProfile(id: string): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const profile = (SECTION_PROFILES as Record<string, SectionSizeProfile | undefined>)[id];
  if (!profile) { errors.push("sectionProfile does not resolve in SECTION_PROFILES"); return { ok: false, errors }; }
  if (!(profile.sectionGain >= 0 && profile.sectionGain <= 1)) errors.push("sectionGain must be within 0..1");
  for (const [role, count] of Object.entries(profile.desks)) {
    if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) errors.push(`desk count ${role} must be a non-negative integer`);
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------- panning profiles (LIVE)

export type PanningProfileId = "CLASSICAL" | "STUDIO_CENTERED_BASS";
export const DEFAULT_PANNING_PROFILE: PanningProfileId = "CLASSICAL";

/** Classical seating, LEFT→RIGHT in CC10 raw values (0=left, 127=right; 64=center).
 *  CLASSICAL (default): violins ≈14 far left, violins2 ≈39, violas ≈77,
 *  cellos ≈102, doubleBass ≈118 (pinned). STUDIO_CENTERED_BASS: the M13
 *  sub-150 Hz center rule lives HERE — doubleBass 64 (bass anchored center),
 *  cellos push further right (108). */
export const PANNING_PROFILES: Record<PanningProfileId, Record<StringInstrument, number>> = {
  CLASSICAL: { violins1: 14, violins2: 39, violas: 77, cellos: 102, doubleBass: 118 },
  STUDIO_CENTERED_BASS: { violins1: 17, violins2: 42, violas: 77, cellos: 108, doubleBass: 64 },
};

/** Resolve a project's active panning profile id (absent = the CLASSICAL default). */
export function resolvePanningProfile(project: { generationSettings?: { strings?: { panningProfile?: string } } }): PanningProfileId {
  const requested = project.generationSettings?.strings?.panningProfile;
  if (requested === undefined) return DEFAULT_PANNING_PROFILE;
  if (requested === "CLASSICAL" || requested === "STUDIO_CENTERED_BASS") return requested;
  return DEFAULT_PANNING_PROFILE;
}

/** CC10 raw value for one string role under the active profile. */
export function panForRole(
  project: { generationSettings?: { strings?: { panningProfile?: string } } },
  role: string,
): number | undefined {
  if (!(STRING_INSTRUMENTS as readonly string[]).includes(role)) return undefined;
  return PANNING_PROFILES[resolvePanningProfile(project)][role as StringInstrument];
}

/** Preview conversion: CC10 → StereoPannerNode value ((cc10 − 64)/63). */
export function panValueFromCc10(cc10: number): number {
  return (cc10 - 64) / 63;
}

/** Convenience for callers holding tracks: CC10 pan for a full track, if it is a string track. */
export function panForTrack(
  project: { generationSettings?: { strings?: { panningProfile?: string } } },
  track: { role: string; family: string },
): number | undefined {
  if (track.family !== "strings") return undefined;
  return panForRole(project, track.role);
}

/** Utility used by the census/checker: is this note a managable Note? (No fields added to Note.) */
export type StringNote = Note;

export const STRING_MODULE_VERSION = "strings-live-1";
