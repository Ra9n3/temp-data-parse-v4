/** Module 8.8 byte-identity reference: dump final track notes for user project + fixture. */
import fs from "node:fs";
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import userProjectJson from "../src/fixtures/user-project.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { importProjectJson } from "../src/export/json";
import { type Project } from "../src/shared/schema/types";

const loaded = importProjectJson(JSON.stringify(userProjectJson));
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
for (const [label, project] of [["USER", loaded.project], ["FIXTURE", cloneProject(dorianFixture as unknown as Project)]] as const) {
  for (const seed of [6, 15, 42]) {
    const tracks = generate(cloneProject(project), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
    fs.writeFileSync(`.tmp-notes-${label}-${seed}.json`, JSON.stringify(tracks.map((t) => ({ id: t.id, name: t.name, role: t.role, family: t.family, notes: t.notes }))));
  }
}
console.log("dumped");
