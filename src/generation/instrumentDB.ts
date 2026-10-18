/** Module 3 — static/dynamic Instrument Profile Database.
 *
 * Wraps `instrument_db.json` with typed accessors used by the orchestration
 * engine (Stage 3 role allocation and Stage 6 range/transposition filtering).
 *
 * Transposition convention (matches the Module 3 spec, NOT the legacy engine
 * field): `transpositionSemitones` is the sounding offset relative to written
 * pitch, i.e. concert = written + transposition; e.g. Horn in F = -7.
 * Use `TranspositionAdapter` rather than reading raw fields when converting.
 */
import rawDatabase from "./instrument_db.json";

export type InstrumentFamily = "STRINGS" | "WOODWINDS" | "BRASS" | "PITCHED_PERCUSSION" | "KEYBOARDS";
export type ClefName = "TREBLE" | "ALTO" | "TENOR" | "BASS";
export type RegisterBandName = "LOW" | "MIDDLE" | "HIGH" | "EXTREME";
export type DynamicControlEase = "EASY" | "MODERATE" | "DIFFICULT";
export type OrchestralRole = "LEAD" | "COUNTERLINE" | "PAD" | "OSTINATO" | "BASS";

export interface RegisterBand {
  name: RegisterBandName;
  minPitchWritten: number;
  maxPitchWritten: number;
  tonalQuality: string;
  velocityModifier: number;
  brightnessModifier: number;
  dynamicControlEase: DynamicControlEase;
}

export interface InstrumentRangeBounds {
  practicalMin: number;
  practicalMax: number;
  professionalMin: number;
  professionalMax: number;
}

export interface InstrumentProfile {
  id: string;
  displayName: string;
  family: InstrumentFamily;
  transpositionSemitones: number;
  defaultClef: ClefName;
  alternateClef?: ClefName;
  rangeWritten: InstrumentRangeBounds;
  registers: RegisterBand[];
  primaryRoles: OrchestralRole[];
  carryingPowerWeight: number;
  unisonBlendingGroup: string;
}

export const INSTRUMENT_DATABASE: readonly InstrumentProfile[] = rawDatabase as InstrumentProfile[];

export class InstrumentProfileLoader {
  private readonly byId = new Map<string, InstrumentProfile>();
  private readonly byFamily = new Map<InstrumentFamily, InstrumentProfile[]>();

  constructor(profiles: readonly InstrumentProfile[] = INSTRUMENT_DATABASE) {
    for (const profile of profiles) {
      this.byId.set(profile.id, profile);
      const family = this.byFamily.get(profile.family) ?? [];
      family.push(profile);
      this.byFamily.set(profile.family, family);
    }
  }

  getProfile(id: string): InstrumentProfile | undefined {
    return this.byId.get(id);
  }

  getProfilesByFamily(family: InstrumentFamily): InstrumentProfile[] {
    return this.byFamily.get(family) ?? [];
  }

  getProfilesByRole(role: OrchestralRole): InstrumentProfile[] {
    return [...this.byId.values()].filter((profile) => profile.primaryRoles.includes(role));
  }

  get instrumentCount(): number {
    return this.byId.size;
  }
}

export interface RangeCheckResult {
  withinPracticalRange: boolean;
  withinProfessionalRange: boolean;
  /** True when the pitch is above the practical ceiling. */
  tooHigh: boolean;
  /** True when the pitch is below the practical floor. */
  tooLow: boolean;
  /** True when the pitch lies in the professional-only extreme zone. */
  professionalOnly: boolean;
}

/** Task 3.3 — validate a written pitch against an instrument's practical boundaries. */
export function isWithinPracticalRange(pitch: number, instrumentId: string, loader: InstrumentProfileLoader | undefined = undefined): RangeCheckResult {
  const profile = loader?.getProfile(instrumentId) ?? new InstrumentProfileLoader().getProfile(instrumentId);
  if (!profile) {
    return { withinPracticalRange: false, withinProfessionalRange: false, tooHigh: false, tooLow: false, professionalOnly: false };
  }
  const { practicalMin, practicalMax, professionalMin, professionalMax } = profile.rangeWritten;
  const tooLow = pitch < practicalMin;
  const tooHigh = pitch > practicalMax;
  return {
    withinPracticalRange: !tooLow && !tooHigh,
    withinProfessionalRange: pitch >= professionalMin && pitch <= professionalMax,
    tooHigh,
    tooLow,
    professionalOnly: tooHigh ? pitch <= professionalMax : pitch < professionalMin,
  };
}

/** Finds the register band a written pitch falls into (undefined when outside all bands). */
export function findRegisterBand(pitch: number, profile: InstrumentProfile): RegisterBand | undefined {
  return profile.registers.find((band) => pitch >= band.minPitchWritten && pitch <= band.maxPitchWritten);
}

export interface RegisterDynamicModifiers {
  velocityModifier: number;
  brightnessModifier: number;
  /** Accompainment engines should attenuate winds/brass around this note. */
  requiresAccompanimentAttenuation: boolean;
  /** Extra CC#11 scaling for natural high-brass projection (1 = unaffected). */
  cc11Scale: number;
}

/**
 * Task spec §4 — register-dependent dynamic & timbral scaling.
 * Applies the velocity and CC#74 (brightness) offsets from the instrument's
 * register band, plus the engine-level protection rules:
 *  - Flute below G4 (MIDI 67): signal engines to attenuate accompaniment by 15%.
 *  - Trumpet above G5 (MIDI 79): scale CC#11 by 0.88 to balance projection.
 */
export function applyRegisterDynamicModifiers(pitch: number, profile: InstrumentProfile, baseVelocityModifier = 0): RegisterDynamicModifiers {
  const band = findRegisterBand(pitch, profile);
  const velocityModifier = baseVelocityModifier + (band?.velocityModifier ?? 0);
  const brightnessModifier = band?.brightnessModifier ?? 0;
  return {
    velocityModifier,
    brightnessModifier,
    requiresAccompanimentAttenuation: profile.id === "flute" && pitch < 67,
    cc11Scale: profile.id === "trumpet_bb" && pitch > 79 ? 0.88 : 1,
  };
}

/** Task 3.4 — concert <-> written pitch conversion adapter. */
export class TranspositionAdapter {
  /** written = concert - transpositionSemitones (Section 4 formula). */
  static concertToWritten(pitchConcert: number, profile: InstrumentProfile): number {
    return pitchConcert - profile.transpositionSemitones;
  }

  /** concert = written + transpositionSemitones (inverse of the formula). */
  static writtenToConcert(pitchWritten: number, profile: InstrumentProfile): number {
    return pitchWritten + profile.transpositionSemitones;
  }

  static clefForPitch(pitchWritten: number, profile: InstrumentProfile): ClefName {
    return pitchWritten >= 84 && profile.alternateClef ? profile.alternateClef : profile.defaultClef;
  }
}
