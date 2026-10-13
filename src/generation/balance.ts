/** Module 7 — deterministic balance and dynamics after score realization.
 * All functions are pure/deterministic and consume no RNG or RNG salt.
 */
import type { AbstractNoteEvent, InstrumentProfile } from "./generate";
import { buildPipelineProfiles } from "./profileAdapter";
import { applyRegisterDynamicModifiers, INSTRUMENT_DATABASE, InstrumentProfileLoader } from "./instrumentDB";
import { databaseProfileForPipelineRole, pipelineRoleForDbInstrument } from "./profileAdapter";
import type { Project } from "../shared/schema/types";
import { CC74_OFFSETS, type EvaluatedNote } from "./articulation";
import { msToTicks } from "../shared/schema/time";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const pitchInClass = (pitchClass: number, range: { low: number; high: number }, preferred: number): number | undefined => {
  const pc = ((Math.round(pitchClass) % 12) + 12) % 12;
  const candidates: number[] = [];
  for (let pitch = Math.ceil(range.low); pitch <= range.high; pitch++) {
    if (((pitch % 12) + 12) % 12 === pc) candidates.push(pitch);
  }
  return candidates.reduce<number | undefined>((best, pitch) =>
    best === undefined || Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, undefined);
};

export const ACOUSTIC_WEIGHTS: Record<string, number> = {
  trumpets: 1.0, trombones: 1.0, tuba: 1.2, horns: 0.5,
  oboes: 0.85, clarinets: 0.6, bassoons: 0.45, flutes: 0.55, piccolo: 0.7,
  violins1: 0.35, violins2: 0.35, violas: 0.3, cellos: 0.45, doubleBass: 0.5,
  harp: 0.35, piano: 0.6, timpani: 0.9,
};
export const SECTION_GAIN: Record<string, number> = { strings: 6, woodwinds: 2, brass: 3, keys: 1, percussion: 1 };

const DB_WEIGHT_BY_ROLE: Record<string, number> = Object.fromEntries(
  INSTRUMENT_DATABASE.map((profile) => [pipelineRoleForDbInstrument(profile.id), profile.carryingPowerWeight])
    .filter((entry): entry is [string, number] => typeof entry[0] === "string"),
);

export function acousticWeightForRole(role: string): number {
  return DB_WEIGHT_BY_ROLE[role] ?? ACOUSTIC_WEIGHTS[role] ?? 0.6;
}

export function acousticWeightForTrack(track: Project["tracks"][number]): number {
  const profile = buildPipelineProfiles().find((candidate) => candidate.role === track.role);
  const supplemental = track.role === "harp" ? 0.35 : track.role === "piano" ? 0.6 : undefined;
  return profile?.carryingPowerWeight ?? supplemental ?? ACOUSTIC_WEIGHTS[track.role] ?? 0.6;
}

export function cc7ForWeight(weight: number): number {
  return Math.round(clamp(127 * (0.4 + 0.6 * (weight / 1.2)), 30, 115));
}

export type CurveType = "EXPONENTIAL" | "LINEAR" | "LOGARITHMIC";
export function curveFor(family: string, role: string): CurveType {
  if (role === "PAD") return "LOGARITHMIC";
  if (family === "brass" || family === "percussion") return "EXPONENTIAL";
  if (family === "keys") return "LOGARITHMIC";
  return "LINEAR";
}
export function applyCurve(type: CurveType, x: number): number {
  const value = clamp(x, 0, 1);
  return type === "EXPONENTIAL" ? Math.pow(value, 1.8) : type === "LOGARITHMIC" ? Math.sqrt(value) : value;
}

export interface BalanceConfig {
  windowing: { enabled: boolean; minGapMs: number; searchWindowMs: number; allowOctaveEscape: boolean };
  attenuation: { lowFluteFactor: number; brassDominanceFactor: number; combinedFloor: number };
  cc11Floor: number;
}
export interface BalanceConfigPartial {
  windowing?: Partial<BalanceConfig["windowing"]>;
  attenuation?: Partial<BalanceConfig["attenuation"]>;
  cc11Floor?: number;
}
export function resolveBalanceConfig(partial?: BalanceConfigPartial): BalanceConfig {
  return {
    windowing: { ...DEFAULT_BALANCE_CONFIG.windowing, ...partial?.windowing },
    attenuation: { ...DEFAULT_BALANCE_CONFIG.attenuation, ...partial?.attenuation },
    cc11Floor: partial?.cc11Floor ?? DEFAULT_BALANCE_CONFIG.cc11Floor,
  };
}
export const DEFAULT_BALANCE_CONFIG: BalanceConfig = {
  windowing: { enabled: true, minGapMs: 120, searchWindowMs: 600, allowOctaveEscape: false },
  attenuation: { lowFluteFactor: 0.82, brassDominanceFactor: 0.8, combinedFloor: 0.6 },
  cc11Floor: 15,
};

export interface BalanceEvent extends AbstractNoteEvent {
  windowed?: boolean;
  attenuationFactor?: number;
  accompanimentAttenuationActive?: boolean;
  dynamics?: { cc11Value: number; cc74Value: number; attenuationActive: boolean; velocityModifier: number };
}
export interface BalanceContext {
  profiles: InstrumentProfile[];
  config: BalanceConfig;
  bpm: number;
}

interface LoudBrassInterval { start: number; end: number }
function mergeIntervals(intervals: LoudBrassInterval[]): LoudBrassInterval[] {
  const merged: LoudBrassInterval[] = [];
  for (const interval of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

/** Shift LEAD strings/winds out of loud brass windows; one pass, no cascading. */
export function applyAntiphonalWindowing<T extends EvaluatedNote & BalanceEvent>(events: T[], ctx: BalanceContext): T[] {
  const { profiles, config, bpm } = ctx;
  if (!config.windowing.enabled || !events.length) return events;
  const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
  const brassWindows = mergeIntervals(events.flatMap((event) => {
    const profile = profileById.get(event.instrumentId);
    return profile?.family === "brass" && event.normalizedDynamic >= 0.85
      ? [{ start: event.startTime, end: event.startTime + event.duration }]
      : [];
  }));
  if (!brassWindows.length) return events;
  const minimumGap = msToTicks(config.windowing.minGapMs, bpm);
  const search = msToTicks(config.windowing.searchWindowMs, bpm);
  const originalOnsets = new Map(events.map((event) => [event, event.startTime]));
  for (const event of events) {
    const profile = profileById.get(event.instrumentId);
    if (event.role !== "LEAD" || !profile || !["strings", "woodwinds"].includes(profile.family ?? "")) continue;
    const originalOnset = originalOnsets.get(event)!;
    if (!brassWindows.some((window) => originalOnset >= window.start && originalOnset < window.end)) continue;
    const low = Math.max(0, originalOnset - search);
    const high = originalOnset + search;
    const gaps: LoudBrassInterval[] = [];
    let cursor = 0;
    for (const window of brassWindows) {
      if (window.start - cursor >= minimumGap) gaps.push({ start: cursor, end: window.start });
      cursor = Math.max(cursor, window.end);
    }
    if (high + minimumGap - cursor >= minimumGap) gaps.push({ start: cursor, end: high + minimumGap });
    const gap = gaps.find((candidate) => candidate.start >= low && candidate.start <= high && candidate.end - candidate.start >= minimumGap);
    if (gap) {
      event.startTime = gap.start;
      event.windowed = true;
    } else if (config.windowing.allowOctaveEscape && profile.family === "woodwinds") {
      const range = profile.comfortableRange ?? profile.writtenRange;
      const escaped = pitchInClass(event.pitchConcert % 12, range, event.pitchConcert + 12);
      if (escaped !== undefined && escaped > event.pitchConcert) {
        event.pitchConcert = escaped;
        event.pitchWritten = clamp(escaped + (profile.transpositionSemitones ?? 0), profile.writtenRange.low, profile.writtenRange.high);
      }
    }
  }
  return events.sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
}

/** Apply multiplicative accompaniment attenuation from low-flute and loud-brass masks. */
export function applyAccompanimentAttenuation<T extends EvaluatedNote & BalanceEvent>(events: T[], ctx: Pick<BalanceContext, "profiles" | "config">): T[] {
  const profileById = new Map(ctx.profiles.map((profile) => [profile.id, profile]));
  const triggers: Array<{ event: T; kind: "flute" | "brass" }> = events.flatMap((event): Array<{ event: T; kind: "flute" | "brass" }> => {
    const profile = profileById.get(event.instrumentId);
    if (!profile) return [];
    if (event.role === "LEAD" && profile.family === "woodwinds" && (profile.id === "flute" || profile.id === "piccolo" || profile.role === "flutes" || profile.role === "piccolo") && event.pitchConcert < 67) {
      return [{ event, kind: "flute" as const }];
    }
    if (profile.family === "brass" && event.normalizedDynamic >= 0.85) return [{ event, kind: "brass" as const }];
    return [];
  });
  for (const event of events) {
    let factor = event.attenuationFactor ?? 1;
    let active = event.accompanimentAttenuationActive ?? false;
    const family = profileById.get(event.instrumentId)?.family;
    for (const trigger of triggers) {
      if (trigger.event === event || event.role === "LEAD" || family === "brass") continue;
      if (Math.floor(event.pitchConcert / 12) !== Math.floor(trigger.event.pitchConcert / 12)) continue;
      if (event.startTime >= trigger.event.startTime + trigger.event.duration || trigger.event.startTime >= event.startTime + event.duration) continue;
      factor *= trigger.kind === "flute" ? ctx.config.attenuation.lowFluteFactor : ctx.config.attenuation.brassDominanceFactor;
      active = true;
    }
    event.attenuationFactor = active ? Math.max(ctx.config.attenuation.combinedFloor, factor) : factor;
    event.accompanimentAttenuationActive = active;
  }
  return events;
}

const MUTE_ATTENUATION: Record<string, number> = { CUP_MUTE: 0.8, STRAIGHT_MUTE: 0.65, HARMON_MUTE: 0.6 };
const DB_LOADER = new InstrumentProfileLoader();

/** Calculate CC11/CC74 and register velocity modifiers without randomness. */
export function calculateNoteDynamics<T extends EvaluatedNote & BalanceEvent>(events: T[], ctx: Pick<BalanceContext, "profiles" | "config">): T[] {
  const profileById = new Map(ctx.profiles.map((profile) => [profile.id, profile]));
  for (const event of events) {
    const profile = profileById.get(event.instrumentId);
    const dbProfile = DB_LOADER.getProfile(event.instrumentId)
      ?? (profile?.role ? databaseProfileForPipelineRole(profile.role) : undefined);
    const register = dbProfile
      ? applyRegisterDynamicModifiers(event.pitchWritten, dbProfile)
      : {
          velocityModifier: profile?.dynamicOffset ? Math.round(profile.dynamicOffset * 127) : 0,
          brightnessModifier: 0,
          cc11Scale: 1,
          requiresAccompanimentAttenuation: false,
        };
    const family = profile?.family ?? "strings";
    const curve = curveFor(family, event.role);
    let cc11Value = clamp(Math.round(127 * applyCurve(curve, event.normalizedDynamic) * register.cc11Scale * (event.attenuationFactor ?? 1)), ctx.config.cc11Floor, 127);
    const technique = event.articulation.primaryTechnique;
    const muteScale = MUTE_ATTENUATION[technique] ?? 1;
    cc11Value = clamp(Math.round(cc11Value * muteScale), ctx.config.cc11Floor, 127);
    const cc74Value = clamp(64 + (CC74_OFFSETS[technique] ?? 0) + register.brightnessModifier + Math.round(cc11Value * 0.4) + (event.cc74Offset ?? 0), 0, 127);
    event.dynamics = {
      cc11Value,
      cc74Value,
      attenuationActive: (event.accompanimentAttenuationActive ?? false) || register.requiresAccompanimentAttenuation || muteScale < 1,
      velocityModifier: register.velocityModifier,
    };
  }
  return events;
}
