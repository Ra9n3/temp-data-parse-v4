import type { PitchClass } from "./types";

export type ChordQuality =
  | "major"
  | "minor"
  | "diminished"
  | "augmented"
  | "sus2"
  | "sus4"
  | "6"
  | "7"
  | "maj7"
  | "m7"
  | "m7b5"
  | "dim7"
  | "9"
  | "add9"
  | "m9"
  | "maj9"
  | "11"
  | "13"
  | "m6"
  | "7sus4"
  | "aug7"
  | "power"
  | "alt";

export interface ParsedChord {
  symbol: string;
  root: PitchClass;
  quality: ChordQuality;
  extensions: string[];
  bass: PitchClass | null;
  /** Pitch classes in voicing order from the root (root, 3rd, 5th, 7th…). */
  pitchClasses: number[];
}

export interface ChordParseError {
  ok: false;
  error: string;
  symbol: string;
}

export interface ChordParseOk {
  ok: true;
  chord: ParsedChord;
}

export type ChordParseResult = ChordParseOk | ChordParseError;

const NOTE_PC: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function parseNoteToken(input: string): { pc: PitchClass; rest: string } | null {
  const m = input.match(/^([A-Ga-g])([#♯b♭]?)/);
  if (!m) return null;
  const letter = m[1].toUpperCase();
  let pc = NOTE_PC[letter];
  if (pc === undefined) return null;
  const acc = m[2];
  if (acc === "#" || acc === "♯") pc = (pc + 1) % 12;
  else if (acc === "b" || acc === "♭") pc = (pc + 11) % 12;
  return { pc: pc as PitchClass, rest: input.slice(m[0].length) };
}

interface QualityMatch {
  quality: ChordQuality;
  intervals: number[];
  consumed: string;
  extensions: string[];
}

const QUALITY_TABLE: Array<{
  re: RegExp;
  quality: ChordQuality;
  intervals: number[];
  extensions?: string[];
}> = [
  { re: /^(maj|Δ|∆|M)7[#♯]11/, quality: "maj7", intervals: [0, 4, 7, 11, 18], extensions: ["#11"] },
  { re: /^(maj|Δ|∆|M)13/, quality: "13", intervals: [0, 4, 7, 11, 14, 21], extensions: ["13"] },
  { re: /^(maj|Δ|∆|M)11/, quality: "11", intervals: [0, 4, 7, 11, 14, 17], extensions: ["11"] },
  { re: /^(maj|Δ|∆|M)9/, quality: "maj9", intervals: [0, 4, 7, 11, 14], extensions: ["9"] },
  { re: /^(maj7|ma7|Δ7|∆7|M7)/, quality: "maj7", intervals: [0, 4, 7, 11] },
  { re: /^(maj|Δ|∆)/, quality: "major", intervals: [0, 4, 7] },
  { re: /^(min7b5|m7b5|m7♭5|ø7|ø|h7|mi7b5)/, quality: "m7b5", intervals: [0, 3, 6, 10] },
  { re: /^(minmaj7|mmaj7|mM7|mΔ7)/, quality: "m7", intervals: [0, 3, 7, 11], extensions: ["maj7"] },
  { re: /^(min9|mi9|m9)/, quality: "m9", intervals: [0, 3, 7, 10, 14], extensions: ["9"] },
  { re: /^(min11|mi11|m11)/, quality: "11", intervals: [0, 3, 7, 10, 14, 17], extensions: ["11"] },
  { re: /^(min7|mi7|m7|-7)/, quality: "m7", intervals: [0, 3, 7, 10] },
  { re: /^(min6|mi6|m6)/, quality: "m6", intervals: [0, 3, 7, 9] },
  { re: /^(min|mi|m(?![aj]))/, quality: "minor", intervals: [0, 3, 7] },
  { re: /^(-)(?!\d)/, quality: "minor", intervals: [0, 3, 7] },
  { re: /^(dim7|°7|o7)/, quality: "dim7", intervals: [0, 3, 6, 9] },
  { re: /^(dim|°|o)(?!n)/, quality: "diminished", intervals: [0, 3, 6] },
  { re: /^(aug7|\+7)/, quality: "aug7", intervals: [0, 4, 8, 10] },
  { re: /^(aug|\+)/, quality: "augmented", intervals: [0, 4, 8] },
  { re: /^(7sus4|7sus)/, quality: "7sus4", intervals: [0, 5, 7, 10] },
  { re: /^(9sus4|9sus)/, quality: "9", intervals: [0, 5, 7, 10, 14], extensions: ["sus4", "9"] },
  { re: /^(sus2)/, quality: "sus2", intervals: [0, 2, 7] },
  { re: /^(sus4|sus)/, quality: "sus4", intervals: [0, 5, 7] },
  { re: /^(add9)/, quality: "add9", intervals: [0, 4, 7, 14] },
  { re: /^(add11)/, quality: "add9", intervals: [0, 4, 7, 17], extensions: ["add11"] },
  { re: /^(add4)/, quality: "add9", intervals: [0, 4, 7, 5], extensions: ["add4"] },
  { re: /^(add2)/, quality: "add9", intervals: [0, 4, 7, 2], extensions: ["add2"] },
  { re: /^(7b9|7♭9)/, quality: "7", intervals: [0, 4, 7, 10, 13], extensions: ["b9"] },
  { re: /^(7[#♯]9)/, quality: "7", intervals: [0, 4, 7, 10, 15], extensions: ["#9"] },
  { re: /^(7b5|7♭5)/, quality: "7", intervals: [0, 4, 6, 10], extensions: ["b5"] },
  { re: /^(7[#♯]5|7\+)/, quality: "7", intervals: [0, 4, 8, 10], extensions: ["#5"] },
  { re: /^(7alt|alt)/, quality: "alt", intervals: [0, 4, 8, 10, 13, 15], extensions: ["alt"] },
  { re: /^(6\/9|69)/, quality: "6", intervals: [0, 4, 7, 9, 14], extensions: ["9"] },
  { re: /^(13)/, quality: "13", intervals: [0, 4, 7, 10, 14, 21] },
  { re: /^(11)/, quality: "11", intervals: [0, 4, 7, 10, 14, 17] },
  { re: /^(9)/, quality: "9", intervals: [0, 4, 7, 10, 14] },
  { re: /^(6)/, quality: "6", intervals: [0, 4, 7, 9] },
  { re: /^(7)/, quality: "7", intervals: [0, 4, 7, 10] },
  { re: /^(5)/, quality: "power", intervals: [0, 7] },
  { re: /^(2)/, quality: "sus2", intervals: [0, 2, 7] },
];

function matchQuality(rest: string): QualityMatch {
  const trimmed = rest.trim();
  if (!trimmed) {
    return { quality: "major", intervals: [0, 4, 7], consumed: "", extensions: [] };
  }
  for (const row of QUALITY_TABLE) {
    const m = trimmed.match(row.re);
    if (m) {
      return {
        quality: row.quality,
        intervals: [...row.intervals],
        consumed: m[0],
        extensions: row.extensions ? [...row.extensions] : [],
      };
    }
  }
  return { quality: "major", intervals: [0, 4, 7], consumed: "", extensions: [] };
}

const ALTER_RE = /([#♯b♭])(13|11|9|5)/g;
const EXTRA_EXTENSION_INTERVALS: Record<string, number> = { "7": 10, maj7: 11, "9": 14, "b9": 13, "#9": 15, "11": 17, "#11": 18, "13": 21, b13: 20 };

function applyAlteration(intervals: number[], acc: string, degree: string): void {
  const isFlat = acc === "b" || acc === "♭";
  const map: Record<string, { natural: number; replace?: number }> = {
    "5": { natural: 7, replace: 7 },
    "9": { natural: 14 },
    "11": { natural: 17 },
    "13": { natural: 21 },
  };
  const spec = map[degree];
  if (!spec) return;
  const target = spec.natural + (isFlat ? -1 : 1);
  const idx = intervals.findIndex((iv) => iv % 12 === spec.natural % 12 && iv !== 0);
  if (idx >= 0) intervals[idx] = target;
  else intervals.push(target);
}

function intervalsToPitchClasses(root: number, intervals: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  const sorted = [...intervals].sort((a, b) => a - b);
  for (const iv of sorted) {
    const pc = (root + iv + 120) % 12;
    if (!seen.has(pc)) {
      seen.add(pc);
      out.push(pc);
    }
  }
  return out;
}

/**
 * Parse a chord symbol. Never throws — invalid input returns an error value.
 */
export function parseChord(symbol: string): ChordParseResult {
  if (typeof symbol !== "string") {
    return { ok: false, error: "Chord symbol must be a string", symbol: String(symbol) };
  }
  const raw = symbol.trim();
  if (!raw) return { ok: false, error: "Empty chord symbol", symbol };

  const slash = raw.split("/");
  if (slash.length > 2) {
    return { ok: false, error: "Too many slashes in chord symbol", symbol };
  }
  const main = slash[0].trim();
  const bassRaw = slash[1]?.trim() ?? null;

  const rootTok = parseNoteToken(main);
  if (!rootTok) {
    return { ok: false, error: `Could not parse root from "${raw}"`, symbol };
  }

  let rest = rootTok.rest.trim();
  // Treat a leading "-" as minor only when not a bare hyphen garbage.
  const q = matchQuality(rest);
  rest = rest.slice(q.consumed.length);

  const intervals = [...q.intervals];
  const extensions = [...q.extensions];
  const qualityExtension: Partial<Record<ChordQuality, string>> = { "7": "7", maj7: "maj7", "9": "9", maj9: "9", "11": "11", "13": "13", m9: "9" };
  if (qualityExtension[q.quality] && !extensions.includes(qualityExtension[q.quality]!)) extensions.push(qualityExtension[q.quality]!);

  rest = rest.replace(ALTER_RE, (full, acc: string, degree: string) => {
    applyAlteration(intervals, acc, degree);
    extensions.push(full);
    return "";
  });

  rest = rest.replace(/\s+/g, "");
  while (rest) {
    const match = rest.match(/^(maj7|7|b9|#9|9|#11|11|b13|13)/i);
    if (!match) return { ok: false, error: `Unrecognized chord quality in "${raw}" (leftover "${rest}")`, symbol };
    const extension = match[1].toLowerCase();
    intervals.push(EXTRA_EXTENSION_INTERVALS[extension]);
    if (!extensions.includes(extension)) extensions.push(extension);
    rest = rest.slice(match[0].length);
  }

  let bass: PitchClass | null = null;
  if (bassRaw) {
    const b = parseNoteToken(bassRaw);
    if (!b || b.rest.trim() !== "") {
      return { ok: false, error: `Could not parse slash bass "${bassRaw}"`, symbol };
    }
    bass = b.pc;
  }

  return {
    ok: true,
    chord: {
      symbol: raw,
      root: rootTok.pc,
      quality: q.quality,
      extensions,
      bass,
      pitchClasses: intervalsToPitchClasses(rootTok.pc, intervals),
    },
  };
}

export function chordToneMidi(
  pitchClasses: number[],
  low: number,
  high: number,
): number[] {
  const out: number[] = [];
  for (let n = low; n <= high; n++) {
    if (pitchClasses.includes(n % 12)) out.push(n);
  }
  return out;
}

export function nearestTone(
  from: number,
  pitchClasses: number[],
  low: number,
  high: number,
): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (let n = low; n <= high; n++) {
    if (!pitchClasses.includes(n % 12)) continue;
    const d = Math.abs(n - from);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  return best;
}

export function fitPitchClass(pc: number, low: number, high: number, prefer: number): number {
  let best = low;
  let bestDist = Infinity;
  for (let n = low; n <= high; n++) {
    if (n % 12 !== ((pc % 12) + 12) % 12) continue;
    const d = Math.abs(n - prefer);
    if (d < bestDist) {
      bestDist = d;
      best = n;
    }
  }
  if (bestDist === Infinity) {
    return Math.max(low, Math.min(high, prefer));
  }
  return best;
}
