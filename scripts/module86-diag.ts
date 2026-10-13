/**
 * Module 8.6 Phase A diagnostics — run BEFORE fixes:
 *   npx tsx scripts/module86-diag.ts
 * A1: section recognition dump (raw name → type → measure energy → stage-2
 *     activeGroups → 8.5 carriers → mask allowance).
 * A2: occupancy report (max simultaneous per track + provenance class).
 * A4: wind/brass polyphony probe on the 32-bar synthetic multi-section project.
 * A5: top-5 note durations per role (the chopped-chords signature).
 */
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import { generate, DynamicMappingEngine, HarmonicParser, type ProjectConfig, type StructureSection } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { validateProject } from "../src/shared/schema/validate";
import { sectionTypeFor, arrangementContext, DEFAULT_ARRANGEMENT_CONFIG } from "../src/generation/arrangement";
import { applyActiveMask, planRotation, resolveRotationConfig, exposedBreakdownRoles } from "../src/generation/rotation";
import { normalizeSectionName } from "../src/generation/config";
import { buildPipelineProfiles } from "../src/generation/profileAdapter";
import type { Project } from "../src/shared/schema/types";

function rawProject(source: unknown): Project {
  const result = validateProject(source);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return cloneProject(result.project);
}

const fixture = rawProject(dorianFixture);
const barTicks = 3840; // 4/4 @ PPQ 960 — identical on fixture and synthetic

/** Synthetic 32-bar multi-section project (A4's permanent source): custom-named
 * sections + the fixture's per-bar chord schedule tiled over 32 bars. */
function synthetic32(): Project {
  const p = cloneProject(fixture);
  p.sections = [
    { ...p.sections[0]!, name: "Verse", startBar: 1, lengthBars: 8 },
    { ...p.sections[0]!, name: "Pre-Chorus Lift", startBar: 9, lengthBars: 4, targetDynamic: 0.7, densityLevel: "Dense" },
    { ...p.sections[0]!, name: "Big Chorus", startBar: 13, lengthBars: 8, targetDynamic: 0.95, densityLevel: "Tutti" },
    { ...p.sections[0]!, name: "Breakdown", startBar: 21, lengthBars: 4, targetDynamic: 0.2, densityLevel: "Sparse" },
    { ...p.sections[0]!, name: "Outro", startBar: 25, lengthBars: 8, targetDynamic: 0.4, densityLevel: "Balanced" },
  ];
  const perBar = new Map<number, string>();
  for (const block of fixture.chords) {
    const startBar = Math.floor(block.startTick / barTicks);
    for (let offset = 0; offset < Math.max(1, Math.round(block.durationTicks / barTicks)); offset++) {
      perBar.set(startBar + offset, block.symbol ?? "C");
    }
  }
  p.chords = Array.from({ length: 32 }, (_, barIndex) => {
    const symbol = perBar.get(barIndex % 16) ?? "C";
    return { id: `diag-chord-${barIndex}`, symbol, startTick: barIndex * barTicks, durationTicks: barTicks };
  });
  return p;
}

const synth = synthetic32();

function stage2Groups(proj: Project, startTick: number, endTick: number): string[] {
  const profiles = buildPipelineProfiles();
  const globalConfig: ProjectConfig = { keyRoot: proj.key, scaleMode: "Major", baseBpm: proj.bpm, timeSignature: [proj.timeSignature.numerator, proj.timeSignature.denominator], presetStyle: "Classical Symphonic" };
  const timeline = new HarmonicParser().parse(globalConfig,
    proj.chords.map((block) => ({ startTime: block.startTick, duration: block.durationTicks, rootPitchClass: 0, quality: "Maj", extensions: [] })));
  const form = proj.sections.map((section): StructureSection => ({
    startTime: (section.startBar - 1) * barTicks, duration: section.lengthBars * barTicks,
    type: (sectionTypeFor(section.name) + "") as StructureSection["type"], targetDynamic: section.targetDynamic ?? 0.55, densityLevel: section.densityLevel ?? "Balanced",
  }));
  const points = new DynamicMappingEngine().map(timeline, form, globalConfig, profiles);
  return [...new Set(points.filter((point) => point.time >= startTick && point.time < endTick).flatMap((point) => point.activeGroups))];
}

/** A1 — section recognition dump. */
function sectionDump(label: string, proj: Project): void {
  console.log(`\n===== A1 ${label} =====`);
  for (const section of proj.sections) {
    const known = ["Verse", "PreChorus", "Chorus", "Intro", "Build", "Breakdown", "Outro"];
    const type = sectionTypeFor(section.name);
    const normalized = normalizeSectionName(section.name);
    const flag = known.includes(type) ? "" : " <-- UNKNOWN";
    console.log(`  raw="${section.name}" → normalized="${normalized}" → type=${type}${flag}`);
  }
  const profiles = buildPipelineProfiles();
  const ctx = arrangementContext(proj, DEFAULT_ARRANGEMENT_CONFIG);
  const rotationConfig = resolveRotationConfig(proj.generationSettings?.arrangement?.rotation);
  const plan = rotationConfig.enabled ? planRotation(proj, proj.generationSettings?.arrangement?.rotation, 6) : undefined;
  const exposed = exposedBreakdownRoles(proj.generationSettings?.arrangement?.breakdownExposedLayer);
  // Mask allowance probes: one dummy event per track per measure start, REAL mask.
  const probeEvents = ctx.measures.flatMap((measure) =>
    profiles.map((profile) => ({ instrumentId: profile.id, pitchConcert: 61, pitchWritten: 61, startTime: measure.startTick, duration: 1, normalizedDynamic: 0.5, semanticArticulation: "LEGATO" as const, role: "BASS" as const })));
  const allowed = plan ? applyActiveMask(probeEvents, plan, ctx.measures, rotationConfig, profiles, exposed) : probeEvents;
  for (const section of proj.sections) {
    const start = (section.startBar - 1) * barTicks;
    const end = start + section.lengthBars * barTicks;
    const inSection = ctx.measures.filter((measure) => measure.startTick >= start && measure.startTick < end);
    const cast = plan?.sections.find((c) => c.startTick > start - barTicks * 20 && c.startTick <= start);
    const allowedRoles = [...new Set(allowed
      .filter((event) => event.startTime >= start && event.startTime < end)
      .map((event) => profiles.find((profile) => profile.id === event.instrumentId)?.role ?? "?"))];
    console.log(`  [${section.name}] bars ${section.startBar}–${section.startBar + section.lengthBars - 1}`);
    console.log(`    measures=${inSection.length} energy: ${inSection.map((m) => m.energy.toFixed(2)).join(" ")}`);
    console.log(`    stage-2 activeGroups: ${stage2Groups(proj, start, end).join(",") || "none"}`);
    console.log(`    8.5 carriers: ${cast ? `lead=${cast.leadCarrier} bass=${cast.bassCarrier} pad=${cast.padCarrier} cl=${cast.counterlineCarrier} os=${cast.ostinatoCarrier}` : "none (uncast)"}`);
    console.log(`    mask allowance (${allowedRoles.length}): ${allowedRoles.join(",")}`);
  }
}

function overlaps(a: { startTick: number; durationTicks: number }, b: { startTick: number; durationTicks: number }): boolean {
  return a.startTick < b.startTick + b.durationTicks && b.startTick < a.startTick + a.durationTicks;
}
function maxSimultaneous(notes: { startTick: number; durationTicks: number }[]): number {
  let max = 0;
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
  for (const note of sorted) {
    const active = sorted.filter((other) => other !== note && overlaps(note, other)).length;
    max = Math.max(max, active);
  }
  return max;
}

const capFor = (family: string | undefined): number => family === "woodwinds" || family === "brass" ? 1 : family === "strings" ? 2 : Infinity;

/** A2 — occupancy report with provenance classification. */
function occupancy(label: string, proj: Project, seed: number): void {
  console.log(`\n===== A2/A4 ${label} (seed ${seed}) =====`);
  const tracks = generate(proj, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
  console.log("track                 maxSim  dbl  class-of-first-nondbl-overlap");
  for (const track of tracks) {
    const notes = track.notes;
    const maxSim = maxSimultaneous(notes);
    const dbl = notes.filter((note) => note.isDoubling).length;
    const cap = capFor(track.family);
    let paths = "";
    if (maxSim > cap) {
      const offender = notes.map((note) => ({
        note,
        others: notes.filter((other) => other !== note && overlaps(note, other) && !note.isDoubling && !other.isDoubling) as Array<{ pitch: number; role?: string }>,
      })).sort((a, b) => b.others.length - a.others.length)[0];
      if (offender) {
        const roles = [...new Set(offender.others.map((other) => other.role ?? "void"))];
        const pitches = offender.others.slice(0, 3).map((other) => other.pitch);
        paths = `non-dbl overlap: THIS role=${(offender.note as { role?: string }).role ?? "void"}@p${offender.note.pitch} vs roles=${roles.join(",")}@p${pitches.join(",")}`;
      }
    }
    console.log(`${track.name.padEnd(21)} ${String(maxSim).padStart(4)}  ${String(dbl).padStart(3)}  ${paths}`);
  }
}

/** A5 — top-5 note durations per role (chopped-chords signature). */
function durations(label: string, proj: Project, seed: number): void {
  console.log(`\n===== A5 ${label} (seed ${seed}) =====`);
  const tracks = generate(proj, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
  for (const role of ["BASS", "PAD", "LEAD"]) {
    const all: number[] = [];
    for (const track of tracks) for (const note of track.notes) if ((note as unknown as { role?: string }).role === role) all.push(note.durationTicks);
    const hist = new Map<number, number>();
    for (const duration of all) hist.set(duration, (hist.get(duration) ?? 0) + 1);
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
    const median = all.length ? [...all].sort((a, b) => a - b)[Math.floor(all.length / 2)]! : 0;
    console.log(`  ${role}: n=${all.length} median=${median}t (${(median / 960).toFixed(2)} beats) top5=${top.map(([d, c]) => `${d}t(${(d / 960).toFixed(0)}b)×${c}`).join(" ")}`);
  }
}

console.log("########## A1/A2/A4/A5 BEFORE FIXES ##########");
sectionDump("fixture (16 bars)", fixture);
sectionDump("synthetic 32-bar multi-section", synth);
occupancy("fixture", fixture, 6);
occupancy("fixture", fixture, 15);
occupancy("synthetic 32-bar", synth, 6);
occupancy("synthetic 32-bar", synth, 15);
durations("fixture", fixture, 6);
durations("synthetic 32-bar", synth, 6);
