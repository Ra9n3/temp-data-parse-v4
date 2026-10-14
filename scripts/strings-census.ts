/**
 * Module STRINGS — Phase 0 census (read-only; reports BEFORE any change).
 * D1: string-track simultaneous PAIRS (overlap depth exactly 2 = the guard's
 *     double-stop regime), classified by the decision-1 validator copy.
 * D2: M13 CC10 write inventory (which byte writes exist today).
 * Run: npx tsx scripts/strings-census.ts
 */
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import userProjectJson from "../src/fixtures/user-project.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { importProjectJson } from "../src/export/json";
import { type Project, type Note } from "../src/shared/schema/types";

const loaded = importProjectJson(JSON.stringify(userProjectJson));
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const BODIES: Array<[string, Project]> = [
  ["USER", loaded.project],
  ["FIXTURE", cloneProject(dorianFixture as unknown as Project)],
];

// decision-1 validator copy (phase 0; the real module lands in Phase A)
const OPEN_STRINGS: Record<string, number[]> = {
  violins1: [55, 62, 69, 76], violins2: [55, 62, 69, 76],
  violas: [48, 55, 62, 69], cellos: [36, 43, 50, 57],
  doubleBass: [28, 33, 38, 43],
};
const assignString = (pitch: number, instrument: string): number => {
  const opens = OPEN_STRINGS[instrument]!;
  let best = -1;
  for (let i = 0; i < opens.length; i++) if (opens[i]! <= pitch && opens[i]! > best) best = opens[i]!;
  return best; // -1 = below the lowest string
};
function classify(p1: number, p2: number, instrument: string): string {
  const s1 = assignString(p1, instrument), s2 = assignString(p2, instrument);
  if (s1 < 0 || s2 < 0) return "out-of-range";
  if (s1 === s2) return "INVALID same-string";
  const lo = OPEN_STRINGS[instrument]!.indexOf(Math.min(s1, s2));
  const hi = OPEN_STRINGS[instrument]!.indexOf(Math.max(s1, s2));
  if (hi - lo !== 1) return "INVALID non-adjacent";
  const interval = Math.abs(p1 - p2);
  const openEither = s1 === p1 || s2 === p2;
  if (interval <= 16 || openEither) return openEither ? "VALID (open)" : `VALID+WARN pcInterval=${Math.abs(s1 - s2)}`;
  return "INVALID stretch";
}

const STRING_TRACKS = new Set(["trk_violins_i", "trk_violins_ii", "trk_violas", "trk_cellos", "trk_double_bass"]);
const ROLE_OF: Record<string, string> = {
  trk_violins_i: "violins1", trk_violins_ii: "violins2", trk_violas: "violas", trk_cellos: "cellos", trk_double_bass: "doubleBass",
};
for (const [label, base] of BODIES) {
  console.log(`\n===== BODY ${label} =====`);
  console.log("string track ids present:", base.tracks.filter((t) => t.role && ROLE_OF[t.id] !== undefined).map((t) => `${t.id}(${t.name})`).join(", ") || "(none by id — resolving by ROLE)");
  // resolve by track.role, not id
  const trackByRole = (role: string) => base.tracks.find((t) => t.role === role && t.family === "strings");
  const totals: Record<string, { pairs: number; valid: number; invalid: number }> = {};
  for (const role of Object.keys(OPEN_STRINGS)) {
    totals[role] = { pairs: 0, valid: 0, invalid: 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const tracks = generate(cloneProject(base), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
      const track = tracks.find((t) => t.family === "strings" && (t.role === role || t.id === `trk_${role}`));
      if (!track) continue;
      const notes = track.notes;
      const overlapsOtherCount = (n: Note) => notes.filter((o) => o !== n && n.startTick < o.startTick + o.durationTicks && o.startTick < n.startTick + n.durationTicks).length;
      const seen = new Set<string>();
      for (const n of notes) {
        for (const o of notes) {
          if (o === n || n.startTick >= o.startTick) continue; // count each pair once, ordered by onset
          if (!(n.startTick < o.startTick + o.durationTicks && o.startTick < n.startTick + n.durationTicks)) continue;
          if (overlapsOtherCount(n) !== 1 || overlapsOtherCount(o) !== 1) continue; // depth exactly 2
          const key = `${n.startTick}:${o.startTick}:${n.pitch}:${o.pitch}`;
          if (seen.has(key)) continue;
          seen.add(key);
          totals[role]!.pairs++;
          const verdict = classify(n.pitch, o.pitch, role);
          if (verdict.startsWith("VALID")) totals[role]!.valid++;
          else totals[role]!.invalid++;
        }
      }
    }
  }
  console.log("D1 double-stop pairs (depth exactly 2, per 20 seeds pooled):");
  for (const [role, t] of Object.entries(totals)) console.log(`  ${role.padEnd(10)} pairs=${String(t.pairs).padStart(4)} valid=${String(t.valid).padStart(4)} unplayable=${String(t.invalid).padStart(4)}`);
}
void ROLE_OF; void STRING_TRACKS;
// D2 — M13 CC10 inventory (static): PAN_CENTERED_ROLES = BASS_CARRIER_ROLES = { doubleBass, tuba, bassoons, cellos }
console.log("\nD2 M13 CC10 inventory (exporter writeInstrumentTrack): one CC10=64 event @tick0 on EVERY track whose role ∈ PAN_CENTERED_ROLES={doubleBass,tuba,bassoons,cellos} — per body:");
for (const [label, base] of BODIES) {
  const hits = base.tracks.filter((t) => ["doubleBass", "tuba", "bassoons", "cellos"].includes(t.role ?? ""));
  console.log(`  ${label}: ${hits.map((t) => t.name).join(", ")} → 1 CC10 write each (4 byte writes, will shift under CLASSICAL)`);
}
