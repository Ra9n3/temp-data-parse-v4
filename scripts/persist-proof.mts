/** Module 8.11 evidence probe: autosave/restore/hydration-guard contract with a
 * localStorage stub (browser API emulated) + the pinned suite's fixture setup. */
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import userProjectJson from "../src/fixtures/user-project.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { importProjectJson } from "../src/export/json";
import { loadAutosave, saveAutosave, parseMixRecord } from "../src/state/persistence";
import { type Project } from "../src/shared/schema/types";

// localStorage stub (the module touches window.localStorage directly)
const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  },
};

const loaded = importProjectJson(JSON.stringify(userProjectJson));
const user = loaded.ok ? loaded.project : null;
const fixture = cloneProject(dorianFixture as unknown as Project);

// 1. Empty boot = fixture path, no warn reason
console.log("1. no save:", JSON.stringify(loadAutosave()));

// 2. Save user project → restore returns exactly that project (sections/chords count)
const tracks = generate(cloneProject(user!), { seed: 42, density: 0.75, humanize: false, lockedTrackIds: [] });
const composed = { ...cloneProject(user!), tracks };
const save = saveAutosave(composed);
const restored = loadAutosave();
const rProj = restored.ok ? restored.project! : null;
console.log("2. save ok:", save.ok, "| restore ok:", restored.ok,
  "| sections:", rProj?.sections.length === composed.sections.length && rProj?.sections.every((s, i) => s.name === composed.sections[i]?.name && s.startBar === composed.sections[i]?.startBar && s.lengthBars === composed.sections[i]?.lengthBars),
  "| chords:", rProj?.chords.length === composed.chords.length,
  "| note count:", rProj?.tracks.reduce((n, t) => n + t.notes.length, 0) === composed.tracks.reduce((n, t) => n + t.notes.length, 0));

// 3. Corrupt payload → invalid, fixture fallback
store.set("scorch.autosave.v1", "{not json!!");
console.log("3. garbage payload:", JSON.stringify(loadAutosave()));
store.set("scorch.autosave.v1", JSON.stringify({ savedAt: new Date().toISOString(), schemaVersion: 1, project: { ...fixture, schemaVersion: 1, tracks: [{ bogus: "data" }] } }));
const bad = loadAutosave();
console.log("4. schema-invalid payload ok:", bad.ok, "reason:", bad.reason);

// 5. Version guard
store.set("scorch.autosave.v1", JSON.stringify({ savedAt: new Date().toISOString(), schemaVersion: 2, project: { ...fixture, schemaVersion: 2 } }));
const v2 = loadAutosave();
console.log("5. schemaVersion 2:", JSON.stringify({ ok: v2.ok, reason: v2.reason }));

// 6. New project change overwrites save (P5): save composed → then save default-ish payload → restore returns the NEW one
const small = { ...fixture, name: "New Project" };
saveAutosave(small);
console.log("6. overwrite restore name:", loadAutosave().ok ? loadAutosave().project!.name === "New Project" : false);

// 7. Mix record parsing: valid / NaN-guard / garbage
store.set("scorch.mix.v1", JSON.stringify({ masterGain: 2.5, trims: { tuba: 0.17 } }));
console.log("7. mix:", JSON.stringify(parseMixRecord(store.get("scorch.mix.v1")!)));
store.set("scorch.mix.v1", JSON.stringify({ masterGain: "NaNstuff", trims: { tuba: -1 } }));
console.log("8. mix sanitized:", JSON.stringify(parseMixRecord(store.get("scorch.mix.v1")!)));
store.set("scorch.mix.v1", "garbage");
console.log("9. mix garbage:", JSON.stringify(parseMixRecord("garbage")));
