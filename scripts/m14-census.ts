/**
 * Module 14 — Percussion Diagnosis & v2 Variety. PHASE 0 CENSUS (D1–D3).
 * Run: npx tsx scripts/m14-census.ts   (read-only; no source changes involved)
 *
 * D1  per track (timpani/snare/cymbals/aux) × seed (1..20) × body (USER + FIXTURE):
 *     total notes, distinct rhythm patterns (normalized onset-interval signatures),
 *     distinct pitch sets, distinct dynamic (tier-sequence) curves, and distinct
 *     COMBINED figures (the headline number).
 * D2  gate audit: every content rule's exact gate condition vs the body's actual
 *     measure-energy distribution (p10/p50/p75/p90/max) + span-level fire counts.
 * D3  cross-seed variance: byte-compare extracted percussion notes across seeds.
 */
import dorianFixture from "../src/fixtures/dorian-16bars.json";
import userProjectJson from "../src/fixtures/user-project.json";
import { generate } from "../src/generation/generate";
import { cloneProject } from "../src/shared/schema/factory";
import { importProjectJson } from "../src/export/json";
import { type Note, type Project, type Track } from "../src/shared/schema/types";
import { buildMeasureProfiles } from "../src/generation/arrangement";
import { DEFAULT_ARRANGEMENT_CONFIG } from "../src/generation/arrangement";

const loaded = importProjectJson(JSON.stringify(userProjectJson));
if (!loaded.ok) throw new Error(loaded.errors.join("; "));
const BODIES: Array<[string, Project]> = [
  ["USER", loaded.project],
  ["FIXTURE", cloneProject(dorianFixture as unknown as Project)],
];
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const TRACK_IDS = ["trk_timpani", "trk_snare", "trk_cymbals", "trk_aux"] as const;

// ------------------------------------------------ figure extraction (D1)

/** A "figure" = one contiguous gesture cluster (notes separated by > 3 bars are
 * new gestures — matches the engine's roll/hit cadence), described by
 *  - onset pattern: inter-onset gaps quantized to 16ths, relative to cluster start,
 *  - pitch set: sorted distinct pitches,
 *  - dynamic curve: velocity-tier sequence (GHOST <40, GROOVE ≤90, ACCENT >90),
 *  - roll flag: whole-cluster isRoll state.
 * Two clusters with the same signature are the SAME figure. */
interface Cluster { sig: string; notes: Note[] }
function tierOf(v: number): string { return v < 40 ? "G" : v <= 90 ? "M" : "A"; }

function clusters(notes: Note[], barTicks: number): Cluster[] {
  const sorted = [...notes].sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch);
  const gapLimit = 3 * barTicks;
  const out: Cluster[] = [];
  let current: Note[] = [];
  for (const note of sorted) {
    if (current.length && note.startTick - current[current.length - 1]!.startTick > gapLimit) {
      out.push(signature(current));
      current = [];
    }
    current.push(note);
  }
  if (current.length) out.push(signature(current));
  return out;
}
function signature(notes: Note[]): Cluster {
  const start = notes[0]!.startTick;
  const gaps = notes.map((n) => n.startTick - start);
  const inter = gaps.slice(1).map((g, i) => g - gaps[i]!);
  const step16 = 240; // ticksPerBeat(4/4)/4 — census normalization is body-independent
  const q = inter.map((g) => Math.round(g / step16 / 4) / 4); // quantize in beats
  const pitchSet = [...new Set(notes.map((n) => n.pitch))].sort((a, b) => a - b).join(",");
  const tiers = notes.map((n) => tierOf(n.velocity)).join("");
  const rolls = notes.filter((n) => n.isRoll).length;
  return {
    sig: `onset[${q.map((v) => v).join(",")}]pitch${pitchSet}tier${tiers}roll${rolls > 0 ? "Y" : "N"}`,
    notes,
  };
}

// ------------------------------------------------ D2 gate audit data

function energyStats(values: number[]): string {
  if (!values.length) return "n/a";
  const s = [...values].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.floor((s.length - 1) * p)]!.toFixed(3);
  return `n=${s.length} min=${pct(0).toFixed ? s[0]!.toFixed(3) : ""} p10=${pct(0.1)} p50=${pct(0.5)} p75=${pct(0.75)} p90=${pct(0.9)} max=${s[s.length - 1]!.toFixed(3)}`;
}

for (const [body, base] of BODIES) {
  console.log(`\n=============== BODY ${body} (${base.name}) ===============`);
  // D2: measure-energy distribution + section spans.
  const measures = buildMeasureProfiles(base, DEFAULT_ARRANGEMENT_CONFIG);
  const byType = new Map<string, number[]>();
  for (const m of measures) {
    const list = byType.get(m.sectionType) ?? [];
    list.push(m.energy);
    byType.set(m.sectionType, list);
  }
  console.log(`D2 measure energies ALL: ${energyStats(measures.map((m) => m.energy))}`);
  for (const [type, list] of [...byType].sort()) console.log(`D2 ${type.padEnd(10)}: ${energyStats(list)}`);
  const barTicks = 3840; // both bodies are 4/4
  const typeOf = (m: (typeof measures)[number]) => m.sectionType;
  // Span audit at the exact granularity the engine sees.
  const spans: Array<{ type: string; start: number; end: number; peak: number; high: boolean }> = [];
  for (const m of measures) {
    const prev = spans[spans.length - 1];
    if (prev && prev.type === typeOf(m)) { prev.end = m.endTick; prev.peak = Math.max(prev.peak, m.energy); prev.high = prev.high || m.maxSubdivisionsPerBeat >= 4; continue; }
    spans.push({ type: typeOf(m), start: m.startTick, end: m.endTick, peak: m.energy, high: m.maxSubdivisionsPerBeat >= 4 });
  }
  console.log(`D2 spans: ${spans.map((s) => `${s.type}@${s.start / barTicks}–${s.end / barTicks}bar pk=${s.peak.toFixed(2)} hi=${s.high ? 1 : 0}`).join(" | ")}`);
  console.log(`D2 GATES — exact conditions vs this body:
  snare-ghost      : Chorus span && highEnergy                → fires: ${spans.filter((s) => s.type === "Chorus" && s.high).length}/${spans.filter((s) => s.type === "Chorus").length} chorus spans
  aux-pulse        : Chorus span && highEnergy                → fires: (same predicate as ghosts)
  aux-kick/cadence : Chorus span end                          → fires: ${spans.filter((s) => s.type === "Chorus").length} ends
  timpani-roll     : Build span                               → fires: ${spans.filter((s) => s.type === "Build").length} build spans
  timpani-hit      : Chorus span start                        → fires: ${spans.filter((s) => s.type === "Chorus").length} chorus starts
  timpani-retune   : ≥2-bar gap before window                 → (ledger)
  cymbal-tutti     : non-Chorus span && highEnergy            → fires: ${spans.filter((s) => s.type !== "Chorus" && s.high).length} spans
  build-roll       : Build span (fixed LAST 2 bars)           → fires: ${spans.filter((s) => s.type === "Build").length} builds
  pre-chorus-roll  : PreChorus span                           → fires: ${spans.filter((s) => s.type === "PreChorus").length} pre-choruses`);

  // D1 + D3
  const perSeedSignatureSets = new Map<string, string[]>();
  const unionSignatures = new Map<string, string[]>();
  const seedHashes = new Map<number, string>();
  for (const seed of SEEDS) {
    const tracks = generate(cloneProject(base), { seed, density: 0.75, humanize: false, lockedTrackIds: [] });
    seedHashes.set(seed, JSON.stringify(tracks.filter((t) => (TRACK_IDS as readonly string[]).includes(t.id)).map((t) => ({ id: t.id, notes: t.notes.map((n) => [n.pitch, n.startTick, n.durationTicks, n.velocity]) }))));
    const bar = tracks ? barTicks : barTicks;
    for (const id of TRACK_IDS) {
      const track: Track | undefined = tracks.find((t) => t.id === id);
      const cls = clusters(track?.notes ?? [], bar);
      const listForSeed = perSeedSignatureSets.get(id) ?? [];
      listForSeed.push(String(cls.length));
      perSeedSignatureSets.set(id, listForSeed);
    }
    // distinct figures across the seed via union of signatures
    for (const id of TRACK_IDS) {
      const track = tracks.find((t) => t.id === id);
      const cls = clusters(track?.notes ?? [], bar);
      const set = unionSignatures.get(id) ?? [];
      for (const c of cls) if (!set.includes(c.sig)) set.push(c.sig);
      unionSignatures.set(id, set);
    }
    if (seed === 1) {
      for (const id of TRACK_IDS) {
        const track = tracks.find((t) => t.id === id);
        const n = track?.notes ?? [];
        const pitchSets = [...new Set([JSON.stringify([...new Set(n.map((x) => x.pitch))].sort((a, b) => a - b))])];
        console.log(`D1 seed1 ${id}: notes=${n.length}`);
        console.log(`   pitchSets=${pitchSets.join(" ")}`);
      }
    }
  }
  console.log(`D1 clusters-per-seed (e.g., 20 seeds, truncated): ${[...perSeedSignatureSets].map(([id, v]) => `${id}=[${v.slice(0, 6).join(",")}…]`).join("  ")}`);
  console.log(`D1 DISTINCT FIGURES (union over 20 seeds): ${[...unionSignatures].map(([id, v]) => `${id}=${v.length}`).join("  ")}`);
  // D3: cross-seed byte-check
  const uniqueOutputs = new Set(seedHashes.values());
  console.log(`D3 cross-seed byte-identical percussion outputs: ${uniqueOutputs.size} distinct over ${SEEDS.length} seeds → variance ${uniqueOutputs.size > 1 ? ">0" : "ZERO"}`);
}
