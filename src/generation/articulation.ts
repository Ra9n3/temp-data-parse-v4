/** Module 4 — playing techniques, articulations & bowings engine.
 *
 * Stage 7 (selectArticulations) and Stage 8 (applyAntiMachineGun) run AFTER
 * rhythm realization, on the realized events. They only attach metadata and
 * bake-safe modifiers; no stage here changes pitchConcert/pitchWritten.
 *
 * Salt registry (see generate.ts): 0x5f3a stages, 0x9e37 rhythm,
 * 0x4a17 articulation, 0xb0b5 anti-machine-gun. Never reuse a salt.
 */
import type { AbstractNoteEvent } from "./generate";
import { msToTicks, ticksToSeconds, ticksPerBeat } from "../shared/schema/time";
import type { TimeSignature } from "../shared/schema/types";

export type StringTechnique =
  | "LEGATO" | "DETACHE" | "PORTATO" | "MARTELE" | "SPICCATO"
  | "JETE" | "SALTANDO" | "PIZZICATO_STD" | "PIZZICATO_SECCO" | "BARTOK_SNAP"
  | "BOWED_TREMOLO" | "FINGERED_TREMOLO" | "SUL_PONTICELLO" | "SUL_TASTO" | "COL_LEGNO";

export type WoodwindTechnique =
  | "LEGATO_SLUR" | "STACCATO_STANDARD" | "STACCATO_DOUBLE_TRIPLE"
  | "FLUTTERTONGUE" | "TRILL_UNMEASURED";

export type BrassTechnique =
  | "STANDARD_TONGUED" | "LEGATO_SLUR" | "FALL_OFF_SHORT" | "FALL_OFF_LONG"
  | "DOIT" | "RIP" | "SHAKE" | "CUP_MUTE" | "STRAIGHT_MUTE" | "HARMON_MUTE";

export type ArticulationTechnique = StringTechnique | WoodwindTechnique | BrassTechnique | "STANDARD";
export type BowDirection = "DOWN_BOW" | "UP_BOW" | "UNDEFINED";

export interface ArticulationMetaData {
  primaryTechnique: ArticulationTechnique;
  bowDirection: BowDirection;
  noteDurationMultiplier: number; // 0.40 spiccato, 0.65 martele, 0.85 detache, 1.02 legato …
  velocityOffset: number; // -15..+15, added to computed velocity then clamped 1..127
  cc74CutoffOffset: number; // offset applied to the track's brightness CC value (base 64)
  preTriggerDelayMs: number; // -15 = key-switch must precede the note by 15 ms (VST3 voice buffer switch)
  timingOffsetTicks?: number; // anti-machine-gun micro-timing, added at bake time, clamped >= 0
  machineGunTagged?: boolean;
}

export interface PitchBendPoint { tick: number; cents: number } // cents clamped to ±200 at export

export interface EvaluatedNote extends AbstractNoteEvent {
  articulation: ArticulationMetaData;
  bendPoints: PitchBendPoint[];
}

/** Techniques realized as metadata only this module: real sample libraries trigger
 * these via key-switch/CC, which is the native JUCE engine's job, not the MIDI stream's. */
export const TAG_ONLY_TECHNIQUES: ReadonlySet<ArticulationTechnique> = new Set([
  "FLUTTERTONGUE", "TRILL_UNMEASURED", "SHAKE", "FINGERED_TREMOLO",
  "CUP_MUTE", "STRAIGHT_MUTE", "HARMON_MUTE",
  "JETE", "SALTANDO", "BARTOK_SNAP", "PIZZICATO_SECCO", "PORTATO", "COL_LEGNO",
]);

const RUN_TECHNIQUES: ReadonlySet<ArticulationTechnique> = new Set(["DETACHE", "SPICCATO", "MARTELE"]);

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));

/** Dynamic band boundaries, matching dynamicLabel() in Arranger.tsx:
 *  pp [0,0.2) p [0.2,0.4) mp [0.4,0.6) mf [0.6,0.8) f [0.8,0.95) ff [0.95,1].
 *  "≥ mf" therefore means normalizedDynamic ≥ 0.6, "≥ f" ≥ 0.8, "≥ ff" ≥ 0.95. */
export const DYN = {
  PP: 0.2,
  P: 0.4,
  MP: 0.6,
  MF: 0.6,
  F: 0.8,
  FF: 0.95,
} as const;

export const DURATION_MULTIPLIERS: Partial<Record<ArticulationTechnique, number>> = {
  SPICCATO: 0.4, MARTELE: 0.65, DETACHE: 0.85, LEGATO: 1.02, LEGATO_SLUR: 1.02,
  STACCATO_STANDARD: 0.5, STACCATO_DOUBLE_TRIPLE: 0.45, PIZZICATO_STD: 0.6,
  PORTATO: 0.9, COL_LEGNO: 0.6, JETE: 0.4, SALTANDO: 0.4,
  BOWED_TREMOLO: 1.0, SUL_TASTO: 1.0, SUL_PONTICELLO: 1.0, STANDARD: 1.0, STANDARD_TONGUED: 0.95,
};

export const VELOCITY_OFFSETS: Partial<Record<ArticulationTechnique, number>> = {
  MARTELE: 6, BOWED_TREMOLO: 4, SUL_PONTICELLO: 4, RIP: 3, DOIT: 3, FALL_OFF_SHORT: 3,
  DETACHE: -2, PIZZICATO_STD: -4, SUL_TASTO: -6,
};

export const CC74_OFFSETS: Partial<Record<ArticulationTechnique, number>> = {
  SUL_TASTO: -24, SUL_PONTICELLO: 63, LEGATO: 4, LEGATO_SLUR: 4, BOWED_TREMOLO: 8, MARTELE: -6,
};

export interface ArticulationContext {
  bpm: number;
  timeSignature: TimeSignature;
  /** Instrument profiles already in scope at the adapter; family lookups use these. */
  profiles: Array<{ id: string; family?: string }>;
  rng: () => number;
}

// The semantic score carries no separate tension value on events; normalizedDynamic
// stands in for the spec's "Energy/Tension" input in every threshold below.
function pick<T extends ArticulationTechnique>(technique: T): Pick<ArticulationMetaData, "primaryTechnique" | "noteDurationMultiplier" | "velocityOffset" | "cc74CutoffOffset"> {
  return {
    primaryTechnique: technique,
    noteDurationMultiplier: DURATION_MULTIPLIERS[technique] ?? 1.0,
    velocityOffset: VELOCITY_OFFSETS[technique] ?? 0,
    cc74CutoffOffset: CC74_OFFSETS[technique] ?? 0,
  };
}

function familyOf(event: AbstractNoteEvent, ctx: ArticulationContext): string | undefined {
  return ctx.profiles.find((profile) => profile.id === event.instrumentId)?.family;
}

/** Bowing rules: plucked → UNDEFINED; runs alternate on non-strong beats; bowed otherwise down/up by strength. */
export function resolveBowDirection(
  technique: ArticulationTechnique,
  role: AbstractNoteEvent["role"],
  normalizedDynamic: number,
  startTick: number,
  beatTicks: number,
  previous: BowDirection,
): BowDirection {
  if (technique === "PIZZICATO_STD" || technique === "PIZZICATO_SECCO" || technique === "BARTOK_SNAP" || technique === "COL_LEGNO") {
    return "UNDEFINED";
  }
  const beatIndex = Math.floor(startTick / beatTicks);
  const strongBeat = Math.abs(startTick - beatIndex * beatTicks) < 1 && beatIndex % 2 === 0;
  if (RUN_TECHNIQUES.has(technique) && role !== "BASS") {
    if (strongBeat) return "DOWN_BOW"; // reset point
    return previous === "DOWN_BOW" ? "UP_BOW" : "DOWN_BOW";
  }
  if (strongBeat || normalizedDynamic >= DYN.MF) return "DOWN_BOW";
  return "UP_BOW";
}

/** Stage 7 — per-event technique selection (decision trees from Module 4 spec; 0.25s/0.50s matrix). */
export function selectArticulations(events: AbstractNoteEvent[], ctx: ArticulationContext): EvaluatedNote[] {
  const beatTicks = ticksPerBeat(ctx.timeSignature);
  const sorted = [...events].sort((a, b) => a.startTime - b.startTime);
  const evaluated: EvaluatedNote[] = [];
  let previousBow: BowDirection = "DOWN_BOW";
  for (const event of sorted) {
    const family = familyOf(event, ctx);
    const seconds = ticksToSeconds(event.duration, ctx.bpm);
    const dyn = event.normalizedDynamic;
    let technique: ArticulationTechnique;
    const bendPoints: PitchBendPoint[] = [];
    if (family === "strings") {
      if (seconds < 0.25) technique = "SPICCATO";
      else if (seconds < 0.5) technique = dyn >= DYN.MF ? "MARTELE" : "DETACHE";
      else if (seconds >= 1.0 && dyn >= DYN.F) technique = "BOWED_TREMOLO";
      else if (dyn < DYN.PP) technique = "SUL_TASTO";
      else technique = "LEGATO";
      // Color rule: soft low spiccato basses become plucked.
      if (technique === "SPICCATO" && event.role === "BASS" && dyn < DYN.P) technique = "PIZZICATO_STD";
    } else if (family === "woodwinds") {
      if (seconds < 0.12) technique = "STACCATO_DOUBLE_TRIPLE";
      else if (seconds < 0.2) technique = "STACCATO_STANDARD";
      else if (seconds >= 1.0 && dyn >= DYN.FF && event.instrumentId.toLowerCase().includes("flute")) technique = "FLUTTERTONGUE";
      else technique = "LEGATO_SLUR";
    } else if (family === "brass") {
      const onBeat = event.startTime % beatTicks < 1;
      if (dyn >= DYN.F && !onBeat) {
        technique = "RIP"; // scoop into the note
        bendPoints.push({ tick: event.startTime, cents: -150 });
        bendPoints.push({ tick: event.startTime + msToTicks(70, ctx.bpm), cents: 0 });
      } else if (dyn >= DYN.F && seconds >= 0.5) {
        technique = "DOIT"; // upward bend tail
        const end = event.startTime + event.duration;
        bendPoints.push({ tick: Math.max(0, end - msToTicks(120, ctx.bpm)), cents: 0 });
        bendPoints.push({ tick: end, cents: 170 });
      } else if (dyn >= DYN.F) {
        technique = "FALL_OFF_SHORT"; // downward bend tail
        const end = event.startTime + event.duration;
        bendPoints.push({ tick: Math.max(0, end - msToTicks(80, ctx.bpm)), cents: 0 });
        bendPoints.push({ tick: end, cents: -170 });
      } else if (seconds < 0.2) technique = "STACCATO_STANDARD";
      else if (seconds >= 0.5) technique = "LEGATO_SLUR";
      else technique = "STANDARD_TONGUED";
    } else {
      // Keys and percussion pass through with no articulation metadata at all
      // (requirement: never emit articulation metadata for percussion; keys stay untouched).
      if (family === "percussion" || family === "keys") continue;
      technique = "STANDARD";
    }
    const articulation: ArticulationMetaData = {
      ...pick(technique),
      bowDirection: family === "strings"
        ? resolveBowDirection(technique, event.role, dyn, event.startTime, beatTicks, previousBow)
        : "UNDEFINED",
      ...pick(technique),
      cc74CutoffOffset: CC74_OFFSETS[technique] ?? 0,
      preTriggerDelayMs: TAG_ONLY_TECHNIQUES.has(technique) || technique === "SPICCATO" ? 15 : 0,
      timingOffsetTicks: 0,
    };
    if (articulation.bowDirection !== "UNDEFINED") previousBow = articulation.bowDirection;
    evaluated.push({ ...event, articulation, bendPoints });
  }
  return evaluated;
}

/** Stage 8 — tag chained repeated short notes with deterministic anti-machine-gun jitter. */
export function applyAntiMachineGun(events: EvaluatedNote[], ctx: ArticulationContext): EvaluatedNote[] {
  type Chain = number[];
  const groups = new Map<string, Chain>();
  for (let index = 0; index < events.length; index++) {
    const key = `${events[index]!.instrumentId}:${events[index]!.pitchConcert}:${events[index]!.articulation.primaryTechnique}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(index);
    groups.set(key, bucket);
  }
  const chainGap = msToTicks(30, ctx.bpm);
  for (const indices of groups.values()) {
    let chain: Chain = [];
    let chainEnd = -Infinity;
    const flush = () => {
      if (chain.length >= 3) tagChain(chain, events, ctx);
      chain = [];
    };
    for (const index of indices) {
      const note = events[index]!;
      const seconds = ticksToSeconds(note.duration, ctx.bpm);
      const short = seconds < 0.5;
      if (chain.length && (note.startTime - chainEnd > chainGap || !short)) flush();
      if (short) {
        chain.push(index);
        chainEnd = note.startTime + note.duration;
      }
    }
    flush();
  }
  return events;
}

function tagChain(chain: number[], events: EvaluatedNote[], ctx: ArticulationContext): void {
  chain.forEach((index, position) => {
    if (position === 0) return;
    const note = events[index]!;
    const rawJitter = Math.round(ctx.rng() * 8 - 4);
    note.articulation = {
      ...note.articulation,
      machineGunTagged: true,
      velocityOffset: clamp(note.articulation.velocityOffset + rawJitter, -15, 15),
      timingOffsetTicks: Math.round((ctx.rng() * 2 - 1) * msToTicks(2, ctx.bpm)),
    };
    // Runs must also alternate bow direction within the chain.
    if (RUN_TECHNIQUES.has(note.articulation.primaryTechnique) && position % 2 === 1) {
      note.articulation.bowDirection = note.articulation.bowDirection === "DOWN_BOW" ? "UP_BOW" : "DOWN_BOW";
    }
  });
}
