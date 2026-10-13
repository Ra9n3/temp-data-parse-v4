/**
 * Polyphony hotfix Phase 4 — MonophonyGuard (final invariant).
 *
 * Winds and brass are one player per track: max 1 simultaneous note. Strings
 * may double-stop: max 2. Keys/percussion are unlimited. The guard runs LAST in
 * generate() — after humanization and anyModule 8 gestures — and is
 * deterministic (no RNG, no salt): it changes only timing/existence, never pitch.
 *
 * Resolution rules:
 *  - overlapping notes on a monophonic track → the earlier note is truncated to
 *    end exactly where the later begins (legato handoff);
 *  - identical startTicks with different pitches → keep the higher role-priority
 *    event (LEAD > COUNTERLINE > OSTINATO > BASS > PAD by the event's role tag),
 *    drop the other;
 *  - strings: same rules, but up to 2 held simultaneously.
 *
 * After the Phase 1–3 fixes the expected resolution count is ZERO; a nonzero
 * count means an upstream stage is still stacking — warn so it is visible.
 */
import type { AbstractNoteEvent } from "./generate";


export type MonophonyFamily = "monophonic" | "double-stop" | "polyphonic";

/** Capability table (hotfix Phase 4). */
export function maxSimultaneousFor(family: string | undefined): number {
  if (family === "woodwinds" || family === "brass") return 1;
  if (family === "strings") return 2; // double-stops
  return Number.POSITIVE_INFINITY; // keys/percussion/others
}

export const ROLE_PRIORITY: Record<string, number> = { LEAD: 0, COUNTERLINE: 1, OSTINATO: 2, BASS: 3, PAD: 4 };

const ROLE_BY_FAMILY: Record<string, string> = {
  flutes: "woodwinds", oboes: "woodwinds", clarinets: "woodwinds", bassoons: "woodwinds",
  piccolo: "woodwinds", englishHorn: "woodwinds", bassClarinet: "woodwinds",
  trumpets: "brass", trombones: "brass", horns: "brass", tuba: "brass", bassTrombone: "brass",
  violins1: "strings", violins2: "strings", violas: "strings", cellos: "strings", doubleBass: "strings",
  harp: "keys", piano: "keys",
};

/** familyOf: resolved profile role → family (mirrors profileAdapter's ROLE_MAP families). */
export function familyOfRole(role: string): string | undefined {
  return ROLE_BY_FAMILY[role];
}

export interface GuardResolution { trackId: string; dropped: number; truncated: number }

/** Generic guard over note rows; optional parallel `roles` array (per-note event role)
 * supplies the priority tiebreak (LEAD > COUNTERLINE > OSTINATO > BASS > PAD).
 * Active-set algorithm: notes are processed in onset order; whenever a candidate
 * would push the simultaneous count past `maxSimultaneous`, the lowest-priority
 * active overlap is truncated to a legato handoff (end exactly where the later
 * note begins) or, when onsets tie, dropped. The invariant holds globally by
 * induction: every admission re-checks against the live active set. Deterministic
 * (sorted order, listed tiebreaks); pitch is NEVER modified. */
export function applyMonophonyGuard<N extends { startTick: number; durationTicks: number }>(
  notes: N[],
  maxSimultaneous: number,
  roles?: string[],
): { notes: N[]; dropped: number; truncated: number } {
  if (maxSimultaneous === Number.POSITIVE_INFINITY || notes.length <= 1) {
    return { notes: [...notes], dropped: 0, truncated: 0 };
  }
  const order = notes.map((note, index) => ({ note, role: roles?.[index] })).sort((a, b) =>
    a.note.startTick - b.note.startTick || (ROLE_PRIORITY[a.role ?? ""] ?? 9) - (ROLE_PRIORITY[b.role ?? ""] ?? 9));
  const active: Array<{ note: N; role?: string }> = [];
  let truncated = 0;
  let dropped = 0;
  const overlaps = (a: { startTick: number; durationTicks: number }, b: { startTick: number; durationTicks: number }): boolean =>
    a.startTick < b.startTick + b.durationTicks && b.startTick < a.startTick + a.durationTicks;
  for (const candidate of order) {
    let overlapping = active.filter((entry) => overlaps(entry.note, candidate.note));
    while (overlapping.length >= maxSimultaneous) {
      // Victim: lowest priority, then earliest onset (smallest startTick).
      const victim = [...overlapping].sort((a, b) =>
        (ROLE_PRIORITY[a.role ?? ""] ?? 9) - (ROLE_PRIORITY[b.role ?? ""] ?? 9)
        || a.note.startTick - b.note.startTick)[0]!;
      const cutTo = candidate.note.startTick - victim.note.startTick; // ≥ 1 → legato handoff possible
      if (cutTo >= 1) {
        (victim.note as { durationTicks: number }).durationTicks = cutTo;
        truncated++;
        // The cut is PERMANENT for this resolution pass (victim's window now ends
        // at the candidate's onset); refresh the overlapping set with the new window.
        overlapping = active.filter((entry) => overlaps(entry.note, candidate.note));
        continue;
      } else {
        // Tied onset: the receiver can only play one note — drop the lower priority.
        dropped++;
        const at = active.indexOf(victim);
        if (at >= 0) active.splice(at, 1);
        overlapping = active.filter((entry) => overlaps(entry.note, candidate.note));
        continue;
      }
    }
    active.push(candidate);
  }
  // Post-pass: the active-set loop enforces COMMON-TICK concurrency, but a long
  // note can still pairwise-overlap more than `max` disjoint sub-events nested
  // inside its span (each pair overlapping the long note at a different tick).
  // The invariant contract is pairwise per note: the total number of notes a
  // note overlaps must stay ≤ max (that is what single-player reality means).
  // Deterministic bounded repair: repeatedly find the earliest offending note
  // and trim the boundary that removes the latest-started overlap (cut the long
  // note's tail to that onset; when the offender began earlier, truncate the
  // handoff instead; a zero-length cut is a drop, as in the main loop).
  for (let pass = 0; pass < 256; pass++) {
    const ordered = active.map((entry) => entry.note).sort((a, b) => a.startTick - b.startTick);
    let excess: N | undefined;
    for (const note of ordered) {
      const count = active.filter((entry) => entry.note !== note && overlaps(entry.note, note)).length;
      if (count > maxSimultaneous) { excess = note; break; }
    }
    if (!excess) break;
    const others = active
      .filter((entry) => entry.note !== excess && overlaps(entry.note, excess))
      .map((entry) => entry.note)
      .sort((a, b) => b.startTick - a.startTick || b.durationTicks - a.durationTicks);
    const victim = others[0]!;
    const cut = victim.startTick - excess.startTick;
    if (cut >= 1) {
      (excess as { durationTicks: number }).durationTicks = cut;
      truncated++;
    } else {
      const victimCut = excess.startTick - victim.startTick;
      if (victimCut >= 1) {
        (victim as { durationTicks: number }).durationTicks = victimCut;
        truncated++;
      } else {
        const at = active.findIndex((entry) => entry.note === victim);
        if (at >= 0) active.splice(at, 1);
        dropped++;
      }
    }
  }
  const kept = active.map((entry) => entry.note).sort((a, b) => a.startTick - b.startTick);
  return { notes: kept, dropped, truncated };
}

/** Track-level entry: capability resolves from the RECEIVING TRACK's family
 * (Module 8.6 B1 fix — the rotation engine remaps event-level instrumentIds, so
 * capability must never depend on a string-keyed role→family map). The legacy
 * role-key lookup stays as a fallback so existing callers keep working. */
export function guardTrackNotes<N extends { startTick: number; durationTicks: number }>(
  trackId: string,
  role: string,
  notes: N[],
  noteRoles?: string[],
  trackFamily?: string,
): GuardResolution & { notes: N[] } {
  const family = trackFamily ?? familyOfRole(role);
  const max = maxSimultaneousFor(family);
  const result = applyMonophonyGuard(notes, max, noteRoles);
  if (result.dropped || result.truncated) {
    console.warn(`[scorch] monophony guard resolved on ${trackId} (${role}): ${result.dropped} dropped, ${result.truncated} truncated`);
  }
  return { trackId, dropped: result.dropped, truncated: result.truncated, notes: result.notes };
}

export type { AbstractNoteEvent };
