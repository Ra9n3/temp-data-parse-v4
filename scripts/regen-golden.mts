/** Module 8.7 — regenerate the E/F/G engines-off golden digest + snapshot files.
 * Settings replicate the pinned test verbatim: themes OFF, rotation OFF. */
import fs from "node:fs";
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { DEFAULT_GENERATION_SETTINGS, type Project } from "../src/shared/schema/types";
import { snapshotDigest } from "../src/generation/efgGolden";

const digests: Record<string, { length: number; fnv: string }> = {};
for (const seed of [6, 15, 42]) {
  const project = cloneProject(dorianFixture as unknown as Project);
  const settings = JSON.parse(JSON.stringify(project.generationSettings ?? DEFAULT_GENERATION_SETTINGS));
  settings.themes = { germ: false, nct: false, counterline: false };
  settings.arrangement = { ...settings.arrangement, rotation: { enabled: false, restBars: 2, restTriggerBars: 8, maxActiveTracks: { intro: 3, verse: 6, preChorus: 10, chorus: 99, build: 99, breakdown: 3, outro: 4 } } };
  project.generationSettings = settings;
  const tracks = generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
  const plain = tracks.map((track) => ({ id: track.id, notes: track.notes }));
  digests[String(seed)] = snapshotDigest(plain as never);
  fs.writeFileSync(`src/fixtures/efg-legacy-golden-${seed}.json`, JSON.stringify(plain, null, 1));
}
fs.writeFileSync("src/fixtures/efg-legacy-golden-digest.json", JSON.stringify(digests, null, 2) + "\n");
console.log("digests:", JSON.stringify(digests, null, 1));
