/** Verify that different seeds produce genuinely different compositions (seed-variation regression test). */
import { generate } from "../generation/generate";
import { createDefaultProject } from "../shared/schema/factory";

let failures = 0;
const check = (name: string, fn: () => string) => {
  try {
    console.log(`PASS ${name} :: ${fn()}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name} :: ${error instanceof Error ? error.message : String(error)}`);
  }
};

function humanizeOff(project: ReturnType<typeof createDefaultProject>) {
  const settings = project.generationSettings!;
  settings.humanization = { intensity: 0, rubato: 0, intonationCents: 0, latencyCompensation: false };
  return project;
}

check("different seeds change note count and content (humanization off)", () => {
  const project = humanizeOff(createDefaultProject());
  const run = (seed: number) => generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] })
    .map((track) => track.notes.length).reduce((a, b) => a + b, 0);
  const counts = [1, 2, 3, 4, 5, 6, 7, 8].map(run);
  const uniqueCounts = new Set(counts);
  if (uniqueCounts.size < 2) throw new Error(`all seeds produced ${counts[0]} notes — seed has no effect`);
  const first = generate(project, { seed: 1, density: 0.75, humanize: false, lockedTrackIds: [] });
  const second = generate(project, { seed: 2, density: 0.75, humanize: false, lockedTrackIds: [] });
  const serialize = (tracks: typeof first) => JSON.stringify(tracks.map((track) => track.notes));
  if (serialize(first) === serialize(second)) throw new Error("seed 1 and seed 2 produced identical note sets");
  return `counts across seeds: ${counts.join(", ")}`;
});

check("consecutive simulate clicks mimic Compose All counter (1,2,3,...)", () => {
  const project = humanizeOff(createDefaultProject());
  let counter = Math.floor(Math.random() * 100_000);
  const signatures: string[] = [];
  for (let click = 0; click < 5; click++) {
    const seed = ++counter;
    const tracks = generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
    signatures.push(JSON.stringify(tracks.map((track) => track.notes)));
  }
  if (new Set(signatures).size !== signatures.length) throw new Error("consecutive clicks reused a composition");
  return "5 simulated clicks produced 5 distinct compositions";
});

check("same seed stays deterministic (repeatability preserved)", () => {
  const project = humanizeOff(createDefaultProject());
  const serialize = (tracks: ReturnType<typeof generate>) => JSON.stringify(tracks.map((track) => track.notes));
  const a = serialize(generate(project, { seed: 42, density: 0.75, humanize: false, lockedTrackIds: [] }));
  const b = serialize(generate(project, { seed: 42, density: 0.75, humanize: false, lockedTrackIds: [] }));
  if (a !== b) throw new Error("same seed no longer reproduces the same composition");
  const withHumanize = project;
  withHumanize.generationSettings!.humanization.intensity = 45;
  const c = serialize(generate(withHumanize, { seed: 42, density: 0.75, humanize: true, lockedTrackIds: [] }));
  const d = serialize(generate(withHumanize, { seed: 42, density: 0.75, humanize: true, lockedTrackIds: [] }));
  if (c !== d) throw new Error("humanized output is not deterministic per seed");
  return "same seed reproduces identical output with humanization off and on";
});

if (failures > 0) process.exit(1);
