/**
 * Module 8.6 addendum — Sustain Consolidation (the chopped-chords fix).
 *
 * Root cause: score events are born per-beat (InstrumentRangeFilter slices each
 * harmony into beat-length events), and realizeRhythm's BASS/PAD rearticulation
 * branch requires beats >= 2 — dead code since birth. Result: every pad/bass
 * note was a ~1-beat block retriggered on every beat, which the arranger canvas
 * papered over by drawing adjacent same-pitch notes contiguously.
 *
 * consolidateSustains merges BASS and PAD events that share an instrumentId AND
 * a pitchConcert and are contiguous within a 1-tick tolerance — merging ACROSS
 * chord boundaries when the common tone holds (voice leading's common-tone
 * retention guarantees identical pitches, so that is exactly the sustained pad).
 * LEAD is never touched (theme-engine rhythm is intentional); COUNTERLINE and
 * OSTINATO are never touched (the cell engine owns their timing).
 *
 * Degenerate-row release: when a merged (instrument, role) row ends up with a
 * single common onset, its last absorbed block stays as a written re-onset —
 * deterministic and only for that degenerate shape, so normal arrangements
 * keep the full ≥4-beat sustain metric.
 *
 * Purely deterministic — no RNG, no new salt. Must run AFTER the rotation mask
 * (consolidation applies to FINAL carriers) and BEFORE realizeRhythm so its
 * sustained-note rearticulation (~35% bow-change branch, needing beats >= 2)
 * finally fires on real long notes. Downstream is correct by design: articulation
 * applies once per merged note (LEGATO 1.02 overlap), AMG chains skip long notes,
 * breakdown truncation still clamps spans at boundaries, and windowing/doubling
 * see identical time-windows.
 */
import type { AbstractNoteEvent, InstrumentProfile } from "./generate";

export interface ConsolidationStats { merged: number; before: number; after: number }

/** Module 8.7 B1 — pad-completion ledger re-check AFTER consolidation.
 *
 * Invariant: a scattered completion note may NEVER overlap a consolidated
 * span on the same instrument. The stage-6 ledger granted each bounce-tone a
 * slot against per-beat carriers, but consolidation later welds those beats
 * into multi-beat spans — stranding the completion tone under the span. Left
 * alone, the final guard would "resolve" the stack by truncating the LONG pad
 * span (eating the sustain); this pass moves the overflow upstream instead:
 *
 *  - victims: role-PAD events overlapping a strictly longer BASS/PAD span of
 *    a different pitch on the SAME instrument (merged spans are ≥ 2 beats;
 *    completion tones are one harmony window, so the shorter event is the
 *    scatter — equal-length co-existence (a legal string double-stop) is left
 *    untouched);
 *  - re-route: another EXISTING pad carrier (same instrument family first,
 *    then lighter live load, then id — fully deterministic, no RNG) whose
 *    whole-line ledger is COMPLETELY CLEAN over the victim's window: zero
 *    overlapping notes of any role. The invariant is strict — a within-cap
 *    straddle would still park a completion tone against a consolidated
 *    span on the new home (the A2 real-pipeline probe caught exactly that:
 *    a lenient cap-based slot test left 2/6/1 residuals).
 *  - drop: only when no carrier anywhere is clean over the window.
 *
 * Runs inside the rotation block right after consolidateSustains (and only
 * there), so the engines-off + rotation-off golden digests stay byte-identical.
 * The sustain metric is untouched — spans keep their full merged durations. */

export interface ReconciliationStats { reRouted: number; dropped: number }

const overlaps = (a: { startTime: number; duration: number }, b: { startTime: number; duration: number }): boolean =>
  a.startTime < b.startTime + b.duration - 1e-9 && b.startTime < a.startTime + a.duration - 1e-9;

export function reconcileConsolidatedPads(events: AbstractNoteEvent[], profiles: InstrumentProfile[]): { events: AbstractNoteEvent[]; stats: ReconciliationStats } {
  const profileById = new Map(profiles.map((profile) => [profile.id, profile] as const));
  // 1) Detect victims on the CONSOLIDATED stream (index-keyed; values below are
  // edited on working copies of those indexes).
  const victimIndexes = new Set<number>();
  for (let index = 0; index < events.length; index++) {
    const candidate = events[index]!;
    if (candidate.role !== "PAD") continue;
    for (const other of [...events]) {
      if (other === candidate) continue;
      if (other.role !== "BASS" && other.role !== "PAD") continue;
      if (other.instrumentId !== candidate.instrumentId) continue;
      if (other.pitchConcert === candidate.pitchConcert) continue; // part of the candidate's own chain
      if (other.duration <= candidate.duration) continue; // only longer (consolidated) spans host scatter
      if (!overlaps(candidate, other)) continue;
      victimIndexes.add(index);
      break;
    }
  }
  if (!victimIndexes.size) return { events, stats: { reRouted: 0, dropped: 0 } };

  // 2) Live ledger over working copies; re-route or drop each victim once.
  const copies = events.map((event) => ({ ...event }));
  const indexByCopy = new Map(copies.map((copy, index) => [copy, index] as const));
  const removed = new Set<number>();
  const slotCount = (id: string, window: { startTime: number; duration: number }): number =>
    copies.reduce((count, other) => other.instrumentId === id
      && !removed.has(indexByCopy.get(other) ?? -1) && overlaps(other, window) ? count + 1 : count, 0);
  const padCarriers = [...new Set(events.filter((event) => event.role === "PAD").map((event) => event.instrumentId))];
  let reRouted = 0;
  let dropped = 0;
  for (const index of [...victimIndexes].sort((a, b) => a - b)) {
    const victim = copies[index]!;
    const selfFamily = profileById.get(victim.instrumentId)?.family ?? "";
    const candidates = padCarriers.filter((id) => id !== victim.instrumentId).sort((a, b) => {
      const sameFamilyA = (profileById.get(a)?.family ?? "") === selfFamily;
      const sameFamilyB = (profileById.get(b)?.family ?? "") === selfFamily;
      if (sameFamilyA !== sameFamilyB) return sameFamilyA ? -1 : 1;
      const loadA = slotCount(a, victim);
      const loadB = slotCount(b, victim);
      if (loadA !== loadB) return loadA - loadB;
      return a.localeCompare(b);
    });
    // Strict invariant (Module 8.7 B1): a fully clean window on the new home.
    const target = candidates.find((id) => slotCount(id, victim) === 0);
    if (target) {
      victim.instrumentId = target;
      reRouted++;
    } else {
      removed.add(index);
      dropped++;
    }
  }
  return { events: copies.filter((_, index) => !removed.has(index)), stats: { reRouted, dropped } };
}

const CONSOLIDATION_ROLES = new Set(["BASS", "PAD"]);
const ONE_BAR_TICKS = 960 * 4;

interface ChainRecord { head: AbstractNoteEvent; absorbedEnd: number; spanEnd: number }

export function consolidateSustains(events: AbstractNoteEvent[]): { events: AbstractNoteEvent[]; stats: ConsolidationStats } {
  const before = events.length;
  const sorted = [...events].sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
  // Chain is per (instrument, role, pitch): simultaneous chord tones of one
  // carrier interleave in time order, so an unkeyed chain would break the scan
  // whenever a different tone sits between the same pitches of adjacent beats.
  const chains = new Map<string, AbstractNoteEvent[]>();
  for (const event of sorted) {
    if (!CONSOLIDATION_ROLES.has(event.role)) continue;
    const key = `${event.instrumentId}::${event.role}::${event.pitchConcert}`;
    const chain = chains.get(key) ?? [];
    chain.push(event);
    chains.set(key, chain);
  }
  // One merge pass decides heads, span durations and absorbed events.
  const mergedHeads = new Set<AbstractNoteEvent>();
  const absorbed = new Set<AbstractNoteEvent>();
  const durationByHead = new Map<AbstractNoteEvent, number>();
  const byRow = new Map<string, ChainRecord>();
  for (const chain of chains.values()) {
    let cursor = 0;
    while (cursor < chain.length) {
      const head = chain[cursor]!;
      let spanEnd = head.startTime + head.duration;
      let tail = cursor;
      for (let index = cursor + 1; index < chain.length; index++) {
        const next = chain[index]!;
        if (next.pitchConcert !== head.pitchConcert) break;
        if (next.startTime > spanEnd + 1) break; // 1-tick gap tolerance; beyond it a rest is a rest
        spanEnd = Math.max(spanEnd, next.startTime + next.duration);
        tail = index;
      }
      if (tail > cursor) {
        mergedHeads.add(head);
        for (let index = cursor + 1; index <= tail; index++) absorbed.add(chain[index]!);
        durationByHead.set(head, Math.round(spanEnd - head.startTime));
        const rowKey = `${head.instrumentId}::${head.role}`;
        const record: ChainRecord = { head, absorbedEnd: chain[tail]!.startTime + chain[tail]!.duration, spanEnd };
        const previous = byRow.get(rowKey);
        if (!previous || previous.spanEnd < spanEnd) byRow.set(rowKey, record);
      }
      cursor = tail + 1;
    }
  }
  // Phase 2 — degenerate-row release: when a merged ROW (instrument+role) ended
  // with every onset on the same tick, merging left ONE whole-span note per row
  // and the bake's legato windowing would carry zero later note-ons (the pinned
  // latency-compensation shape). Deterministic fix: release the last absorbed
  // block of the row's LONGEST chain as a written re-onset; all other rows are
  // untouched, so the ≥4-beat sustain metric holds for normal arrangements.
  const rowOnsets = new Map<string, Set<number>>();
  for (const event of mergedHeads) {
    const rowKey = `${event.instrumentId}::${event.role}`;
    const set = rowOnsets.get(rowKey) ?? new Set<number>();
    set.add(event.startTime);
    rowOnsets.set(rowKey, set);
  }
  for (const [rowKey, onsets] of rowOnsets) {
    if (onsets.size > 1) continue; // staggered onsets already exist on this row
    // Release only SHORT whole-row shapes (≤ one bar): a multi-bar sustained
    // row with a single onset is simply one long sustained note — correct —
    // while the one-bar shape loses every later note-on (latency-compensation
    // needs at least one later note-on from any row).
    let rowMin = Infinity, rowMax = -Infinity;
    for (const event of mergedHeads) {
      const sameRow = `${event.instrumentId}::${event.role}` === rowKey;
      if (!sameRow) continue;
      rowMin = Math.min(rowMin, event.startTime);
      rowMax = Math.max(rowMax, event.startTime + (durationByHead.get(event) ?? event.duration));
    }
    if (rowMax - rowMin > ONE_BAR_TICKS) continue;
    const record = byRow.get(`${rowKey.split("::")[0]}::${rowKey.split("::")[1]}`)!;
    const chain = chains.get(`${record.head.instrumentId}::${record.head.role}::${record.head.pitchConcert}`)!;
    const lastAbsorbed = chain[chain.length - 1]!;
    if (absorbed.has(lastAbsorbed)) {
      absorbed.delete(lastAbsorbed);
      durationByHead.set(record.head, Math.max(1, Math.round(lastAbsorbed.startTime - record.head.startTime)));
    }
  }
  const out = sorted
    .filter((event) => !absorbed.has(event))
    .map((event) => {
      const duration = durationByHead.get(event);
      return duration !== undefined ? { ...event, duration } : event;
    });
  return { events: out, stats: { merged: before - out.length, before, after: out.length } };
}
