/**
 * Module 11 — Woodwind virtual chairs, auxiliary switching and register balance.
 *
 * MODEL: chairs are a DATA LAYER over the existing section profiles — the project
 * keeps its 21 section tracks; multiple virtual chairs may map onto one section
 * track. Real per-chair tracks / patch switching are native-engine territory
 * (documented in ASSUMPTIONS.md). Aux notes are written on the chair's SECTION
 * track at SOUNDING pitch (`Note.auxInstrumentId` tags the instrument; the
 * piccolo octave from the doubling rule IS the sounding pitch).
 *
 * OWNERSHIP MAP (no double-processing):
 *   M6 low-flute unison protection (flutes→clarinets < 67) — untouched (11.4 verify-only).
 *   Doubling engine guests (salt 0xd0b1, occupancy ledger) — untouched; this
 *     module INTERCEPTS post-doubling events whose receiver is an aux
 *     instrument and converts them to chair switches per the reconciliation.
 *   M7 balance — Phase B extends calculateNoteDynamics/doubling rule data in place.
 *   MonophonyGuard stays LAST and inviolable; switches make the chair's primar y
 *     silent during the aux window so the result is structurally mono.
 *
 * DETERMINISM LAW: no new RNG/salts. Every choice resolves by deterministic
 * rules: an idle chair = one whose section track has no notes in the window;
 * ties resolve to the lowest chair index / instrument-id order.
 * Timing discipline: the only new offset is the +5 ms switch stabilization,
 * inside the ±15 ms ASSUMPTIONS cap, clamped startTick ≥ 0.
 */

import { msToTicks, ticksPerBar, ticksToSeconds } from "../shared/schema/time";
import type { TimeSignature } from "../shared/schema/types";

export type WoodwindEnsemble = "THREES_LARGE" | "PAIRS_CHAMBER";
export const DEFAULT_WOODWIND_ENSEMBLE: WoodwindEnsemble = "THREES_LARGE";
export const WOODWIND_ENSEMBLES: WoodwindEnsemble[] = ["THREES_LARGE", "PAIRS_CHAMBER"];

export interface ChairAssignment {
  chairId: string;
  chairName: string;
  /** Section role key ("flutes" | "oboes" | "clarinets" | "bassoons"). */
  primaryInstrumentId: string;
  auxiliaryInstrumentIds: string[];
}

/** THREES_LARGE: 3 flutes, 3 oboes (3rd doubles English horn), 3 clarinets
 * (3rd doubles bass clarinet), bassoons. The contrabassoon (Bassoon 3's aux
 * slot) is OMITTED — the instrument DB has none (documented deferral).
 * PIT_MULTI_REED is likewise deferred — no saxophones in the DB. */
export const WOODWIND_CHAIRS: Record<WoodwindEnsemble, ChairAssignment[]> = {
  THREES_LARGE: [
    { chairId: "ww_fl_1", chairName: "Flute 1", primaryInstrumentId: "flutes", auxiliaryInstrumentIds: ["piccolo"] },
    { chairId: "ww_fl_2", chairName: "Flute 2", primaryInstrumentId: "flutes", auxiliaryInstrumentIds: [] },
    { chairId: "ww_fl_3", chairName: "Flute 3", primaryInstrumentId: "flutes", auxiliaryInstrumentIds: [] },
    { chairId: "ww_ob_1", chairName: "Oboe 1", primaryInstrumentId: "oboes", auxiliaryInstrumentIds: [] },
    { chairId: "ww_ob_2", chairName: "Oboe 2", primaryInstrumentId: "oboes", auxiliaryInstrumentIds: [] },
    { chairId: "ww_ob_3", chairName: "Oboe 3 · English Horn", primaryInstrumentId: "oboes", auxiliaryInstrumentIds: ["englishHorn"] },
    { chairId: "ww_cl_1", chairName: "Clarinet 1 in Bb", primaryInstrumentId: "clarinets", auxiliaryInstrumentIds: [] },
    { chairId: "ww_cl_2", chairName: "Clarinet 2 in Bb", primaryInstrumentId: "clarinets", auxiliaryInstrumentIds: [] },
    { chairId: "ww_cl_3", chairName: "Clarinet 3 · Bass Clarinet", primaryInstrumentId: "clarinets", auxiliaryInstrumentIds: ["bassClarinet"] },
    { chairId: "ww_bn_1", chairName: "Bassoon 1", primaryInstrumentId: "bassoons", auxiliaryInstrumentIds: [] },
    { chairId: "ww_bn_2", chairName: "Bassoon 2", primaryInstrumentId: "bassoons", auxiliaryInstrumentIds: [] },
  ],
  PAIRS_CHAMBER: [
    { chairId: "wp_fl_1", chairName: "Flute 1", primaryInstrumentId: "flutes", auxiliaryInstrumentIds: ["piccolo"] },
    { chairId: "wp_fl_2", chairName: "Flute 2", primaryInstrumentId: "flutes", auxiliaryInstrumentIds: [] },
    { chairId: "wp_ob_1", chairName: "Oboe 1", primaryInstrumentId: "oboes", auxiliaryInstrumentIds: [] },
    { chairId: "wp_ob_2", chairName: "Oboe 2 · English Horn", primaryInstrumentId: "oboes", auxiliaryInstrumentIds: ["englishHorn"] },
    { chairId: "wp_cl_1", chairName: "Clarinet 1 in Bb", primaryInstrumentId: "clarinets", auxiliaryInstrumentIds: [] },
    { chairId: "wp_cl_2", chairName: "Clarinet 2 · Bass Clarinet", primaryInstrumentId: "clarinets", auxiliaryInstrumentIds: ["bassClarinet"] },
    { chairId: "wp_bn_1", chairName: "Bassoon 1", primaryInstrumentId: "bassoons", auxiliaryInstrumentIds: [] },
    { chairId: "wp_bn_2", chairName: "Bassoon 2", primaryInstrumentId: "bassoons", auxiliaryInstrumentIds: [] },
  ],
};

/** Aux guest events may carry either the DB instrument id or the pipeline role. */
export const AUX_CANONICAL: Record<string, string> = {
  piccolo: "piccolo",
  english_horn: "englishHorn",
  englishHorn: "englishHorn",
  bass_clarinet: "bassClarinet",
  bassClarinet: "bassClarinet",
};

/** The switch interval from the chair's primary line to the aux instrument in
 * semitones (piccolo sounds one octave above the written flute line). */
const AUX_INTERVAL_SEMITONES: Record<string, number> = { piccolo: 12, englishHorn: 0, bassClarinet: 0 };

/** Task 11.2b constants — deterministic, within the ±15 ms timing discipline. */
export const AUX_SWITCH_DELAY_MS = 5;
export const AUX_SWITCH_VELOCITY_FACTOR = 0.95;

export interface SwitchValidation {
  ok: boolean;
  elapsedSeconds: number;
  elapsedMeasures: number;
  /** null = switch valid; otherwise the deterministic fallback that fired. */
  fallback: null | "idle-chair" | "keep-primary";
}

export interface SwitchWindow {
  startTick: number;
  endTick: number;
}

export interface AuxSwitchEventLike {
  instrumentId: string;
  pitchConcert: number;
  startTime: number;
  duration: number;
  normalizedDynamic: number;
  isDoubling?: boolean;
}

/** Task 11.2 — validate a would-be chair switch: elapsed = first aux note
 * start − the chair's last primary note end (converted via ticksToSeconds).
 * Valid iff elapsed ≥ 4.0 s OR ≥ 2 measures. PURE. */
export function validateAuxSwitch(
  chair: ChairAssignment,
  events: AuxSwitchEventLike[],
  window: SwitchWindow,
  config: { bpm: number; timeSignature: TimeSignature; trackIdForInstrument: (role: string) => string | undefined },
): SwitchValidation {
  const primaryTrackId = config.trackIdForInstrument(chair.primaryInstrumentId);
  const lastPrimaryEnd = primaryTrackId === undefined ? 0 : events
    .filter((event) => event.instrumentId === primaryTrackId && event.startTime + event.duration <= window.startTick && !(event as { auxInstrumentId?: string }).auxInstrumentId)
    .reduce((max, event) => Math.max(max, event.startTime + event.duration), 0);
  const elapsedTicks = window.startTick - lastPrimaryEnd;
  const elapsedSeconds = ticksToSeconds(Math.max(0, elapsedTicks), config.bpm);
  const elapsedMeasures = elapsedTicks / ticksPerBar(config.timeSignature);
  const ok = elapsedSeconds >= 4.0 || elapsedMeasures >= 2;
  return { ok, elapsedSeconds, elapsedMeasures, fallback: ok ? null : "idle-chair" };
}

export interface AuxSwitchConfig {
  ensemble: WoodwindEnsemble;
  /** resolve a section role (or instrument id) to the project's section track id. */
  trackIdForInstrument: (role: string) => string | undefined;
  /** comfortable range per track id — routing candidates must accommodate the sounding pitch. */
  rangeForTrack?: (trackId: string) => { low: number; high: number } | undefined;
}

/** Task 11.1 — the aux switch engine. Identifies aux-guest events (post-doubling;
 * the doubling rules still create them — Task 11.4 verify-only), validates each
 * switch and executes/falls back per the reconciliation decisions:
 *   1. aux octave-double on a simultaneously-playing chair is impossible →
 *      ONE PLAYER, ONE INSTRUMENT: on a valid switch the chair's handed-off
 *      primary notes (the exact events the double was layered on) are removed
 *      for that window and the aux line takes over, tagged auxInstrumentId.
 *   4. invalid → (a) idle same-family chair (ledger/overlap-checked, lowest
 *      chair index), (b) keep the line on primary (drop the guest colour),
 *      (c) warn + drop. Deterministic order throughout.
 *   5. post-switch stabilization: the first aux note of a switch burst gets
 *      +5 ms start (≥ 0) and −5% velocity (normalizedDynamic ×0.95 — linear
 *      through the balance/bake pipeline).
 * Guest events whose source primary cannot be located keep today's behavior
 * (dropped at the bake) — byte-identical. */
export function applyAuxSwitches<T extends AuxSwitchEventLike & { auxInstrumentId?: string }>(
  events: T[],
  config: AuxSwitchConfig,
  bpm: number,
  timeSignature: TimeSignature,
): T[] {
  const hasGuests = events.some((event) => event.isDoubling && AUX_CANONICAL[event.instrumentId]);
  if (!hasGuests) return events; // byte-identical fast path
  const chairs = WOODWIND_CHAIRS[config.ensemble];
  const auxGuests = events
    .map((event, index) => ({ event, index }))
    .filter((entry) => entry.event.isDoubling && AUX_CANONICAL[entry.event.instrumentId]);
  const removed = new Set<number>();
  const converted = new Map<number, T>(); // original index → replacement event
  const lastSwingEnd = new Map<string, number>(); // chair id → last aux window end handled
  const delayTicks = msToTicks(AUX_SWITCH_DELAY_MS, bpm); // +5 ms, inside the ±15 ms cap
  const stabilize = (guest: T): T => ({
    ...guest,
    startTime: Math.max(0, guest.startTime + delayTicks),
    normalizedDynamic: guest.normalizedDynamic * AUX_SWITCH_VELOCITY_FACTOR, // −5% velocity (linear through balance/bake)
  });
  for (const { event: guest, index } of auxGuests) {
    const aux = AUX_CANONICAL[guest.instrumentId];
    if (!aux) continue;
    const chair = chairs.find((candidate) => candidate.auxiliaryInstrumentIds.includes(aux));
    if (!chair) continue; // no virtual chair owns this aux — keep today's bake-drop behavior
    const primaryTrackId = config.trackIdForInstrument(chair.primaryInstrumentId);
    if (primaryTrackId === undefined) continue;
    const interval = AUX_INTERVAL_SEMITONES[aux] ?? 0;
    // locate the exact source primary the double was layered on (one player, one instrument)
    const sourceIndex = events.findIndex((candidate, candidateIndex) =>
      !removed.has(candidateIndex) &&
      candidate.instrumentId === primaryTrackId &&
      candidate.startTime === guest.startTime &&
      candidate.pitchConcert === guest.pitchConcert - interval,
    );
    if (sourceIndex === -1) continue; // orphan guest — today's silent drop, byte-identical
    const window: SwitchWindow = { startTick: guest.startTime, endTick: guest.startTime + guest.duration };
    const validation = validateAuxSwitch(chair, events, window, { bpm, timeSignature, trackIdForInstrument: config.trackIdForInstrument });
    const stabilized = guest.startTime > (lastSwingEnd.get(chair.chairId) ?? -Infinity);
    const settledTag = stabilized ? stabilize(guest) : guest;
    if (validation.ok) {
      // decision 1: one player, one instrument — the doubled primary hands off
      removed.add(sourceIndex);
      converted.set(index, { ...settledTag, instrumentId: primaryTrackId, auxInstrumentId: aux } as T);
      lastSwingEnd.set(chair.chairId, window.endTick);
      continue;
    }
    // decision 4 fallback (a): idle same-family chair (woodwinds), excluding the
    // switching chair's own section; lowest ensemble order wins; range must fit.
    const routed = chairs.find((candidate) => {
      if (candidate.chairId === chair.chairId) return false;
      const candidateTrackId = config.trackIdForInstrument(candidate.primaryInstrumentId);
      if (candidateTrackId === undefined || candidateTrackId === primaryTrackId) return false;
      const range = config.rangeForTrack?.(candidateTrackId);
      if (range && (guest.pitchConcert < range.low || guest.pitchConcert > range.high)) return false;
      return !events.some((other, otherIndex) =>
        !removed.has(otherIndex) &&
        other.instrumentId === candidateTrackId &&
        other.startTime < window.endTick && window.startTick < other.startTime + other.duration,
      );
    });
    if (routed) {
      removed.add(sourceIndex);
      converted.set(index, { ...settledTag, instrumentId: config.trackIdForInstrument(routed.primaryInstrumentId)!, auxInstrumentId: aux } as T);
    } else {
      // fallback (b)→(c): keep the line on primary — drop the aux colour with a warn
      console.warn(`[scorch] impossible aux switch ${chair.chairId} elapsed=${validation.elapsedSeconds.toFixed(2)}s/${validation.elapsedMeasures.toFixed(2)}m — aux colour dropped`);
    }
    lastSwingEnd.set(chair.chairId, window.endTick);
  }
  if (!removed.size && !converted.size) return events;
  const out: T[] = [];
  for (let index = 0; index < events.length; index++) {
    if (removed.has(index)) continue;
    out.push(converted.get(index) ?? events[index]);
  }
  return out.sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
}
