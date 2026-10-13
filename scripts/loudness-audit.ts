/**
 * Module 8.8 — Instrument Loudness Audit (measured on the FINAL generate()
 * output, decomposing the PREVIEW gain chain the user actually hears).
 *   npx tsx scripts/loudness-audit.ts [user|fixture|both]
 * User project (fixtures/user-project.json) primary; dorian fixture secondary.
 *
 * Per instrument role (all seeds pooled), printed ranked table:
 *  - median concert pitch + register distribution (low/mid/high by thirds of
 *    the track's range), notes/sec density, doubling-guest count + share,
 *    % of notes that carry a violins1→trumpets/octave TUTTI_PEAK double;
 *  - median + max final velocity (post chain: base + register modifier +
 *    technique offset + AMG jitter), CC7 fader (export), CC11 at the notes'
 *    actual dynamics, and the preview chain constants;
 *  - median + max EFFECTIVE LOUDNESS per note:
 *       0.05 (base peak) × (velocity/127)^1.5 × cc7/127 × cc11/127
 *       × timbreWeight (sawtooth 1.0, triangle 0.8, square 0.9, sine 0.7)
 *       × pitchWeight × (percussion ×1.6 as in usePlayback).
 *    cc7/127 uses the PREVIEW cc7Gain (acousticWeightForTrack — that is what
 *    the ear hears; the export CC7 fader value is printed alongside).
 *    pitchWeight is an equal-loudness approximation: 1.0 across 0.5–4 kHz,
 *    falling to 0.7 at 150 Hz (log-frequency linear ramp 0.15–0.5 kHz),
 *    0.7 below 150 Hz, and held at 1.0 above 4 kHz (documented simplification;
 *    orchestrally used pitches rarely exceed 4 kHz).
 *
 * Roles are ranked by median effective loudness; the report pins a Horn
 * reference and flags roles >15% above it (the B1 trim targets).
 */
import fs from "node:fs";
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import userProjectJson from "../src/fixtures/user-project.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { importProjectJson } from "../src/export/json";
import { type Project } from "../src/shared/schema/types";
import { acousticWeightForTrack, cc7ForWeight } from "../src/generation/balance";
import { ROLE_PREVIEW_GAIN_TRIM } from "../src/audio/usePlayback";

const which = process.argv[2] ?? "both";

function familyParameters(family: string): { osc: string; timbre: number; filter: number; perc: number } {
  if (family === "strings") return { osc: "sawtooth", timbre: 1.0, filter: 2200, perc: 1 };
  if (family === "brass") return { osc: "sawtooth", timbre: 1.0, filter: 2800, perc: 1 };
  if (family === "woodwinds") return { osc: "triangle", timbre: 0.8, filter: 4200, perc: 1 };
  if (family === "keys") return { osc: "triangle", timbre: 0.8, filter: 4200, perc: 1 };
  if (family === "percussion") return { osc: "square", timbre: 0.9, filter: 4200, perc: 1 };
  return { osc: "sine", timbre: 0.7, filter: 4200, perc: 1 };
}

/** Equal-loudness pitch weight (documented in the header). */
function pitchWeight(pitch: number): number {
  const hz = 440 * Math.pow(2, (pitch - 69) / 12);
  if (hz >= 500) return 1.0;
  if (hz >= 150) { // log-frequency linear ramp 0.7 → 1.0 between 0.15 and 0.5 kHz
    const t = Math.log(hz / 150) / Math.log(500 / 150);
    return 0.7 + 0.3 * t;
  }
  return 0.7;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

interface Row {
  role: string; name: string; family: string;
  count: number; medPitch: number; regLow: number; regMid: number; regHigh: number;
  medVelocity: number; maxVelocity: number; cc7Export: number; medCc11: number;
  notesPerSec: number; guests: number; tuttiPct: number;
  medLoud: number; maxLoud: number;
  velFactor: number; pitchFactor: number; cc7Factor: number; cc11Factor: number; trimFactor: number;
}

const rowsByRole = new Map<string, Row>();
const poolsByRole = new Map<string, { louds: number[]; vel: number[]; pitches: number[]; cc11s: number[] }>();
const projects: Array<[string, Project]> = [];
if (which !== "fixture") {
  const loaded = importProjectJson(JSON.stringify(userProjectJson));
  if (!loaded.ok) { console.error("VALIDATION FAILED:", loaded.errors.join("; ")); process.exit(1); }
  projects.push(["USER", loaded.project]);
}
if (which !== "user") projects.push(["FIXTURE", cloneProject(dorianFixture as unknown as Project)]);

const window = (label: string, project: Project, seed: number): void => {
  const tracks = generate(cloneProject(project), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
  const endTick = Math.max(...tracks.flatMap((track) => track.notes.map((note) => note.startTick + note.durationTicks)), 1);
  const seconds = (endTick * 60) / (project.bpm * 960);
  for (const track of tracks) {
    if (track.family === "structure" || track.family === "audio") continue;
    const params = familyParameters(track.family);
    const rangeLow = track.lowestNote, rangeHigh = track.highestNote;
    const cc7Preview = acousticWeightForTrack(track); // preview cc7Gain
    for (const note of track.notes) {
      const key = `${track.role}::${track.family}`;
      let row = rowsByRole.get(key);
      if (!row) {
        row = { role: track.role, name: track.name, family: track.family, count: 0, medPitch: 0, regLow: 0, regMid: 0, regHigh: 0,
          medVelocity: 0, maxVelocity: 0, cc7Export: Math.round(cc7ForWeight(cc7Preview)), medCc11: 0, notesPerSec: 0, guests: 0, tuttiPct: 0,
          medLoud: 0, maxLoud: 0, velFactor: 0, pitchFactor: 0, cc7Factor: 0, cc11Factor: 0, trimFactor: 0 };
        rowsByRole.set(key, row);
        poolsByRole.set(key, { louds: [], vel: [], pitches: [], cc11s: [] });
      }
      row = row!;
      const pools = poolsByRole.get(key)!;
      row.count++;
      const span = Math.max(1, rangeHigh - rangeLow);
      if (note.pitch < rangeLow + span / 3) row.regLow++; else if (note.pitch < rangeLow + (2 * span) / 3) row.regMid++; else row.regHigh++;
      const cc11 = note.dynamics ? note.dynamics.cc11Value / 127 : 1;
      // Include the per-role preview trim (Module 8.8 B1) so measured medians
      // reflect the chain the user hears (usePlayback schedule() multiplies it).
      const roleTrim = ROLE_PREVIEW_GAIN_TRIM[track.role] ?? 1;
      const effective = 0.05 * roleTrim * Math.pow(note.velocity / 127, 1.5) * cc7Preview * cc11 * params.timbre * pitchWeight(note.pitch) * params.perc;
      row.maxLoud = Math.max(row.maxLoud, effective);
      pools.louds.push(effective);
      pools.vel.push(note.velocity);
      pools.pitches.push(note.pitch);
      pools.cc11s.push(note.dynamics?.cc11Value ?? 127);
      if (note.isDoubling) row.guests++;
      row.notesPerSec += 1 / Math.max(seconds, 1e-9);
      row.velFactor += Math.pow(note.velocity / 127, 1.5);
      row.pitchFactor += pitchWeight(note.pitch);
      row.trimFactor += roleTrim;
      row.cc7Factor += cc7Preview;
      row.cc11Factor += cc11;
    }
    // TUTTI_PEAK octave detection: trumpets guest one octave above a violins1 note at the same tick.
    if (track.role === "violins1") {
      const trumpets = tracks.find((candidate) => candidate.role === "trumpets");
      if (trumpets) {
        const key = "trumpets::brass";
        const target = rowsByRole.get(key) as unknown as { tuttiDoubles?: number } | undefined;
        if (target) {
          target.tuttiDoubles = (target.tuttiDoubles ?? 0) + trumpets.notes.filter((guest) => guest.isDoubling
            && track.notes.some((source) => source.startTick === guest.startTick && guest.pitch === source.pitch + 12)).length;
        }
      }
    }
  }
};

for (const [label, project] of projects) {
  rowsByRole.clear();
  poolsByRole.clear();
  for (const seed of [6, 15, 42]) window(label, project, seed);
  console.log(`\n===== Loudness audit — ${label} project (seeds 6/15/42 pooled) =====`);
  const rows = [...rowsByRole.entries()].filter(([, row]) => row.count > 0);
  for (const [key, row] of rows) {
    const r = poolsByRole.get(key)!;
    row.medPitch = median(r.pitches);
    row.medVelocity = median(r.vel);
    row.maxVelocity = Math.max(...r.vel);
    row.medCc11 = median(r.cc11s);
    row.medLoud = median(r.louds);
    row.notesPerSec = Math.round(row.notesPerSec * 10) / 10;
    // pooled factor = MEAN velocity power / pitch weight / cc7 / cc11 (loudness-relevant, not the median composition)
    row.velFactor /= row.count; row.pitchFactor /= row.count; row.cc7Factor /= row.count; row.cc11Factor /= row.count; row.trimFactor /= row.count;
    row.tuttiPct = Math.round(100 * ((row as unknown as { tuttiDoubles?: number }).tuttiDoubles ?? 0) / Math.max(1, row.count));
  }
  rows.sort((a, b) => b[1].medLoud - a[1].medLoud);
  const horn = rowsByRole.get("horns::brass");
  const hornReference = horn?.medLoud ?? 0;
  console.log("rank  role          family      medLoud    vsHorn   medV  maxV  medCC11  cc7(exp)  medPitch  reg L/M/H        n/s   guests  tutti%");
  rows.forEach(([key, row], index) => {
    const params = familyParameters(row.family);
    console.log(`${String(index + 1).padStart(4)}  ${row.role.padEnd(12)} ${row.family.padEnd(10)} ${row.medLoud.toFixed(5)}  ${
      hornReference ? `${(100 * row.medLoud / hornReference).toFixed(0)}%`.padStart(6) : "  n/a "}  ${String(row.medVelocity).padStart(4)} ${String(row.maxVelocity).padStart(5)}  ${String(row.medCc11).padStart(6)}  ${String(row.cc7Export).padStart(8)}  ${String(row.medPitch).padStart(8)}  ${
      `${row.regLow}/${row.regMid}/${row.regHigh}`.padStart(12)}  ${String(row.notesPerSec).padStart(5)}  ${String(row.guests).padStart(6)}  ${String(row.tuttiPct).padStart(6)}%  [${params.osc} f${params.filter}]`);
  });
  if (hornReference) {
    console.log(`\n-- B1 targets (horn reference median ${hornReference.toFixed(5)}, roles >15% above) --`);
    for (const [, row] of rows) {
      const share = row.medLoud / hornReference;
      if (row.family === "brass" && share > 1.15 && row.role !== "horns") {
        console.log(`  ${row.role}: ${(100 * share).toFixed(0)}% of horn (+${(100 * (share - 1)).toFixed(0)}%) — suggested preview trim factor ×${(1.05 / share).toFixed(3)} (centers the result at 105% of horn)`);
      }
    }
  }
  console.log("\n-- Decomposition (median-per-note factor ratios vs horns; density/doubling separate) --");
  if (horn) for (const [, row] of rows) {
    if (row.family !== "brass" || row.role === "horns") continue;
    const vel = (row.velFactor / horn.velFactor);
    const pitch = row.pitchFactor / horn.pitchFactor;
    const cc7 = row.cc7Factor / horn.cc7Factor;
    const cc11 = row.cc11Factor / horn.cc11Factor;
    const loud = row.medLoud / hornReference;
    console.log(`  ${row.role.padEnd(12)} loud ${loud.toFixed(2)}× = vel ${vel.toFixed(2)} × pitch ${pitch.toFixed(2)} × cc7 ${cc7.toFixed(2)} × cc11 ${cc11.toFixed(2)} × trim ${row.trimFactor.toFixed(2)} | density ${row.notesPerSec}/s vs ${horn.notesPerSec}/s | guest share ${(100 * row.guests / row.count).toFixed(0)}% vs ${(100 * horn.guests / horn.count).toFixed(0)}%`);
  }
}
// console.log("\n-- Cleanup only (no noise, pure data) --")
