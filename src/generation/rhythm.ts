import type { AbstractNoteEvent, SemanticRole } from "./generate";

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export interface RealizeOptions {
  rng: () => number;
  beatTicks: number;
  intensity?: number; // 0..1 — pass options.density (default when no intensityAt)
  /** Addendum E/F/G roles contract: ONLY these roles may be shaped. Absent = legacy
   * path (all roles), byte-identical to the pre-E/F/G build. Callers pass the roles
   * their active engines still own: e.g. engines ON ⇒ ["BASS", "PAD"]. */
  roles?: SemanticRole[];
  /** Module 8: per-event intensity override (deterministic probe from measure profiles). */
  intensityAt?: (startTimeTick: number) => number;
  /** Module 8: hard cap on divisions per beat: 1 | 2 | 4 (default 4 ⇒ unchanged). */
  subdivisionCapAt?: (startTimeTick: number) => number;
}

/**
 * Stage 6.5: turn the sustained per-beat grid from the semantic pipeline into
 * role-appropriate rhythmic figures. Fully deterministic for a given rng,
 * so seed N always produces the same arrangement.
 */
export function realizeRhythm(events: AbstractNoteEvent[], opts: RealizeOptions): AbstractNoteEvent[] {
  const { rng, beatTicks } = opts;
  const intensityFor = (startTimeTick: number): number =>
    clamp(opts.intensityAt ? opts.intensityAt(startTimeTick) : (opts.intensity ?? 0.7), 0, 1);
  const subdivisionCapFor = (startTimeTick: number): number => opts.subdivisionCapAt?.(startTimeTick) ?? 4;
  // Phase 0 roles contract: opts.roles lists the roles that may still be shaped.
  // Engine-active roles never arrive here (the caller omits them); every role not
  // listed passes through untouched. legacyMode (roles absent) = the exact
  // pre-E/F/G behavior for every role, so engines-OFF stays byte-identical.
  const legacyMode = opts.roles === undefined;
  const out: AbstractNoteEvent[] = [];
  for (const ev of events) {
    if (!legacyMode && !opts.roles!.includes(ev.role)) { out.push(ev); continue; }
    const beats = ev.duration / beatTicks;
    if (beats <= 0.5) {
      out.push(ev);
      continue;
    }
    const intensity = intensityFor(ev.startTime);
    const cap = subdivisionCapFor(ev.startTime);
    switch (ev.role) {
      case "LEAD": {
        // Phrase the line into 1–3 sub-phrases with optional breath rests.
        const parts = beats >= 3 ? 1 + Math.floor(rng() * 3) : beats >= 2 && rng() < 0.5 ? 2 : 1;
        let cursor = ev.startTime;
        const end = ev.startTime + ev.duration;
        for (let i = 0; i < parts; i++) {
          const remaining = end - cursor;
          if (remaining <= 1) break;
          const dur = i === parts - 1
            ? remaining
            : Math.min(remaining, Math.max(beatTicks * 0.5, (ev.duration / (parts - i)) * (0.7 + rng() * 0.6)));
          if (i > 0 && rng() < 0.12 * intensity) {
            cursor += Math.min(beatTicks * 0.5, dur * 0.5); // breath rest
            continue;
          }
          // Cap < 4 replaces the fixed beatTicks*0.25 floor; cap 4 ⇒ identical.
          const floor = cap < 4 ? beatTicks / Math.max(1, cap) : beatTicks * 0.25;
          out.push({ ...ev, startTime: cursor, duration: Math.max(floor, dur) });
          cursor += dur;
        }
        break;
      }
      case "COUNTERLINE":
      case "OSTINATO": {
        // Rearticulate on the beat grid; SPICCATO is shorter and detached.
        const staccato = ev.semanticArticulation === "SPICCATO";
        let step = staccato ? beatTicks : beatTicks * (rng() < 0.3 ? 0.5 : 1);
        step = Math.max(step, beatTicks / cap); // Module 8 hard cap
        const restProb = Math.min(0.2, (staccato ? 0.08 : 0.15) * intensity);
        for (let t = ev.startTime; t < ev.startTime + ev.duration - 1e-6; t += step) {
          if (rng() < restProb) continue;
          const dur = staccato ? step * (0.3 + rng() * 0.25) : step * (0.8 + rng() * 0.2);
          out.push({ ...ev, startTime: t, duration: Math.min(dur, ev.startTime + ev.duration - t) + (staccato ? dur * 0 : 0) });
          // Cap-aware legato: never shorter than the cap floor (1.0 legato = full step).
          const last = out.at(-1)!;
          if (!staccato) last.duration = Math.min(step, ev.startTime + ev.duration - last.startTime);
        }
        break;
      }
      case "BASS":
      case "PAD": {
        // Mostly sustained; occasionally rearticulate mid-note (bow change / chord punch).
        // Module 8: sustained at low energy — skip splitting when beats/cap < 2.
        // This is the SAME condition in legacy and roles mode (the roles-mode copy
        // that dropped the beats/cap guard was a flagged regression; fixed here).
        if (beats >= 2 && beats / cap >= 2 && rng() < 0.35 * intensity) {
          const split = Math.round(beats / 2) * beatTicks;
          out.push({ ...ev, duration: split });
          out.push({ ...ev, startTime: ev.startTime + split, duration: ev.duration - split });
        } else {
          out.push(ev);
        }
        break;
      }
      default:
        out.push(ev);
        break;
    }
  }
  return out.map((ev) => ({ ...ev, startTime: Math.round(ev.startTime), duration: Math.round(ev.duration) || 1 }))
    .sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
}
