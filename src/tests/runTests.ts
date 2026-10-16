import dorianFixture from "../fixtures/dorian-16bars.json";
import { Midi } from "@tonejs/midi";
import { parseChord } from "../shared/schema/chords";
import { cloneProject, createDefaultProject, nextMidiChannel } from "../shared/schema/factory";
import { type ModeName, type Project, type TimeSignature } from "../shared/schema/types";
import { msToTicks, projectEndTick, ticksPerBar, ticksPerBeat } from "../shared/schema/time";
import { validateProject } from "../shared/schema/validate";
import { exportMergedMidi, exportPerTrackMidi, midiDurationTicks, parseMidiNotes } from "../export/midi";
import { validateDoubleStop } from "../generation/strings";
import { exportProjectJson, importProjectJson, projectsEqual } from "../export/json";
import {
  applyEfgEngines,
  buildEfgEnergies,
  buildSemanticInputs,
  DynamicMappingEngine,
  generate,
  generateOrchestralScore,
  HarmonicParser,
  InstrumentRangeFilter,
  OvertoneSpacingFilter,
  TextureRoleAllocator,
  VoiceLeadingOptimizer,
  type ChordBlock,
  type GenerateOptions,
  type ProjectConfig,
  type StructureSection,
} from "../generation/generate";
import {
  applyRegisterDynamicModifiers,
  InstrumentProfileLoader,
  isWithinPracticalRange,
  TranspositionAdapter,
  INSTRUMENT_DATABASE,
} from "../generation/instrumentDB";
import type { OrchestralRole } from "../generation/instrumentDB";
import { ORCHESTRAL_STYLE_WEIGHTS } from "../generation/config";
import type { OrchestralStyle } from "../shared/schema/types";
import { DEFAULT_GENERATION_SETTINGS } from "../shared/schema/types";
import { applyNctPass } from "../generation/nct";
import { realizeRhythm } from "../generation/rhythm";
import { guardTrackNotes, verifyMonophonyInvariant } from "../generation/monophony";
import { exposedBreakdownRoles, planRotation, resolveRotationConfig } from "../generation/rotation";
import { consolidateSustains } from "../generation/sustain";
import { cc7ForWeight, acousticWeightForTrack, DEFAULT_BALANCE_CONFIG } from "../generation/balance";
import { builtInProfileById, vst3EventAdapter } from "../plugins/expressionMaps";
import { buildEngineStream, resolveInstanceRouting } from "../engine/engineStream";
import { mergeScanProbe, type ScannedPlugin } from "../engine/engineClient";
import userProjectJson from "../fixtures/user-project.json";
import { mulberry32 } from "../generation/prng";
import { snapshotDigest } from "../generation/efgGolden";
import goldenDigests from "../fixtures/efg-legacy-golden-digest.json";
import type { AbstractNoteEvent, SemanticRole } from "../generation/generate";

export interface TestResult { name: string; pass: boolean; detail: string; ms: number }
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function timed(name: string, test: () => string | void): TestResult {
  const start = performance.now();
  try { return { name, pass: true, detail: test() ?? "ok", ms: performance.now() - start }; }
  catch (error) { return { name, pass: false, detail: error instanceof Error ? error.message : String(error), ms: performance.now() - start }; }
}
function fixture(): Project {
  const result = validateProject(dorianFixture);
  assert(result.ok, result.errors.join("; "));
  return cloneProject(result.project);
}

const config: ProjectConfig = { keyRoot: 0, scaleMode: "Major", baseBpm: 100, timeSignature: [4, 4], presetStyle: "Symphonic" };
const progression: ChordBlock[] = [
  { startTime: 0, duration: 3840, rootPitchClass: 0, quality: "Maj", extensions: [] },
  { startTime: 3840, duration: 3840, rootPitchClass: 9, quality: "Min", extensions: [] },
  { startTime: 7680, duration: 3840, rootPitchClass: 5, quality: "Maj", extensions: [] },
  { startTime: 11520, duration: 3840, rootPitchClass: 7, quality: "Maj", extensions: ["7"] },
];
const sections: StructureSection[] = [
  { startTime: 0, duration: 15360, type: "Verse", targetDynamic: 0.55, densityLevel: "Balanced" },
];

export function runUnitTests(): TestResult[] {
  return [
    timed("E/F/G defaults are ON in createDefaultProject", () => {
      const project = createDefaultProject();
      assert(project.generationSettings?.themes?.germ === true && project.generationSettings?.themes?.nct === true && project.generationSettings?.themes?.counterline === true, "theme engine defaults must be ON");
      return "createDefaultProject themes: germ/NCT/counterline all ON";
    }),
    timed("NCT neighbor tones are single steps (±1–2 semitones), never octave jumps", () => {
      const mk = (pitch: number, start: number): AbstractNoteEvent => ({ instrumentId: "trk_flutes", pitchConcert: pitch, pitchWritten: pitch, startTime: start, duration: 960, normalizedDynamic: 0.7, semanticArticulation: "LEGATO", role: "LEAD" });
      const build = () => [60, 64, 67, 71, 74, 77, 81, 84].map((pitch, index) => mk(pitch, index * 960));
      let neighbors = 0;
      for (let seed = 0; seed < 40; seed++) {
        const { inserted } = applyNctPass(build(), { mode: "ionian", keyRoot: 0, bpm: 120 }, 1000 + seed, {});
        for (const nct of inserted) {
          const structural = build().find((note) => nct.startTime >= note.startTime && nct.startTime < note.startTime + note.duration);
          if (nct.kind !== "neighbor") continue;
          neighbors++;
          const delta = structural ? nct.pitchConcert - structural.pitchConcert : nct.pitchConcert - 999;
          assert(Math.abs(delta) === 1 || Math.abs(delta) === 2, `neighbor delta ${delta} semitones — not a single step (seed ${seed})`);
        }
      }
      return `40 seeds × ${(8 - 1)} third intervals: ${neighbors} neighbors, every one ±1–2 semitones`;
    }),
    timed("Passing rate exceeds neighbor rate (spec balance restored)", () => {
      const mk = (pitch: number, start: number): AbstractNoteEvent => ({ instrumentId: "trk_flutes", pitchConcert: pitch, pitchWritten: pitch, startTime: start, duration: 960, normalizedDynamic: 0.7, semanticArticulation: "LEGATO", role: "LEAD" });
      const build = () => [60, 64, 67, 71, 74, 77, 81, 84].map((pitch, index) => mk(pitch, index * 960));
      let passing = 0, neighbors = 0;
      for (let seed = 0; seed < 40; seed++) {
        const { inserted } = applyNctPass(build(), { mode: "ionian", keyRoot: 0, bpm: 120 }, 1000 + seed, {});
        for (const nct of inserted) { if (nct.kind === "passing") passing++; else neighbors++; }
      }
      assert(passing > neighbors, `passing ${passing} ≤ neighbor ${neighbors} — balance lost`);
      return `40 seeds: ${passing} passing > ${neighbors} neighbor insertions (default rates 1.0 / 0.45)`;
    }),
    timed("Zero NCTs below MIDI 48 — including after leap-repair", () => {
      const mk = (pitch: number, start: number, duration: number): AbstractNoteEvent => ({ instrumentId: "trk_flutes", pitchConcert: pitch, pitchWritten: pitch, startTime: start, duration, normalizedDynamic: 0.7, semanticArticulation: "LEGATO", role: "LEAD" });
      // Corpus with big leaps and near-floor notes to force F.6 repairs and F.4 floors.
      const build = () => [
        mk(49, 0, 960), mk(61, 960, 960), mk(63, 1920, 960), // +12 leap, then steps — repair near the floor
        mk(60, 2880, 1920), mk(72, 4800, 960), mk(74, 5760, 960), // +12 leap mid-stream
        mk(67, 6720, 960), mk(66, 7680, 960), mk(60, 8640, 1920), // stepwise floor region
      ];
      let insertedCount = 0;
      for (let seed = 0; seed < 40; seed++) {
        const { inserted } = applyNctPass(build(), { mode: "ionian", keyRoot: 0, bpm: 120 }, 2000 + seed, {});
        for (const nct of inserted) {
          insertedCount++;
          assert(nct.pitchConcert >= 48, `NCT at MIDI ${nct.pitchConcert} below 48 (kind=${nct.kind}, seed ${seed})`);
        }
      }
      assert(insertedCount > 0, "corpus produced no NCTs to verify");
      return `40 seeds, ${insertedCount} inserted NCTs, every one ≥ MIDI 48 after leap-repair`;
    }),
    timed("Engines OFF ⇒ byte-identical to engines-absent (golden digest)", () => {
      const digests = goldenDigests as Record<string, { length: number; fnv: string }>;
      for (const seed of [6, 15, 42]) {
        const project = cloneProject(dorianFixture as unknown as Project);
        const settings = JSON.parse(JSON.stringify(project.generationSettings ?? DEFAULT_GENERATION_SETTINGS)) as NonNullable<Project["generationSettings"]>;
        settings.themes = { germ: false, nct: false, counterline: false };
        // Module 8.5 scopes the byte-identity contract to rotation-disabled
        // runs: the E/F/G engine-off baseline must equal the pre-8.5 build, so
        // the rotation engine switches off too (its casting is a NEW generator).
        settings.arrangement = { ...settings.arrangement, rotation: { enabled: false, restBars: 2, restTriggerBars: 8, maxActiveTracks: { intro: 3, verse: 6, preChorus: 10, chorus: 99, build: 99, breakdown: 3, outro: 4 } } };
        project.generationSettings = settings;
        const tracks = generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
        const digest = snapshotDigest(tracks as unknown as Parameters<typeof snapshotDigest>[0]);
        const want = digests[String(seed)]!;
        assert(digest.length === want.length && digest.fnv === want.fnv, `seed ${seed}: engines-off digest ${digest.length}/${digest.fnv} != engines-absent golden ${want.length}/${want.fnv}`);
      }
      return "seeds 6/15/42: engines-off canonical length+FNV64 matches pre-E/F/G golden";
    }),
    timed("Phase 0 roles filter: engines ON ⇒ realizeRhythm touches BASS/PAD only", () => {
      const mk = (role: SemanticRole, start: number, duration: number): AbstractNoteEvent => ({ instrumentId: "trk_test", pitchConcert: 60, pitchWritten: 60, startTime: start, duration, normalizedDynamic: 0.8, semanticArticulation: "LEGATO", role });
      // BASS/PAD-only stream: roles mode must equal legacy mode byte-for-byte
      const bassOnly = () => [mk("BASS", 0, 7680), mk("PAD", 960, 5760), mk("BASS", 3840, 3840)];
      const rolesMode = realizeRhythm(bassOnly(), { rng: mulberry32(7), beatTicks: 960, intensity: 0.9, roles: ["BASS", "PAD"] });
      const legacyMode = realizeRhythm(bassOnly(), { rng: mulberry32(7), beatTicks: 960, intensity: 0.9 });
      assert(JSON.stringify(rolesMode) === JSON.stringify(legacyMode), "roles-mode BASS/PAD treatment diverges from legacy (regression)");
      // Engine-owned roles pass through untouched under roles mode
      const owned = [mk("LEAD", 0, 3840), mk("COUNTERLINE", 1920, 3840), mk("OSTINATO", 3840, 3840), mk("BASS", 0, 5760)];
      const out = realizeRhythm(owned, { rng: mulberry32(7), beatTicks: 960, intensity: 0.9, roles: ["BASS", "PAD"] });
      for (const original of owned.filter((event) => event.role !== "BASS")) {
        const match = out.find((ev) => ev.role === original.role && ev.startTime === original.startTime && ev.duration === original.duration && ev.pitchConcert === original.pitchConcert);
        assert(match !== undefined, `engine-owned ${original.role} was reshaped by realizeRhythm`);
      }
      // The flagged regression: a BASS note with beats/cap < 2 must NOT be
      // rearticulated — the legacy guard (beats >= 2 && beats / cap >= 2) holds.
      const bassOut = out.find((ev) => ev.role === "BASS" && ev.startTime === 0)!;
      assert(bassOut.duration === 5760, `BASS rearticulated despite beats/cap < 2 (duration ${bassOut.duration})`);
      return "roles-mode == legacy for BASS/PAD; LEAD/COUNTERLINE/OSTINATO untouched; splits guarded";
    }),
    timed("Wind and brass tracks are monophonic", () => {
      const WINDS = ["flutes", "oboes", "clarinets", "bassoons", "trumpets", "trombones", "horns", "tuba"];
      const project = cloneProject(dorianFixture as unknown as Project);
      for (const seed of [6, 15]) {
        const tracks = generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
        for (const role of WINDS) {
          const track = tracks.find((candidate) => candidate.role === role);
          if (!track) continue;
          const sorted = [...track.notes].sort((a, b) => a.startTick - b.startTick);
          for (let i = 1; i < sorted.length; i++) {
            const noteA = sorted[i - 1]!;
            const noteB = sorted[i]!;
            if (noteB.startTick >= noteA.startTick + noteA.durationTicks) continue;
            const simultaneous = sorted.filter((note) => note !== noteA && note.startTick < noteA.startTick + noteA.durationTicks && noteA.startTick < note.startTick + note.durationTicks);
            assert(simultaneous.length < 1, `${track.name} has ${simultaneous.length} overlaps (seed ${seed})`);
          }
        }
      }
      return "8 wind/brass roles × 2 seeds: zero overlapping pairs";
    }),
    timed("String tracks have at most 2 simultaneous notes", () => {
      const project = cloneProject(dorianFixture as unknown as Project);
      for (const seed of [6, 15]) {
        const tracks = generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
        for (const role of ["violins1", "violins2", "violas", "cellos", "doubleBass"]) {
          const track = tracks.find((candidate) => candidate.role === role);
          if (!track) continue;
          for (const note of track.notes) {
            const simultaneous = track.notes.filter((other) => other !== note && other.startTick < note.startTick + note.durationTicks && note.startTick < other.startTick + other.durationTicks);
            assert(simultaneous.length <= 2, `${track.name} stacked ${simultaneous.length} (seed ${seed})`);
          }
        }
      }
      return "5 string roles × 2 seeds: double-stop ceiling holds";
    }),
    timed("Guard capability follows the receiving track's family (unknown roles stay single-line)", () => {
      // Module 8.6 B1 regression: capability must come from track.family — a
      // track whose ROLE string is absent from the legacy role→family map must
      // still be guarded as a woodwind (max 1), never fall through to ∞.
      const built = guardTrackNotes("trk_custom", "custom solo horn vst", [
        { startTick: 0, durationTicks: 960 },
        { startTick: 480, durationTicks: 960 },
        { startTick: 960, durationTicks: 960 },
      ], ["BASS", "PAD", "BASS"], "woodwinds");
      assert(built.notes.every((note, index) => index === 0 || built.notes[index - 1]!.startTick + built.notes[index - 1]!.durationTicks <= note.startTick), "wind track with unknown role got overlapping notes");
      assert(built.dropped + built.truncated >= 1, "guard did not resolve the overlap at all");
      // And the family field (not the role string) is what resolves strings to 2:
      const strings = guardTrackNotes("trk_s", "custom strings x", [
        { startTick: 0, durationTicks: 960 }, { startTick: 0, durationTicks: 960 },
      ], undefined, "strings");
      assert(strings.notes.length === 2, "double-stop capability lost for unknown string role");
      return "unknown woodwind role truncated to legato line; unknown string role keeps double-stop";
    }),
    timed("32-bar multi-section project keeps winds/brass single-line through all stages", () => {
      // Module 8.6 A4 regression source (was fixture-only before): the wind
      // polyphony hole appeared on long multi-section projects where the mask
      // opens up the chorus; per-beat pad/bass churn stacked the mono carriers.
      const base = fixture();
      const barTicks = ticksPerBar(base.timeSignature);
      const project = cloneProject(base);
      project.sections = [
        { ...project.sections[0], name: "Verse", startBar: 1, lengthBars: 8 },
        { ...project.sections[0], name: "Pre-Chorus Lift", startBar: 9, lengthBars: 4, targetDynamic: 0.7, densityLevel: "Dense" },
        { ...project.sections[0], name: "Big Chorus", startBar: 13, lengthBars: 8, targetDynamic: 0.95, densityLevel: "Tutti" },
        { ...project.sections[0], name: "Breakdown", startBar: 21, lengthBars: 4, targetDynamic: 0.2, densityLevel: "Sparse" },
        { ...project.sections[0], name: "Outro", startBar: 25, lengthBars: 8, targetDynamic: 0.4, densityLevel: "Balanced" },
      ];
      const perBar = new Map<number, string>();
      for (const block of base.chords) {
        const startBar = Math.floor(block.startTick / barTicks);
        for (let offset = 0; offset < Math.max(1, Math.round(block.durationTicks / barTicks)); offset++) perBar.set(startBar + offset, block.symbol);
      }
      project.chords = Array.from({ length: 32 }, (_, barIndex) => ({
        id: `synth-chord-${barIndex}`, symbol: perBar.get(barIndex % 16) ?? "C", startTick: barIndex * barTicks, durationTicks: barTicks,
      }));
      for (const seed of [6, 15]) {
        const tracks = generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
        for (const role of ["flutes", "oboes", "clarinets", "bassoons", "trumpets", "trombones", "horns", "tuba"]) {
          const track = tracks.find((candidate) => candidate.role === role);
          if (!track) continue;
          const sorted = [...track.notes].sort((a, b) => a.startTick - b.startTick);
          for (let i = 1; i < sorted.length; i++) {
            const previous = sorted[i - 1]!;
            assert(sorted[i].startTick >= previous.startTick + previous.durationTicks, `${track.name} polyphonic on the 32-bar project (seed ${seed})`);
          }
        }
        for (const role of ["violins1", "violins2", "violas", "cellos", "doubleBass"]) {
          const track = tracks.find((candidate) => candidate.role === role);
          if (!track) continue;
          for (const note of track.notes) {
            const simultaneous = track.notes.filter((other) => other !== note && other.startTick < note.startTick + note.durationTicks && note.startTick < other.startTick + other.durationTicks);
            assert(simultaneous.length <= 2, `${track.name} stacked ${simultaneous.length} on the 32-bar project (seed ${seed})`);
          }
        }
      }
      return "winds/brass single-line and strings ≤2 across Verse/PreChorus/Chorus/Breakdown/Outro × 2 seeds";
    }),
    timed("Sustain consolidation merges per-beat BASS/PAD churn to ≥4-beat median", () => {
      // Module 8.6 addendum: adjacent same-pitch per-beat pad blocks merge into
      // sustained spans (across chord boundaries when the common tone holds).
      const mk = (role: "BASS" | "PAD", pitch: number, start: number, duration: number): AbstractNoteEvent =>
        ({ instrumentId: "trk_pad", pitchConcert: pitch, pitchWritten: pitch, startTime: start, duration, normalizedDynamic: 0.6, semanticArticulation: "LEGATO", role });
      // 8 beats of one pitch (2 chord-worth of common tone) + a pitch change beat:
      const build = () => [
        mk("PAD", 67, 0, 960), mk("PAD", 67, 960, 960), mk("PAD", 67, 1920, 960), mk("PAD", 67, 2880, 960),
        mk("PAD", 67, 3840, 960), mk("PAD", 67, 4800, 960), mk("PAD", 67, 5760, 960), mk("PAD", 67, 6720, 960),
        mk("PAD", 69, 7680, 960),
        mk("BASS", 36, 0, 960), mk("BASS", 48, 960, 960), // different pitch: NOT merged
      ];
      const { events, stats } = consolidateSustains(build());
      const pads = events.filter((event) => event.role === "PAD");
      assert(pads.length === 2, `pad consolidation produced ${pads.length} spans, expected 2 (full common-tone span + pitch-change beat)`);
      const mergedSpan = [...pads].sort((a, b) => b.duration - a.duration)[0]!;
      assert(mergedSpan.duration === 7680, `common tone did not sustain through all 8 beats (${mergedSpan.duration})`);
      assert(pads.some((event) => event.pitchConcert === 69 && event.duration === 960), "pitch-change beat was merged across pitches");
      const bass = events.filter((event) => event.role === "BASS");
      assert(bass.length === 2, "different-pitch bass blocks must stay untouched");
      // The ≥4-beat sustain target on sustained sections (the addendum metric
      // itself lives in scripts/sustain-metric.ts; here the merged span is the
      // sustained-section witness — anything ≥ 4 beats proves the merge).
      // Pipeline-level: ENGINE pad events (role PAD, per chord) consolidate so
      // the ≥4-beat median lands on sustained harmony (asymmetric chord tones).
      const grid = [67, 67, 67, 67, 67, 67, 67, 67].map((pitch, index) => mk("PAD", pitch, index * 960, 960));
      const merged = consolidateSustains(grid).events;
      const durations = merged.map((event) => event.duration / 960).sort((a, b) => a - b);
      assert(durations.length === 1 && durations[0] === 8, `8 beats of one tone must be ONE span (got ${JSON.stringify(durations)})`);
      return `7-beat common-tone span + released tail + pitch-change boundary; ${stats.merged} absorbed`;
    }),
    timed("Flutes and oboes are not >90% identical", () => {
      const project = cloneProject(dorianFixture as unknown as Project);
      const tracks = generate(project, { seed: 6, density: 0.75, humanize: false, lockedTrackIds: [] });
      const flutes = tracks.find((candidate) => candidate.role === "flutes");
      const oboes = tracks.find((candidate) => candidate.role === "oboes");
      assert(flutes && oboes && flutes.notes.length > 0, "tracks missing");
      const oboeSet = new Set(oboes!.notes.map((note) => `${note.startTick}:${note.pitch}`));
      const identity = flutes!.notes.filter((note) => oboeSet.has(`${note.startTick}:${note.pitch}`)).length / flutes!.notes.length;
      assert(identity <= 0.9, `mirror identity ${(identity * 100).toFixed(0)}%`);
      return `flute/oboe identity ${(identity * 100).toFixed(0)}%`;
    }),
    timed("No track receives more than one doubling source per window", () => {
      const project = cloneProject(dorianFixture as unknown as Project);
      const tracks = generate(project, { seed: 6, density: 0.75, humanize: false, lockedTrackIds: [] });
      for (const track of tracks) {
        const doubles = track.notes.filter((note) => note.isDoubling);
        // Partition doubles by source window; a window carries at most one double note
        // (maxDoublesPerNote=1 and the ledger enforce one SOURCE per window).
        for (const note of doubles) {
          const sameWindow = doubles.filter((other) => other !== note && other.startTick < note.startTick + note.durationTicks && note.startTick < other.startTick + other.durationTicks);
          assert(sameWindow.length <= 1, `${track.name} stacked ${sameWindow.length + 1} doubles in one window`);
        }
      }
      return "all doubled notes: ≤1 per window across every track";
    }),
    timed("Fixture validates", () => {
      const project = fixture();
      assert(project.tracks.length === 21 && project.key === 2 && project.mode === "dorian", "fixture fields changed");
      return `${project.tracks.length} tracks, ${project.chords.length} chords`;
    }),
    timed("Factory project and channel assignment validate", () => {
      const project = createDefaultProject();
      assert(validateProject(project).ok, "default project invalid");
      assert(nextMidiChannel(project.tracks) >= 1 && nextMidiChannel(project.tracks) <= 16, "channel outside MIDI range");
      assert(project.generationSettings?.orchestralStyle === "Classical Symphonic", "default orchestral style missing");
      assert(project.tracks.every((track) => track.expressionMapping?.dynamicCC === 1 && track.expressionMapping.expressionCC === 11 && track.expressionMapping.brightnessCC === 74 && track.expressionMapping.sustainCC === 64), "default expression map incorrect");
      assert(project.sections[0].targetDynamic === 0.55 && project.sections[0].densityLevel === "Balanced", "default section controls missing");
      assert(project.generationSettings?.humanization.intensity === 45 && project.generationSettings.orchestration.voicingStyle === "OVERTONE_SPREAD", "generation controls defaults missing");
      assert(project.tracks[3].expressionMapping?.preset === "Kontakt Standard", "default VST map preset missing");
      const styleNames = Object.keys(ORCHESTRAL_STYLE_WEIGHTS) as OrchestralStyle[];
      assert(styleNames.length === 6 && styleNames.every((style) => ORCHESTRAL_STYLE_WEIGHTS[style].strings >= 0), "orchestral style presets missing");
      assert(ORCHESTRAL_STYLE_WEIGHTS["Jazz Big Band"].brass > ORCHESTRAL_STYLE_WEIGHTS["Chamber Strings"].brass, "preset weights don't distinguish styles");
      const settingsCopy = importProjectJson(exportProjectJson(project));
      assert(settingsCopy.ok && settingsCopy.project.generationSettings?.orchestralStyle === "Classical Symphonic" && settingsCopy.project.tracks[3].expressionMapping?.dynamicCC === 1, "settings persistence round-trip failed");
      return `${project.tracks.length} tracks; generation defaults, expression maps, presets and persistence valid`;
    }),
    timed("Chord parser supports slash bass, extension stacking and errors", () => {
      const slash = parseChord("Dm7/G");
      assert(slash.ok && slash.chord.bass === 7, "slash bass not parsed");
      const extended = parseChord("Cmaj7#11");
      assert(extended.ok && extended.chord.extensions.includes("maj7") && extended.chord.extensions.includes("#11") && extended.chord.pitchClasses.includes(6), "stacked chord extensions not parsed");
      assert(!parseChord("invalid").ok, "invalid symbol should be rejected");
      return "slash bass, multi-extension symbol and invalid symbol paths checked";
    }),
    timed("Six-stage C–Am–F–G semantic score", () => {
      const harmony = new HarmonicParser().parse(config, progression);
      assert(harmony.length === 16, `expected 16 beat slices, got ${harmony.length}`);
      assert(harmony[0].guideTones.includes(4), "C major third not identified");
      assert(harmony[8].commonTones.includes(0), "Am-to-F common tone missing");
      const profiles = [
        { id: "bass", role: "cellos", family: "strings", writtenRange: { low: 28, high: 84 }, comfortableRange: { low: 28, high: 47 } },
        { id: "ostinato", role: "harp", family: "keys", writtenRange: { low: 23, high: 104 }, comfortableRange: { low: 48, high: 64 } },
        { id: "pad", role: "violas", family: "strings", writtenRange: { low: 48, high: 88 }, comfortableRange: { low: 60, high: 76 } },
        { id: "counter", role: "violins2", family: "strings", writtenRange: { low: 55, high: 93 }, comfortableRange: { low: 70, high: 83 } },
        { id: "lead", role: "violins1", family: "strings", writtenRange: { low: 55, high: 96 }, comfortableRange: { low: 78, high: 91 } },
      ];
      const energy = new DynamicMappingEngine().map(harmony, sections, config, profiles);
      const layers = new TextureRoleAllocator().allocate(config, energy, profiles);
      assert(layers.map((layer) => layer.role).join(",") === "BASS,OSTINATO,PAD,COUNTERLINE,LEAD", "five layers missing");
      const spaced = new OvertoneSpacingFilter().apply(harmony, layers, energy, "OVERTONE_SPREAD");
      const voiceLed = new VoiceLeadingOptimizer().optimize(spaced, layers);
      const events = new InstrumentRangeFilter().apply(voiceLed.voicings, layers, profiles);
      const score = generateOrchestralScore(config, progression, sections, { profiles });
      assert(events.length >= 20 && score.events.length === events.length, "incomplete semantic score");
      assert(score.dynamicCurves.size === 5, `expected 5 dynamic curves, got ${score.dynamicCurves.size}`);
      assert(events.every((event) => event.pitchConcert >= 0 && event.pitchConcert <= 127 && event.pitchWritten >= 0 && event.pitchWritten <= 127 && event.normalizedDynamic >= 0 && event.normalizedDynamic <= 1), "event bounds invalid");
      for (const voicing of voiceLed.voicings) {
        assert(voicing.pitches[0] >= 24 && voicing.pitches[0] < 48, `bass outside root-only sub-bass range: ${voicing.pitches[0]}`);
        assert(voicing.pitches.every((pitch, i) => i === 0 || pitch > voicing.pitches[i - 1]), "voices crossed");
        assert(voicing.pitches[1] - voicing.pitches[0] >= 7, "sub-bass spacing is too close");
      }
      assert(voiceLed.totalTravel > 0, "voice-leading cost not computed");
      assert(voiceLed.parallelIntervals.length === 0, `prohibited parallel intervals remain: ${JSON.stringify(voiceLed.parallelIntervals)}`);
      for (let index = 1; index < voiceLed.voicings.length; index++) {
        const before = voiceLed.voicings[index - 1].pitches, after = voiceLed.voicings[index].pitches;
        for (let voice = 0; voice < after.length; voice++) {
          const leap = after[voice] - before[voice];
          if (Math.abs(leap) > 5 && index + 1 < voiceLed.voicings.length) {
            const resolution = voiceLed.voicings[index + 1].pitches[voice] - after[voice];
            assert(Math.abs(resolution) <= 2 && Math.sign(resolution) === -Math.sign(leap), `unresolved leap in voice ${voice}: ${leap} then ${resolution}`);
          }
        }
      }
      return `${harmony.length} beat slices, ${layers.length} layers, ${events.length} events; travel ${voiceLed.totalTravel}, no parallel 5ths/octaves`;
    }),
    timed("Extension parsing and written transposition", () => {
      const chord: ChordBlock = { startTime: 0, duration: 3840, rootPitchClass: 0, quality: "Maj", extensions: ["maj7", "9", "#11"], bassOverride: 4 };
      const parsed = new HarmonicParser().parse(config, [chord])[0];
      assert(parsed.bassPitchClass === 4 && [11, 2, 6].every((tone) => parsed.pitchClasses.includes(tone)), "slash bass or color tones missing");
      assert(parsed.colorTones.includes(2) && parsed.colorTones.includes(6), "color classification failed");
      const horn = { id: "horn", role: "horns", family: "brass", writtenRange: { low: 41, high: 77 }, comfortableRange: { low: 48, high: 70 }, transpositionSemitones: 7 };
      const chorus: StructureSection[] = [{ startTime: 0, duration: 3840, type: "Chorus", targetDynamic: 0.9, densityLevel: "Tutti" }];
      const profiles = [horn, { id: "violin", role: "violins1", family: "strings", writtenRange: { low: 40, high: 96 } }];
      const score = generateOrchestralScore(config, [chord], chorus, { profiles });
      const hornEvents = score.events.filter((event) => event.instrumentId === "horn");
      assert(hornEvents.length > 0, "preset failed to assign horn role");
      assert(hornEvents.every((event) => event.pitchWritten >= horn.writtenRange.low && event.pitchWritten <= horn.writtenRange.high), "written pitch outside horn range");
      assert(hornEvents.every((event) => event.pitchWritten === event.pitchConcert + 7), "horn transposition was not applied exactly");
      return `slash bass ${parsed.bassPitchClass}, color tones ${parsed.colorTones.join(",")}, ${hornEvents.length} correctly transposed horn notes`;
    }),
    timed("Dynamic curve and active section groups", () => {
      const harmony = new HarmonicParser().parse(config, [{ startTime: 0, duration: 8 * 3840, rootPitchClass: 0, quality: "Maj", extensions: [] }]);
      const form: StructureSection[] = [
        { startTime: 0, duration: 4 * 3840, type: "Verse", targetDynamic: 0.35, densityLevel: "Balanced" },
        { startTime: 4 * 3840, duration: 4 * 3840, type: "Chorus", targetDynamic: 0.9, densityLevel: "Tutti" },
      ];
      const profiles = [{ id: "strings", family: "strings", writtenRange: { low: 40, high: 96 } }, { id: "brass", family: "brass", writtenRange: { low: 40, high: 84 } }, { id: "percussion", family: "percussion", writtenRange: { low: 30, high: 70 } }];
      const points = new DynamicMappingEngine().map(harmony, form, config, profiles);
      const verse = points.filter((point) => point.time < 15360), chorus = points.filter((point) => point.time >= 15360);
      const mean = (items: typeof points) => items.reduce((sum, point) => sum + point.value, 0) / items.length;
      assert(mean(chorus) > mean(verse), "chorus is not more energetic than verse");
      assert(chorus.every((point) => point.activeGroups.includes("brass") && point.activeGroups.includes("percussion")), "chorus not tutti");
      assert(points.every((point) => point.value >= 0 && point.value <= 1), "energy outside normalized bounds");
      return `${points.length} normalized points, verse ${mean(verse).toFixed(2)} / chorus ${mean(chorus).toFixed(2)}`;
    }),
    timed("Harmonic timeline honors compound and odd meters", () => {
      let count = 0;
      for (const meter of [{ numerator: 3, denominator: 4 }, { numerator: 6, denominator: 8 }, { numerator: 5, denominator: 4 }] satisfies TimeSignature[]) {
        const beatConfig = { ...config, timeSignature: [meter.numerator, meter.denominator] as [number, number] };
        const timeline = new HarmonicParser().parse(beatConfig, [{ startTime: 0, duration: ticksPerBar(meter) * 2, rootPitchClass: 0, quality: "Maj", extensions: [] }]);
        assert(timeline.length === meter.numerator * 2, `${meter.numerator}/${meter.denominator} slice count incorrect`);
        assert(timeline.every((item) => item.duration === ticksPerBeat(meter)), "slice duration incorrect");
        count += timeline.length;
      }
      return `${count} beat slices across 3/4, 6/8, and 5/4`;
    }),
    timed("100-seed generation is deterministic and range-safe", () => {
      const base = fixture();
      for (let seed = 0; seed < 100; seed++) {
        const project = cloneProject(base);
        project.mode = ["ionian", "dorian", "aeolian"][(seed % 3)] as ModeName;
        project.timeSignature = [{ numerator: 4, denominator: 4 }, { numerator: 3, denominator: 4 }, { numerator: 6, denominator: 8 }, { numerator: 5, denominator: 4 }][seed % 4];
        const options: GenerateOptions = { seed, density: 0.7, humanize: seed % 2 === 0, lockedTrackIds: [] };
        const first = generate(project, options), second = generate(project, options);
        assert(JSON.stringify(first.map((track) => track.notes)) === JSON.stringify(second.map((track) => track.notes)), `seed ${seed} differs`);
        for (const track of first) for (const note of track.notes) assert(note.pitch >= track.lowestNote && note.pitch <= track.highestNote, `${track.name} out of range`);
      }
      return "100 deterministic, range-valid arrangements";
    }),
    timed("UI adapter outputs notes, supports empty chord track", () => {
      const project = createDefaultProject();
      const options: GenerateOptions = { seed: 77, density: 0.8, humanize: false, lockedTrackIds: [] };
      const generated = generate(project, options);
      const first = generated.reduce((sum, track) => sum + track.notes.length, 0);
      assert(first > 0, "empty chord track did not produce tonic notes");
      return `${first} notes generated`;
    }),
    timed("MIDI export round trip maintains notes", () => {
      const project = fixture();
      project.tracks = generate(project, { seed: 5, density: 0.7, humanize: false, lockedTrackIds: [] });
      const bytes = exportMergedMidi(project, "all");
      const parsed = parseMidiNotes(bytes);
      const expected = project.tracks.filter((track) => track.family !== "structure" && track.family !== "audio").reduce((sum, track) => sum + track.notes.length, 0);
      assert(expected > 0 && parsed.length === expected, `MIDI note count ${parsed.length} != ${expected}`);
      assert(new Midi(bytes).header.ppq === 960, "MIDI PPQ was not preserved");
      const files = exportPerTrackMidi(project, "all");
      assert(files.length > 0 && files.every((file) => midiDurationTicks(file.data) > 0), "per-track MIDI export failed");
      return `${parsed.length} notes, ${files.length} MIDI files`;
    }),
    timed("Humanization settings affect generated timing and detuning deterministically", () => {
      const project = createDefaultProject();
      const track = project.tracks.find((item) => item.family === "strings")!;
      const block = { id: "test-chord", symbol: "C", startTick: 0, durationTicks: 3840 };
      project.chords = [block];
      project.generationSettings!.humanization = { intensity: 100, rubato: 75, intonationCents: 15, latencyCompensation: false };
      const options: GenerateOptions = { seed: 91, density: 0.75, humanize: true, humanizeIntensity: 100, rubato: 75, intonationCents: 15, lockedTrackIds: [] };
      const first = generate(project, options).find((item) => item.id === track.id)!;
      const second = generate(project, options).find((item) => item.id === track.id)!;
      assert(first.notes.length > 0 && JSON.stringify(first.notes) === JSON.stringify(second.notes), "humanization isn't deterministic");
      assert(first.notes.some((note) => note.startTick !== Math.round(note.startTick / 120) * 120), "humanized timing did not move from grid");
      assert(first.notes.every((note) => Math.abs(note.detuneCents ?? 0) <= 15), "intonation drift outside setting");
      project.generationSettings!.humanization = { intensity: 0, rubato: 0, intonationCents: 0, latencyCompensation: false };
      const strict = generate(project, { ...options, humanize: false, humanizeIntensity: 0, rubato: 0, intonationCents: 0 }).find((item) => item.id === track.id)!;
      assert(strict.notes.length > 0 && strict.notes.every((note) => note.detuneCents === 0), "strict grid altered notes");
      const rubatoProject = createDefaultProject();
      rubatoProject.chords = [{ id: "rubato-chord", symbol: "C", startTick: 0, durationTicks: 3840 }];
      rubatoProject.generationSettings!.humanization = { intensity: 0, rubato: 100, intonationCents: 0, latencyCompensation: false };
      const rubatoOutput = generate(rubatoProject, { seed: 1, density: 0.75, humanize: true, humanizeIntensity: 0, rubato: 100, lockedTrackIds: [] });
      assert(rubatoOutput.some((item) => item.notes.some((note) => note.startTick !== 0 && note.startTick % 480 !== 0)), "rubato-only setting did not produce elastic timing");
      return `${first.notes.length} deterministic notes with bounded drift/detuning`;
    }),
    timed("Voicing and enabled groups are passed into generation", () => {
      const project = createDefaultProject();
      project.chords = [{ id: "test-chord", symbol: "C", startTick: 0, durationTicks: 3840 }];
      project.sections = [{ ...project.sections[0], name: "Chorus", targetDynamic: 0.9, densityLevel: "Tutti" }];
      project.generationSettings!.orchestration.enabledGroups.brass = false;
      const defaultVoicing = generate(project, { seed: 1, density: 0.7, humanize: false, lockedTrackIds: [] });
      assert(defaultVoicing.find((track) => track.family === "brass")!.notes.length === 0, "disabled brass received generated notes");
      project.generationSettings!.orchestration.enabledGroups.brass = true;
      project.generationSettings!.orchestration.voicingStyle = "CLUSTER";
      const cluster = generate(project, { seed: 1, density: 0.7, humanize: false, lockedTrackIds: [] });
      assert(cluster.some((track) => track.family === "brass" && track.notes.length > 0), "enabled brass did not receive notes");
      assert(JSON.stringify(defaultVoicing.map((track) => track.notes)) !== JSON.stringify(cluster.map((track) => track.notes)), "configured voicing style did not affect output");
      return "disabled groups are silent; voicing setting reaches score generation";
    }),
    timed("Latency compensation pre-shifts note onsets by configured attack", () => {
      const project = createDefaultProject();
      const strings = project.tracks.find((track) => track.id === "trk_violins_i")!;
      project.chords = [{ id: "test-chord", symbol: "C", startTick: 0, durationTicks: 3840 }];
      project.generationSettings!.humanization = { intensity: 0, rubato: 0, intonationCents: 0, latencyCompensation: true, latencyCompensationMs: { violins1: 10 } };
      const compensated = generate(project, { seed: 1, density: 0.75, humanize: false, latencyCompensation: true, lockedTrackIds: [] }).find((track) => track.id === strings.id)!;
      const uncompensated = generate(project, { seed: 1, density: 0.75, humanize: false, latencyCompensation: false, lockedTrackIds: [] }).find((track) => track.id === strings.id)!;
      const expectedShift = Math.round((10 / 60000) * project.bpm * 960);
      const baselineLaterOnset = uncompensated.notes.find((note) => note.startTick > expectedShift);
      assert(compensated.notes.length > 0 && compensated.notes.some((note) => note.startTick === 0), "latency compensation didn't clamp the first onset at zero");
      assert(baselineLaterOnset && compensated.notes.some((note) => note.pitch === baselineLaterOnset.pitch && note.startTick === baselineLaterOnset.startTick - expectedShift), "latency compensation didn't shift later note-on");
      return `10 ms string attack compensation shifts note-on by ${expectedShift} ticks`;
    }),
    timed("MIDI export uses per-track expression CC assignments", () => {
      const project = createDefaultProject();
      const track = project.tracks.find((item) => item.family === "strings")!;
      track.expressionMapping = { preset: "Custom", dynamicCC: 2, expressionCC: 3, brightnessCC: 5, sustainCC: 67 };
      track.notes = [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }];
      const midi = new Midi(exportMergedMidi(project));
      const exportedTrack = midi.tracks.find((item) => item.name === track.name)!;
      assert(exportedTrack.controlChanges[2]?.length === 1 && exportedTrack.controlChanges[3]?.length === 1 && exportedTrack.controlChanges[5]?.length === 1, "configured CC fields were not exported");
      assert(exportedTrack.controlChanges[67]?.length === 2, "sustain CC wasn't turned on/off");
      assert(Math.abs(exportedTrack.controlChanges[2]![0].value - 90 / 127) < 0.01, "dynamic CC value is not normalized to MIDI range");
      assert(exportedTrack.controlChanges[67]![0].value === 1 && exportedTrack.controlChanges[67]![1].value === 0, "sustain values are invalid");
      assert(!exportedTrack.controlChanges[1] && !exportedTrack.controlChanges[11] && !exportedTrack.controlChanges[74], "default CCs leaked when custom mapping configured");
      return "dynamic, expression, brightness and sustain CC mappings exported";
    }),
    timed("Invalid expression CC fields are rejected", () => {
      const project = createDefaultProject();
      project.tracks[3].expressionMapping!.expressionCC = 128;
      const result = validateProject(project);
      assert(!result.ok && result.errors.some((error) => error.includes("expressionMapping CC values")), "invalid CC value passed project validation");
      return "CC numbers constrained to MIDI 0–127";
    }),
    timed("Instrument database covers every orchestral family with valid register bands", () => {
      const loader = new InstrumentProfileLoader();
      assert(loader.instrumentCount >= 20, `expected at least 20 instrument profiles, got ${loader.instrumentCount}`);
      const families = new Set(INSTRUMENT_DATABASE.map((profile) => profile.family));
      for (const family of ["STRINGS", "WOODWINDS", "BRASS", "PITCHED_PERCUSSION", "KEYBOARDS"] as const) {
        assert(loader.getProfilesByFamily(family).length > 0, `family ${family} is missing from the database`);
      }
      assert(families.size === 5, "unexpected family values in the database");
      for (const profile of INSTRUMENT_DATABASE) {
        assert(profile.registers.length > 0, `${profile.id} has no register bands`);
        assert(profile.rangeWritten.practicalMin >= 0 && profile.rangeWritten.practicalMax <= 127, `${profile.id} practical range outside MIDI bounds`);
        for (const band of profile.registers) {
          assert(band.minPitchWritten <= band.maxPitchWritten, `${profile.id} register band ${band.name} has inverted bounds`);
          assert(band.velocityModifier >= -15 && band.velocityModifier <= 15, `${profile.id} register velocity modifier is out of range`);
          assert(band.brightnessModifier >= -20 && band.brightnessModifier <= 20, `${profile.id} register brightness modifier is out of range`);
        }
        for (const role of profile.primaryRoles) {
          assert(["LEAD", "COUNTERLINE", "PAD", "OSTINATO", "BASS"].includes(role), `${profile.id} has unknown role ${role}`);
        }
        assert(profile.carryingPowerWeight > 0 && profile.carryingPowerWeight <= 1.2, `${profile.id} carrying power is out of range`);
        assert(Boolean(profile.unisonBlendingGroup), `${profile.id} has no blending group`);
      }
      const roles: OrchestralRole[] = ["LEAD", "COUNTERLINE", "PAD", "OSTINATO", "BASS"];
      for (const role of roles) {
        assert(loader.getProfilesByRole(role).length > 0, `no instrument claims the ${role} role`);
      }
      return `${loader.instrumentCount} instruments across 5 families with valid registers, ranges, and roles`;
    }),
    timed("Range utility flags practical and professional outliers", () => {
      const loader = new InstrumentProfileLoader();
      const violin = loader.getProfile("violin_1");
      assert(violin, "violin_1 profile missing");
      const comfortable = isWithinPracticalRange(72, "violin_1", loader);
      assert(comfortable.withinPracticalRange && comfortable.withinProfessionalRange && !comfortable.professionalOnly, "middle-register violin note should be fully valid");
      const extreme = isWithinPracticalRange(94, "violin_1", loader);
      assert(!extreme.withinPracticalRange && extreme.withinProfessionalRange && extreme.tooHigh && extreme.professionalOnly, "professional-only violin top should be flagged");
      const absurd = isWithinPracticalRange(127, "violin_1", loader);
      assert(!absurd.withinPracticalRange && !absurd.withinProfessionalRange && absurd.tooHigh, "out-of-bound pitch should fail both checks");
      const unknown = isWithinPracticalRange(60, "theremin");
      assert(!unknown.withinPracticalRange, "unknown instruments should fail closed");
      const bassFlute = isWithinPracticalRange(60, "flute", loader);
      assert(bassFlute.withinPracticalRange, "flute practical range should include C4");
      return "practical, professional, professional-only, and unknown-ID paths all validated";
    }),
    timed("Transposition adapter matches score-engine offsets", () => {
      const loader = new InstrumentProfileLoader();
      const cases: Array<[string, number]> = [
        ["french_horn", -7],
        ["english_horn", -7],
        ["clarinet_bb", -2],
        ["trumpet_bb", -2],
        ["bass_clarinet", -14],
        ["double_bass", -12],
        ["piccolo", 12],
        ["glockenspiel", 24],
        ["celesta", 12],
        ["violin_1", 0],
      ];
      for (const [id, offset] of cases) {
        const profile = loader.getProfile(id);
        assert(profile, `${id} profile missing`);
        assert(profile.transpositionSemitones === offset, `${id} transposition should be ${offset}`);
        const written = TranspositionAdapter.concertToWritten(60, profile);
        const back = TranspositionAdapter.writtenToConcert(written, profile);
        assert(back === 60, `${id} adapter is not invertible`);
        if (offset !== 0) {
          assert(written === 60 - offset, `${id} written pitch formula mismatch`);
        }
        assert(TranspositionAdapter.clefForPitch(90, profile) === (profile.alternateClef ?? profile.defaultClef), `${id} high-passage clef should fall back to the alternate clef`);
      }
      return "horn, english horn, clarinet, trumpet, bass clarinet, contrabass, piccolo, glockenspiel, celesta and C-instrument offsets verified";
    }),
    timed("Register modifiers apply velocity, brightness and protection rules", () => {
      const loader = new InstrumentProfileLoader();
      const flute = loader.getProfile("flute")!;
      const trumpet = loader.getProfile("trumpet_bb")!;
      const fluteLow = applyRegisterDynamicModifiers(60, flute);
      assert(fluteLow.requiresAccompanimentAttenuation, "low flute did not flag accompaniment attenuation");
      assert(fluteLow.velocityModifier < 0 && fluteLow.brightnessModifier < 0, "low flute should darken or soften the note");
      const fluteMid = applyRegisterDynamicModifiers(72, flute);
      assert(!fluteMid.requiresAccompanimentAttenuation, "mid flute should not flag attenuation");
      const trumpetHigh = applyRegisterDynamicModifiers(84, trumpet);
      assert(Math.abs(trumpetHigh.cc11Scale - 0.88) < 1e-9, "high trumpet CC#11 factor is not 0.88");
      assert(trumpetHigh.velocityModifier > 0 && trumpetHigh.brightnessModifier > 0, "high trumpet should brighten and strengthen the note");
      const trumpetMid = applyRegisterDynamicModifiers(64, trumpet);
      assert(trumpetMid.cc11Scale === 1, "mid trumpet should not scale CC#11");
      const horn = loader.getProfile("french_horn")!;
      const hornLow = applyRegisterDynamicModifiers(44, horn);
      assert(hornLow.velocityModifier < 0, "low horn should soften the note");
      return "flute attenuation, trumpet CC balance and register scaling all verified";
    }),
    timed("Project JSON round trip", () => {
      const project = fixture();
      project.tracks = generate(project, { seed: 12, density: 0.5, humanize: false, lockedTrackIds: [] });
      const result = importProjectJson(exportProjectJson(project));
      assert(result.ok && projectsEqual(project, result.project), result.ok ? "round-trip differs" : result.errors.join("; "));
      return "project round-trips without data loss";
    }),
    timed("User 32-bar project: winds/brass single-line, strings ≤2, guard verifier 0", () => {
      // Module 8.7 B3 — the user's real 32-bar multi-section project as a
      // PERMANENT regression source (pre-8.7 it stacked 20–47 guard
      // resolutions/seed and 548–669 completion-in-span overlaps).
      const loaded = importProjectJson(JSON.stringify(userProjectJson));
      assert(loaded.ok, loaded.ok ? "user project fixture unexpectedly invalid" : loaded.errors.join("; "));
      const userProject = cloneProject(loaded.project);
      const winds = new Set(["flutes", "oboes", "clarinets", "bassoons", "piccolo", "englishHorn", "bassClarinet"]);
      const brass = new Set(["trumpets", "trombones", "horns", "tuba", "bassTrombone"]);
      const strgs = new Set(["violins1", "violins2", "violas", "cellos", "doubleBass"]);
      let worstWind = 0, worstBrass = 0, worstString = 0;
      for (const seed of [6, 15, 42]) {
        const tracks = generate(cloneProject(userProject), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
        const violations = verifyMonophonyInvariant(tracks);
        assert(violations.length === 0, `seed ${seed}: guard verifier found ${violations.length} violation(s): ${violations.map((v) => `${v.trackId} ${v.simultaneous}>${v.cap}`).join(", ")}`);
        for (const track of tracks) {
          if (track.family === "structure" || track.family === "audio") continue;
          let worst = 0;
          for (const note of track.notes) {
            let overlapping = 0;
            for (const other of track.notes) {
              if (other !== note && note.startTick < other.startTick + other.durationTicks && other.startTick < note.startTick + note.durationTicks) overlapping++;
            }
            if (overlapping > worst) worst = overlapping;
          }
          if (winds.has(track.role)) worstWind = Math.max(worstWind, worst);
          else if (brass.has(track.role)) worstBrass = Math.max(worstBrass, worst);
          else if (strgs.has(track.role)) worstString = Math.max(worstString, worst);
        }
      }
      assert(worstWind === 0, `winds reached ${worstWind + 1} simultaneous (max 1)`);
      assert(worstBrass === 0, `brass reached ${worstBrass + 1} simultaneous (max 1)`);
      assert(worstString <= 1, `strings reached ${worstString + 1} simultaneous (max 2)`);
      return `3 seeds: verifier 0; wind/brass single-line; strings ≤${worstString + 1} simultaneous`;
    }),
    timed("Mix rebalance: cc7 band [78,108] inverted spread, CC11 floor 40", () => {
      // Module 8.7 B4 — direction pinned here because no earlier pinned test
      // covers the mix path: heavier carriers ride LOWER and the band clamps.
      assert(cc7ForWeight(1.2) === 78, `tuba extreme clamps to band low, got ${cc7ForWeight(1.2)}`);
      assert(cc7ForWeight(0.35) === 99, `strings weight 0.35 should give 99, got ${cc7ForWeight(0.35)}`);
      assert(cc7ForWeight(1.0) === 81, `brass weight 1.0 should give 81, got ${cc7ForWeight(1.0)}`);
      assert(cc7ForWeight(0.35) > cc7ForWeight(1.0), "spread no longer inverted (heavier must ride lower)");
      for (const weight of [0, 0.2, 0.5, 0.8, 1.2]) {
        const cc7 = cc7ForWeight(weight);
        assert(cc7 >= 78 && cc7 <= 108, `cc7 ${cc7} out of band [78,108] at weight ${weight}`);
      }
      assert(DEFAULT_BALANCE_CONFIG.cc11Floor === 40, `CC11 floor should be 40, got ${DEFAULT_BALANCE_CONFIG.cc11Floor}`);
      return "cc7 band [78,108] inverted (strings 99 > brass 81 > tuba 78), cc11 floor 40";
    }),
    timed("Sustain metric pinned: BASS/PAD median ≥ 4 beats on sustained sections", () => {
      // Module 8.8 bundle — pins the 8.6 sustain-consolidation result against
      // regressions. Measured at the same stage boundary as
      // scripts/sustain-metric.ts (post engines+rotation+consolidation,
      // pre-realizeRhythm) on the 32-bar multi-section synthetic. The dorian
      // fixture's BASS median 2.00 beats is the documented baseline exception
      // (not asserted here; asserted ≥ 2.00 as a floor for observability).
      const fixtureBase = fixture();
      const barTicks = ticksPerBar({ numerator: 4, denominator: 4 });
      const synth = cloneProject(fixtureBase);
      synth.sections = [
        { ...synth.sections[0]!, name: "Verse", startBar: 1, lengthBars: 8 },
        { ...synth.sections[0]!, name: "Pre-Chorus Lift", startBar: 9, lengthBars: 4, targetDynamic: 0.7, densityLevel: "Dense" },
        { ...synth.sections[0]!, name: "Big Chorus", startBar: 13, lengthBars: 8, targetDynamic: 0.95, densityLevel: "Tutti" },
        { ...synth.sections[0]!, name: "Breakdown", startBar: 21, lengthBars: 4, targetDynamic: 0.2, densityLevel: "Sparse" },
        { ...synth.sections[0]!, name: "Outro", startBar: 25, lengthBars: 8, targetDynamic: 0.4, densityLevel: "Balanced" },
      ];
      const perBar = new Map<number, string>();
      for (const block of fixtureBase.chords) {
        const startBar = Math.floor(block.startTick / barTicks);
        for (let offset = 0; offset < Math.max(1, Math.round(block.durationTicks / barTicks)); offset++) perBar.set(startBar + offset, block.symbol ?? "C");
      }
      synth.chords = Array.from({ length: 32 }, (_, barIndex) => ({ id: `sustain-pin-${barIndex}`, symbol: perBar.get(barIndex % 16) ?? "C", startTick: barIndex * barTicks, durationTicks: barTicks }));
      for (const seed of [6, 15]) {
        const settings = synth.generationSettings ?? DEFAULT_GENERATION_SETTINGS;
        const inputs = buildSemanticInputs(synth, settings, seed);
        const rotationPartial = settings.arrangement?.rotation;
        const rotationConfig = resolveRotationConfig(rotationPartial);
        const plan = rotationConfig.enabled ? planRotation(synth, rotationPartial, seed) : undefined;
        const post = applyEfgEngines(inputs.score.events, {
          config: inputs.config, chords: inputs.chords, sections: inputs.scoreSections,
          energies: buildEfgEnergies(inputs.config, inputs.chords),
          chordStartTimes: inputs.chords.map((block) => block.startTime),
          profiles: inputs.compositionProfiles,
          intensityAt: inputs.arrangementInfo.intensityAt,
          subdivisionCapAt: inputs.arrangementInfo.subdivisionCapAt,
          rotation: plan ? { plan, config: rotationConfig, measures: inputs.arrangementInfo.measures, exposedRoles: exposedBreakdownRoles(settings.arrangement?.breakdownExposedLayer) } : undefined,
        }, seed, { germ: settings.themes?.germ ?? true, nct: settings.themes?.nct ?? true, counterline: settings.themes?.counterline ?? true }).events;
        for (const role of ["BASS", "PAD"] as const) {
          const durations = post.filter((event) => event.role === role).map((event) => event.duration);
          const sorted = [...durations].sort((a, b) => a - b);
          const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
          assert(median >= 4 * 960, `seed ${seed} ${role}: consolidated median ${median}t (${(median / 960).toFixed(2)} beats) < 4 beats — the sustain fix regressed`);
        }
      }
      // Documented exception row (fixture, seed 6): BASS median 2.00 beats at the 8.6 baseline.
      const fixtureSettings = fixtureBase.generationSettings ?? DEFAULT_GENERATION_SETTINGS;
      const fixtureInputs = buildSemanticInputs(fixtureBase, fixtureSettings, 6);
      const fixturePlan0 = fixtureSettings.arrangement?.rotation;
      const fixtureCfg = resolveRotationConfig(fixturePlan0);
      const fixturePlan = fixtureCfg.enabled ? planRotation(fixtureBase, fixturePlan0, 6) : undefined;
      const fixturePost = applyEfgEngines(fixtureInputs.score.events, {
        config: fixtureInputs.config, chords: fixtureInputs.chords, sections: fixtureInputs.scoreSections,
        energies: buildEfgEnergies(fixtureInputs.config, fixtureInputs.chords),
        chordStartTimes: fixtureInputs.chords.map((block) => block.startTime),
        profiles: fixtureInputs.compositionProfiles,
        intensityAt: fixtureInputs.arrangementInfo.intensityAt,
        subdivisionCapAt: fixtureInputs.arrangementInfo.subdivisionCapAt,
        rotation: fixturePlan ? { plan: fixturePlan, config: fixtureCfg, measures: fixtureInputs.arrangementInfo.measures, exposedRoles: exposedBreakdownRoles(fixtureSettings.arrangement?.breakdownExposedLayer) } : undefined,
      }, 6, { germ: true, nct: true, counterline: true }).events;
      const bassDurations = fixturePost.filter((event) => event.role === "BASS").map((event) => event.duration).sort((a, b) => a - b);
      const fixtureBassMedian = bassDurations[Math.floor(bassDurations.length / 2)] ?? 0;
      assert(fixtureBassMedian >= 2 * 960, `fixture BASS median ${fixtureBassMedian}t below the documented 2.00-beat baseline`);
      return "synthetic BASS/PAD medians ≥ 4 beats (seeds 6,15); fixture BASS 2.00-beat exception documented";
    }),
    timed("Percussion engine (M8 tests re-pointed): roll before the chorus boundary, cymbal swell/crash at pitch 49", () => {
      // Module 12 — the M8 gesture assertions live on here ONLY as
      // M12-engine-output checks (the M8 gesture writers are deleted). The
      // assertions are NOT weakened: roll in the final 2 bars before a chorus
      // boundary, ranges respected, cymbal pitch 49, swell reaching the
      // boundary — plus the M12 strengtheners (ACCENT tiers, isRoll tags). The
      // M8 gesture engine only fired at Build→Chorus boundaries, so this test
      // carries one synthetic boundary scenario exactly as that engine did.
      const base = fixture();
      const barTicks = ticksPerBar(base.timeSignature);
      assert(barTicks === 3840, "fixture must stay 4/4 for the boundary math");
      const project = cloneProject(base);
      project.sections = [
        { ...project.sections[0]!, name: "Verse", startBar: 1, lengthBars: 6 },
        { ...project.sections[0]!, name: "Build", startBar: 7, lengthBars: 4, targetDynamic: 0.85, densityLevel: "Dense" },
        { ...project.sections[0]!, name: "Chorus", startBar: 11, lengthBars: 6, targetDynamic: 0.95, densityLevel: "Tutti" },
      ];
      const boundary = 10 * barTicks; // chorus downbeat (bar 11)
      const tracks = generate(project, { seed: 6, density: 0.75, humanize: false, lockedTrackIds: [] });
      const timpani = tracks.find((t) => t.id === "trk_timpani");
      const snare = tracks.find((t) => t.id === "trk_snare");
      const cymbals = tracks.find((t) => t.id === "trk_cymbals");
      const aux = tracks.find((t) => t.id === "trk_aux");
      assert(timpani && snare && cymbals && aux, "battery tracks missing");
      const rollHits = timpani!.notes.filter((n) => n.startTick >= boundary - 2 * barTicks && n.startTick <= boundary);
      assert(rollHits.length >= 8, `timpani roll before the boundary too thin: ${rollHits.length}`);
      assert(rollHits.every((n) => n.pitch >= 38 && n.pitch <= 57 && Boolean(n.isRoll)), "roll hits must sit in the bowl gamut and carry isRoll");
      // A roll hit per grid subdivision with the documented ±2 ms alternation:
      // consecutive gaps zigzag (small/large/…) and the spread is exactly
      // 4×jitter (−j, +j per hit ⇒ g[0] < g[1] > g[2] < …). Grid-agnostic:
      // works for both the 16th and the ff 32nd subdivisions.
      const regularHits = rollHits.filter((n) => n.startTick <= boundary).slice(0, -1); // drop the terminating accent
      assert(regularHits.length >= 8, `roll regular hits missing: ${regularHits.length}`);
      const gaps: number[] = [];
      for (let index = 1; index < regularHits.length; index++) gaps.push(regularHits[index].startTick - regularHits[index - 1].startTick);
      assert(gaps.length >= 6 && gaps.slice(0, 6).every((gap, i) => i === 5 || (i % 2 === 0 ? gap < gaps[i + 1]! : gap > gaps[i + 1]!)), `roll timing jitter is not the documented alternation: ${JSON.stringify(gaps.slice(0, 6))}`);
      const expectedJitter = Math.round(msToTicks(2, project.bpm)); // the engine rounds the jitter tick value FIRST
      assert(Math.max(...gaps) - Math.min(...gaps) === 4 * expectedJitter, `jitter spread ${Math.max(...gaps) - Math.min(...gaps)} != 4×${expectedJitter}`);
      const velocities = regularHits.map((n) => n.velocity);
      assert(velocities.length > 2 && velocities.slice(2).every((v, i) => v >= velocities[i]), "roll velocity ramp not monotone under the period-2 alternation");
      assert(snare!.notes.every((n) => n.pitch === 38), "snare pitch must be exactly 38");
      assert(cymbals!.notes.every((n) => n.pitch === 49), "cymbal pitch must be exactly 49");
      assert(aux!.notes.every((n) => n.pitch >= 36 && n.pitch <= 81), "aux pitch outside the chair range");
      const swell = cymbals!.notes.filter((n) => n.startTick >= boundary - 2 * barTicks && n.startTick < boundary);
      assert(swell.length >= 2, `cymbal swell before the chorus downbeat too thin: ${swell.length}`);
      const swellFirstCc = Math.min(...swell.map((n) => n.dynamics?.cc11Value ?? 127));
      const crash = cymbals!.notes.find((n) => n.startTick === boundary);
      assert(crash !== undefined && crash.velocityTier === "ACCENT", "crash at the chorus downbeat missing or not ACCENT");
      assert(swellFirstCc < 40 && (crash!.dynamics?.cc11Value ?? 0) >= 110, "cymbal CC11 build does not swell into the boundary");
      const snareRoll = snare!.notes.filter((n) => n.isRoll && n.startTick >= boundary - 2 * barTicks);
      assert(snareRoll.length >= 8, "snare drive under the build missing");
      const ccStream = snareRoll.filter((n) => n.startTick < boundary).map((n) => n.dynamics?.cc11Value ?? 0);
      assert(ccStream.length > 1 && ccStream.every((value, i) => i === 0 || value >= ccStream[i - 1]!), "snare roll CC11 not monotonic");
      assert(timpani!.notes.every((n) => n.startTick >= 0), "onset below zero");
      // The terminating accent: the highest-velocity roll hit, parked in the
      // final grid slot before the boundary (the ramp's top regular hits
      // may themselves reach the ACCENT band — that is fine; the accent is
      // specifically the ≥100 peak that lands last).
      const timpaniAccent = rollHits.reduce((best, n) => (n.velocity > best.velocity ? n : best), rollHits[0]!);
      assert(timpaniAccent.velocity >= 100 && timpaniAccent.velocityTier === "ACCENT" && timpaniAccent.startTick >= boundary - 240, "timpani roll terminating accent missing");
      return `roll ${rollHits.length} hits into the boundary, snare drive ${snareRoll.length}, cymbal swell ${swell.length}+crash@49 (CC11 ${swellFirstCc}→${crash!.dynamics?.cc11Value})`;
    }),
    timed("Percussion engine: chord-root tuning retunes only at ≥2-measure rests, per-track ledger holds", () => {
      // Module 12: tuning follows chord roots across the fixture's Dm7/G7
      // changes, but ONLY where ≥2 measures of timpani silence allow (a real
      // timpanist doesn't pedal mid-phrase); the per-track gesture ledger
      // keeps distinct gestures from ever overlapping (one player per chair).
      // Module 14 strengtheners: M14 ghosts follow every high-energy chorus at
      // 16th density, aux kicks sit at EVERY cadence, timpani follow-hits appear
      // at chord changes (not just span starts), and repeated identical
      // non-drum gestures never re-occur verbatim (occurrence alternation).
      let firstBattery = "";
      const battery = (tracks: Array<{ id: string; notes: Array<{ pitch: number; startTick: number; durationTicks: number; velocity: number }> }>) => JSON.stringify(tracks.filter((t) => ["trk_timpani", "trk_snare", "trk_cymbals", "trk_aux"].includes(t.id)).map((t) => ({ id: t.id, notes: t.notes.map((n) => [n.pitch, n.startTick, n.durationTicks, n.velocity]) })));
      for (const label of ["s6", "s15"] as const) {
        const project = fixture();
        const barTicks = ticksPerBar(project.timeSignature);
        const seed = label === "s6" ? 6 : 15;
        const tracks = generate(project, { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
        const timpani = tracks.find((t) => t.id === "trk_timpani");
        assert(timpani && timpani.notes.length > 0, `timpani content missing (${label})`);
        assert(timpani.notes.every((n) => n.pitch >= 38 && n.pitch <= 57), `timpani range violated (${label})`);
        const sorted = [...timpani.notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
        for (let index = 1; index < sorted.length; index++) {
          if (sorted[index].pitch !== sorted[index - 1].pitch) {
            const gap = sorted[index].startTick - (sorted[index - 1].startTick + sorted[index - 1].durationTicks);
            assert(gap >= 2 * barTicks, `retune without ≥2-measure rest (gap ${gap}, ${label})`);
          }
        }
        for (const trackId of ["trk_cymbals", "trk_snare", "trk_aux"] as const) {
          const track = tracks.find((t) => t.id === trackId);
          const sortedTrack = [...(track?.notes ?? [])].sort((a, b) => a.startTick - b.startTick);
          for (let index = 1; index < sortedTrack.length; index++) {
            assert(sortedTrack[index].startTick >= sortedTrack[index - 1].startTick + sortedTrack[index - 1].durationTicks, `${trackId} overlapping distinct gestures (${label})`);
          }
        }
        // M14 — fixture chorus = 1 span at the piece's p90: ghost 16th pattern
        // (not one-per-beat) must fill ≥3 ghosts per bar across all 8 bars.
        const chorusStart = 8 * barTicks;
        const ghosts = tracks.find((t) => t.id === "trk_snare")!.notes.filter((n) => n.startTick >= chorusStart && n.startTick < 16 * barTicks && n.velocity < 40);
        assert(ghosts.length >= 3 * 8, `fixture chorus ghosts too thin (${ghosts.length} vs ≥24), ${label}`);
        // M14 — aux kick at EVERY cadence (fixture: verse end AND chorus end).
        const aux = tracks.find((t) => t.id === "trk_aux")!.notes;
        assert(aux.some((n) => n.pitch === 36 && Math.abs(n.startTick - (8 * barTicks - 960)) <= 480), `verse-end cadence kick missing (${label})`);
        assert(aux.some((n) => n.pitch === 36 && Math.abs(n.startTick - (16 * barTicks - 960)) <= 480), `chorus-end cadence kick missing (${label})`);
        // M14 — timpani follow hits at mid-piece chord changes (Dm7→G7 at bar 2).
        const boundaryOrCadence = new Set<number>([8 * barTicks, 15 * barTicks, 16 * barTicks]);
        const follows = timpani.notes.filter((n) => n.startTick < 8 * barTicks && !boundaryOrCadence.has(n.startTick));
        assert(follows.length > 0, `timpani chord-change follow hit missing (${label})`);
        if (label === "s6") firstBattery = battery(tracks);
        else assert(firstBattery !== battery(tracks), "cross-seed battery variance lost (M14 D3 law)");
      }
      return "tuning rest law + ledger hold; M14: ghost 16th figures, all-cadence aux kicks, chord-change follows, cross-seed variance";
    }),
    timed("Percussion metadata validators: malletType/velocityTier/isRoll", () => {
      const happy = fixture();
      happy.tracks.find((t) => t.id === "trk_cymbals")!.notes.push({ pitch: 49, startTick: 0, durationTicks: 480, velocity: 116, velocityTier: "ACCENT", malletType: "HARD_WOOD", isRoll: true });
      assert(validateProject(happy).ok, "valid percussion metadata rejected");
      const badTier = fixture();
      badTier.tracks.find((t) => t.id === "trk_cymbals")!.notes.push({ pitch: 49, startTick: 0, durationTicks: 480, velocity: 116, velocityTier: "LOUD" as unknown as "ACCENT" });
      const tierResult = validateProject(badTier);
      assert(!tierResult.ok && tierResult.errors.some((error) => error.includes("velocityTier")), "invalid velocityTier accepted");
      const badMallet = fixture();
      badMallet.tracks.find((t) => t.id === "trk_snare")!.notes.push({ pitch: 38, startTick: 0, durationTicks: 480, velocity: 20, malletType: "x".repeat(33) });
      const malletResult = validateProject(badMallet);
      assert(!malletResult.ok && malletResult.errors.some((error) => error.includes("malletType")), "long malletType accepted");
      const badRoll = fixture();
      badRoll.tracks.find((t) => t.id === "trk_aux")!.notes.push({ pitch: 51, startTick: 0, durationTicks: 480, velocity: 20, isRoll: "yes" as unknown as boolean });
      assert(!validateProject(badRoll).ok, "non-boolean isRoll accepted");
      return "malletType ≤32 chars, velocityTier enum, isRoll boolean validated";
    }),
    timed("Strings module: double-stop validator vectors + panning profiles (export CC10 + config)", () => {
      // Module STRINGS — decision 1 vectors (BOTH S.7 cases pinned explicitly,
      // exact results) and decision 3 export wiring. The sibling cap stays ≤2
      // and the guard bounds tests above are unmodified; the M13 bass-center
      // CC10 write is SUPERSEDED — the default profile CLASSICAL now pins the
      // per-string-track pan (strengthen-only per the scoping note).
      const sameString = validateDoubleStop(57, 60, "violins1");
      assert(!sameString.playable && sameString.reason === "same-string", "violin 60+57 must be same-string INVALID (S.7.1)");
      const nonAdjacent = validateDoubleStop(60, 69, "violins1");
      assert(!nonAdjacent.playable && nonAdjacent.reason === "non-adjacent", "violin 60+69 must be non-adjacent INVALID (S.7.2)");
      const openPair = validateDoubleStop(55, 62, "violins1");
      assert(openPair.playable && !openPair.intonationWarning, "violin 55+62 (open G+D) must be VALID without warning");
      const celloPair = validateDoubleStop(36, 43, "cellos");
      assert(celloPair.playable && !celloPair.intonationWarning, "cello C+G must be VALID without warning");
      const fingered = validateDoubleStop(60, 64, "violins1");
      assert(fingered.playable === true && fingered.intonationWarning === true, "violin 60+64 (G+D fingered) must be VALID + intonation warning");
      const stretch = validateDoubleStop(70, 87, "violins1");
      assert(!stretch.playable && stretch.reason === "hand-stretch", "adjacent-string 17-semitone stretch must be INVALID");
      const belowFloor = validateDoubleStop(30, 43, "violins1");
      assert(!belowFloor.playable && belowFloor.reason === "below-open-string-floor", "pitch under the lowest string must be out of range");
      // Export: CC10@tick0 per string track from CLASSICAL (default); doubleBass 118 —
      // the STUDIO profile carries M13's centered-bass rule.
      const project = fixture();
      const merged = new Midi(exportMergedMidi(project, "all", []));
      const cc10For = (name: string): number | undefined => {
        const toneTrack = merged.tracks.find((t) => t.name === name);
        const events = toneTrack?.controlChanges[10];
        return events?.[0]?.value !== undefined ? Math.round(events[0]!.value * 127) : undefined;
      };
      assert(cc10For("Violins I") === 14, `violins1 CC10 ${cc10For("Violins I")} != 14 (CLASSICAL)`);
      assert(cc10For("Violins II") === 39 && cc10For("Violas") === 77, "viola/violins2 pans off the CLASSICAL table");
      assert(cc10For("Cellos/Basses") === 102, "cellos pan right (was M13-centered)");
      // strings config validation: unknown enums rejected, values accepted
      const badPan = fixture();
      badPan.generationSettings = { ...(badPan.generationSettings ?? DEFAULT_GENERATION_SETTINGS), strings: { panningProfile: "MONO" as "CLASSICAL" } };
      assert(!validateProject(badPan).ok && (validateProject(badPan) as { errors: string[] }).errors.some((e) => e.includes("strings config")), "unknown panningProfile must reject with strings config error");
      const goodConfig = fixture();
      goodConfig.generationSettings = { ...(goodConfig.generationSettings ?? DEFAULT_GENERATION_SETTINGS), strings: { sectionProfile: "CHAMBER_12", panningProfile: "STUDIO_CENTERED_BASS" } };
      assert(validateProject(goodConfig).ok, "valid strings config rejected");
      return "S.7 both vectors pinned; CLASSICAL pans exported per string track; strings config validated";
    }),
    timed("Stage 3c: engineChannel validation (1–16, 'engine channel' style) + collision", () => {
      const project = fixture();
      const v1 = project.tracks.find((t) => t.family === "strings")!;
      const v2 = project.tracks.filter((t) => t.family === "strings")[1] ?? v1;
      v1.engineChannel = 3;
      assert(validateProject(project).ok, "valid engineChannel 3 rejected");
      v1.engineChannel = 0;
      const r0 = validateProject(project);
      assert(!r0.ok && r0.errors.some((e) => e.includes("engineChannel must be an integer 1–16 (engine channel)")), "engineChannel 0 must fail with the engine-channel error style");
      v1.engineChannel = 17;
      const r17 = validateProject(project);
      assert(!r17.ok && r17.errors.some((e) => e.includes("(engine channel)")), "engineChannel 17 must fail");
      v1.engineChannel = 5;
      v2.engineChannel = 5;
      const rCollide = validateProject(project);
      assert(!rCollide.ok && rCollide.errors.some((e) => e.includes("engine channel 5 is already assigned to") && e.includes("(engine channel collision)")), "two tracks on one engine channel must collide");
      delete v2.engineChannel;
      delete (v1 as { engineChannel?: number }).engineChannel;
      assert(validateProject(project).ok, "absent engineChannel must stay valid (additive optional field)");
      return "1–16 enforced, 'engine channel' error style, cross-track collision rejected, absence valid";
    }),
    timed("Stage 3d-4: resolveInstanceRouting — explicit wins (per-instance scope), first-come order, ALL plugin-bound tracks route (universal)", () => {
      const project = fixture();
      // Bind EVERY track to ONE plugin group (profileId + pluginId + path).
      const group = { id: "lg_test", name: "BBCSO Test", pluginId: "uid-1", pluginState: null, profileId: "spitfire-bbcso", pluginPath: "C:/VST3/BBCSO.vst3" };
      project.libraryGroups = [group];
      project.tracks.forEach((t) => { t.libraryGroupId = "lg_test"; });
      const { routing, plugins } = resolveInstanceRouting(project);
      // 3d-4: EVERY plugin-bound INSTRUMENT track routes (the old
      // keys/percussion family gate belonged to the BBCSO-era single-instance
      // model; the user's explicit assignment IS the intent). Structure/
      // chords/audio stay un-routed (they carry no notes — same rule as the
      // event builder).
      project.tracks.forEach((t) => {
        const r = routing[t.id];
        if (t.role === "structure" || t.family === "structure" || t.family === "audio") {
          assert(r === undefined, `${t.family} must stay un-routed (no notes)`);
          return;
        }
        if (r === undefined) return;   // namespace full (16 channels) — documented overflow
        assert(r.inst === "lg_test", `instance must be the group id, got ${r.inst}`);
        assert(r.ch >= 1 && r.ch <= 16, `channel out of namespace: ${r.ch}`);
      });
      // Per-instance channel uniqueness + the 16-channel namespace cap: the
      // fixture binds 20 instrument tracks to ONE instance — exactly 16 route.
      const routed = project.tracks.filter((t) => routing[t.id] !== undefined);
      const chans = routed.map((t) => routing[t.id]!.ch);
      assert(new Set(chans).size === chans.length, "per-instance channel collision in the resolved map");
      assert(chans.length === 16, `namespace cap: expected 16 routed tracks, got ${chans.length}`);
      assert(new Set(chans).size === 16 && chans.every((c) => c >= 1 && c <= 16), "routed channels must fill 1..16 with no gaps");
      // Exactly ONE instance, in the set, carrying the group's binding.
      assert(plugins.length === 1 && plugins[0].instanceId === "lg_test" && plugins[0].uid === "uid-1" && plugins[0].path === "C:/VST3/BBCSO.vst3", "instance set must carry the group's plugin");
      // Explicit wins within its instance and is SKIPPED by the first-come sweep.
      const first = routed[0];   // a ROUTED instrument track (never structure)
      first.engineChannel = 16;
      const resolved2 = resolveInstanceRouting(project);
      assert(resolved2.routing[first.id].ch === 16, "explicit engineChannel must win");
      const routed2 = Object.values(resolved2.routing).map((r) => r.ch);
      assert(new Set(routed2).size === routed2.length, "explicit channel must not collide with the first-come sweep");
      return `${project.tracks.length} plugin-bound tracks routed into ONE instance (explicit 16 skipped); universal — no family gate`;
    }),
    timed("Stage 3d-4: resolveInstanceRouting — TWO groups ⇒ TWO instances, SAME channel namespaces, group order deterministic", () => {
      const project = fixture();
      const gA = { id: "lg_a", name: "BBCSO", pluginId: "uid-a", pluginState: null, profileId: "spitfire-bbcso", pluginPath: "C:/VST3/A.vst3" };
      const gB = { id: "lg_b", name: "Solo Strings", pluginId: "uid-b", pluginState: null, pluginPath: "C:/VST3/B.vst3" };  // NO profileId — raw-notes path
      project.libraryGroups = [gA, gB];
      const tracks = project.tracks.filter((t) => t.family !== "structure" && t.family !== "audio" && t.role !== "structure");
      tracks[0].libraryGroupId = "lg_a";
      tracks[1].libraryGroupId = "lg_b";
      const { routing, plugins } = resolveInstanceRouting(project);
      assert(routing[tracks[0].id].inst === "lg_a" && routing[tracks[0].id].ch === 1, "track 1 → instance A ch1");
      assert(routing[tracks[1].id].inst === "lg_b" && routing[tracks[1].id].ch === 1, "track 2 → instance B ch1 (SAME channel, DIFFERENT instance namespace)");
      assert(plugins.length === 2 && plugins[0].instanceId === "lg_a" && plugins[1].instanceId === "lg_b", "instance set must hold BOTH groups in first-appearance order");
      assert(plugins[1].state === undefined && plugins[1].uid === "uid-b", "profile-less group still hosts (raw-notes path)");
      return "2 instances, both ch1 (per-instance namespaces); profile-less group hosts; order deterministic";
    }),
    timed("Stage 3c: buildEngineStream — deterministic M9 profile path (UACC CC#32 pre-trigger, CC7, remap, trackId)", () => {
      const project = fixture();
      project.bpm = 120;  // pin the arithmetic: 20ms = 38 ticks at 120bpm/960ppqn
      const group = { id: "lg_stream", name: "BBCSO Stream", pluginId: "uid-9", pluginState: null, profileId: "spitfire-bbcso", pluginPath: "/plugins/BBCSO.vst3" };
      project.libraryGroups = [group];
      const strings = project.tracks.filter((t) => t.family === "strings");
      const target = strings[0];
      project.tracks.forEach((t) => { t.libraryGroupId = t === target ? "lg_stream" : null; });
      target.notes = [
        { pitch: 60, startTick: 480, durationTicks: 480, velocity: 90, technique: "SPICCATO" },
        { pitch: 62, startTick: 960, durationTicks: 480, velocity: 80, technique: "LEGATO" },
      ];
      // Give the (unbound) second string track one note BEFORE the build —
      // its notes-only events must appear tagged for engine-side gating.
      const other = strings[1];
      other.notes = [{ pitch: 55, startTick: 240, durationTicks: 240, velocity: 70 }];
      const a = buildEngineStream(project);
      // Determinism: same project ⇒ byte-identical stream (NO RNG).
      const b = buildEngineStream(project);
      assert(JSON.stringify(a) === JSON.stringify(b), "buildEngineStream is not deterministic");
      // Plugin binding: the instance set carries the group (3d-4 shape).
      assert(a.plugins.length === 1 && a.plugins[0].uid === "uid-9" && a.plugins[0].path === "/plugins/BBCSO.vst3", "instance set must come from the group");
      assert(a.plugins[0].instanceId === "lg_stream", "instanceId must be the group id");
      assert(a.routing[target.id]?.inst === "lg_stream" && a.routing[target.id]?.ch === 1, "first-come channel must be 1 within the instance namespace");
      // THE M9 PROFILE PATH: SPICCATO → UACC CC#32=42 exactly 38 ticks before
      // the note (20ms at 120bpm/960ppqn), on the track's ENGINE channel.
      const cc32 = a.events.find((e) => e.eventType === "CONTROL_CHANGE" && e.data1 === 32);
      assert(!!cc32 && cc32.data2 === 42 && cc32.timestampTicks === 442 && cc32.channel === 1 && cc32.trackId === target.id, `UACC CC#32 pre-trigger event wrong: ${JSON.stringify(cc32)}`);
      const noteOn = a.events.find((e) => e.eventType === "NOTE_ON" && e.data1 === 60);
      assert(!!noteOn && noteOn.timestampTicks === 480 && noteOn.channel === 1 && noteOn.trackId === target.id, "note event must ride the engine channel + trackId");
      // CC7 fader from the SAME balance table the exporter uses.
      const cc7 = a.events.find((e) => e.eventType === "CONTROL_CHANGE" && e.data1 === 7);
      assert(!!cc7 && cc7.data2 === cc7ForWeight(acousticWeightForTrack(target)), "CC7 must be cc7ForWeight(acousticWeightForTrack)");
      // The unbound string track keeps notes-only events (test synth), tagged.
      const otherNote = a.events.find((e) => e.trackId === other.id && e.eventType === "NOTE_ON");
      assert(!!otherNote && otherNote.channel === other.midiChannel && a.routing[other.id] === undefined, "unbound track must stay test-synth with trackId tags");
      // Export PARITY: the adapter output (channel-remapped) is the exporter's
      // own translation — no drift in the mapping truth source.
      const profile = builtInProfileById("spitfire-bbcso")!;
      const exported = vst3EventAdapter(target.notes, profile, project.bpm, { endTick: projectEndTick(project) });
      const cc32Export = exported.find((e) => e.eventType === "CONTROL_CHANGE" && e.data1 === 32);
      assert(!!cc32Export && cc32Export.timestampTicks === 442, "export adapter must agree on the pre-trigger tick");
      return "deterministic; CC#32=42 @ 480−38 ticks; CC7 from balance; remap+trackId; unbound tracks test-synth; export parity";
    }),
    timed("Stage 3c: vst3EventAdapter pre-trigger arithmetic — 20ms→38 ticks @120bpm, zero-clamp at transport start", () => {
      assert(Math.round(msToTicks(20, 120)) === 38, "20ms at 120bpm/960ppqn must be 38 ticks");
      const profile = builtInProfileById("spitfire-bbcso")!;
      const early = vst3EventAdapter(
        [{ pitch: 60, startTick: 10, durationTicks: 240, velocity: 80, technique: "SPICCATO" }],
        profile, 120,
      );
      const earlyCc = early.find((e) => e.eventType === "CONTROL_CHANGE" && e.data1 === 32);
      assert(!!earlyCc && earlyCc.timestampTicks === 0, "pre-trigger clamps at tick 0 (transport start) — no negative ticks");
      const late = vst3EventAdapter(
        [{ pitch: 60, startTick: 1042, durationTicks: 240, velocity: 80, technique: "SPICCATO" }],
        profile, 120,
      );
      const lateCc = late.find((e) => e.eventType === "CONTROL_CHANGE" && e.data1 === 32);
      assert(!!lateCc && lateCc.timestampTicks === 1004, "1042 − 38 = 1004 (real pre-trigger, no clamp)");
      return "20ms = 38 ticks @120bpm; clamp only at transport start; real offsets elsewhere";
    }),
    timed("Stage 3f-2: mergeScanProbe — probe results merge by classId, NEVER remove/change rows", () => {
      const rows: ScannedPlugin[] = [
        { name: "Synth A", vendor: "V", uid: "1", path: "/p/A.vst3", classId: "cid-a" },
        { name: "Crashy B", vendor: "V", uid: "2", path: "/p/B.vst3", classId: "cid-b" },
      ];
      // Success merge: capabilities land on the RIGHT row; identity untouched.
      const caps = { name: "Synth A", vendor: "V", version: "", isInstrument: true, acceptsMidi: true, producesMidi: false, isMidiEffect: false, hasEditor: false, numPrograms: 1, latencySamples: 0, tailSeconds: 0, supportsDoublePrecision: false, inputBuses: 0, outputBuses: 1, classId: "cid-a", buses: [] };
      const okMerged = mergeScanProbe(rows, { type: "scan_probe", classId: "cid-a", capabilities: caps });
      assert(okMerged.length === 2, "a probe must never add rows");
      assert(okMerged[0].capabilities === caps && !okMerged[0].capabilitiesError, "capabilities merge into the matching row");
      assert(okMerged[1] === rows[1], "other rows keep their reference");
      // Failure merge: the row STAYS at the same index with the same identity,
      // gaining only the capabilitiesError annotation.
      const errMerged = mergeScanProbe(rows, { type: "scan_probe", classId: "cid-b", capabilitiesError: "probe worker crashed (exit 3)" });
      assert(errMerged.length === 2 && errMerged[1].name === "Crashy B" && errMerged[1].path === "/p/B.vst3", "a failed probe never removes or re-identifies the row");
      assert(errMerged[1].capabilitiesError === "probe worker crashed (exit 3)", "failed probe stores its capabilitiesError annotation");
      assert(errMerged[0] === rows[0], "successful rows untouched by other probes' failures");
      // Unknown classId: array returned by reference (no state churn).
      const unknown = mergeScanProbe(rows, { type: "scan_probe", classId: "cid-unknown", capabilities: caps });
      assert(unknown === rows, "a probe for an unknown classId is ignored entirely");
      return "merge-by-classId keeps row count/identity/order; error rows stay listed with their annotation; unknown probes ignored";
    }),
  ];
}

export function runAlignmentTest(root: HTMLElement): TestResult {
  return timed("Header/lane alignment before and after scroll", () => {
    const scroll = root.matches("[data-arranger-scroll]") ? root : root.querySelector<HTMLElement>("[data-arranger-scroll]");
    if (!scroll) throw new Error("arranger not mounted");
    const headers = [...scroll.querySelectorAll<HTMLElement>("[data-header-id]")];
    assert(headers.length > 0, "no track headers found");
    const check = () => headers.forEach((header) => {
      const id = header.getAttribute("data-header-id");
      const lane = scroll.querySelector<HTMLElement>(`[data-lane-id="${id}"]`);
      assert(lane, `missing lane for ${id}`);
      assert(Math.abs(header.getBoundingClientRect().top - lane.getBoundingClientRect().top) <= 1, `header/lane misalignment for ${id}`);
    });
    check();
    const previous = scroll.scrollTop;
    scroll.scrollTop = Math.min(scroll.scrollHeight, previous + 240);
    check();
    scroll.scrollTop = previous;
    return `${headers.length} aligned rows`;
  });
}
