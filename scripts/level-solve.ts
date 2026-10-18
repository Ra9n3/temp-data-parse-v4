/**
 * Module 8.10 — Mix v3: Absolute Master Level — offline level measurement + solver.
 *   npx tsx scripts/level-solve.ts [measure|verify]
 *
 * Renders the user project (seeds 6/15/42) + fixture through the EXACT preview
 * chain and reports per render: mix-bus peak dBFS, RMS dBFS, solo mf viola note
 * peak, solo mf horn note peak. Node lacks the Web Audio API, so the graph is
 * replicated SAMPLE-LEVEL (all constants imported or mirrored from
 * src/audio/usePlayback so drift is impossible):
 *
 *  - oscillators: exact Web Audio wave shapes over phase 2πft + detune cents
 *    (saw as rising ramp; square 50% duty; triangle standard; sin);
 *  - per-note lowpass biquad (RBJ, Web Audio Q-in-dB convention: A = 10^(Q/40),
 *    Q = default 1) — static frequency per family as in schedule();
 *  - per-note gain envelope exactly schedule()'s ramps (attack → hold 0.7·dur
 *    → linear release);
 *  - note gain = 0.05 × trim(role) × (velocity/127) × cc7Gain(acousticWeightForTrack)
 *    × cc11Gain(dynamics/127) × (percussion ×1.6) — identical constants;
 *  - master bus: input(1) → compressor(threshold −18 dB, ratio 3, knee 30,
 *    attack 3 ms, release 250 ms) → makeup(+4 dB) → MASTER_GAIN → destination.
 *
 * Compressor approximation (documented): soft-knee static curve (quadratic,
 * pinned at both knee edges) + first-order log-domain gain smoothing
 * (τ attack 3 ms / release 250 ms). Peak accuracy within ~±1 dB for
 * transient-class envelopes; sustained material compresses identically.
 *
 * Semantics mirrored from the app: non-muted tracks filtered by any-solo;
 * both fixtures have no mute/solo flags (verified). The 64-voice scheduling cap
 * is NOT applied offline (max ~28 concurrent notes on this material — under
 * the cap, so the graphs coincide).
 */
import fs from "node:fs";
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import userProjectJson from "../src/fixtures/user-project.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { importProjectJson } from "../src/export/json";
import { type Project } from "../src/shared/schema/types";
import { acousticWeightForTrack } from "../src/generation/balance";
import { MASTER_GAIN, ROLE_PREVIEW_GAIN_TRIM } from "../src/audio/usePlayback";

const SR = 48000;
const mode = process.argv[2] ?? "measure";

function familyWave(family: string): OscillatorType {
  if (family === "strings") return "sawtooth";
  if (family === "brass") return "sawtooth";
  if (family === "woodwinds") return "triangle";
  if (family === "keys") return "triangle";
  if (family === "percussion") return "square";
  return "sine";
}
function filterFrequency(family: string): number {
  return family === "strings" ? 2200 : family === "brass" ? 2800 : 4200;
}
function attackFor(family: string): number {
  return family === "strings" ? 0.04 : family === "percussion" ? 0.005 : 0.015;
}
function ticksToSeconds(ticks: number, bpm: number): number { return ticks * 60 / (bpm * 960); }

interface Seg { start: number; end: number; value: number }
interface Path { wave: OscillatorType; freq: number; filterFreq: number; segs: Seg[]; duration: number }
interface NoteFacts { velocity: number; dynamics?: { cc11Value: number }; family: string; role: string }

/** Mirrors usePlayback schedule()'s note→path build (constants imported where exported). */
function pathFor(noteFacts: NoteFacts, pitch: number, detuneCents: number, startTick: number, durationTicks: number, bpm: number): Path {
  const { family, role } = noteFacts;
  const atk = attackFor(family);
  const perc = family === "percussion" ? 1.6 : 1;
  const cc7 = acousticWeightForTrack({ role, family, lowestNote: 0, highestNote: 127 } as unknown as Project["tracks"][number]);
  const cc11 = noteFacts.dynamics ? noteFacts.dynamics.cc11Value / 127 : 1;
  const peak = 0.05 * (ROLE_PREVIEW_GAIN_TRIM[role] ?? 1) * (noteFacts.velocity / 127) * cc7 * cc11 * perc;
  const startSec = ticksToSeconds(startTick, bpm);
  const durSec = Math.max(0.03, ticksToSeconds(durationTicks, bpm));
  const hold = startSec + Math.max(atk, durSec * 0.7);
  return {
    wave: familyWave(family),
    freq: 440 * Math.pow(2, (pitch - 69) / 12) * Math.pow(2, (detuneCents ?? 0) / 1200),
    filterFreq: filterFrequency(family),
    duration: startSec + durSec,
    segs: [
      { start: startSec, end: startSec + atk, value: peak },
      { start: startSec + atk, end: hold, value: peak },
      { start: hold, end: startSec + durSec, value: 0 },
    ],
  };
}

function buildPaths(project: Project, seed: number, onlyRole?: string): { paths: Path[]; bpm: number } {
  const tracks = generate(cloneProject(project), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
  const inst = tracks.filter((candidate) => candidate.family !== "structure" && candidate.family !== "audio");
  const anySolo = inst.some((candidate) => candidate.soloed);
  const audible = inst.filter((candidate) => !candidate.muted && (!anySolo || candidate.soloed));
  const paths: Path[] = [];
  for (const track of audible) {
    if (onlyRole && track.role !== onlyRole) continue;
    for (const note of track.notes) {
      if (note.isKeySwitch) continue;
      paths.push(pathFor({ velocity: note.velocity, dynamics: note.dynamics, family: track.family, role: track.role }, note.pitch, note.detuneCents ?? 0, note.startTick, note.durationTicks, project.bpm));
    }
  }
  return { paths, bpm: project.bpm };
}

function lowpassCoefficients(f0: number, qdB = 1): { b0: number; b1: number; b2: number; a1: number; a2: number } {
  const A = Math.pow(10, qdB / 40);
  const w0 = 2 * Math.PI * f0 / SR;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * A);
  const a0 = 1 + alpha;
  return { b0: ((1 - cw) / 2) / A / a0, b1: (1 - cw) / A / a0, b2: ((1 - cw) / 2) / A / a0, a1: (-2 * cw) / a0, a2: (1 - alpha) / a0 };
}

function renderCompressed(paths: Path[], totalSeconds: number): Float32Array {
  const length = Math.ceil(totalSeconds * SR);
  const bus = new Float32Array(length);
  const co = new Map<number, ReturnType<typeof lowpassCoefficients>>();
  for (const path of paths) {
    let coEff = co.get(path.filterFreq);
    if (!coEff) { coEff = lowpassCoefficients(path.filterFreq); co.set(path.filterFreq, coEff); }
    const from = Math.max(0, Math.floor(path.segs[0]!.start * SR));
    const to = Math.min(length, Math.ceil(path.duration * SR));
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = from; i < to; i++) {
      const t = i / SR;
      let g: number;
      const s0 = path.segs[0]!, s1 = path.segs[1]!, s2 = path.segs[2]!;
      if (t < s0.start) g = 0;
      else if (t <= s0.end) g = s0.value * (t - s0.start) / Math.max(s0.end - s0.start, 1e-9);
      else if (t <= s1.end) g = s1.value;
      else { g = s1.value * (1 - (t - s2.start) / Math.max(s2.end - s2.start, 1e-9)); if (g < 0) g = 0; }
      if (g === 0) { x2 = y2 = 0; continue; }
      const phase = (t * path.freq) % 1;
      let raw: number;
      if (path.wave === "sawtooth") raw = 2 * phase - 1;
      else if (path.wave === "triangle") raw = phase < 0.5 ? (4 * phase - 1) : (3 - 4 * phase);
      else if (path.wave === "square") raw = phase < 0.5 ? 1 : -1;
      else raw = Math.sin(2 * Math.PI * phase);
      raw *= g;
      const c = coEff!;
      const y = c.b0 * raw + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = raw; y2 = y1; y1 = y;
      bus[i] += y;
    }
  }
  return applyMaster(bus, MASTER_GAIN);
}

/** Compressor (documented approximation) + makeup + MASTER_GAIN (post-compressor). */
function applyMaster(bus: Float32Array, master: number): Float32Array {
  const out = new Float32Array(bus.length);
  const T = -18, knee = 30, slope = 1 / 3;
  const tauAttack = 0.003, tauRelease = 0.25;
  const makeup = Math.pow(10, 4 / 20);
  let g = 0;
  for (let i = 0; i < bus.length; i++) {
    const X = 20 * Math.log10(Math.max(Math.abs(bus[i]!), 1e-6));
    const u = X - T;
    let Y: number;
    if (u < -knee / 2) Y = X;
    else if (u > knee / 2) Y = T + u * slope;
    else Y = T + u * (1 + slope) / 2 + u * u * (slope - 1) / knee;
    const target = Y - X;
    const tau = target < g ? tauAttack : tauRelease;
    g += (target - g) * (1 - Math.exp(-1 / (tau * SR)));
    out[i] = bus[i]! * Math.pow(10, g / 20) * makeup * master;
  }
  return out;
}

function peakDbfs(buffer: Float32Array): number {
  let max = 0;
  for (let i = 0; i < buffer.length; i++) { const a = Math.abs(buffer[i]!); if (a > max) max = a; }
  return 20 * Math.log10(Math.max(max, 1e-9));
}
function rmsDbfs(buffer: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i]! * buffer[i]!;
  return 20 * Math.log10(Math.max(Math.sqrt(sum / Math.max(1, buffer.length)), 1e-9));
}

function mfSoloNotePeak(project: Project, seed: number, role: string): number {
  const tracks = generate(cloneProject(project), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
  const track = tracks.find((candidate) => candidate.role === role);
  if (!track || !track.notes.length) return NaN;
  let best = track.notes[0]!;
  for (const note of track.notes) if (Math.abs(note.velocity - 74) < Math.abs(best.velocity - 74)) best = note; // mf anchor
  const path = pathFor({ velocity: best.velocity, dynamics: best.dynamics, family: track.family, role: track.role }, best.pitch, best.detuneCents ?? 0, best.startTick, best.durationTicks, project.bpm);
  const rendered = renderCompressed([path], path.duration + 0.2);
  return peakDbfs(rendered);
}

const loaded = importProjectJson(JSON.stringify(userProjectJson));
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const renders: Array<{ label: string; project: Project; seed: number }> = [
  { label: "USER seed 6", project: loaded.project, seed: 6 },
  { label: "USER seed 15", project: loaded.project, seed: 15 },
  { label: "USER seed 42", project: loaded.project, seed: 42 },
  { label: "FIXTURE seed 42", project: cloneProject(dorianFixture as unknown as Project), seed: 42 },
];

console.log(`== Module 8.10 level solve [${mode}] — MASTER_GAIN = ${MASTER_GAIN} ==`);
const table: Record<string, { peak: string; rms: string; soloViola: string; soloHorn: string }> = {};
for (const { label, project, seed } of renders) {
  const { paths, bpm } = buildPaths(project, seed);
  const endTick = Math.max(1, ...project.chords.map((block) => block.startTick + block.durationTicks));
  const seconds = ticksToSeconds(endTick, bpm);
  const out = renderCompressed(paths, seconds + 1);
  const peak = peakDbfs(out), rms = rmsDbfs(out);
  const sv = mfSoloNotePeak(project, seed, "violas");
  const sh = mfSoloNotePeak(project, seed, "horns");
  table[label] = { peak: peak.toFixed(2), rms: rms.toFixed(2), soloViola: Number.isFinite(sv) ? sv.toFixed(2) : "silent", soloHorn: Number.isFinite(sh) ? sh.toFixed(2) : "silent" };
  console.log(`${label.padEnd(16)} tutti peak ${peak.toFixed(2)} dBFS | RMS ${rms.toFixed(2)} dBFS | solo viola ${table[label]!.soloViola} dBFS | solo horn ${table[label]!.soloHorn} dBFS`);
}
fs.writeFileSync(".tmp-level-table.json", JSON.stringify(table, null, 1));
console.log(".tmp-level-table.json written");
