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
import type { AbstractNoteEvent } from "./generate";

export interface ConsolidationStats { merged: number; before: number; after: number }

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
