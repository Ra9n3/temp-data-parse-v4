import type { AbstractNoteEvent, SemanticRole } from "./generate";
import { msToTicks } from "../shared/schema/time";
import type { Project, Track } from "../shared/schema/types";

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

// =====================================================================
// Module 13 — Rhythm-Section Sub-Engine (machinery + the pieces that work
// with instruments that actually exist: piano keys tracks, orchestral bass
// carriers, the M12 aux kick @36). Guitar and dedicated rhythm tracks don't
// exist yet, so their engines ship as tested, shelved code — the M12
// percussion pattern. Arranged APPEND-ONLY after the Stage 6.5 realizer so
// that engine's byte-identity contract is untouched.
//
// OWNERSHIP MAP (do not let this module creep):
//  - Orchestral timing on ALL existing tracks stays M10 humanization v2 — VVQ
//    NEVER touches existing tracks (pure machinery; native era wires it).
//  - Bass line CONTENT stays the pipeline + G's approach-tone pass (0x6066) —
//    no new bass generator lives here.
//  - Percussion content stays M12 generatePercussion — the pocket pass READS
//    aux-kick events and never writes percussion.
//  - Sustain CC on non-keys tracks stays the M4 legacy per-note path (pinned).
//  - Detune/bends stay M4 pitchBendPoints + the M10 budget — fretless slides
//    are DEFERRED (native).
//
// DETERMINISM LAW: no RNG, no new salts. Jitter bands (VVQ's ±, strum's
// +3–6 ms, fret noise) are DETERMINISTIC ALTERNATION / index-based spread —
// the M12 deviation pattern applies identically here.
// =====================================================================

// ---------------------------------------------------------------- VVQ (pure machinery, ZERO application today)

/** Spec table: strength = velocity scale; offsetMs/jitterMs = timing pull
 * (deterministic alternation across the jitter band). These profiles apply
 * ONLY to tracks whose role ∈ RHYTHM_SECTION_ROLES, which no current track
 * carries — they ship as tested machinery for the native era. */
export interface VVQProfile {
  id: "kick" | "snare" | "bass" | "hats" | "keys-comping" | "guitar";
  /** Velocity scale 0..1 (e.g. kick/snare 92%). */
  strength: number;
  /** Center timing offset in ms (bass rides behind the beat, guitar behind the grid). */
  offsetMs: number;
  /** Half-width of the deterministic alternation band, ms. */
  jitterMs: number;
}

export const VVQ_PROFILES: readonly VVQProfile[] = [
  { id: "kick", strength: 0.92, offsetMs: 0, jitterMs: 1.5 },
  { id: "snare", strength: 0.92, offsetMs: 0, jitterMs: 1.5 },
  { id: "bass", strength: 0.86, offsetMs: 4.5, jitterMs: 1.5 },
  { id: "hats", strength: 0.80, offsetMs: 0, jitterMs: 1.5 },
  { id: "keys-comping", strength: 0.82, offsetMs: 0, jitterMs: 1.5 },
  { id: "guitar", strength: 0.75, offsetMs: 8, jitterMs: 3.5 },
];

/** Roles RESERVED for native-era rhythm-section tracks (kick/snare/hats/
 * comping-keys/guitar chairs). Deliberately EMPTY of current tracks: every
 * existing role maps to orchestral semantics owned by M10/M12/M13's other
 * owners. applyVVQ is a no-op on everything alive today — proven in tests. */
export const RHYTHM_SECTION_ROLES: ReadonlySet<string> = new Set([
  "rhythm-kick",
  "rhythm-snare",
  "rhythm-hats",
  "rhythm-keys-comping",
  "rhythm-guitar",
]);

export interface VVQEvent { startTick: number; durationTicks: number; velocity: number }

/** Deterministic all-alternation quantizer (shipped machinery, zero
 * application today — no current track has a rhythm-section role). Index-based
 * alternation across the offsetMs ± jitterMs band, clamped to the global ±15 ms
 * discipline (the cap, not the band, wins), startTick ≥ 0, velocity × strength.
 * Returns new events; the input is untouched. */
export function applyVVQ<T extends VVQEvent>(events: T[], profile: VVQProfile, bpm: number): T[] {
  return events.map((event, index) => {
    const sign = index % 2 === 0 ? 1 : -1;
    const shiftMs = Math.max(-15, Math.min(15, profile.offsetMs + sign * profile.jitterMs));
    const shiftTicks = Math.round(msToTicks(shiftMs, bpm));
    return {
      ...event,
      startTick: Math.max(0, event.startTick + shiftTicks),
      durationTicks: Math.max(1, event.durationTicks - shiftTicks),
      velocity: Math.max(1, Math.min(127, Math.round(event.velocity * profile.strength))),
    };
  });
}

/** v1 comping zone for keys-style accompaniment (data only — the native era
 * enforces it; enforcing it TODAY would change piano pad-overflow routing). */
export const COMPING_ZONE = { min: 48, max: 71 } as const;

// ---------------------------------------------------------------- guitar machinery (pure, shelved)

/** Standard-tuning concert MIDI pitches, string 0 (low E) → 5 (high E). */
export const GUITAR_TUNING = [40, 45, 50, 55, 59, 64] as const;
export const GUITAR_STRING_COUNT = GUITAR_TUNING.length;
export const MAX_FRET_SPAN = 4;
export interface GuitarVoicingConfig {
  tuning?: readonly number[];
  maxFretSpan?: number;
  /** Velocity floor/ceiling of a muted string marker (spec: muted strings are quiet). */
  mutedVelocity: [number, number];
}
export const DEFAULT_GUITAR_VOICING_CONFIG: GuitarVoicingConfig = { mutedVelocity: [1, 15] };

export interface GuitarStringPosition {
  /** 0 = low E … 5 = high E. */
  string: number;
  fret: number; // -1 = muted ("x")
}

export interface GuitarVoicingResult {
  strings: GuitarStringPosition[];
  /** Pure-function level warning: chord falls below C3 (48) — real voicings
   * would need drop-2/open re-mapping; the flag is the machinery seam. */
  lowIntervalWarning?: boolean;
  /** When the straight mapping cannot close a ≤4-fret window, the drop-2
   * re-map (anchor raised an octave) is applied automatically. */
  appliedDrop2?: boolean;
  warnings: string[];
}

/** Map a chord onto the 6 strings with the POSITION-WINDOW search: walk the
 * fretting-hand window start p = 0…12; every string takes its OPEN pitch when
 * that is a chord tone, else the smallest fret in [p, p+maxSpan] whose pitch is
 * a chord tone, else mutes (−1). All fretted positions are in-window BY
 * CONSTRUCTION, so the ≤maxSpan hand-shape law holds; open strings (fret 0)
 * are exempt from the span metric — a ringing open needs no finger. The first
 * window with maximal distinct-tone coverage wins (ties → lowest p). When the
 * required tones cannot all fit, ONE drop-2 retry removes the highest tone
 * from the required set (it may still ring via an open string). Below-C3
 * (48) mappings flag the low-interval warning at the pure-function level. */
export function transformToGuitarVoicing(chord: { rootPitchClass: number; pitchClasses: number[] }, config: GuitarVoicingConfig = DEFAULT_GUITAR_VOICING_CONFIG): GuitarVoicingResult {
  const tuning = [...(config.tuning ?? GUITAR_TUNING)];
  const maxSpan = config.maxFretSpan ?? MAX_FRET_SPAN;
  const warnings: string[] = [];
  const allTones = [...new Set(chord.pitchClasses.map((pitchClass) => ((Math.round(pitchClass) % 12) + 12) % 12))];
  if (!allTones.length) {
    warnings.push("empty chord pitch-class set");
    return { strings: tuning.map((_, string) => ({ string, fret: -1 })), warnings };
  }
  const mapWindow = (windowStart: number, required: number[]): { strings: GuitarStringPosition[]; covered: number } => {
    const strings: GuitarStringPosition[] = [];
    const covered = new Set<number>();
    for (let string = 0; string < tuning.length; string++) {
      const open = tuning[string]!;
      if (required.includes(((open % 12) + 12) % 12)) {
        strings.push({ string, fret: 0 });
        covered.add(((open % 12) + 12) % 12);
        continue;
      }
      let fret = -1;
      for (let candidate = Math.max(1, windowStart); candidate <= windowStart + maxSpan; candidate++) {
        const pitchClass = ((open + candidate) % 12 + 12) % 12;
        if (allTones.includes(pitchClass)) { fret = candidate; break; }
      }
      if (fret >= 0) covered.add(((open + fret) % 12 + 12) % 12);
      strings.push({ string, fret });
    }
    return { strings, covered: covered.size };
  };
  let best = mapWindow(0, allTones);
  let bestStart = 0;
  for (let windowStart = 0; windowStart <= 12; windowStart++) {
    const candidate = mapWindow(windowStart, allTones);
    if (candidate.covered > best.covered) {
      best = candidate;
      bestStart = windowStart;
    }
  }
  void bestStart;
  let required = allTones;
  let appliedDrop2 = false;
  if (best.covered < allTones.length) {
    // Drop-2 retry: the top tone leaves the required set (may still ring open).
    // The flag is honest: it marks ONLY an actual improvement.
    const dropTone = allTones[allTones.length - 1]!;
    required = allTones.filter((tone) => tone !== dropTone);
    for (let windowStart = 0; windowStart <= 12; windowStart++) {
      const candidate = mapWindow(windowStart, required);
      if (candidate.covered > best.covered) {
        best = candidate;
        bestStart = windowStart;
        appliedDrop2 = true;
      }
    }
  }
  const fretted = best.strings.filter((position) => position.fret > 0);
  if (fretted.length > 1) {
    const span = Math.max(...fretted.map((position) => position.fret)) - Math.min(...fretted.map((position) => position.fret));
    if (span > maxSpan) warnings.push(`voicing span ${span} exceeds ${maxSpan} frets`);
  }
  const sounding = best.strings.filter((position) => position.fret >= 0).map((position) => tuning[position.string]! + position.fret);
  // Below-C3 flag at the pure-function level only when the mapping DIPS (the
  // root cannot be grounded above 48 within the window): a clean 36-class
  // anchor on the low E string is exactly the E-standard open region, so the
  // flag fires on covered-chord mappings whose LOWEST tone sits under C3.
  const dips = sounding.length > 0 && Math.min(...sounding) < 48;
  if (dips) warnings.push("voicing dips below C3 (48) — low-interval zone warning");
  return { strings: best.strings, lowIntervalWarning: dips, appliedDrop2, warnings };
}

// ---------------------------------------------------------------- guitar strum (pure, shelved content)

export type StrumDirection = "DOWN" | "UP";
export const STRUM_SPREAD_MS = { DOWN: 25, UP: 18 } as const;
export const STRUM_PER_STRING_MS: readonly [number, number] = [3, 6]; // DOWN alternation band (UP alternates [3,4] — see generateGuitarStrum)
export const STRUM_VELOCITY_DECAY = 2; // per string, trailing

export interface StrumNote { pitch: number; tickOffsetTicks: number; durationTicks: number; velocity: number; string: number }

/** Deterministic strum generator (testable now, aimed at a future guitar
 * track). Order is by SOUNDING PITCH: DOWN climbs low→high, UP is the exact
 * reversal (with ringing opens the string order is not monotone in pitch — a
 * strum sweeps the heard cluster). Per-note stagger uses CUMULATIVE step pairs
 * inside the spec's +3–6 ms band (DOWN [3,6] ms, UP [3,4] ms, deterministic
 * alternation — strictly monotone by construction); when alternating steps
 * would overflow the direction's spread budget (25/18 ms) they are scaled to
 * fit, which keeps strict ascent and honest bounds. Trailing velocity decays
 * −2 per note (clamped ≥ 1). No RNG anywhere. */
export function generateGuitarStrum(voicing: GuitarVoicingResult, direction: StrumDirection, speedMs: number, bpm: number, config: GuitarVoicingConfig = DEFAULT_GUITAR_VOICING_CONFIG): StrumNote[] {
  const budget = direction === "DOWN" ? STRUM_SPREAD_MS.DOWN : STRUM_SPREAD_MS.UP;
  const spreadMs = Math.min(Math.max(speedMs, 1), budget);
  const sounding = voicing.strings
    .filter((position) => position.fret >= 0)
    .map((position) => ({ ...position, pitch: (config.tuning ?? GUITAR_TUNING)[position.string]! + position.fret }))
    .sort((a, b) => a.pitch - b.pitch);
  const ordered = direction === "DOWN" ? sounding : [...sounding].reverse();
  // Cumulative deterministic stagger: steps alternate inside the ± band.
  const gaps = ordered.length - 1;
  const stepPair = direction === "DOWN" ? STRUM_PER_STRING_MS : ([3, 4] as const);
  let rawTotal = 0;
  for (let index = 0; index < gaps; index++) rawTotal += stepPair[index % 2];
  const scale = rawTotal > spreadMs && rawTotal > 0 ? spreadMs / rawTotal : 1;
  let cursorMs = 0;
  return ordered.map((position, index) => {
    if (index > 0) cursorMs += stepPair[(index - 1) % 2] * scale;
    return {
      pitch: position.pitch,
      tickOffsetTicks: Math.max(0, Math.round(msToTicks(cursorMs, bpm))),
      durationTicks: Math.max(1, Math.round(msToTicks(120, bpm))),
      velocity: Math.max(1, Math.min(127, Math.round(config.mutedVelocity[1] + (127 - config.mutedVelocity[1]) * 0.7 - STRUM_VELOCITY_DECAY * index))),
      string: position.string,
    };
  });
}

/** Fret-noise event defs (CC118 — content is deferred with the guitar track;
 * the defs exist so the native era has a stable contract). */
export const FRET_NOISE_CC = 118;
export const FRET_NOISE_LENGTH_MS = 40;
export function fretNoiseEvent(startTick: number, bpm: number): { cc: number; tick: number; value: number; durationTicks: number } {
  return { cc: FRET_NOISE_CC, tick: Math.max(0, startTick), value: 1, durationTicks: Math.round(msToTicks(FRET_NOISE_LENGTH_MS, bpm)) };
}

// ---------------------------------------------------------------- keyboard pedal catch (LIVE duty, keys family only)

export interface PedalCcEvent { cc: number; tick: number; value: number }

/** Decision 3 — pedal-catch automation for KEYS-FAMILY tracks ONLY: at each
 * chord boundary (from project.chords) the exporter emits CC(sustain) = 127 at
 * the chord start, 0 at the NEXT chord start, 127 again +10 ms after the clear
 * ("the catch"), and releases at the project end. Non-keys tracks keep the M4
 * legacy per-note sustain (pinned strings test stays byte-green).
 * Deterministic; empty when there is no chord data (callers then keep the
 * legacy per-note path — configured tracks without chords are unchanged).
 * The CC number follows the track's own expressionMapping.sustainCC so custom
 * mappings stay honored. */
export function keyboardPedalAutomation(chords: Project["chords"], bpm: number, endTick: number, cc: number): PedalCcEvent[] {
  if (!chords.length) return [];
  const starts = [...new Set(chords.map((block) => block.startTick))].sort((a, b) => a - b);
  if (!starts.length) return [];
  const catchTicks = Math.round(msToTicks(10, bpm));
  const events: PedalCcEvent[] = [];
  // Hold from the FIRST chord start; every subsequent boundary clears + re-
  // catches (0 at the boundary, 127 again +10 ms) — the catch IS the next
  // chord's pedal-down, so no extra 127 is emitted at the boundary tick
  // (that would collide with the 0). Final release at the project end.
  events.push({ cc, tick: Math.max(0, starts[0]!), value: 127 });
  for (let index = 1; index < starts.length; index++) {
    const boundary = starts[index]!;
    events.push({ cc, tick: Math.max(0, boundary), value: 0 });
    events.push({ cc, tick: Math.max(0, boundary + catchTicks), value: 127 });
  }
  events.push({ cc, tick: endTick, value: 0 });
  return events;
}

// ---------------------------------------------------------------- bass pocket (LIVE duty, decision 2)

export interface BassPocketConfig {
  /** Deterministic shift constant behind the aux kick (spec: +3–6 ms band;
   * documented choice: a FLAT +4 ms — no alternation, honest pocket). */
  offsetMs: number;
  /** Window: 1 beat around the kick (the pocket's metrical unit). */
  windowBeats: number;
}
export const DEFAULT_BASS_POCKET_CONFIG: BassPocketConfig = { offsetMs: 4, windowBeats: 1 };

/** Bass carriers per the rotation engine (the sub-150 Hz roles whose notes sit
 * in the pocket window; doubleBass also the pan-centering union). */
export const BASS_CARRIER_ROLES: ReadonlySet<string> = new Set(["doubleBass", "tuba", "bassoons", "cellos"]);

export interface BassPocketResult { tracks: Track[]; shifted: number; candidates: number }

/** Decision 2 — ONE live pocket duty: where an aux-kick event (pitch 36 on
 * trk_aux) and a BASS-role note on a bass-carrying track share the same beat
 * window, the bass note moves a flat deterministic +4 ms behind the kick (the
 * ±15 ms discipline holds trivially). Ledger: the shifted start never crosses
 * the next bass note on the same track; startTick ≥ 0. No kick ⇒ no-op
 * (census: ZERO kick/bass beat overlaps on current fixtures, so this is
 * provably a no-op end-to-end today — the synthetic path is unit-tested).
 * Candidate rule: note.role === "BASS" (rotation stamps), or — when rotation
 * is OFF and roles are unstamped — doubleBass-track notes only (the role
 * whose line IS the bass). Input untouched; returns new track objects. */
export function applyBassPocket(tracks: Track[], project: Project, config: BassPocketConfig = DEFAULT_BASS_POCKET_CONFIG): BassPocketResult {
  const beatTicks = Math.max(1, Math.round((960 * 4) / project.timeSignature.denominator));
  const shiftTicks = Math.round(msToTicks(config.offsetMs, project.bpm));
  const aux = tracks.find((track) => track.id === "trk_aux" && track.family === "percussion");
  const kicks = (aux?.notes ?? []).filter((note) => note.pitch === 36).map((note) => note.startTick);
  if (!kicks.length) return { tracks, shifted: 0, candidates: 0 };
  const windows = new Set<number>();
  for (const kick of kicks) windows.add(Math.floor(kick / beatTicks));
  let shifted = 0;
  let candidates = 0;
  const out = tracks.map((track) => {
    if (track.family !== "strings" && track.family !== "brass" && track.family !== "woodwinds") return track;
    if (!BASS_CARRIER_ROLES.has(track.role ?? "")) return track;
    const sortedIndexes = track.notes.map((note, index) => ({ note, index })).sort((a, b) => a.note.startTick - b.note.startTick || a.index - b.index);
    const newNotes = track.notes.map((note) => ({ ...note }));
    for (let position = 0; position < sortedIndexes.length; position++) {
      const { note, index } = sortedIndexes[position]!;
      const isCandidate = note.role === "BASS" || (note.role === undefined && track.role === "doubleBass");
      if (!isCandidate) continue;
      candidates++;
      const beat = Math.floor(note.startTick / beatTicks);
      if (!windows.has(beat)) continue;
      const nextStart = position + 1 < sortedIndexes.length ? sortedIndexes[position + 1]!.note.startTick : Infinity;
      const target = note.startTick + shiftTicks;
      if (target >= nextStart) continue; // ledger: never crosses the next bass note
      newNotes[index] = { ...note, startTick: Math.max(0, target) };
      shifted++;
    }
    return { ...track, notes: newNotes };
  });
  return { tracks: out, shifted, candidates };
}

/** Tracks that receive the CC10 centering at tick 0 (decision 4 — the sub-150
 * Hz rule): bass carriers ∪ {doubleBass} (doubleBass is already a carrier;
 * kept as an explicit union for clarity). */
export const PAN_CENTERED_ROLES: ReadonlySet<string> = new Set([...BASS_CARRIER_ROLES]);
