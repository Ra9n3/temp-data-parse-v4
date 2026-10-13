/**
 * Module 8.5 — Arrangement Intelligence: seeded role rotation, active masks,
 * rest budgeting and the chorus role divider.
 *
 * Composes with the polyphony hotfix (occupancy ledger / MonophonyGuard) and
 * Addendums E/F/G (engines own LEAD/COUNTERLINE/OSTINATO); rotation remaps REAL
 * melodies, so pitch classes survive via octave-only refits (pitchInClass).
 *
 * PROFILES ARE SECTIONS, NOT CHAIRS — every pool entry is a SECTION role
 * ("cellos"), never a chair ("Clarinet 1"). Chair-level rotation inside a
 * section is Module 11's job (the chairs will plug into the SAME pools and the
 * casting draw below — the pools are the M11 seam by design). Section types
 * come from name normalization ("Verse 1" → verse); "Bridge" maps to Build;
 * families are lowercase; there is no "RHYTHM" family (it is "keys").
 *
 * SALT REGISTRY: 0x8a55 (rotation casting) — the ONLY RNG consumer in this
 * module. Every other function is deterministic; draw order is part of the
 * determinism contract: sections in time order; within a section, layers in
 * the fixed order LEAD → BASS → PAD → COUNTERLINE → OSTINATO.
 */
import type { AbstractNoteEvent, InstrumentProfile } from "./generate";
import type { MeasureProfile } from "./arrangement";
import type { Note, Project as ProjectSchema, Track } from "../shared/schema/types";
import { barToTick, ticksPerBar } from "../shared/schema/time";
import { normalizeSectionName } from "./config";
import { mulberry32 } from "./prng";
import { projectProfiles } from "./generate";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;

/** Same convention as generate(): pitch inside a range keeping a pitch class, nearest preferred. */
function pitchInClass(pitchClass: number, range: { low: number; high: number }, preferred: number): number {
  const candidates: number[] = [];
  for (let pitch = Math.ceil(range.low); pitch <= range.high; pitch++) {
    if (pc(pitch) === pitchClass) candidates.push(pitch);
  }
  if (!candidates.length) return clamp(preferred, range.low, range.high);
  return candidates.reduce((best, pitch) => Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, candidates[0]!);
}

export interface LayerPools { lead: string[]; counterline: string[]; ostinato: string[]; pad: string[]; bass: string[]; }

/** Pool 2 — menus, not schedules: the seed picks the entry POINT, and casting is
 * drawn per section (§2). Register-fit rule for chorus lead: pool allows only
 * high-register carriers (the plan-time fit re-checks each candidate's
 * comfortableRange, see validCandidate). Style presets (future) may shrink
 * pools via masks or override them — that is the style-preset extension seam;
 * no UI in this module. */
export const ROTATION_POOLS: Record<"verse" | "chorus" | "default", LayerPools> = {
  verse: {
    lead: ["cellos", "flutes", "oboes", "violins1", "clarinets"],
    counterline: ["clarinets", "violins2", "cellos", "horns", "violas"],
    ostinato: ["violas", "violins2", "cellos"],
    pad: ["violas", "horns", "clarinets", "violins1"],
    bass: ["bassoons", "cellos", "doubleBass"],
  },
  chorus: {
    lead: ["violins1", "flutes", "oboes"],           // high-register carriers only
    counterline: ["cellos", "horns", "clarinets"],
    ostinato: ["violas", "violins2", "cellos"],
    pad: ["clarinets", "oboes", "trombones", "horns"],
    bass: ["doubleBass", "tuba", "bassoons", "cellos"],
  },
  default: { lead: [], counterline: [], ostinato: [], pad: [], bass: [] }, // empty = leave stage-3 assignment untouched
};

export interface RotationConfig {
  enabled: boolean;
  restBars: number;
  restTriggerBars: number;
  maxActiveTracks: Record<"intro" | "verse" | "preChorus" | "chorus" | "build" | "breakdown" | "outro", number>;
}

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  enabled: true,
  restBars: 2,
  restTriggerBars: 8,
  maxActiveTracks: { intro: 3, verse: 6, preChorus: 10, chorus: 99, build: 99, breakdown: 3, outro: 4 },
};

export function resolveRotationConfig(partial?: { enabled?: boolean; restBars?: number; restTriggerBars?: number; maxActiveTracks?: Record<string, number | undefined> }): RotationConfig {
  const restBars = clamp(Math.round(partial?.restBars ?? DEFAULT_ROTATION_CONFIG.restBars), 2, 4);
  const trigger = Math.max(1, Math.round(partial?.restTriggerBars ?? DEFAULT_ROTATION_CONFIG.restTriggerBars));
  const caps = { ...DEFAULT_ROTATION_CONFIG.maxActiveTracks };
  for (const key of Object.keys(caps) as Array<keyof typeof caps>) {
    const override = partial?.maxActiveTracks?.[key];
    if (typeof override === "number" && Number.isInteger(override) && override >= 1) caps[key] = override;
  }
  return { enabled: partial?.enabled ?? true, restBars, restTriggerBars: trigger, maxActiveTracks: caps };
}

export interface RestWindow { instrumentRole: string; startTick: number; endTick: number }

export interface SectionCasting {
  index: number;
  name: string;
  /** Pool band used for casting (default sections have no casting). */
  poolType: "verse" | "chorus" | "default";
  startTick: number;
  endTick: number;
  /** Instrument (section) roles drawn as this section's carriers. */
  leadCarrier?: string;
  bassCarrier?: string;
  padCarrier?: string;
  counterlineCarrier?: string;
  ostinatoCarrier?: string;
  /** Rest-budget windows (the exiting/kept carrier's breath) at hand-offs. */
  restWindows: RestWindow[];
}

export interface RotationPlan { sections: SectionCasting[] }

/** Normalized pool band from a section name. "Bridge" maps to Build; verses are
 * indexed by position but ALL verses draw from the single verse pool (there is
 * no fixed verseA/verseB schedule). Unknown ("Form") → default (untouched). */
export function poolTypeForSection(name: string): "verse" | "chorus" | "default" {
  const normalized = normalizeSectionName(name);
  if (normalized.includes("verse")) return "verse";
  if (normalized.includes("chorus") && !normalized.includes("pre-chorus") && !normalized.includes("prechorus")) return "chorus";
  return "default";
}

/** Mask-band key for the active cap; bridge maps to build. */
export function maskTypeForSection(name: string): "intro" | "verse" | "preChorus" | "chorus" | "build" | "breakdown" | "outro" | "default" {
  const normalized = normalizeSectionName(name);
  if (normalized.includes("intro")) return "intro";
  if (normalized.includes("pre-chorus") || normalized.includes("prechorus")) return "preChorus";
  if (normalized.includes("chorus")) return "chorus";
  if (normalized.includes("build") || normalized.includes("bridge") || normalized.includes("rise")) return "build";
  if (normalized.includes("break")) return "breakdown";
  if (normalized.includes("outro") || normalized.includes("coda")) return "outro";
  if (normalized.includes("verse")) return "verse";
  return "default";
}

/** Documented register-fit path: planRotation runs PRE-pipeline, so no LEAD
 * events exist yet — the fit uses the POOL ROLE'S TYPICAL REGISTER (the
 * profile's comfortableRange): the section theme median can always be placed
 * after an octave refit when the comfortable span covers an octave; the chorus
 * HIGH-REGISTER ceiling applies to the LEAD layer only (G.2 pools). */
function validCandidate(
  roleKey: string,
  layer: "lead" | "bass" | "pad" | "counterline" | "ostinato",
  poolType: "verse" | "chorus",
  profileForRole: Map<string, InstrumentProfile>,
): boolean {
  const profile = profileForRole.get(roleKey);
  if (!profile) return false;
  const comfortable = profile.comfortableRange ?? profile.writtenRange;
  if (comfortable.high - comfortable.low < 12) return false;
  if (poolType === "chorus" && layer === "lead" && comfortable.high < 84) return false;
  return true;
}

/** Family band from §4 for CANDIDATE PRE-FILTERING in planRotation: e.g. a
 * strings-only mask eliminates brass candidates BEFORE the draw. */
function familyBannedForLayer(poolType: "verse" | "chorus", layer: "lead" | "bass" | "pad" | "counterline" | "ostinato", family: string): boolean {
  if (poolType === "verse" && family === "brass" && layer !== "pad") return true; // brass only for pad/horn rows in verses
  return false;
}

/** §2 — cast every section. Draws ONLY RNG (0x8a55). One draw per layer per
 * casted section; pools are menus, not schedules. */
export function planRotation(
  project: ProjectSchema,
  configPartial?: Parameters<typeof resolveRotationConfig>[0],
  seed = 0,
): RotationPlan {
  const config = resolveRotationConfig(configPartial);
  const castingRng = mulberry32(seed + 0x8a55); // the ONLY RNG spend in this module
  const profiles = projectProfilesFor(project);
  const profileForRole = new Map<string, InstrumentProfile>();
  for (const profile of profiles) if (profile.role) profileForRole.set(profile.role, profile);
  const barTicks = ticksPerBar(project.timeSignature);
  const sectionsOut: SectionCasting[] = [];
  let prevLead: string | undefined;
  let prevCarryBars = 0;

  for (let index = 0; index < project.sections.length; index++) {
    const section = project.sections[index]!;
    const poolType = poolTypeForSection(section.name);
    const startTick = barToTick(section.startBar, project.timeSignature);
    const endTick = startTick + Math.max(1, section.lengthBars) * barTicks;
    const cast: SectionCasting = { index, name: section.name, poolType, startTick, endTick, restWindows: [] };
    if (poolType !== "default" && config.enabled) {
      const pools = ROTATION_POOLS[poolType];
      const used = new Set<string>();
      // Draw order (determinism contract): LEAD → BASS → PAD → COUNTERLINE → OSTINATO.
      const draw = (layer: keyof LayerPools): string | undefined => {
        const valid = pools[layer].filter((roleKey) => {
          if (used.has(roleKey)) return false;
          const profile = profileForRole.get(roleKey);
          if (!profile) return false;
          if (familyBannedForLayer(poolType, layer, profile.family ?? "")) return false;
          return validCandidate(roleKey, layer, poolType, profileForRole);
        });
        if (!valid.length) return undefined; // no draw when nothing valid — the stream is not spent
        return valid[Math.floor(castingRng() * valid.length)]!;
      };
      // §2 hand-off + rest budget: a carrier that carried >= restTriggerBars earns
      // the treatment: redraw excluding it; if the pool is exhausted keep it AND
      // open the section with its rest window (never leave a section leadless).
      // The rest window is emitted for the exiting/kept carrier EVERY time the
      // trigger fires — the previous lead rests at the next section start (its
      // residual events are masked for restBars bars by applyActiveMask; when it
      // is re-cast that doubles as the breathing pause before re-taking the tune).
      let lead = draw("lead");
      if (prevLead !== undefined && prevCarryBars >= config.restTriggerBars) {
        if (lead === prevLead) {
          const alternatives = pools.lead.filter((roleKey) => roleKey !== prevLead
            && !used.has(roleKey) && validCandidate(roleKey, "lead", poolType, profileForRole)
            && !familyBannedForLayer(poolType, "lead", profileForRole.get(roleKey)?.family ?? ""));
          if (alternatives.length) lead = alternatives[Math.floor(castingRng() * alternatives.length)]!;
          // exhausted: keep the previous carrier — the rest window below becomes
          // its breathing pause before re-taking the tune.
        }
        cast.restWindows.push({ instrumentRole: prevLead, startTick, endTick: startTick + config.restBars * barTicks });
      }
      if (lead !== undefined) { cast.leadCarrier = lead; used.add(lead); }
      const bass = draw("bass");
      if (bass !== undefined) { cast.bassCarrier = bass; used.add(bass); }
      const pad = draw("pad");
      if (pad !== undefined) { cast.padCarrier = pad; used.add(pad); }
      const counterline = draw("counterline");
      if (counterline !== undefined) { cast.counterlineCarrier = counterline; used.add(counterline); }
      const ostinato = draw("ostinato");
      if (ostinato !== undefined) { cast.ostinatoCarrier = ostinato; used.add(ostinato); }
      // carry accounting for the NEXT boundary (bars are counted per consecutive
      // section carrying the same lead).
      prevLead = lead;
      prevCarryBars = lead === (sectionsOut.at(-1)?.leadCarrier ?? undefined) ? prevCarryBars + Math.max(1, section.lengthBars) : Math.max(1, section.lengthBars);
    }
    sectionsOut.push(cast);
  }
  return { sections: sectionsOut };
}

/** Plan-time profile list for casting (same DB-backed convention as the bake);
 * projectProfiles is exported from generate.ts (additive export, no logic change). */
function projectProfilesFor(project: ProjectSchema): InstrumentProfile[] {
  return projectProfiles(project);
}

const LAYER_ROLES: Array<{ layer: keyof LayerPools; role: AbstractNoteEvent["role"] }> = [
  { layer: "lead", role: "LEAD" },
  { layer: "bass", role: "BASS" },
  { layer: "pad", role: "PAD" },
  { layer: "counterline", role: "COUNTERLINE" },
  { layer: "ostinato", role: "OSTINATO" },
];

const LAYER_CARRIER_KEY: Record<AbstractNoteEvent["role"], keyof Omit<SectionCasting, "index" | "name" | "poolType" | "startTick" | "endTick" | "restWindows">> = {
  LEAD: "leadCarrier",
  BASS: "bassCarrier",
  PAD: "padCarrier",
  COUNTERLINE: "counterlineCarrier",
  OSTINATO: "ostinatoCarrier",
};

/** Mirror of M8's private breakdown exposed-layer mapping (arrangement.ts keeps
 * EXPOSED_ROLES private; this data copy avoids touching Module 8 files). Used by
 * the active mast's breakdown UNION rule. */
const EXPOSED_ROLE_KEYS: Record<string, string[]> = {
  SOLO_CELLO: ["cellos", "flutes", "harp", "piano"],
  SOLO_WOODWIND: ["oboes", "flutes", "violas", "harp"],
  HARP_PAD: ["harp", "flutes"],
  PIANO_ONLY: ["piano", "flutes"],
};

export function exposedBreakdownRoles(layer: string | undefined): string[] {
  if (!layer) return [];
  return EXPOSED_ROLE_KEYS[layer] ?? [];
}

/** §3 — remap each layer's events onto its drawn carrier and refit registers.
 * Octave shifts + pitchInClass ONLY: pitch classes survive per note, so the
 * motif, cadence targets and chord alignment survive exactly. No RNG here
 * (the casting stream was spent in planRotation). Sections in time order;
 * events in sorted order. */
export function applyRoleRotation(
  events: AbstractNoteEvent[],
  plan: RotationPlan,
  profiles: InstrumentProfile[],
): AbstractNoteEvent[] {
  const profileByRole = new Map<string, InstrumentProfile>();
  const profileById = new Map<string, InstrumentProfile>();
  for (const profile of profiles) {
    profileById.set(profile.id, profile);
    if (profile.role) profileByRole.set(profile.role, profile);
  }
  const out = [...events].sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
  // Pre-sweep instrumentId snapshot — feeds the cameo post-pass below (§3 note).
  const originalInstrument = new Map<AbstractNoteEvent, string>();
  for (const event of out) originalInstrument.set(event, event.instrumentId);
  for (const cast of plan.sections) {
    if (cast.poolType === "default") continue;
    for (const { role } of LAYER_ROLES) {
      const carrierRole = cast[LAYER_CARRIER_KEY[role]];
      if (!carrierRole) continue;
      const carrier = profileByRole.get(carrierRole);
      if (!carrier) continue;
      const group = out.filter((event) => event.role === role && event.startTime >= cast.startTick && event.startTime < cast.endTick);
      if (!group.length) continue;
      let remappedAny = false;
      for (const event of group) {
        const current = profileById.get(event.instrumentId);
        if (current?.role === carrierRole && event.instrumentId === carrier.id) continue;
        event.instrumentId = carrier.id;
        remappedAny = true;
      }
      if (!remappedAny) continue;
      // Octave refit: move the GROUP median into the carrier's comfortable range.
      const comfortable = carrier.comfortableRange ?? carrier.writtenRange;
      const pitches = group.map((event) => event.pitchConcert).sort((a, b) => a - b);
      const mid = Math.floor(pitches.length / 2);
      const median = pitches.length % 2 === 1 ? pitches[mid]! : (pitches[mid - 1]! + pitches[mid]!) / 2;
      let shift = 0;
      let bestDistance = Infinity;
      for (const candidate of [0, 12, -12, 24, -24]) {
        const shifted = median + candidate;
        if (shifted < comfortable.low || shifted > comfortable.high) continue;
        const distance = Math.abs(candidate);
        if (distance < bestDistance) { bestDistance = distance; shift = candidate; }
      }
      if (bestDistance === Infinity) {
        // No octave shift lands inside: take the smallest |shift| anyway.
        shift = (median < (comfortable.low + comfortable.high) / 2 ? 12 : -12);
      }
      const written = carrier.writtenRange;
      for (const event of group) {
        const preferred = event.pitchConcert + shift;
        const refit = pitchInClass(pc(event.pitchConcert), comfortable, preferred);
        event.pitchConcert = refit;
        event.pitchWritten = clamp(refit + (carrier.transpositionSemitones ?? 0), written.low, written.high);
      }
    }
  }
  // §3 refinement — cameo preservation (documented; deterministic, no RNG).
  // The mask cap's "then anything else in existing order" implies non-carrier
  // instruments may keep content up to the cap. A color whose content the sweep
  // silences ENTIRELY across the score would leave a dead track; that is never
  // musical, so it reinstates ONLY the first bar of its original content at its
  // earliest original position — octave refit to ITS OWN comfort range (pitch
  // classes preserved), written pitch re-clamped to its own writtenRange. The
  // mask still applies afterwards; a tight cap (intro/breakdown) may cut the
  // cameo. Casted instruments are never silent, so this touches only uncast
  // colors — one job per instrument still holds.
  const remaining = new Map<string, number>();
  for (const event of out) remaining.set(event.instrumentId, (remaining.get(event.instrumentId) ?? 0) + 1);
  const silentInstruments = new Set<string>();
  for (const profile of profiles) if ((remaining.get(profile.id) ?? 0) === 0) silentInstruments.add(profile.id);
  const earliestByInstrument = new Map<string, AbstractNoteEvent>();
  for (const [event, originalId] of originalInstrument) {
    if (!silentInstruments.has(originalId)) continue;
    const current = earliestByInstrument.get(originalId);
    if (!current || event.startTime < current.startTime
      || (event.startTime === current.startTime && event.pitchConcert < current.pitchConcert)) earliestByInstrument.set(originalId, event);
  }
  const profileComfort = new Map<string, { low: number; high: number }>();
  for (const profile of profiles) profileComfort.set(profile.id, profile.comfortableRange ?? profile.writtenRange);
  const BAR_TICKS = 1920; // 4/4 at PPQ 480 — conservative one-bar cameo window
  // Same-phrase grouping: the cameo keeps the CONTIGUOUS first phrase (forward
  // window ends at the first >1-bar gap), so a color takes a full breath, not a
  // lone blip. The original instrument is restored and the register refit runs
  // in the OPPOSITE direction: octave-only, pitch classes preserved.
  const originalEventsByInstrument = new Map<string, AbstractNoteEvent[]>();
  for (const [event, originalId] of originalInstrument) {
    if (!silentInstruments.has(originalId)) continue;
    const array = originalEventsByInstrument.get(originalId) ?? [];
    array.push(event);
    originalEventsByInstrument.set(originalId, array);
  }
  for (const [instrumentId, anchor] of earliestByInstrument) {
    const profile = profileById.get(instrumentId);
    if (!profile) continue;
    const originalComfort = profile.comfortableRange ?? profile.writtenRange;
    const phrase = (originalEventsByInstrument.get(instrumentId) ?? [])
      .filter((event) => event.startTime >= anchor.startTime && event.startTime <= anchor.startTime + BAR_TICKS)
      .sort((a, b) => a.startTime - b.startTime);
    for (const event of phrase) {
      event.instrumentId = instrumentId;
      const refit = pitchInClass(pc(event.pitchConcert), originalComfort, event.pitchConcert);
      event.pitchConcert = refit;
      event.pitchWritten = clamp(refit + (profile.transpositionSemitones ?? 0), profile.writtenRange.low, profile.writtenRange.high);
    }
  }
  return out;
}

/** §3 — active masks. M8's buildMeasureProfiles is the ONLY energy/section-type
 * source (passed in as `measures`; no new energy math). Allowed set per measure:
 * drawn carriers ∪ M8 breakdown exposed layer (union, never intersection, in
 * breakdown windows) — then the §4 family band — then the maxActiveTracks cap
 * by priority (LEAD, BASS, PAD carriers always kept). Rest windows from the
 * plan additionally mask the resting carrier for their duration. */
export function applyActiveMask(
  events: AbstractNoteEvent[],
  plan: RotationPlan,
  measures: MeasureProfile[],
  config: RotationConfig,
  profiles: InstrumentProfile[],
  exposedRoles: string[],
): AbstractNoteEvent[] {
  const profileById = new Map<string, InstrumentProfile>();
  for (const profile of profiles) profileById.set(profile.id, profile);
  const eventsSorted = [...events].sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);

  // First appearance order (deterministic tiebreak for cap extras).
  const firstAppearance = new Map<string, number>();
  for (const event of eventsSorted) {
    const role = profileById.get(event.instrumentId)?.role ?? "";
    if (role && !firstAppearance.has(role)) firstAppearance.set(role, firstAppearance.size);
  }

  const allowedByMeasure = new Map<number, Set<string>>();
  for (let measureIndex = 0; measureIndex < measures.length; measureIndex++) {
    const measure = measures[measureIndex]!;
    const maskType = maskTypeForSection(measure.sectionType);
    if (maskType === "default") { allowedByMeasure.set(measureIndex, new Set(["*"])); continue; } // Form/unknown: untouched
    const midTick = (measure.startTick + measure.endTick) / 2;
    const cast = plan.sections.find((section) => section.startTick <= midTick && midTick < section.endTick);
    const carriers = cast
      ? (["LEAD", "BASS", "PAD", "COUNTERLINE", "OSTINATO"] as const).map((role) => cast[LAYER_CARRIER_KEY[role]])
      : [];
    const allowed = new Set<string>();
    for (const carrier of carriers) if (carrier) allowed.add(carrier); // minimum-ensemble guarantee first
    if (maskType === "breakdown") for (const role of exposedRoles) allowed.add(role);
    // Family band (§4): intro/outro allow strings+woodwinds+keys only; verse
    // allows brass only for the pad carrier row; other types unrestricted.
    for (const event of eventsSorted) {
      const role = profileById.get(event.instrumentId)?.role ?? "";
      if (!role || allowed.has(role)) continue;
      const family = profileById.get(event.instrumentId)?.family ?? "";
      if ((maskType === "intro" || maskType === "outro") && !["strings", "woodwinds", "keys"].includes(family)) continue;
      if (maskType === "verse" && family === "brass" && role !== cast?.padCarrier) continue;
      allowed.add(role);
    }
    // Cap by priority: the guaranteed assigned carriers (min ensemble) come
    // first; the cap trims only the remaining extras in first-appearance order.
    const cap = config.maxActiveTracks[maskType as keyof RotationConfig["maxActiveTracks"]];
    if (cap !== undefined && Number.isFinite(cap)) {
      const guaranteed = carriers.filter((carrier): carrier is string => Boolean(carrier));
      const ordered = [...guaranteed, ...[...firstAppearance.entries()].sort((a, b) => a[1] - b[1]).map(([role]) => role)];
      const kept = new Set<string>(guaranteed);
      for (const role of ordered) {
        if (kept.size >= cap) break;
        kept.add(role);
      }
      allowedByMeasure.set(measureIndex, kept);
    } else {
      allowedByMeasure.set(measureIndex, allowed);
    }
  }

  const kept = eventsSorted.filter((event) => {
    const profile = profileById.get(event.instrumentId);
    const role = profile?.role ?? "";
    for (const cast of plan.sections) {
      for (const window of cast.restWindows) {
        if (event.startTime >= window.startTick && event.startTime < window.endTick && (role === window.instrumentRole || profile?.role === window.instrumentRole)) return false;
      }
    }
    const measureIndex = measures.findIndex((measure) => measure.startTick <= event.startTime && event.startTime < measure.endTick);
    if (measureIndex < 0) return true; // outside profiles: keep
    const allowed = allowedByMeasure.get(measureIndex)!;
    if (allowed.has("*")) return true;
    if (!role) return true; // unresolvable instrument: keep
    return allowed.has(role);
  });
  return kept.sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
}

/** §5 — chorus role divider: post-bake, after gestures, BEFORE MonophonyGuard.
 * Within a CASTED section, each track's non-doubling notes must share ONE
 * semantic role; on a mix keep the majority (tie → LEAD > COUNTERLINE >
 * OSTINATO > BASS > PAD) and drop the rest. Doubling guests are exempt (they
 * follow their source line — that IS the lead layer). Expected ≈ 0 resolves. */
const DIVIDER_PRIORITY: Record<string, number> = { LEAD: 0, COUNTERLINE: 1, OSTINATO: 2, BASS: 3, PAD: 4 };

export function divideChorusRoles(tracks: Track[], plan?: RotationPlan): Track[] {
  if (!plan) return tracks;
  const casted = plan.sections.filter((section) => section.poolType !== "default"
    && (section.leadCarrier || section.bassCarrier || section.padCarrier || section.counterlineCarrier || section.ostinatoCarrier));
  if (!casted.length) return tracks;
  return tracks.map((track) => {
    let next = track;
    for (const section of casted) {
      const inSection = next.notes.filter((note) => note.startTick >= section.startTick && note.startTick < section.endTick);
      const core = inSection.filter((note) => !note.isDoubling);
      if (!core.length) continue;
      const roles = new Set<string>();
      for (const note of core) {
        if (note.role === undefined) continue;
        roles.add(note.role);
      }
      if (roles.size <= 1) continue;
      const counts = new Map<string, number>();
      for (const note of core) if (note.role !== undefined) counts.set(note.role, (counts.get(note.role) ?? 0) + 1);
      let keepRole: string | undefined;
      let keepCount = -1;
      for (const role of roles) {
        const count = counts.get(role) ?? 0;
        if (count > keepCount || (count === keepCount && DIVIDER_PRIORITY[role] < DIVIDER_PRIORITY[keepRole ?? ""])) {
          keepRole = role; keepCount = count;
        }
      }
      if (keepRole === undefined) continue;
      const dropped = core.filter((note) => note.role !== keepRole).length;
      const keptNotes = next.notes.filter((note) => (note.isDoubling || note.role === undefined || note.role === keepRole) && !(note.role !== undefined && note.role !== keepRole && !note.isDoubling && note.startTick >= section.startTick && note.startTick < section.endTick));
      console.warn("[scorch] chorus role divider resolved", track.name ?? track.id, dropped);
      next = { ...next, notes: keptNotes };
    }
    return next;
  });
}

export type { AbstractNoteEvent, MeasureProfile, Note, Track };
