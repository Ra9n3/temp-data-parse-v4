/**
 * Module 8 — Structure Mapping & Density Engine (macro-arranger).
 *
 * Three touch points, all DETERMINISTIC (no RNG, no new RNG salt — see the
 * registry comment in generate.ts: "arrangement/gestures: deterministic, no salt"):
 *
 *  1. PRE-pipeline: per-measure density profiles (Es) + virtual section tiling
 *     for builds (feeds generateOrchestralScore stage 2 via input data — the
 *     six pinned stages are untouched) + intensityAt/subdivisionCapAt probes
 *     handed to realizeRhythm.
 *  2. POST-score: breakdown-drop event filter (after doubling/anti-flanging,
 *     before attenuation + dynamics, so dropped events cost nothing).
 *  3. BAKE: transition gestures written directly as Notes on percussion +
 *     melody tracks (fixed performance semantics; the semantic pipeline is
 *     bypassed by design — Module 12 will generalize percussion).
 *
 * Two-tier energy relationship: stage 2's BASE_DYNAMICS baseline (in generate.ts)
 * is deliberately NOT reused as the measure baseline. This module computes its
 * own spec-table baselines (B) below; virtual slices exploit stage 2's exact
 * groupFor/DENSITY_VALUES mappings through the section data we feed it.
 */
import type { Project, Note, Track, Section } from "../shared/schema/types";
import { barToTick, ticksPerBar } from "../shared/schema/time";
import { normalizeSectionName } from "./config";
import { parseChord } from "../shared/schema/chords";
import type { AbstractNoteEvent, InstrumentProfile } from "./generate";

export type BuildCurveType = "LINEAR" | "EXPONENTIAL" | "STEPPED";
export type BreakdownExposedLayer = "SOLO_CELLO" | "SOLO_WOODWIND" | "HARP_PAD" | "PIANO_ONLY";

export interface ArrangementConfig {
  enableAutoBuildStaggering: boolean;
  enableTransitionGestures: boolean;
  breakdownExposedLayer: BreakdownExposedLayer;
}
export const DEFAULT_ARRANGEMENT_CONFIG: ArrangementConfig = {
  enableAutoBuildStaggering: true,
  enableTransitionGestures: true,
  breakdownExposedLayer: "SOLO_CELLO",
};

export interface MeasureProfile {
  startTick: number;
  endTick: number;
  measureIndex: number;
  /** Es index, 0..1 */
  energy: number;
  /** From Es bands: <0.35 → 1, <0.70 → 2, else 4. */
  maxSubdivisionsPerBeat: 1 | 2 | 4;
  sectionType: string;
}

/** Spec-table baselines (NOT stage 2's BASE_DYNAMICS — see the two-tier comment above). */
const BASELINES: Record<string, number> = { Intro: 0.2, Verse: 0.4, PreChorus: 0.65, Chorus: 0.9, Build: 0.72, Breakdown: 0.15, Outro: 0.3 };
/** Mirror of stage 2's DENSITY_VALUES (generate.ts) — redeclared locally because
 * importing it would create a module cycle through generate.ts. Keep in sync:
 * { Sparse: 0.28, Balanced: 0.58, Dense: 0.82, Tutti: 1 }. Stage 2's table itself
 * is untouched; this is read-only for the build baseline fold-in. */
const DENSITY_VALUES_REF: Record<string, number> = { Sparse: 0.28, Balanced: 0.58, Dense: 0.82, Tutti: 1 };

/** Local redeclares (established pattern — generate.ts keeps its own). */
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const pc = (value: number) => ((Math.round(value) % 12) + 12) % 12;
function pitchInClass(pitchClass: number, range: { low: number; high: number }, preferred: number): number {
  const candidates: number[] = [];
  for (let pitch = Math.ceil(range.low); pitch <= range.high; pitch++) {
    if (pc(pitch) === pc(pitchClass)) candidates.push(pitch);
  }
  if (!candidates.length) return clamp(preferred, range.low, range.high);
  return candidates.reduce((best, pitch) => Math.abs(pitch - preferred) < Math.abs(best - preferred) ? pitch : best, candidates[0]!);
}

export type ArrangementSectionType = "Intro" | "Verse" | "PreChorus" | "Chorus" | "Build" | "Breakdown" | "Outro";

/** Reuse the EXISTING config.ts normalization (no second mapper). */
export function sectionTypeFor(name: string): ArrangementSectionType {
  const normalized = normalizeSectionName(name);
  if (normalized.includes("pre-chorus") || normalized.includes("prechorus")) return "PreChorus";
  if (normalized.includes("chorus") || normalized.includes("climax")) return "Chorus";
  if (normalized.includes("intro")) return "Intro";
  if (normalized.includes("build") || normalized.includes("rise")) return "Build";
  if (normalized.includes("break")) return "Breakdown";
  if (normalized.includes("outro") || normalized.includes("coda")) return "Outro";
  return "Verse";
}

interface ChordInfo { rootPc: number; colorTones: number; hasSeventh: boolean }

/** Parse a chord symbol via the existing parser; fall back to nothing. */
function chordInfoOf(symbol: string | undefined): ChordInfo | undefined {
  if (!symbol) return undefined;
  const parsed = parseChord(symbol);
  if (!parsed.ok) return undefined;
  const root = parsed.chord.root;
  const crown = new Set([root, root + 7]);
  const tones = parsed.chord.pitchClasses;
  return {
    rootPc: root,
    colorTones: tones.filter((tone) => !crown.has(pc(tone))).length,
    hasSeventh: tones.some((tone) => [10, 11].includes(pc(tone - root))),
  };
}

/** Task 8.1: one MeasureProfile per measure across the project span.
 * Spans come from the STAGGERED sections (same data stage 2 receives), so the
 * per-measure Es mirrors what the score will actually see: a build escalates
 * through its virtual slices, giving the subdivision caps a real ramp. */
export function buildMeasureProfiles(project: Project, config: ArrangementConfig): MeasureProfile[] {
  const ts = project.timeSignature;
  const barTicks = ticksPerBar(ts);
  const staged = expandSectionsForStaggering(project.sections, config);
  const sectionSpans: Array<{ type: ArrangementSectionType; startTick: number; endTick: number; targetDynamic: number | undefined; buildCurveType: BuildCurveType | undefined; lengthBars: number; startBar: number; densityLevel: Section["densityLevel"] }> = staged.map((section) => ({
    type: sectionTypeFor(section.name),
    startTick: barToTick(section.startBar, ts),
    endTick: barToTick(section.startBar + section.lengthBars, ts),
    targetDynamic: section.targetDynamic,
    buildCurveType: section.buildCurveType,
    lengthBars: section.lengthBars,
    startBar: section.startBar,
    densityLevel: section.densityLevel,
  }));
  const endTick = Math.max(barTicks * 16, ...sectionSpans.map((span) => span.endTick));
  const profiles: MeasureProfile[] = [];
  let measureIndex = 0;
  let lastBuildEnergy = -1; // running max: Es is a ramp by construction; per-slice
  // chord tension (H) can dip between measures, so a build's Es is clamped to be
  // non-decreasing across its contiguous measures.
  for (let start = 0; start < endTick; start += barTicks) {
    const end = start + barTicks;
    const span = sectionSpans.find((candidate) => candidate.startTick <= start && start < candidate.endTick)
      ?? { type: "Verse" as ArrangementSectionType, startTick: 0, endTick, targetDynamic: undefined, buildCurveType: undefined, lengthBars: 0, startBar: 0, densityLevel: undefined };
    // For Build measures staged into virtual slices, the slice's densityLevel is
    // the staggering signal stage 2 receives — fold it into the baseline so the
    // subdiv caps actually ramp Sparse(D)→Tutti(D) across the build.
    const densityBaseline = span.type === "Build" && span.densityLevel
      ? DENSITY_VALUES_REF[span.densityLevel] : undefined;
    const B = densityBaseline ?? BASELINES[span.type] ?? 0.4;
    const S = 0.5 + (span.targetDynamic ?? 0.55);
    // H_tension approximation of Module 2's value, from chords overlapping this measure.
    const overlapping = project.chords.filter((chord) => chord.startTick < end && start < chord.startTick + chord.durationTicks);
    let H = 0;
    for (const chord of overlapping) {
      const info = chordInfoOf(chord.symbol);
      if (info) H = Math.min(0.15, info.colorTones * 0.05 + (info.hasSeventh ? 0.05 : 0));
    }
    // T_transition: inside BUILD only, 0 → 0.15 ramp across the ORIGINAL build
    // section. Staggered 2-bar slices each restart their own span, so the ramp
    // fraction is measured against the pre-stagger build that contains this
    // measure — keeping Es monotone across slice boundaries.
    let T = 0;
    if (span.type === "Build" && span.lengthBars > 0) {
      const original = project.sections
        .map((section) => ({ section, startTick: barToTick(section.startBar, ts), endTick: barToTick(section.startBar + section.lengthBars, ts) }))
        .filter((candidate) => sectionTypeFor(candidate.section.name) === "Build"
          && candidate.startTick <= start && start < candidate.endTick)
        .at(-1);
      const rampStart = original ? original.startTick : span.startTick;
      const rampEnd = original ? original.endTick : span.endTick;
      const fraction = clamp((start - rampStart) / (rampEnd - rampStart), 0, 1);
      const curve = original?.section.buildCurveType ?? span.buildCurveType ?? "LINEAR";
      const shaped = curve === "EXPONENTIAL" ? fraction * fraction : curve === "STEPPED" ? Math.floor(fraction * 3) / 2 : fraction;
      T = 0.15 * shaped;
    }
    // Spec: build energies must RAMP — the pre-chorus convention saturates B*S+H
    // for hot builds, so compress the ceiling: scale the sum into (0, 0.98] while
    // preserving ordering (monotonic map keeps the ramp observable section to section).
    const raw = B * S + H + T;
    // Saturation compressor: raw ∈ [1, 1.3] maps into (0.9, 0.98] so hot build
    // ends stay below 1 while the monotonic running-max below preserves the ramp.
    let energy = raw >= 1 ? 0.9 + (0.08 * (raw - 1)) / 0.3 : raw;
    if (span.type === "Build") energy = Math.min(energy, 0.98);
    if (span.type === "Build") {
      energy = Math.max(energy, lastBuildEnergy);
      lastBuildEnergy = energy;
    } else {
      lastBuildEnergy = -1;
    }
    profiles.push({
      startTick: start,
      endTick: end,
      measureIndex: measureIndex++,
      energy,
      maxSubdivisionsPerBeat: energy < 0.35 ? 1 : energy < 0.7 ? 2 : 4,
      sectionType: span.type,
    });
  }
  void config;
  return profiles;
}

/** Task 8.2: virtual 2-bar tiling for builds (OUTRO decay nicety included). */
export function expandSectionsForStaggering(sections: Section[], config: ArrangementConfig): Section[] {
  if (!config.enableAutoBuildStaggering) return sections.map((section) => ({ ...section }));
  const out: Section[] = [];
  for (const section of sections) {
    const type = sectionTypeFor(section.name);
    if (type === "Build" && section.lengthBars > 2) {
      const slices = Math.ceil(section.lengthBars / 2);
      const firstEnergy = Math.max(0.25, (section.targetDynamic ?? 0.55) * 0.4);
      const lastEnergy = section.targetDynamic ?? 0.55;
      for (let index = 0; index < slices; index++) {
        const startBar = section.startBar + index * 2;
        const lengthBars = Math.min(2, section.startBar + section.lengthBars - startBar);
        const progress = slices > 1 ? index / (slices - 1) : 1;
        const density = ["Sparse", "Balanced", "Dense", "Tutti"] as const;
        out.push({
          ...section,
          startBar,
          lengthBars,
          targetDynamic: firstEnergy + (lastEnergy - firstEnergy) * progress,
          densityLevel: density[clamp(Math.floor(progress * 3.5), 0, Math.min(3, slices - 1))],
        });
      }
      continue;
    }
    if (type === "Outro" && section.lengthBars >= 4) {
      const half = Math.floor(section.lengthBars / 2);
      out.push({ ...section, lengthBars: section.lengthBars - half });
      out.push({ ...section, startBar: section.startBar + (section.lengthBars - half), lengthBars: half, targetDynamic: (section.targetDynamic ?? 0.3) * 0.6, densityLevel: "Sparse" });
      continue;
    }
    out.push({ ...section });
  }
  return out;
}

/** Task 8.3: deterministic probes for realizeRhythm (W.2 additive pattern). */
export function intensityFromProfiles(profiles: MeasureProfile[]): {
  intensityAt: (startTimeTick: number) => number;
  subdivisionCapAt: (startTimeTick: number) => 1 | 2 | 4;
} {
  return {
    intensityAt: (startTimeTick: number) => {
      const profile = profiles.find((candidate) => candidate.startTick <= startTimeTick && startTimeTick < candidate.endTick);
      return clamp(profile?.energy ?? 0.5, 0.15, 1);
    },
    subdivisionCapAt: (startTimeTick: number) => {
      const profile = profiles.find((candidate) => candidate.startTick <= startTimeTick && startTimeTick < candidate.endTick);
      return profile?.maxSubdivisionsPerBeat ?? 2;
    },
  };
}

/** Breakdown windows in ticks, from the measure profiles. */
export function breakdownWindows(profiles: MeasureProfile[]): Array<{ start: number; end: number }> {
  const windows: Array<{ start: number; end: number }> = [];
  for (const profile of profiles) {
    if (profile.sectionType !== "Breakdown") continue;
    const previous = windows.at(-1);
    if (previous && previous.end === profile.startTick) previous.end = profile.endTick;
    else windows.push({ start: profile.startTick, end: profile.endTick });
  }
  return windows;
}

/** Task 8.4: post-score breakdown drop. Deterministic; runs after doubling. */
export function applyBreakdownDrop(
  events: AbstractNoteEvent[],
  ctx: { windows: Array<{ start: number; end: number }>; config: ArrangementConfig; profiles: InstrumentProfile[] },
): AbstractNoteEvent[] {
  if (!ctx.windows.length) return events;
  const exposed = exposedInstrumentIdsFor(ctx.config.breakdownExposedLayer, ctx.profiles);
  const inWindowNotExposed = (event: AbstractNoteEvent): boolean =>
    ctx.windows.some((window) => event.startTime >= window.start && event.startTime < window.end)
    && !exposed.has(event.instrumentId);
  const kept = events.filter((event) => !inWindowNotExposed(event));
  // Truncate any kept note that SPANS a window start ("instant mute on beat 1";
  // decay tails are a render-engine concern — the exporter already writes MIDI
  // sustain-off at note end).
  for (const event of kept) {
    for (const window of ctx.windows) {
      if (event.startTime < window.start && event.startTime + event.duration > window.start && event.startTime < window.start) {
        event.duration = Math.max(1, window.start - event.startTime);
      }
    }
  }
  return kept;
}

const EXPOSED_ROLES: Record<BreakdownExposedLayer, Record<string, Array<AbstractNoteEvent["role"]>>> = {
  SOLO_CELLO: { cellos: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"], flutes: ["LEAD"], harp: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"], piano: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"] },
  SOLO_WOODWIND: { oboes: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"], flutes: ["LEAD"], violas: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"], harp: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"] },
  HARP_PAD: { harp: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"], flutes: ["LEAD"] },
  PIANO_ONLY: { piano: ["LEAD", "COUNTERLINE", "PAD", "BASS", "OSTINATO"], flutes: ["LEAD"] },
};

function exposedInstrumentIdsFor(layer: BreakdownExposedLayer, profiles: InstrumentProfile[]): Set<string> {
  const rules = EXPOSED_ROLES[layer];
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (profile.id.startsWith("Harp_Section")) ids.add("Harp_Section");
    if (profile.id.startsWith("Piano_Section")) ids.add("Piano_Section");
    const allowed = rules[profile.role ?? ""];
    if (allowed && allowed.length) ids.add(profile.id);
  }
  // Sequencer track ids mirror db ids by role naming; also admit by role key presence.
  for (const role of Object.keys(rules)) {
    for (const profile of profiles) if (profile.role === role) ids.add(profile.id);
  }
  return ids;
}

/** Post-bake truncation (Module 8): the articulation multiplier can push an
 * event-level rewrite a few ticks past the boundary, so a final NOTE-level pass
 * enforces the "instant mute on beat 1" on the built tracks. Deterministic. */
export function truncateNotesAtBreakdownBoundaries(tracks: Track[], windows: Array<{ start: number; end: number }>): Track[] {
  if (!windows.length) return tracks.map((track) => ({ ...track, notes: track.notes.map((note) => ({ ...note })) }));
  return tracks.map((track) => ({
    ...track,
    notes: track.notes.map((note) => {
      for (const window of windows) {
        if (note.startTick < window.start && note.startTick + note.durationTicks > window.start) {
          return { ...note, durationTicks: Math.max(1, window.start - note.startTick) };
        }
      }
      return { ...note };
    }),
  }));
}

interface GestureContext {
  project: Project;
  measures: MeasureProfile[];
  config: ArrangementConfig;
}

interface BuildBoundary {
  boundaryTick: number;
  nextChord: { rootPitchClass: number } | undefined;
}

function ctxKeyRoot(project: Project): number {
  return project.key;
}

function parsedChordRoot(chord: { symbol: string }, keyRoot: number): number {
  const parsed = parseChord(chord.symbol);
  return parsed.ok ? parsed.chord.root : pc(keyRoot);
}

/** Find BUILD→(CHORUS|CLIMAX) boundaries with the chord covering the downbeat. */
function buildBoundaries(project: Project): BuildBoundary[] {
  const ts = project.timeSignature;
  const barTicks = ticksPerBar(ts);
  const out: BuildBoundary[] = [];
  const sorted = [...project.sections].sort((a, b) => a.startBar - b.startBar);
  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!;
    const next = sorted[i + 1]!;
    if (sectionTypeFor(current.name) !== "Build") continue;
    const nextType = sectionTypeFor(next.name);
    if (nextType !== "Chorus") continue;
    const boundaryTick = barToTick(next.startBar, ts);
    if (barToTick(current.startBar + current.lengthBars, ts) !== boundaryTick) {
      // Still gesture when the build ends exactly one bar before the chorus (pickup).
      if (barToTick(current.startBar + current.lengthBars, ts) !== boundaryTick - barTicks) continue;
    }
    const chord = project.chords
      .filter((block) => block.startTick <= boundaryTick && boundaryTick < block.startTick + block.durationTicks)
      .sort((a, b) => a.startTick - b.startTick)[0];
    out.push({ boundaryTick, nextChord: chord ? { rootPitchClass: parsedChordRoot(chord, ctxKeyRoot(project)) } : undefined });
  }
  return out;
}



/** Task 8.5: deterministic transition gestures appended to tracks. */
export function applyArrangementGestures(tracks: Track[], ctx: GestureContext): Track[] {
  if (!ctx.config.enableTransitionGestures) return tracks.map((track) => ({ ...track, notes: track.notes.map((note) => ({ ...note })) }));
  const additions = new Map<string, Note[]>();
  const push = (trackId: string, note: Note) => {
    const bucket = additions.get(trackId) ?? [];
    bucket.push(note);
    additions.set(trackId, bucket);
  };
  const ts = ctx.project.timeSignature;
  const barTicksPerBar = ticksPerBar(ts);

  for (const boundary of buildBoundaries(ctx.project)) {
    const T = boundary.boundaryTick;
    // ---- Timpani roll: final 2 bars before T; hits every 16th, ramp 40→95, accent at T.
    const timpani = tracks.find((track) => track.id === "trk_timpani");
    if (timpani) {
      const rollLength = 2 * barTicksPerBar;
      const rollStart = T - rollLength;
      const hits = Math.floor(rollLength / 240);
      const rollRamp = Array.from({ length: hits }, (_, index) => index);
      for (const index of rollRamp) {
        const tick = rollStart + index * 240;
        const velocity = Math.round(40 + (95 - 40) * (index / Math.max(1, hits - 1)));
        push("trk_timpani", pickTimpaniPitch(ctx.project.key, { startTick: tick, endTick: tick + 216 }, velocity, index));
      }
      push("trk_timpani", { ...pickTimpaniPitch(ctx.project.key, { startTick: T, endTick: T + 480 }, 112, hits), velocity: 112, durationTicks: 480, dynamics: { cc11Value: 118, cc74Value: 64, attenuationActive: false } });
    }
    // ---- Cymbal swell: one long note + ≤6 grace notes for the crescendo.
    const cymbals = tracks.find((track) => track.id === "trk_cymbals");
    if (cymbals) {
      const swellStart = T - 2 * barTicksPerBar;
      push("trk_cymbals", { pitch: 49, startTick: swellStart, durationTicks: rollLengthSafe(T - swellStart), velocity: 50, dynamics: { cc11Value: 95, cc74Value: 64, attenuationActive: false } });
      const graceCount = 6;
      for (let index = 0; index < graceCount; index++) {
        const graceStart = swellStart + Math.round(((T - swellStart) / graceCount) * index);
        const cc = Math.round(25 + (90 - 25) * (index / Math.max(1, graceCount - 1)));
        push("trk_cymbals", { pitch: 49, startTick: graceStart, durationTicks: 120, velocity: 40 + index * 8, dynamics: { cc11Value: cc, cc74Value: 64, attenuationActive: false } });
      }
    }
    // ---- Percussion only at boundaries: the run into the next section is owned
    // by the LEAD/melody engine (theme.ts) — do NOT add scale runs here.
  }
  if (!additions.size) return tracks.map((track) => ({ ...track, notes: track.notes.map((note) => ({ ...note })) }));
  return tracks.map((track) => {
    const extra = additions.get(track.id);
    if (!extra) return { ...track, notes: track.notes.map((note) => ({ ...note })) };
    return { ...track, notes: [...track.notes.map((note) => ({ ...note })), ...extra].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch) };
  });
}

function rollLengthSafe(delta: number): number {
  return Math.max(1, Math.round(delta));
}

function pickTimpaniPitch(keyRoot: number, span: { startTick: number; endTick: number }, velocity: number, index: number): Note {
  void span;
  const dynamic = { cc11Value: Math.round(30 + (110 - 30) * (index / 16)), cc74Value: 64, attenuationActive: false };
  return {
    pitch: pitchInClass(keyRoot, { low: 38, high: 57 }, 45),
    startTick: span.startTick,
    durationTicks: 216,
    velocity,
    dynamics: dynamic,
  };
}


/** Exposed for the wiring layer: measure-driven rhythm probes + windows. */
export function arrangementContext(project: Project, config: ArrangementConfig): {
  measures: MeasureProfile[];
  intensityAt: (startTimeTick: number) => number;
  subdivisionCapAt: (startTimeTick: number) => 1 | 2 | 4;
  windows: Array<{ start: number; end: number }>;
} {
  const measures = buildMeasureProfiles(project, config);
  const probes = intensityFromProfiles(measures);
  return { measures, ...probes, windows: breakdownWindows(measures) };
}
