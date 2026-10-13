import {
  DEFAULT_EXPRESSION_MAPPING,
  DEFAULT_GENERATION_SETTINGS,
  FAMILY_COLORS,
  INSTRUMENT_RANGES,
  SCHEMA_VERSION,
  type Family,
  type InstrumentRole,
  type Project,
  type Track,
} from "./types";

export interface DefaultTrackDef {
  id: string;
  name: string;
  family: Family;
  role: InstrumentRole;
}

export const DEFAULT_TRACK_DEFS: DefaultTrackDef[] = [
  { id: "trk_structure", name: "Structure", family: "structure", role: "structure" },
  { id: "trk_chords", name: "Chords", family: "structure", role: "chords" },
  { id: "trk_audio", name: "Reference Audio", family: "audio", role: "audio" },
  { id: "trk_violins_i", name: "Violins I", family: "strings", role: "violins1" },
  { id: "trk_violins_ii", name: "Violins II", family: "strings", role: "violins2" },
  { id: "trk_violas", name: "Violas", family: "strings", role: "violas" },
  { id: "trk_cellos", name: "Cellos/Basses", family: "strings", role: "cellos" },
  { id: "trk_horns", name: "French Horns", family: "brass", role: "horns" },
  { id: "trk_trumpets", name: "Trumpets", family: "brass", role: "trumpets" },
  { id: "trk_trombones", name: "Trombones", family: "brass", role: "trombones" },
  { id: "trk_tuba", name: "Tuba", family: "brass", role: "tuba" },
  { id: "trk_flutes", name: "Flutes", family: "woodwinds", role: "flutes" },
  { id: "trk_oboes", name: "Oboes", family: "woodwinds", role: "oboes" },
  { id: "trk_clarinets", name: "Clarinets", family: "woodwinds", role: "clarinets" },
  { id: "trk_bassoons", name: "Bassoons", family: "woodwinds", role: "bassoons" },
  { id: "trk_timpani", name: "Timpani", family: "percussion", role: "timpani" },
  { id: "trk_snare", name: "Snare", family: "percussion", role: "snare" },
  { id: "trk_cymbals", name: "Cymbals", family: "percussion", role: "cymbals" },
  { id: "trk_aux", name: "Aux", family: "percussion", role: "aux" },
  { id: "trk_piano", name: "Piano", family: "keys", role: "piano" },
  { id: "trk_harp", name: "Harp", family: "keys", role: "harp" },
];

export function makeId(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}

export function makeTrack(def: DefaultTrackDef, midiChannel: number): Track {
  const range = INSTRUMENT_RANGES[def.role] ?? INSTRUMENT_RANGES.custom;
  return {
    id: def.id,
    name: def.name,
    family: def.family,
    color: FAMILY_COLORS[def.family],
    role: def.role,
    lowestNote: range.low,
    highestNote: range.high,
    locked: false,
    muted: false,
    soloed: false,
    expressionMapping: { ...DEFAULT_EXPRESSION_MAPPING },
    libraryGroupId: null,
    midiChannel,
    frozen: false,
    notes: [],
  };
}

export function createDefaultProject(name = "Untitled"): Project {
  let channel = 1;
  const tracks: Track[] = DEFAULT_TRACK_DEFS.map((def) => {
    const isInstrument = def.family !== "structure" && def.family !== "audio";
    const ch = isInstrument ? channel : 1;
    if (isInstrument) channel = channel >= 16 ? 1 : channel + 1;
    return makeTrack(def, ch);
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    name,
    bpm: 120,
    tempoMap: [{ tick: 0, bpm: 120 }],
    timeSignature: { numerator: 4, denominator: 4 },
    key: 0,
    mode: "ionian",
    generationSettings: JSON.parse(JSON.stringify(DEFAULT_GENERATION_SETTINGS)),
    sections: [{ id: "sec_form", name: "Form", startBar: 1, lengthBars: 16, targetDynamic: 0.55, densityLevel: "Balanced" }],
    chords: [],
    referenceAudio: { path: "", offsetMs: 0 },
    tracks,
    libraryGroups: [],
  };
}

export function createAddedTrack(family: Family, name?: string): Track {
  const role: InstrumentRole = family === "structure" ? "structure" : family === "audio" ? "audio" : "custom";
  const range = INSTRUMENT_RANGES[role] ?? INSTRUMENT_RANGES.custom;
  const labels: Record<Family, string> = {
    structure: "Section",
    audio: "Audio",
    strings: "Strings",
    brass: "Brass",
    woodwinds: "Woodwinds",
    percussion: "Percussion",
    keys: "Keys",
  };
  return {
    id: makeId("trk"),
    name: name ?? `New ${labels[family]}`,
    family,
    color: FAMILY_COLORS[family],
    role,
    lowestNote: range.low,
    highestNote: range.high,
    locked: false,
    muted: false,
    soloed: false,
    expressionMapping: { ...DEFAULT_EXPRESSION_MAPPING },
    libraryGroupId: null,
    midiChannel: 1,
    frozen: false,
    notes: [],
  };
}

/** Pick the least-used MIDI channel (1–16) among instrument tracks; ties go to the lowest channel. */
export function nextMidiChannel(tracks: Track[]): number {
  const counts = new Array<number>(17).fill(0);
  for (const t of tracks) {
    if (t.family === "structure" || t.family === "audio") continue;
    const ch = t.midiChannel;
    if (ch >= 1 && ch <= 16) counts[ch] += 1;
  }
  let best = 1;
  for (let ch = 2; ch <= 16; ch++) {
    if (counts[ch] < counts[best]) best = ch;
  }
  return best;
}

export function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}
