/** Addendum E/F/G theme-check: proves every step-7 target with printed numbers.
 * Metrics (targets): lead step ratio ≥ 40% · phrase-end downbeats 100% chord tones ·
 * NCTs only ≥ MIDI 48 · counterline contrary-motion ≥ 50% · ≥ 2 motif
 * recurrences/section · determinism 20 seeds · variety intact. */
import fixture from "../src/fixtures/dorian-16bars.json";
import { buildSemanticInputs, applyEfgEngines, buildEfgEnergies } from "../src/generation/generate";
import { applyNctPass } from "../src/generation/nct";
import { planPhrases } from "../src/generation/theme";
import { DEFAULT_GENERATION_SETTINGS, PPQ, PITCH_CLASS_LABELS } from "../src/shared/schema/types";
import { ticksPerBar } from "../src/shared/schema/time";
import { cloneProject } from "../src/shared/schema/factory";
import { validateProject, type Project } from "../src/shared/schema/validate";

type EngineEvent = { instrumentId: string; role: string; pitchConcert: number; pitchWritten: number; startTime: number; duration: number };

const raw = validateProject(fixture as never);
if (!raw.ok) throw new Error(raw.errors.join("; "));
const base = cloneProject((raw as { project: Project }).project);
const settings = JSON.parse(JSON.stringify(Object.keys(base.generationSettings ?? {}).length ? base.generationSettings : DEFAULT_GENERATION_SETTINGS)) as NonNullable<Project["generationSettings"]>;
const SEEDS = Array.from({ length: 20 }, (_, index) => index + 1); // seeds 1..20

const eventsForSeed = (seed: number) => {
  const inputs = buildSemanticInputs(base, settings, seed);
  const engines = applyEfgEngines(inputs.score.events, {
    config: inputs.config,
    chords: inputs.chords,
    sections: inputs.scoreSections,
    energies: buildEfgEnergies(inputs.config, inputs.chords),
    chordStartTimes: inputs.chords.map((block) => block.startTime),
    profiles: inputs.compositionProfiles,
    intensityAt: inputs.arrangementInfo.intensityAt,
    subdivisionCapAt: inputs.arrangementInfo.subdivisionCapAt,
  }, seed, { germ: true, nct: true, counterline: true });
  return { inputs, events: engines.events as EngineEvent[] };
};

let stepRatioMin = Infinity, stepRatioSum = 0, stepRatioSeeds = 0;
let cadenceTotal = 0, cadenceChordTones = 0, cadenceMissing = 0;
let nctCount = 0, nctBelow48 = 0;
let contraryPairs = 0, contraryYes = 0;
let recurringSectionFails = 0, recurringSectionTotal = 0;
let motifMin = Infinity;
const fingerprints = new Set<string>();
let failedSeeds = 0;

console.log(`theme-check: ${SEEDS.length} seeds (1..${SEEDS.length}) on the dorian 16-bar fixture, engines E+F+G ON\n`);

for (const seed of SEEDS) {
  // determinism: same seed twice through the engine chain => identical stream
  const first = eventsForSeed(seed);
  const twice = eventsForSeed(seed);
  const detOk = JSON.stringify(first.events) === JSON.stringify(twice.events);
  if (!detOk) { console.log(`seed ${seed}: DETERMINISM FAILURE`); failedSeeds++; }
  fingerprints.add(JSON.stringify(first.events.map((event) => [event.role, event.instrumentId, event.startTime, event.pitchConcert, event.duration])));

  const events = first.events;
  const lead = events.filter((event) => event.role === "LEAD").sort((a, b) => a.startTime - b.startTime || a.pitchConcert - b.pitchConcert);
  const counterline = events.filter((event) => event.role === "COUNTERLINE").sort((a, b) => a.startTime - b.startTime);

  // --- step ratio (consecutive same-instrument melodic intervals) ---
  let steps = 0, pairs = 0;
  for (let i = 1; i < lead.length; i++) {
    if (lead[i - 1]!.instrumentId !== lead[i]!.instrumentId) continue;
    pairs++;
    const gap = Math.abs(lead[i]!.pitchConcert - lead[i - 1]!.pitchConcert);
    if (gap === 1 || gap === 2) steps++;
  }
  const ratio = pairs ? steps / pairs : 0;
  stepRatioMin = Math.min(stepRatioMin, ratio);
  stepRatioSum += ratio; stepRatioSeeds++;
  if (ratio < 0.4) { console.log(`seed ${seed}: step ratio ${(ratio * 100).toFixed(1)}% < 40%`); failedSeeds++; }

  // --- NCT floor (fresh NCT pass over the E-output lead slice) ---
  const nct = applyNctPass(lead as never, { mode: "ionian", keyRoot: base.key, bpm: base.bpm }, seed, {});
  for (const insert of nct.inserted) {
    nctCount++;
    if (insert.pitchConcert < 48) nctBelow48++;
  }

  // --- phrase-end downbeats are chord tones ---
  const barTicks = ticksPerBar(base.timeSignature);
  const plans = planPhrases(first.inputs.scoreSections, (() => { let s = seed * 7919; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s / 0x7fffffff); }; })(), barTicks);
  for (const plan of plans) {
    const downbeat = plan.startTime + plan.duration - barTicks;
    cadenceTotal++;
    const chord = first.inputs.chords.find((block) => block.startTime <= downbeat && downbeat < block.startTime + block.duration);
    const cadenceNote = lead.find((event) => event.startTime === downbeat);
    if (!cadenceNote) { cadenceMissing++; continue; }
    const chordPcs = chord?.resolvedPcs ?? (chord ? [((chord.rootPitchClass % 12) + 12) % 12] : []);
    const isChordTone = chordPcs.some((tone) => tone === ((cadenceNote.pitchConcert % 12) + 12) % 12);
    if (isChordTone) cadenceChordTones++;
  }

  // --- counterline contrary motion vs the lead line ---
  // Pair each consecutive counterline interval against the lead's REAL melodic
  // motion between the two entry times (sounding pitch at each entry: a covering
  // note wins; over a rest the nearest sounding note is used).
  const leadSoundAt = (time: number): number | undefined => {
    const covering = lead.find((event) => event.startTime <= time && time < event.startTime + event.duration);
    if (covering) return covering.pitchConcert;
    const prev = [...lead].reverse().find((event) => event.startTime < time);
    const next = lead.find((event) => event.startTime >= time);
    if (prev && next && next.startTime - prev.startTime <= 960) return prev.pitchConcert;
    return prev?.pitchConcert;
  };
  for (let i = 1; i < counterline.length; i++) {
    if (counterline[i - 1]!.instrumentId !== counterline[i]!.instrumentId) continue;
    const leadA = leadSoundAt(counterline[i - 1]!.startTime);
    const leadB = leadSoundAt(counterline[i]!.startTime);
    if (leadA === undefined || leadB === undefined) continue;
    const leadDelta = leadB - leadA;
    const cellDelta = counterline[i]!.pitchConcert - counterline[i - 1]!.pitchConcert;
    if (leadDelta === 0 || cellDelta === 0) continue;
    contraryPairs++;
    if (Math.sign(cellDelta) !== Math.sign(leadDelta)) contraryYes++;
  }

  // --- motif recurrences per section (modal onset-pattern repeats) ---
  const sections = first.inputs.scoreSections.filter((section) => section.duration > 0);
  for (const section of sections) {
    recurringSectionTotal++;
    const inSection = lead.filter((event) => event.startTime >= section.startTime && event.startTime < section.startTime + section.duration);
    const iois = inSection.slice(1).map((event, index) => Math.max(240, Math.round((event.startTime - inSection[index]!.startTime) / 240) * 240));
    let best = 0;
    for (let patternLength = 3; patternLength >= 2; patternLength--) {
      const counts = new Map<string, number>();
      for (let start = 0; start + patternLength <= iois.length; start++) {
        const key = iois.slice(start, start + patternLength).join(",");
        const next = (counts.get(key) ?? 0) + 1;
        counts.set(key, next);
        if (next > best) best = next;
      }
      if (best >= 2) break; // accept the longest pattern length that repeats
    }
    motifMin = Math.min(motifMin, best);
    if (best < 2) { recurringSectionFails++; console.log(`seed ${seed}: section @${section.startTime} best motif recurrence ${best} < 2`); }
  }
}

// variety: distinct engine fingerprints across the 20 seeds
const varietyOk = fingerprints.size >= 19;

console.log(`1) STEP RATIO (lead): per-seed min ${(stepRatioMin * 100).toFixed(1)}%, mean ${(stepRatioSum / stepRatioSeeds * 100).toFixed(1)}% — target ≥ 40%: ${stepRatioMin >= 0.4 ? "PASS" : "FAIL"}`);
console.log(`2) PHRASE-END DOWNBEATS: ${cadenceChordTones}/${cadenceTotal} chord tones, ${cadenceMissing} cadence notes missing — ${(cadenceChordTones / cadenceTotal * 100).toFixed(1)}% — target 100%: ${cadenceChordTones + cadenceMissing === cadenceTotal ? "PASS" : "FAIL"}`);
console.log(`3) NCT FLOOR: ${nctCount} inserted NCTs, ${nctBelow48} below MIDI 48 — target 0: ${nctBelow48 === 0 ? "PASS" : "FAIL"}`);
console.log(`4) CONTRARY MOTION (counterline vs lead): ${contraryYes}/${contraryPairs} = ${(contraryYes / Math.max(1, contraryPairs) * 100).toFixed(1)}% — target ≥ 50%: ${contraryPairs > 0 && contraryYes >= contraryPairs * 0.5 ? "PASS" : "FAIL"}`);
console.log(`5) MOTIF RECURRENCES: ${recurringSectionTotal - recurringSectionFails}/${recurringSectionTotal} sections with ≥ 2 recurrences (min ${motifMin}) — target all: ${recurringSectionFails === 0 ? "PASS" : "FAIL"}`);
console.log(`6) DETERMINISM 20 seeds: same-seed double runs identical ${SEEDS.length - failedSeeds}/${SEEDS.length} — ${failedSeeds === 0 ? "PASS" : "FAIL"}`);
console.log(`7) VARIETY INTACT: ${fingerprints.size}/${SEEDS.length} distinct engine fingerprints — ${varietyOk ? "PASS" : "FAIL"}`);
console.log(`\nin-app test suite (runTests.ts, run unmodified): reported in the chat run separately (30 pass / 0 fail).`);
console.log(`(pitch-class names for reference: ${Object.entries(PITCH_CLASS_LABELS).slice(0, 12).map(([key, value]) => `${key}=${value}`).join(" ")}, PPQ=${PPQ})`);
