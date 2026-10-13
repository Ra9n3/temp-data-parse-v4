/**
 * Hotfix diagnostic: per-track maximal simultaneous notes, doubling note counts,
 * and flute/oboe mirror-line percentage. Run before and after the polyphony
 * fixes; usage: npx tsx scripts/occupancy-report.ts [before|after]
 */
import fixture from "../src/fixtures/dorian-16bars.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { validateProject, type Project } from "../src/shared/schema/validate";

const raw = validateProject(fixture as never);
if (!raw.ok) throw new Error(raw.errors.join("; "));
const base = cloneProject((raw as { project: Project }).project);

function overlaps(a: { startTick: number; durationTicks: number }, b: { startTick: number; durationTicks: number }): boolean {
  return a.startTick < b.startTick + b.durationTicks && b.startTick < a.startTick + a.durationTicks;
}

function maxSimultaneous(notes: { startTick: number; durationTicks: number }[]): number {
  let max = 0;
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick);
  for (const note of sorted) {
    // exclude the note itself — a note trivially overlaps its own window
    const active = sorted.filter((other) => other !== note && overlaps(note, other)).length;
    max = Math.max(max, active);
  }
  return max;
}

const WINDS = new Set(["flutes", "oboes", "clarinets", "bassoons", "piccolo", "englishHorn", "bassClarinet"]);
const BRASS = new Set(["trumpets", "trombones", "horns", "tuba", "bassTrombone"]);
const STRINGS = new Set(["violins1", "violins2", "violas", "cellos", "doubleBass", "harp"]);

for (const seed of [6, 15, 42]) {
  const tracks = generate(base, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
  console.log(`== seed ${seed} (label: ${process.argv[2] ?? "unlabeled"}) ==`);
  console.log("track                 maxSim  doubling  mirror%");
  for (const track of tracks) {
    // only instrument tracks
    const role = track.role;
    const maxSim = maxSimultaneous(track.notes);
    const doubling = track.notes.filter((note) => note.isDoubling).length;
    let mirror = 0;
    if (role === "flutes" || role === "oboes") {
      const self = track.notes.map((note) => [note.startTick, note.pitch] as const);
      const other = tracks.find((candidate) => candidate.role === (role === "flutes" ? "oboes" : "flutes"))!;
      const otherSet = new Set(other.notes.map((note) => [note.startTick, note.pitch].join(",")));
      if (self.length) {
        mirror = Math.round((self.filter((pair) => otherSet.has(pair.join(","))).length / self.length) * 100);
      }
    }
    const bucket = WINDS.has(role) ? "WIND" : BRASS.has(role) ? "BRASS" : STRINGS.has(role) ? "STRING" : "keys/perc";
    console.log(`${track.name.padEnd(21)} ${String(maxSim).padStart(4)}  ${String(doubling).padStart(8)}  ${String(mirror).padStart(4)}%  [${bucket}]`);
  }
  // aggregate hotfix scorecard
  const windBrass = tracks.filter((track) => WINDS.has(track.role) || BRASS.has(track.role));
  const strings = tracks.filter((track) => STRINGS.has(track.role));
  const worstWind = Math.max(...windBrass.map((track) => maxSimultaneous(track.notes)), 0);
  const worstString = Math.max(...strings.map((track) => maxSimultaneous(track.notes)), 0);
  const fl = tracks.find((track) => track.role === "flutes");
  const ob = tracks.find((track) => track.role === "oboes");
  let identity = 0;
  if (fl && ob) {
    const obSet = new Set(ob.notes.map((note) => `${note.startTick}:${note.pitch}`));
    const denominator = Math.max(1, fl.notes.length);
    identity = Math.round((fl.notes.filter((note) => obSet.has(`${note.startTick}:${note.pitch}`)).length / denominator) * 100);
  }
  console.log(`scorecard: worst wind/brass maxSim=${worstWind} (goal 1), worst string maxSim=${worstString} (goal ≤2), flute/oboe identity=${identity}% (goal <90)`);
}
