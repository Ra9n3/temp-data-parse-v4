/**
 * Module 8.7 Phase A diagnostics — run BEFORE fixes:
 *   npx tsx scripts/module87-diag.ts [user|fixture|both]
 * USER project (fixtures/user-project.json) is the PRIMARY input; the dorian
 * fixture is the secondary sanity check (task order).
 * A1: occupancy — per track maxSim, overlap geometry (sameStart/contains/partial),
 *     provenance (own/pad/doubling-guest/other).
 * A2: consolidation/scatter interaction — per section pad carriers, instruments
 *     receiving pad-completion notes, and whether consolidation merged spans
 *     UNDER those notes (completion window inside a same-instrument consolidated span).
 * A3: guard audit — geometry enumeration + fail-closed check + final ordering.
 * A4: volume audit — per-track CC7, CC11 floor at dd/pp/mf/ff, preview gain chain.
 */
import fs from "node:fs";
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import { importProjectJson } from "../src/export/json";
import { generate, buildSemanticInputs, applyEfgEngines, buildEfgEnergies } from "../src/generation/generate";
import { planRotation, resolveRotationConfig, exposedBreakdownRoles } from "../src/generation/rotation";
import { cloneProject } from "../src/shared/schema/factory";
import { validateProject, type Project } from "../src/shared/schema/validate";
import { consolidateSustains } from "../src/generation/sustain";
import { applyMonophonyGuard, maxSimultaneousFor, guardTrackNotes } from "../src/generation/monophony";
import { DEFAULT_GENERATION_SETTINGS } from "../src/shared/schema/types";
import { acousticWeightForRole, cc7ForWeight, curveFor, applyCurve, DEFAULT_BALANCE_CONFIG } from "../src/generation/balance";

const which = process.argv[2] ?? "both";

function load(): Array<[string, Project]> {
  const projects: Array<[string, Project]> = [];
  if (which !== "fixture") {
    const result = importProjectJson(fs.readFileSync("fixtures/user-project.json", "utf-8"));
    if (!result.ok) { console.error("VALIDATION FAILED:", result.errors.join("; ")); process.exit(1); }
    projects.push(["USER", result.project]);
  }
  if (which !== "user") {
    const fixture = validateProject(dorianFixture as never);
    if (!fixture.ok) throw new Error(fixture.errors.join("; "));
    projects.push(["FIXTURE", cloneProject((fixture as { project: Project }).project)]);
  }
  return projects;
}

const WINDS = new Set(["flutes", "oboes", "clarinets", "bassoons", "piccolo", "englishHorn", "bassClarinet"]);
const BRASS = new Set(["trumpets", "trombones", "horns", "tuba", "bassTrombone"]);
const STRINGS = new Set(["violins1", "violins2", "violas", "cellos", "doubleBass"]);

function maxSim(notes: { startTick: number; durationTicks: number }[]): number {
  let max = 0;
  for (const n of notes) {
    const over = notes.filter((m) => m !== n && n.startTick < m.startTick + m.durationTicks && m.startTick < n.startTick + n.durationTicks).length;
    max = Math.max(max, over);
  }
  return max;
}
function fmt(p: { own: number; pad: number; guest: number; other: number }) { return `${p.own}/${p.pad}/${p.guest}/${p.other}`; }

function geometryCounts(notes: { startTick: number; durationTicks: number }[]) {
  let sameStart = 0, contains = 0, partial = 0;
  for (let i = 0; i < notes.length; i++) for (let j = i + 1; j < notes.length; j++) {
    const a = notes[i]!, b = notes[j]!;
    const overlap = a.startTick < b.startTick + b.durationTicks && b.startTick < a.startTick + a.durationTicks;
    if (!overlap) continue;
    if (a.startTick === b.startTick) { sameStart++; continue; }
    const inside = b.startTick <= a.startTick && a.startTick + a.durationTicks <= b.startTick + b.durationTicks
      || a.startTick <= b.startTick && b.startTick + b.durationTicks <= a.startTick + a.durationTicks;
    if (inside) contains++; else partial++;
  }
  return { sameStart, contains, partial };
}

// ===================== Phase A =====================
for (const [label, project] of load()) {
  console.log(`\n########## ${label} project ##########`);
  const sections = [...project.sections].sort((a, b) => a.startBar - b.startBar);
  const barTicks = project.timeSignature.denominator ? (960 * 4 * project.timeSignature.numerator) / project.timeSignature.denominator : 3840;
  const barOf = (tick: number) => Math.floor(tick / barTicks);
  const sectionAt = (tick: number) => [...sections].reverse().find((s) => barOf(tick) >= (s.startBar - 1))?.name ?? "?";

  for (const seed of [6, 15, 42]) {
    console.log(`\n=== seed ${seed} ===`);
    const inputs = buildSemanticInputs(project, DEFAULT_GENERATION_SETTINGS, seed);
    const carriers = new Map<string, { role: string; pitchConcert: number; startTime: number; duration: number; completionsTouching: number }>();
    const padByInst = new Map<string, number>();           // score-stage PAD events per instrument
    const completionByInst = new Map<string, number>();    // scatter assigned-completion proxies
    // stage-6 score events carry the completion scatter (InstrumentRangeFilter).
    const completionMarkers = inputs.score.events.filter((e) => e.role === "PAD");

    const tracks = generate(cloneProject(project), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });

    // ---- A1 ----
    console.log(`-- A1 occupancy --`);
    console.log("track                 maxSim  sameStart contains partial  own/pad/guest/other  maxDur");
    let worstWind = 0, worstBrass = 0, worstString = 0;
    for (const track of tracks) {
      if (track.family === "structure" || track.family === "audio") continue;
      const ms = maxSim(track.notes);
      const g = geometryCounts(track.notes);
      const prov = { own: 0, pad: 0, guest: 0, other: 0 };
      let maxDur = 0;
      for (const n of track.notes) {
        if (n.isDoubling) prov.guest++; else if (n.role === "PAD") prov.pad++; else if (n.role) prov.own++; else prov.other++;
        maxDur = Math.max(maxDur, n.durationTicks);
      }
      if (WINDS.has(track.role)) worstWind = Math.max(worstWind, ms);
      else if (BRASS.has(track.role)) worstBrass = Math.max(worstBrass, ms);
      else if (STRINGS.has(track.role)) worstString = Math.max(worstString, ms);
      console.log(`${track.name.padEnd(21)} ${String(ms).padStart(4)}  ${String(g.sameStart).padStart(9)} ${String(g.contains).padStart(8)} ${String(g.partial).padStart(7)}  ${fmt(prov).padEnd(18)} ${maxDur}`);
    }
    console.log(`scorecard: wind maxSim=${worstWind} (goal 1)  brass maxSim=${worstBrass} (goal 1)  string maxSim=${worstString} (goal ≤2)`);

    // ---- A2 ----
    console.log(`-- A2 consolidation x scatter interaction (stage-6, pre-guard) --`);
    const padPool = new Set(inputs.score.events.filter((e) => e.role === "PAD").map((e) => e.instrumentId));
    const consolidated = consolidateSustains(inputs.score.events).events;
    const merged = consolidateSustains(inputs.score.events).stats;
    console.log(`consolidation: ${merged.before} → ${merged.after} events (merged ${merged.merged})`);
    // Per section: pad carriers (instruments with PAD events), completions per instrument,
    // and the interaction test: completion window inside a same-instrument consolidated multi-beat span.
    const consSpanByInst = new Map<string, Array<{ start: number; end: number; pitch: number }>>();
    // Match consolidated events back to their stage-6 originals by tuple (heads are NEW objects after spread).
    const origByTuple = new Map(inputs.score.events.map((e) => [`${e.instrumentId}|${e.role}|${e.pitchConcert}|${e.startTime}`, e.duration]));
    for (const e of consolidated) {
      const d0 = origByTuple.get(`${e.instrumentId}|${e.role}|${e.pitchConcert}|${e.startTime}`) ?? e.duration;
      if (e.duration > d0 + 1) { // head survived merging with a LONGER span
        (consSpanByInst.get(e.instrumentId) ?? consSpanByInst.set(e.instrumentId, []).get(e.instrumentId)!).push({ start: e.startTime, end: e.startTime + e.duration, pitch: e.pitchConcert });
      }
    }
    const interBySection = new Map<string, { carrier: string; span: [number, number]; completion: string; at: number }[]>();
    for (const inst of [...new Set(inputs.score.events.filter((e) => e.role === "PAD").map((e) => e.instrumentId))]) {
      const spans = consSpanByInst.get(inst) ?? [];
      const completions = completionMarkers.filter((e) => e.instrumentId === inst);
      padByInst.set(inst, completions.length);
      for (const e of completions) {
        for (const span of spans) {
          if (e.pitchConcert === span.pitch) continue; // same-pitch = part of the chain itself
          if (e.startTime < span.end && span.start < e.startTime + e.duration) {
            const key = sectionAt(e.startTime);
            (interBySection.get(key) ?? interBySection.set(key, []).get(key)!).push({ carrier: inst, span: [span.start, span.end], completion: `PAD@${e.startTime}+${e.duration} p${e.pitchConcert}`, at: e.startTime });
          }
        }
      }
    }
    console.log("PAD completion events by instrument (stage-6 scatter):");
    for (const [inst, count] of [...padByInst].sort((a, b) => b[1] - a[1])) console.log(`  ${inst.padEnd(30)} ${count}`);
    console.log("consolidated spans >1 note (interaction candidates) by instrument:");
    for (const [inst, spans] of consSpanByInst) if (spans.length) console.log(`  ${inst.padEnd(30)} ${spans.length} spans`);
    let totalInter = 0;
    for (const [section, list] of interBySection) {
      totalInter += list.length;
      if (list.length <= 4) for (const hit of list) console.log(`  [${section}] completion ${hit.completion} on ${hit.carrier} inside consolidated span [${hit.span[0]},${hit.span[1]})`);
      else { for (const hit of list.slice(0, 3)) console.log(`  [${section}] completion ${hit.completion} on ${hit.carrier} inside consolidated span [${hit.span[0]},${hit.span[1]})`); console.log(`  [${section}] … +${list.length - 3} more`); }
    }
    console.log(`INTERACTION (stage-6 pre-rotation raw): ${totalInter} completion-note-in-consolidated-span overlaps`);
    // ---- A2-after: the REAL internal pipeline — post-rotation, post-consolidation,
    // B1 reconciliation applied — is the decisive invariant measurement.
    const rotationPartial = DEFAULT_GENERATION_SETTINGS.arrangement?.rotation;
    const rotationCfg = resolveRotationConfig(rotationPartial);
    const plan = rotationCfg.enabled ? planRotation(project, rotationPartial, seed) : undefined;
    const efgRotation = plan ? { plan, config: rotationCfg, measures: inputs.arrangementInfo.measures, exposedRoles: exposedBreakdownRoles(inputs.arrangement.breakdownExposedLayer) } : undefined;
    const internal = applyEfgEngines(inputs.score.events, {
      config: inputs.config, chords: inputs.chords, sections: inputs.scoreSections,
      energies: buildEfgEnergies(inputs.config, inputs.chords),
      chordStartTimes: inputs.chords.map((block) => block.startTime),
      profiles: inputs.compositionProfiles,
      intensityAt: inputs.arrangementInfo.intensityAt,
      subdivisionCapAt: inputs.arrangementInfo.subdivisionCapAt,
      rotation: efgRotation,
    }, seed, { germ: true, nct: true, counterline: true }).events;
    const rowByInst = new Map<string, typeof internal>();
    for (const event of internal) {
      if (event.role !== "BASS" && event.role !== "PAD") continue;
      (rowByInst.get(event.instrumentId) ?? rowByInst.set(event.instrumentId, []).get(event.instrumentId)!).push(event);
    }
    let realViolations = 0;
    for (const rows of rowByInst.values()) for (const candidate of rows) {
      if (candidate.role !== "PAD") continue;
      for (const other of rows) {
        if (other === candidate || (other.role !== "BASS" && other.role !== "PAD")) continue;
        if (other.pitchConcert === candidate.pitchConcert || other.duration <= candidate.duration) continue;
        if (candidate.startTime < other.startTime + other.duration && other.startTime < candidate.startTime + candidate.duration) { realViolations++; break; }
      }
    }
    console.log(`INTERACTION (real pipeline post-consolidation, must be 0): ${realViolations}`);
    void carriers; void completionByInst; void padPool; void barOf;
  }

  // ---- A3 guard audit ----
  console.log(`\n-- A3 guard audit --`);
  // Geometry enumeration with synthetic rows (monophonic = max 1):
  const geometries: Array<{ name: string; rows: [number, number][] }> = [
    { name: "same-start", rows: [[0, 100], [0, 100]] },
    { name: "contained (long short short)", rows: [[0, 300], [50, 100]] },
    { name: "partial", rows: [[0, 200], [100, 200]] },
    { name: "3-way pileup", rows: [[0, 300], [100, 300], [200, 300]] },
    { name: "tied triple onset", rows: [[0, 50], [0, 50], [0, 50]] },
    { name: "nested long under pile", rows: [[0, 1000], [10, 500], [20, 500], [30, 500]] },
  ];
  for (const g of geometries) {
    const rows = g.rows.map(([s, d]) => ({ startTick: s, durationTicks: d }));
    const res = applyMonophonyGuard(rows, 1);
    const final = maxSim(res.notes);
    console.log(`  geometry ${g.name.padEnd(34)} dropped=${res.dropped} truncated=${res.truncated} final maxSim=${final} ${final <= 1 && res.dropped + res.truncated >= 1 ? "OK" : "FAIL"}`);
  }
  // Fail-closed check for the family resolver itself:
  console.log(`  maxSimultaneousFor(woodwinds)=${maxSimultaneousFor("woodwinds")} (1), (unknown/undefined)=${maxSimultaneousFor(undefined)} (goal 1 fail-closed), (keys)=${maxSimultaneousFor("keys")}`);
  console.log(`  guardTrackNotes on unknown-role track: ${JSON.stringify((() => { const r = guardTrackNotes("t", "quuxrole", [{ startTick: 0, durationTicks: 100 }, { startTick: 50, durationTicks: 100 }]); return { dropped: r.dropped, truncated: r.truncated, maxSim: maxSim(r.notes) }; })())} (goal: resolved, final maxSim 1 ⇒ fail-closed)`);
  console.log(`  ordering: guard runs in the FINAL return map of generate() — nothing after it except track mapping (code audit).`);

  // ---- A4 ----
  console.log(`\n-- A4 volume audit --`);
  console.log("Current cc7ForWeight (0.4 + 0.6*(w/1.2), band [30,115]) and CC11 floor:",
    DEFAULT_BALANCE_CONFIG.cc11Floor);
  const roles = ["trumpets", "trombones", "tuba", "horns", "oboes", "clarinets", "bassoons", "flutes", "violins1", "violas", "cellos", "doubleBass", "piano", "harp"];
  console.log("role          weight  cc7   band");
  for (const role of roles) {
    const w = acousticWeightForRole(role);
    console.log(`${role.padEnd(13)} ${String(w).padStart(6)}  ${String(cc7ForWeight(w)).padStart(3)}  [${Math.round(127 * 0.4)},115]`);
  }
  console.log("CC11 at dd/pp/mf/ff (curve & floor):");
  for (const dyn of [0.05, 0.2, 0.5, 0.85]) {
    for (const role of ["violins1", "flutes", "trumpets", "piano"]) {
      const curve = curveFor(role === "piano" ? "keys" : role === "trumpets" ? "brass" : role === "flutes" ? "woodwinds" : "strings", role === "trumpets" ? "COUNTERLINE" : "LEAD");
      const cc = Math.max(DEFAULT_BALANCE_CONFIG.cc11Floor, Math.round(127 * applyCurve(curve, dyn)));
      console.log(`  dyn ${dyn}: ${role.padEnd(10)} curve=${curve} cc11=${cc}`);
    }
  }
  console.log(`Preview chain: osc(type by family) -> velocity*n.cc7Gain(acousticWeightForTrack) * n.cc11Gain(dynamics.cc11Value/127) * 0.035 -> destination (NO master bus, NO compressor).`);
}
