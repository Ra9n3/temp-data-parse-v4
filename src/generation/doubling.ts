/** Module 6 — post-score multi-instrument doubling, disposition & anti-flanging.
 *
 * Deterministic by design: every draw comes from ONE mulberry32 stream seeded with
 * salt 0xd0b1 (doubling draws first, then anti-flanging consumes the same stream
 * in event order — documented pattern, no other salt reused). Stage ordering:
 * doubling → anti-flanging, both BEFORE the adapter bake, both AFTER AMG.
 * Doubled events are octave/unison doublings across DIFFERENT instruments, so they
 * are exempt from LowIntervalLimitFilter zone compliance by design (see the
 * OCTAVE_DOUBLING note in VoiceLeadingOptimizer).
 *
 * Transposition convention here is the GENERATE profile convention:
 * pitchWritten = pitchConcert + transpositionSemitones (horn +7).
 * instrument_db.json uses the OPPOSITE sign (written = concert − transposition) —
 * never mix them.
 */
import type { AbstractNoteEvent, InstrumentProfile } from "./generate";
import { msToTicks } from "../shared/schema/time";

export type DispositionType = "JUXTAPOSITION" | "INTERLOCKING" | "ENCLOSURE" | "OVERLAPPING";

export interface DoublingRule {
  primaryRole: string;            // e.g. "flutes" (role, not instrument id)
  doublingRole: string;           // e.g. "oboes"
  intervalSemitones: number;      // 0 unison, +12 above, -12 below
  minDynamicLevel: number;        // only trigger at/above this normalizedDynamic
  maxDynamicLevel: number;
  condition: "LOW_REGISTER_PROTECTION" | "TUTTI_PEAK" | "ALWAYS";
}

export interface AntiFlangingConfig {
  enableMicroDetune: boolean;     // default true
  detuneRangeCents: [number, number]; // default [-5, +5], split applied deterministically
  enableMicroDelay: boolean;      // default true
  delayRangeMs: [number, number]; // default [4, 12]
  filterCutoffJitterPercent: number; // default 0.04
}

export interface DoublingConfig {
  enabled: boolean;               // default true
  maxDoublesPerNote: number;      // default 1
  rules?: DoublingRule[];         // undefined = DEFAULT_DOUBLING_RULES
  antiFlanging: AntiFlangingConfig;
  preferredWoodwindDisposition?: DispositionType;
  preferredBrassDisposition?: DispositionType;
}

export const DEFAULT_ANTI_FLANGING: AntiFlangingConfig = {
  enableMicroDetune: true,
  detuneRangeCents: [-5, 5],
  enableMicroDelay: true,
  delayRangeMs: [4, 12],
  filterCutoffJitterPercent: 0.04,
};

export const DEFAULT_DOUBLING_RULES: DoublingRule[] = [
  // Unison hybrid timbres (matrix §2) — all roles exist in current profiles
  { primaryRole: "flutes", doublingRole: "oboes", intervalSemitones: 0, minDynamicLevel: 0.6, maxDynamicLevel: 1, condition: "ALWAYS" },
  { primaryRole: "flutes", doublingRole: "clarinets", intervalSemitones: 0, minDynamicLevel: 0.6, maxDynamicLevel: 1, condition: "ALWAYS" },
  { primaryRole: "oboes", doublingRole: "clarinets", intervalSemitones: 0, minDynamicLevel: 0.6, maxDynamicLevel: 1, condition: "ALWAYS" },
  { primaryRole: "bassoons", doublingRole: "cellos", intervalSemitones: 0, minDynamicLevel: 0.5, maxDynamicLevel: 1, condition: "ALWAYS" },
  { primaryRole: "horns", doublingRole: "bassoons", intervalSemitones: 0, minDynamicLevel: 0.5, maxDynamicLevel: 1, condition: "ALWAYS" },
  // Octave doublings — roles in the DB-backed profiles, including Module 3.5 instruments.
  { primaryRole: "flutes", doublingRole: "violins1", intervalSemitones: 12, minDynamicLevel: 0.75, maxDynamicLevel: 1, condition: "TUTTI_PEAK" },
  { primaryRole: "flutes", doublingRole: "piccolo", intervalSemitones: 12, minDynamicLevel: 0.8, maxDynamicLevel: 1, condition: "TUTTI_PEAK" },
  { primaryRole: "cellos", doublingRole: "doubleBass", intervalSemitones: -12, minDynamicLevel: 0.75, maxDynamicLevel: 1, condition: "TUTTI_PEAK" },
  { primaryRole: "tuba", doublingRole: "bassTrombone", intervalSemitones: 0, minDynamicLevel: 0.75, maxDynamicLevel: 1, condition: "TUTTI_PEAK" },
  // Mandatory register-protection rules (§2B); ignore dynamic thresholds.
  { primaryRole: "flutes", doublingRole: "clarinets", intervalSemitones: 0, minDynamicLevel: 0, maxDynamicLevel: 1, condition: "LOW_REGISTER_PROTECTION" },   // concert pitch < 67 (below G4)
  { primaryRole: "cellos", doublingRole: "bassoons", intervalSemitones: 12, minDynamicLevel: 0, maxDynamicLevel: 1, condition: "LOW_REGISTER_PROTECTION" },   // concert pitch < 36 (below C2)
  // Module 8.5 §4 — chorus lead brass color: the violins1 tutti carries gain a
  // trumpet octave top at fortissimo peaks. Gated by the rotation engine (the
  // wiring strips this rule when rotation is disabled for byte-identity). The
  // occupancy ledger + sparse gates govern insertion as for every other rule.
  { primaryRole: "violins1", doublingRole: "trumpets", intervalSemitones: 12, minDynamicLevel: 0.85, maxDynamicLevel: 1, condition: "TUTTI_PEAK" },
  // Module 8.6 B5 — chorus weight: the violins1 tutti peak picks up a violins2
  // unison to thicken the section. Ledger-gated like every double: it lands ONLY
  // where violins2 is actually resting, and the wiring strips this rule when the
  // rotation engine is disabled so the engines-off + rotor-off golden digests stay
  // byte-identical (same pattern as the violins1→trumpets 8.5 rule above).
  { primaryRole: "violins1", doublingRole: "violins2", intervalSemitones: 0, minDynamicLevel: 0.85, maxDynamicLevel: 1, condition: "TUTTI_PEAK" },
];

export const DEFAULT_DOUBLING_CONFIG: DoublingConfig = {
  enabled: true,
  maxDoublesPerNote: 1,
  rules: DEFAULT_DOUBLING_RULES,
  antiFlanging: DEFAULT_ANTI_FLANGING,
};

const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const pc = (n: number) => ((Math.round(n) % 12) + 12) % 12;

/** Re-declared locally per module convention (don't cross-import generate.ts internals). */
function pitchInClass(pitchClass: number, range: { low: number; high: number }, preferred: number): number {
  const valid: number[] = [];
  for (let pitch = range.low; pitch <= range.high; pitch++) if (pc(pitch) === pc(pitchClass)) valid.push(pitch);
  if (!valid.length) return clamp(preferred, range.low, range.high);
  return valid.reduce((best, pitch) => Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, valid[0]);
}

export interface DoublingContext {
  profiles: InstrumentProfile[];
  rng: () => number;
  config: DoublingConfig;
  /** Module 8.6 B5: when set (rotation-enabled runs only), the TUTTI_PEAK global
   * dynamic floor drops from 0.8 so the tutti picks fire more often — the raised
   * gate rate. ALWAYS keeps its seeded 35% sparse gate untouched. Undefined
   * (rotation disabled) = the pre-8.6 floor of 0.8, byte-identical for the golden
   * digests: no extra draws, purely a threshold change gated in the wiring. */
  tuttiPeakFloor?: number;
}

function profileForEvent(event: AbstractNoteEvent, profiles: InstrumentProfile[]): InstrumentProfile | undefined {
  return profiles.find((profile) => profile.id === event.instrumentId);
}

const BASS_ACTING_ROLES = new Set(["cellos", "bassoons"]);

/** whether the rule's condition holds for this event. */
function conditionMet(rule: DoublingRule, event: AbstractNoteEvent, profile: InstrumentProfile | undefined, ctx?: DoublingContext): boolean {
  if (rule.condition === "LOW_REGISTER_PROTECTION") {
    // Mandatory register protection: flutes below G4 (concert 67),
    // and bass-acting cellos/bassoons below C2 (concert 36). Dynamic ignored.
    if ((profile?.role ?? "").startsWith("flut") || profile?.role === "flutes") return event.pitchConcert < 67;
    if (BASS_ACTING_ROLES.has(profile?.role ?? "")) return event.pitchConcert < 36;
    return false;
  }
  if (rule.condition === "TUTTI_PEAK") return event.normalizedDynamic >= (ctx?.tuttiPeakFloor ?? 0.8) && event.normalizedDynamic >= rule.minDynamicLevel && event.normalizedDynamic <= rule.maxDynamicLevel;
  return event.normalizedDynamic >= rule.minDynamicLevel && event.normalizedDynamic <= rule.maxDynamicLevel;
}

/** Polyphony hotfix — occupancy ledger: per-instrument calendar of event windows.
 * The receiver's own line always wins; doubles are guests. A receiver accepts at
 * most ONE doubling source per window. Deterministic, no RNG. */
export class OccupancyLedger {
  private windows = new Map<string, Array<{ start: number; end: number; source: string }>>();

  constructor(events: AbstractNoteEvent[]) {
    for (const event of events) {
      this.add(event.instrumentId, event.startTime, event.startTime + event.duration, "self");
    }
  }

  add(instrumentId: string, start: number, end: number, source: string): void {
    const bucket = this.windows.get(instrumentId) ?? [];
    bucket.push({ start, end, source });
    this.windows.set(instrumentId, bucket);
  }

  /** true when any entry overlaps [start, end). */
  overlaps(instrumentId: string, start: number, end: number): boolean {
    return (this.windows.get(instrumentId) ?? []).some((window) => start < window.end && window.start < end);
  }

  /** true when the instrument already carries a DOUBLE from `sourceRole` in the window. */
  hasSource(instrumentId: string, sourceRole: string, start: number, end: number): boolean {
    return (this.windows.get(instrumentId) ?? []).some((window) =>
      window.source === sourceRole && start < window.end && window.start < end);
  }
}

/** Rule priority when multiple rules target the same note: LOW_REGISTER_PROTECTION
 * > TUTTI_PEAK > ALWAYS; the first winner takes the slot (hotfix Phase 1). */
const CONDITION_RANK: Record<DoublingRule["condition"], number> = { LOW_REGISTER_PROTECTION: 0, TUTTI_PEAK: 1, ALWAYS: 2 };

/** Apply the doubling matrix; events arrive sorted, iteration order is the RNG order.
 * Generic so upstream metadata (articulation/bends) survives the stage untouched.
 * Hotfix: every candidate insertion checks the receiver's occupancy ledger first
 * (self line wins, one source per window); ALWAYS unisons additionally gate on a
 * seeded 35% draw from the SAME 0xd0b1 stream (Phase 2), drawn in sorted event
 * order so the stream stays deterministic. */
export function applyDoublings<T extends AbstractNoteEvent>(events: T[], ctx: DoublingContext): T[] {
  const { profiles, rng, config } = ctx;
  if (config.maxDoublesPerNote < 1) return events;
  const rules = config.rules;
  if (!rules?.length) return events;
  const doubles = new Set<number>();
  const out = [...events];
  const ledger = new OccupancyLedger(events);
  for (let index = 0; index < out.length; index++) {
    if (doubles.has(index)) continue; // never double a double
    const primary = out[index]!;
    const primaryProfile = profileForEvent(primary, profiles);
    if (!primaryProfile) continue;
    const applicable = rules.filter((rule) => rule.primaryRole === primaryProfile.role && conditionMet(rule, primary, primaryProfile, ctx));
    // Hotfix Phase 1: LOW_REGISTER_PROTECTION > TUTTI_PEAK > ALWAYS — first winner
    // takes the slot; ties break back to the interval-width order.
    const prioritized = [...applicable].sort((a, b) => CONDITION_RANK[a.condition] - CONDITION_RANK[b.condition]
      || Math.abs(b.intervalSemitones) - Math.abs(a.intervalSemitones));
    let doubleCount = 0;
    for (const rule of prioritized) {
      if (doubleCount >= config.maxDoublesPerNote) break;
      const doublingProfile = profiles.find((profile) => profile.role === rule.doublingRole);
      if (!doublingProfile) continue; // roles absent from profiles skip silently
      // Phase 1: skip when the receiver's OWN line already plays in the window.
      // Window padding: the bake multiplies durations by up to ~1.02 (legato),
      // so event-disjoint doubles could still overlap at note level; pad both
      // ends by 2% of the primary duration to check the receiver's NOTE calendar.
      const windowStart = primary.startTime;
      const windowEnd = primary.startTime + primary.duration * 1.02;
      if (ledger.overlaps(doublingProfile.id, windowStart, windowEnd)) continue;
      // Phase 1: one doubling source per window per receiver.
      if (ledger.hasSource(doublingProfile.id, primaryProfile.role ?? "", windowStart, windowEnd)) continue;
      // Phase 2: ALWAYS unisons are sparse/musical — require the primary to be a
      // sustained note (≥ 1 beat) or Forte (≥ 0.85) AND pass a seeded 35% gate
      // (same 0xd0b1 stream, drawn in sorted order — no new salt).
      if (rule.condition === "ALWAYS") {
        const beatTicks = (960 * 4) / 4; // 1-beat sustain floor in ticks (quarter at PPQ 960/4)
        const sustainedOrLoud = primary.duration >= beatTicks || primary.normalizedDynamic >= 0.85;
        const gate = sustainedOrLoud && rng() < 0.35;
        if (!gate) continue;
      }
      // Disposition router: section-level order only (chair-level schemes arrive with Module 11
      // chairs; profiles here are sections, not chairs). JUXTAPOSITION/INTERLOCKING ordering
      // already emerges from profile-list order; the router marks intent for the native engine.
      const [minMs, maxMs] = config.antiFlanging.enableMicroDelay && rule.intervalSemitones === 0 && rng() < 0.0 ? config.antiFlanging.delayRangeMs : [0, 0];
      const delayOffsetTicks = 0; // unison doubles stay sample-accurate aligned; anti-flanging handles spread
      void minMs; void maxMs; void delayOffsetTicks;
      const range = doublingProfile.comfortableRange ?? doublingProfile.writtenRange;
      const target = primary.pitchConcert + rule.intervalSemitones;
      // Key rules: pitch class is preserved by construction. Unison doubles use the
      // comfortable window; OCTAVE doubles reach the full WRITTEN range so the shifted
      // pitch can land at/above the comfortable ceiling (e.g. flute 84 -> violins 96).
      // If no in-range octave exists (target beyond written range), the double is skipped
      // rather than clamped into an out-of-range or degenerate unison pitch.
      const written = doublingProfile.writtenRange;
      const octaveWindow = rule.intervalSemitones !== 0 ? written : range;
      if (rule.intervalSemitones !== 0 && (target < written.low || target > written.high)) continue;
      const pitchConcert = pitchInClass(pc(target), octaveWindow, target);
      if (rule.intervalSemitones !== 0 && pitchConcert !== target) continue;
      const pitchWritten = clamp(pitchConcert + (doublingProfile.transpositionSemitones ?? 0), doublingProfile.writtenRange.low, doublingProfile.writtenRange.high);
      out.push({
        ...primary,
        instrumentId: doublingProfile.id,
        pitchConcert,
        pitchWritten,
        startTime: primary.startTime + delayOffsetTicks,
        isDoubling: true,
        // the double follows the line: same role, same articulation, flagged for bake/export
      });
      doubles.add(out.length - 1);
      doubleCount++;
      // Phase 1: record the double in the receiver's ledger, padded like the check
      // window so later candidates see the baked note's true span.
      ledger.add(doublingProfile.id, windowStart, primary.startTime + primary.duration * 1.02, primaryProfile.role ?? "");
    }
  }
  return out.sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
}

export interface AntiFlangingContext extends DoublingContext {
  bpm: number;
}

/** Anti-flanging defense: same-instrument unison overlaps get deterministic detune/delay/CC74.
 * Heterogeneous unisons (flute+oboe) are intentionally left alone — that hybrid blend is the point. */
export function applyAntiFlanging<T extends AbstractNoteEvent>(events: T[], ctx: AntiFlangingContext): T[] {
  const { rng, config, bpm } = ctx;
  const af = config.antiFlanging;
  const [detuneMin = 0, detuneMax = 0] = af.detuneRangeCents ?? [];
  const [delayMinMs = 4, delayMaxMs = 12] = af.delayRangeMs ?? [];
  const cc74Offset = Math.round(-af.filterCutoffJitterPercent * 127);
  const groups = new Map<string, number[]>();
  for (let index = 0; index < events.length; index++) {
    const id = events[index]!.instrumentId;
    const bucket = groups.get(id) ?? [];
    bucket.push(index);
    groups.set(id, bucket);
  }
  for (const indices of groups.values()) {
    // deterministic order: group insertion order, then time order within the group
    const ordered = [...indices].sort((a, b) =>
      events[a]!.startTime - events[b]!.startTime || events[a]!.pitchConcert - events[b]!.pitchConcert);
    for (let position = 1; position < ordered.length; position++) {
      const laterIndex = ordered[position]!;
      const later = events[laterIndex]!;
      // pair against any EARLIER overlapping same-pitch note in this group
      const overlapsEarlier = ordered.slice(0, position).some((earlierIndex) => {
        const earlier = events[earlierIndex]!;
        return earlier.pitchConcert === later.pitchConcert
          && earlier.startTime < later.startTime + later.duration
          && later.startTime < earlier.startTime + earlier.duration;
      });
      if (!overlapsEarlier) continue;
      if (af.enableMicroDetune) {
        const spread = detuneMax - detuneMin;
        const draw = rng() * spread + detuneMin;
        const rounded = Math.round(draw * 10) / 10;
        existing: {
          const existing = later.detuneCents ?? 0;
          if (existing !== 0) {
            later.detuneCents = Math.round(clamp(existing + rounded, -15, 15) * 10) / 10;
            break existing;
          }
          later.detuneCents = rounded;
        }
      }
      if (af.enableMicroDelay) {
        const delayMs = rng() * (delayMaxMs - delayMinMs) + delayMinMs;
        const shifted = later.startTime + Math.round(msToTicks(delayMs, bpm));
        if (shifted >= 0) later.startTime = shifted;
      }
      later.cc74Offset = (later.cc74Offset ?? 0) + cc74Offset;
    }
  }
  return events;
}

/** Section disposition router: candidate ordering for a role's profile list.
 * Chairs arrive with Module 11; until then this only orders section-level voices,
 * JUXTAPOSITION is a no-op for single-voice roles like BASS/LEAD by construction. */
export function SectionDispositionRouter(
  _role: string,
  candidates: InstrumentProfile[],
  voiceCount: number,
  scheme: DispositionType,
): InstrumentProfile[] {
  if (candidates.length <= 1) return candidates;
  switch (scheme) {
    case "INTERLOCKING": {
      // strict alternation across candidates for every voice slot
      const order: InstrumentProfile[] = [];
      for (let voice = 0; voice < voiceCount; voice++) order.push(candidates[voice % candidates.length]!);
      return [...new Map(order.map((profile) => [profile.id, profile])).values()];
    }
    case "JUXTAPOSITION": {
      // block assignment: first half of voices → candidate[0], second half → candidate[1]
      const first = voiceCount - Math.floor(voiceCount / 2);
      const chosen = [candidates[0]!, ...(voiceCount > 1 && candidates[1] ? [candidates[1]!] : [])];
      if (voiceCount <= 1 || chosen.length === 1) return chosen;
      // For section pairs the enclosing orchestration assigns per voice; router returns
      // the profile order the allocator should consume (block A then block B).
      return first >= voiceCount / 2 ? chosen : chosen.reverse();
    }
    case "ENCLOSURE":
    case "OVERLAPPING":
      // Ordering implemented; meaningful chair-level behavior arrives with Module 11.
      // Documented deferred behavior: enclose melodic lines between reinforcement pairs.
      return candidates;
    default:
      return candidates;
  }
}
