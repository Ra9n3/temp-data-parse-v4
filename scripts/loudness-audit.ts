/**
 * Module 8.9 — Instrument Loudness Audit v2 (distribution-based).
 *   npx tsx scripts/loudness-audit.ts [user|fixture|both]
 *
 * Root-failure diagnosis (Module 8.8): the v1 audit ran seeds 6/15/42 only —
 * too small a sample to expose a high-variance role like tuba, which is a
 * BASS/pad carrier only on some seeds. v2 runs seeds 1..20 and reports the
 * DISTRIBUTION per role (median / p75 / p90 / max effective loudness); the
 * solver targets p90 against the horn reference MEDIAN (user-confirmed
 * balanced role).
 *
 * Effective loudness per note:
 *   0.05 × trim(role) × (velocity/127)^1.5 × cc7/127 × cc11/127
 *   × timbreWeight (sawtooth 1.0, square 0.9, triangle 0.8, sine 0.7)
 *   × pitchWeight(model) × (percussion ×1.6)
 *   cc7 is the PREVIEW cc7Gain (acousticWeightForTrack — what the ear hears);
 *   the export CC7 fader value is printed alongside. Per-note MODEL-FREE
 *   components (vel^1.5 × cc7 × cc11 × timbre × perc) are pooled, so every
 *   pitchWeight model below is evaluated exactly on the same data.
 *
 * A3 pitchWeight comparison (printed per project; per-note exact recomputation):
 *   V0-discount (8.8):  1.0 @ 0.5–4 kHz, log-ramp to 0.7 @ 150 Hz, 0.7 below
 *   V1-flat:            1.0 down to 80 Hz (log-ramp 80–150 Hz), 0.7 below 80
 *   V2-boost (ADOPTED): 1.2 below 120 Hz, log-ramp up to 1.0 by 800 Hz, 1.0
 *     above — low frequencies read louder on real speakers (cabinet/coupler
 *     resonance) and the preview chain has no compensating low-shelf. The
 *     user's by-ear report ("tuba bursts out on seeds the three-seed audit
 *     never sampled") is the ground truth the discount curve contradicted.
 *
 * The audit applies the CURRENT ROLE_PREVIEW_GAIN_TRIM (so its tables show the
 * chain the user hears), plus per-model UNTRIMMED comparisons; the solver
 * proposes NEW trims only for roles flagged above the ±10% p90 band (minimal
 * change set); roles inside the band are left untouched.
 */
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import userProjectJson from "../src/fixtures/user-project.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { importProjectJson } from "../src/export/json";
import { type Project } from "../src/shared/schema/types";
import { acousticWeightForTrack, cc7ForWeight } from "../src/generation/balance";
import { ROLE_PREVIEW_GAIN_TRIM } from "../src/audio/usePlayback";

const which = process.argv[2] === "fixture" ? "fixture" : process.argv[2] === "user" ? "user" : "both";
const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1);

function familyParameters(family: string): { osc: string; timbre: number; filter: number; perc: number } {
  if (family === "strings") return { osc: "sawtooth", timbre: 1.0, filter: 2200, perc: 1 };
  if (family === "brass") return { osc: "sawtooth", timbre: 1.0, filter: 2800, perc: 1 };
  if (family === "woodwinds") return { osc: "triangle", timbre: 0.8, filter: 4200, perc: 1 };
  if (family === "keys") return { osc: "triangle", timbre: 0.8, filter: 4200, perc: 1 };
  if (family === "percussion") return { osc: "square", timbre: 0.9, filter: 4200, perc: 1 };
  return { osc: "sine", timbre: 0.7, filter: 4200, perc: 1 };
}

type Model = "V0-discount" | "V1-flat" | "V2-boost";

export function pitchWeight(pitch: number, model: Model): number {
  const hz = 440 * Math.pow(2, (pitch - 69) / 12);
  if (model === "V0-discount") {
    if (hz >= 500) return 1.0;
    if (hz >= 150) return 0.7 + 0.3 * (Math.log(hz / 150) / Math.log(500 / 150));
    return 0.7;
  }
  if (model === "V1-flat") {
    if (hz >= 150) return 1.0;
    if (hz >= 80) return 0.7 + 0.3 * (Math.log(hz / 80) / Math.log(150 / 80));
    return 0.7;
  }
  if (hz <= 120) return 1.2;
  if (hz >= 800) return 1.0;
  return 1.2 - 0.2 * (Math.log(hz / 120) / Math.log(800 / 120));
}

function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}
function median(values: number[]): number { return quantile(values, 0.5); }

interface Row {
  role: string; name: string; family: string;
  count: number; medPitch: number; regLow: number; regMid: number; regHigh: number;
  medVelocity: number; maxVelocity: number; cc7Export: number; medCc11: number;
  notesPerSec: number; guests: number; tuttiPct: number;
  medLoud: number; p75Loud: number; p90Loud: number; maxLoud: number;
  velMean: number; pitchMean: number; cc7Mean: number; cc11Mean: number; trimMean: number;
}
interface TubaExposure { seed: number; notes: number; bass: number; pad: number }

interface ProjectResult {
  label: string;
  rows: Map<string, Row>;
  pools: Map<string, { louds: number[]; base: number[]; vel: number[]; pitches: number[]; cc11s: number[] }>;
  tubaExposure: TubaExposure[];
}

function measureProject(label: string, project: Project): ProjectResult {
  const rows = new Map<string, Row>();
  const pools = new Map<string, { louds: number[]; base: number[]; vel: number[]; pitches: number[]; cc11s: number[] }>();
  const tubaExposure: TubaExposure[] = [];
  for (const seed of SEEDS) {
    const tracks = generate(cloneProject(project), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
    const endTick = Math.max(...tracks.flatMap((track) => track.notes.map((note) => note.startTick + note.durationTicks)), 1);
    const seconds = (endTick * 60) / (project.bpm * 960);
    let tubaNotes = 0, tubaBass = 0, tubaPad = 0;
    for (const track of tracks) {
      if (track.family === "structure" || track.family === "audio") continue;
      const params = familyParameters(track.family);
      const rangeLow = track.lowestNote, rangeHigh = track.highestNote;
      const cc7Preview = acousticWeightForTrack(track);
      for (const note of track.notes) {
        const key = `${track.role}::${track.family}`;
        let row = rows.get(key);
        if (!row) {
          row = { role: track.role, name: track.name, family: track.family, count: 0, medPitch: 0, regLow: 0, regMid: 0, regHigh: 0,
            medVelocity: 0, maxVelocity: 0, cc7Export: Math.round(cc7ForWeight(cc7Preview)), medCc11: 0, notesPerSec: 0, guests: 0, tuttiPct: 0,
            medLoud: 0, p75Loud: 0, p90Loud: 0, maxLoud: 0,
            velMean: 0, pitchMean: 0, cc7Mean: 0, cc11Mean: 0, trimMean: 0 };
          rows.set(key, row);
          pools.set(key, { louds: [], base: [], vel: [], pitches: [], cc11s: [] });
        }
        row = row!;
        const pool = pools.get(key)!;
        row.count++;
        const span = Math.max(1, rangeHigh - rangeLow);
        if (note.pitch < rangeLow + span / 3) row.regLow++; else if (note.pitch < rangeLow + (2 * span) / 3) row.regMid++; else row.regHigh++;
        const cc11 = note.dynamics ? note.dynamics.cc11Value / 127 : 1;
        const roleTrim = ROLE_PREVIEW_GAIN_TRIM[track.role] ?? 1;
        // model-free base: everything except the pitch weight
        const base = Math.pow(note.velocity / 127, 1.5) * cc7Preview * cc11 * params.timbre * params.perc;
        pool.base.push(base);
        pool.louds.push(0.05 * roleTrim * base * pitchWeight(note.pitch, "V2-boost"));
        pool.vel.push(note.velocity); pool.pitches.push(note.pitch); pool.cc11s.push(note.dynamics?.cc11Value ?? 127);
        if (note.isDoubling) row.guests++;
        row.notesPerSec += 1 / Math.max(seconds, 1e-9);
        row.velMean += Math.pow(note.velocity / 127, 1.5);
        row.pitchMean += pitchWeight(note.pitch, "V2-boost");
        row.cc7Mean += cc7Preview;
        row.cc11Mean += cc11;
        row.trimMean += roleTrim;
        if (track.role === "tuba") {
          tubaNotes++;
          if (note.role === "BASS") tubaBass++; else if (note.role === "PAD") tubaPad++;
        }
      }
      if (track.role === "violins1") {
        const trumpets = tracks.find((candidate) => candidate.role === "trumpets");
        if (trumpets) {
          const target = rows.get("trumpets::brass") as unknown as { tuttiDoubles?: number } | undefined;
          if (target) {
            target.tuttiDoubles = (target.tuttiDoubles ?? 0) + trumpets.notes.filter((guest) => guest.isDoubling
              && track.notes.some((source) => source.startTick === guest.startTick && guest.pitch === source.pitch + 12)).length;
          }
        }
      }
    }
    tubaExposure.push({ seed, notes: tubaNotes, bass: tubaBass, pad: tubaPad });
  }
  for (const [key, row] of rows) {
    const pool = pools.get(key)!;
    row.medPitch = median(pool.pitches);
    row.medVelocity = median(pool.vel);
    row.maxVelocity = Math.max(...pool.vel, 0);
    row.medCc11 = median(pool.cc11s);
    row.medLoud = median(pool.louds);
    row.p75Loud = quantile(pool.louds, 0.75);
    row.p90Loud = quantile(pool.louds, 0.9);
    row.maxLoud = quantile(pool.louds, 1);
    row.notesPerSec = Math.round(row.notesPerSec * 10) / 10;
    row.velMean /= row.count; row.pitchMean /= row.count; row.cc7Mean /= row.count; row.cc11Mean /= row.count; row.trimMean /= row.count;
    row.tuttiPct = Math.round(100 * ((row as unknown as { tuttiDoubles?: number }).tuttiDoubles ?? 0) / Math.max(1, row.count));
  }
  return { label, rows, pools, tubaExposure };
}

function loadProjects(): Array<[string, Project]> {
  const list: Array<[string, Project]> = [];
  if (which !== "fixture") {
    const loaded = importProjectJson(JSON.stringify(userProjectJson));
    if (!loaded.ok) { console.error("VALIDATION FAILED:", loaded.errors.join("; ")); process.exit(1); }
    list.push(["USER", loaded.project]);
  }
  if (which !== "user") list.push(["FIXTURE", cloneProject(dorianFixture as unknown as Project)]);
  return list;
}

const HORN_REF = "horns::brass";
const TUBA = "tuba::brass";

for (const [label, project] of loadProjects()) {
  const result = measureProject(label, project);
  console.log(`\n########## Loudness audit v2 — ${label} project — ${SEEDS.length} seeds (A3-corrected V2-boost model applied) ##########`);

  // --- A2: tuba exposure ---
  const withTuba = result.tubaExposure.filter((entry) => entry.notes > 0);
  const tubaRow = result.rows.get(TUBA);
  console.log(`-- A2 tuba exposure: carrier in ${withTuba.length}/${result.tubaExposure.length} seeds — BASS notes ${withTuba.reduce((s, e) => s + e.bass, 0)}, PAD notes ${withTuba.reduce((s, e) => s + e.pad, 0)} --`);
  console.log("  " + result.tubaExposure.map((entry) => `s${entry.seed}=${entry.notes}(${entry.bass}b/${entry.pad}p)`).join(" "));
  if (tubaRow) {
    console.log(`tuba variance: median ${tubaRow.medLoud.toFixed(5)} | p90 ${tubaRow.p90Loud.toFixed(5)} (${(tubaRow.p90Loud / tubaRow.medLoud).toFixed(2)}× median) | max ${tubaRow.maxLoud.toFixed(5)} (${(tubaRow.maxLoud / tubaRow.medLoud).toFixed(2)}×)`);
  } else {
    console.log("tuba variance: role SILENT across all seeds");
  }

  // --- A1: distribution table, ranked by p90 ---
  const hornRow = result.rows.get(HORN_REF);
  const hornReference = hornRow?.medLoud ?? 0;
  const ranked = [...result.rows.entries()].filter(([, row]) => row.count > 0).sort((a, b) => b[1].p90Loud - a[1].p90Loud);
  console.log(`-- A1 distribution (current trims; horn reference MEDIAN ${hornReference.toFixed(5)}) --`);
  console.log("role          fam      medLoud   p75Loud   p90Loud   maxLoud  p90/horn  p90rank  medV  maxV  medCC11  medPitch  reg L/M/H          n/s  guests");
  for (const [, row] of ranked) {
    const params = familyParameters(row.family);
    const p90Rank = ranked.findIndex(([key]) => key === `${row.role}::${row.family}`) + 1;
    console.log(`${row.role.padEnd(12)} ${row.family.slice(0, 8).padEnd(9)}${row.medLoud.toFixed(5)}  ${row.p75Loud.toFixed(5)}  ${row.p90Loud.toFixed(5)}  ${row.maxLoud.toFixed(5)}  ${String((100 * row.p90Loud / hornReference).toFixed(0)).padStart(6)}%  ${String(p90Rank).padStart(7)}  ${String(row.medVelocity).padStart(4)} ${String(row.maxVelocity).padStart(5)}  ${String(row.medCc11).padStart(6)}  ${String(row.medPitch).padStart(8)}  ${`${row.regLow}/${row.regMid}/${row.regHigh}`.padStart(12)}  ${String(row.notesPerSec).padStart(5)}  ${String(row.guests).padStart(6)}  [${params.osc} f${params.filter}]`);
  }

  // --- A3: exact per-note model comparison (untrimmed; the model-free base pool
  // lets every model be evaluated exactly on the SAME per-note data) ---
  console.log("-- A3 pitchWeight models on identical data (untrimmed medians; rank among sounding roles) --");
  for (const model of ["V0-discount", "V1-flat", "V2-boost"] as Model[]) {
    const medians = new Map<string, number>();
    for (const [key] of result.rows) {
      const pool = result.pools.get(key)!;
      medians.set(key, median(pool.base.map((base, index) => 0.05 * base * pitchWeight(pool.pitches[index] ?? 60, model))));
    }
    const positions = [...medians.entries()].sort((a, b) => b[1] - a[1]);
    const tubaRank = positions.findIndex(([key]) => key === TUBA) + 1;
    const tubaMed = medians.get(TUBA) ?? 0;
    const hornMed = medians.get(HORN_REF) ?? 0;
    const trumpetRank = positions.findIndex(([key]) => key === "trumpets::brass") + 1;
    console.log(`  ${model}: tuba rank ${tubaRank}/${positions.length}, median ${tubaMed.toFixed(5)}, vs horn ${(100 * tubaMed / hornMed).toFixed(0)}% | trumpets rank ${trumpetRank}`);
  }

  // --- B1/B2: solver — minimal change set vs horn reference ---
  if (hornReference && hornRow) {
    console.log(`-- B1 solver (p90 vs horn reference ${hornReference.toFixed(5)}; band 90–110%) --`);
    for (const [key, row] of result.rows) {
      if (row.count === 0 || key === HORN_REF) continue;
      const p90Ratio = row.p90Loud / hornReference;
      const current = row.trimMean;
      const inBand = p90Ratio >= 0.9 && p90Ratio <= 1.1;
      if (inBand) {
        console.log(`  ${row.role.padEnd(12)} p90 ${(100 * p90Ratio).toFixed(0)}% — in band, trim ${current} UNTOUCHED`);
        continue;
      } else if (p90Ratio < 0.9) {
        console.log(`  ${row.role.padEnd(12)} p90 ${(100 * p90Ratio).toFixed(0)}% — below band (quiet role; NOT boosted, stays untouched)`);
        continue;
      }
      // above band → propose trim: the CURRENT pool already includes current trim, so scale it
      const proposed = current / p90Ratio * 1.0; // centers p90 exactly at 100% of horn reference
      // check the ±10% band satisfiable from BOTH projects? The main solver prints per project here;
      // the cross-project restatement happens in the report (single constant, user project preferred).
      console.log(`  ${row.role.padEnd(12)} p90 ${(100 * p90Ratio).toFixed(0)}% — ABOVE band → trim ${current} → ${proposed.toFixed(3)}`);
    }
  }
}
