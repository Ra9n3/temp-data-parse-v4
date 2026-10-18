/** Addendum E/F/G lead-print: per seed, the finished LEAD stream (theme engine E
 * + NCT engine F), onsets + pitches, plus the step ratio (fraction of consecutive
 * melodic intervals of 1–2 semitones). Target: ≥ 40%. */
import fixture from "../src/fixtures/dorian-16bars.json";
import { buildSemanticInputs, applyEfgEngines, buildEfgEnergies } from "../src/generation/generate";
import { DEFAULT_GENERATION_SETTINGS, PITCH_CLASS_LABELS } from "../src/shared/schema/types";
import { cloneProject } from "../src/shared/schema/factory";
import { validateProject, type Project } from "../src/shared/schema/validate";

const raw = validateProject(fixture as never);
if (!raw.ok) throw new Error(raw.errors.join("; "));
const base = cloneProject((raw as { project: Project }).project);
const settings = JSON.parse(JSON.stringify(Object.keys(base.generationSettings ?? {}).length ? base.generationSettings : DEFAULT_GENERATION_SETTINGS)) as NonNullable<Project["generationSettings"]>;

for (const seed of [6, 15, 42]) {
  const inputs = buildSemanticInputs(base, settings, seed);
  const engines = applyEfgEngines(inputs.score.events, {
    config: inputs.config,
    chords: inputs.chords,
    sections: inputs.scoreSections,
    energies: buildEfgEnergies(inputs.config, inputs.chords),
    chordStartTimes: inputs.chords.map((block) => block.startTime),
    profiles: inputs.compositionProfiles,
    intensityAt: inputs.arrangementInfo.intensityAt,
    subdivisionCapAt: inputs.arrangementInfo.subdivisionCapAt,
  }, seed, { germ: true, nct: true, counterline: true });
  const lead = (engines.events as Array<{ instrumentId: string; role: string; pitchConcert: number; startTime: number; duration: number; pitchWritten: number }>)
    .filter((event) => event.role === "LEAD")
    .sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
  let steps = 0, pairs = 0, repeats = 0;
  const lines: string[] = [];
  for (let i = 0; i < lead.length; i++) {
    const note = lead[i]!;
    const label: string = PITCH_CLASS_LABELS[((note.pitchConcert % 12) + 12) % 12] ?? String(note.pitchConcert);
    let delta = "";
    if (i > 0) {
      const prev = lead[i - 1]!;
      if (prev.instrumentId === note.instrumentId) {
        // Melodic interval = consecutive notes within one instrument's line.
        // Phrase handoffs across instruments are not melodic intervals.
        pairs++;
        const gap = note.pitchConcert - prev.pitchConcert;
        if (gap === 0) repeats++;
        else if (Math.abs(gap) === 1 || Math.abs(gap) === 2) steps++;
        delta = `${prev.instrumentId === note.instrumentId ? "" : "(handoff)"} Δ${gap > 0 ? "+" : ""}${gap}`;
      } else delta = " (handoff)";
    }
    lines.push(`  ${String(note.startTime).padStart(6)} dur ${String(note.duration).padStart(4)}  pitch ${String(note.pitchConcert).padStart(3)} (${label})${delta}`);
  }
  const ratio = pairs ? steps / pairs : 0;
  console.log(`== seed ${seed}: ${lead.length} LEAD events from ${new Set(lead.map((n) => n.instrumentId)).size} instrument(s) [${[...new Set(lead.map((n) => n.instrumentId))].join(", ")}]`);
  console.log(`   STEP RATIO: ${steps} steps / ${pairs} melodic pairs = ${(ratio * 100).toFixed(1)}% (target ≥ 40%); ${repeats} unison repeats (not intervals)`);
  console.log(lines.join("\n"));
  console.log();
}
