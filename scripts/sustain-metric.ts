/**
 * Module 8.6 addendum verification metric — sustain consolidation effect at the
 * exact stage boundary (after engines + rotation + mask, BEFORE realizeRhythm
 * and BEFORE the guard), measured on the fixture and the 32-bar synthetic.
 *   npx tsx scripts/sustain-metric.ts
 */
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import { generateOrchestralScore, applyEfgEngines, buildSemanticInputs, buildEfgEnergies, type ProjectConfig, type StructureSection } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { validateProject } from "../src/shared/schema/validate";
import type { Project } from "../src/shared/schema/types";
import { arrangementContext, DEFAULT_ARRANGEMENT_CONFIG } from "../src/generation/arrangement";
import { sectionTypeFor } from "../src/generation/arrangement";
import { buildPipelineProfiles } from "../src/generation/profileAdapter";
import { DEFAULT_GENERATION_SETTINGS } from "../src/shared/schema/types";
import { planRotation, resolveRotationConfig, applyRoleRotation, applyActiveMask, exposedBreakdownRoles } from "../src/generation/rotation";
import { consolidateSustains } from "../src/generation/sustain";

function rawProject(source: unknown): Project {
  const result = validateProject(source);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return cloneProject(result.project);
}

const barTicks = 3840;
function synthetic32(fixture: Project): Project {
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
    for (let offset = 0; offset < Math.max(1, Math.round(block.durationTicks / barTicks)); offset++) perBar.set(startBar + offset, block.symbol ?? "C");
  }
  p.chords = Array.from({ length: 32 }, (_, barIndex) => ({ id: `sustain-chord-${barIndex}`, symbol: perBar.get(barIndex % 16) ?? "C", startTick: barIndex * barTicks, durationTicks: barTicks }));
  return p;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function measure(label: string, project: Project, seed: number): void {
  const settings = project.generationSettings ?? DEFAULT_GENERATION_SETTINGS;
  const inputs = buildSemanticInputs(project, settings, seed);
  const { config, chords, scoreSections, score, compositionProfiles } = inputs;
  const profiles = compositionProfiles.length ? compositionProfiles : buildPipelineProfiles();
  const arrangementInfo = inputs.arrangementInfo;
  const rotationPartial = settings.arrangement?.rotation;
  const rotationConfig = resolveRotationConfig(rotationPartial);
  const rotationPlan = rotationConfig.enabled ? planRotation(project, rotationPartial, seed) : undefined;
  const efgRotation = rotationPlan ? { plan: rotationPlan, config: rotationConfig, measures: arrangementInfo.measures, exposedRoles: exposedBreakdownRoles(settings.arrangement?.breakdownExposedLayer) } : undefined;
  const themeSwitches = { germ: settings.themes?.germ ?? true, nct: settings.themes?.nct ?? true, counterline: settings.themes?.counterline ?? true };
  const pre = rotationPlan
    ? applyActiveMask(
      applyRoleRotation(score.events, rotationPlan, profiles),
      rotationPlan, arrangementInfo.measures, rotationConfig, profiles,
      exposedBreakdownRoles(settings.arrangement?.breakdownExposedLayer))
    : score.events;
  // The real pipeline path (applyEfgEngines tail performs rotation+mask+consolidation).
  const post = applyEfgEngines(score.events, {
    config, chords, sections: scoreSections,
    energies: buildEfgEnergies(config, chords), chordStartTimes: chords.map((block) => block.startTime),
    profiles,
    intensityAt: arrangementInfo.intensityAt,
    subdivisionCapAt: arrangementInfo.subdivisionCapAt,
    rotation: efgRotation,
  }, seed, themeSwitches).events;
  for (const role of ["BASS", "PAD"] as const) {
    const beforeDurations = pre.filter((event) => event.role === role).map((event) => event.duration);
    const afterDurations = post.filter((event) => event.role === role).map((event) => event.duration);
    const coveredBefore = beforeDurations.length ? 100 * beforeDurations.filter((duration) => duration >= 4 * 960).length / beforeDurations.length : 0;
    const coveredAfter = afterDurations.length ? 100 * afterDurations.filter((duration) => duration >= 4 * 960).length / afterDurations.length : 0;
    const hist = new Map<number, number>();
    for (const duration of afterDurations) hist.set(duration, (hist.get(duration) ?? 0) + 1);
    const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, c]) => `${d}t(${(d / 960).toFixed(1)}b)×${c}`).join(" ");
    console.log(`[${label} seed ${seed}] ${role}: events ${beforeDurations.length}→${afterDurations.length} | median ${median(beforeDurations)}t→${median(afterDurations)}t (${(median(beforeDurations) / 960).toFixed(2)}→${(median(afterDurations) / 960).toFixed(2)} beats) | ≥4-beat coverage ${coveredBefore.toFixed(1)}%→${coveredAfter.toFixed(1)}% | post top5: ${top}`);
  }
  console.log(`[${label} seed ${seed}] stage totals: ${pre.length}→${post.length} (absorbed ${pre.length - post.length})`);
}

const fixture = rawProject(dorianFixture);
measure("fixture 16-bar", fixture, 6);
measure("synthetic 32-bar", synthetic32(fixture), 6);
measure("synthetic 32-bar", synthetic32(fixture), 15);
type StructureSectionType = StructureSection["type"];
void (0 as unknown as StructureSectionType);
void sectionTypeFor;
type ProjectConfigRef = ProjectConfig;
void (0 as unknown as ProjectConfigRef);
