import type { InstrumentProfile as PipelineInstrumentProfile } from "./generate";
import {
  INSTRUMENT_DATABASE,
  type InstrumentFamily as DbFamily,
  type InstrumentProfile as DbProfile,
} from "./instrumentDB";

const FAMILY_MAP: Record<DbFamily, string> = {
  STRINGS: "strings",
  WOODWINDS: "woodwinds",
  BRASS: "brass",
  KEYBOARDS: "keys",
  PITCHED_PERCUSSION: "percussion",
};

/** Existing allocator candidates rely on the canonical role spellings below. */
const ROLE_MAP: Record<string, string> = {
  violin_1: "violins1",
  violin_2: "violins2",
  viola: "violas",
  cello: "cellos",
  french_horn: "horns",
  flute: "flutes",
  oboe: "oboes",
  clarinet_bb: "clarinets",
  bassoon: "bassoons",
  trumpet_bb: "trumpets",
  piccolo: "piccolo",
  english_horn: "englishHorn",
  bass_clarinet: "bassClarinet",
  double_bass: "doubleBass",
  tenor_trombone: "trombones",
  bass_trombone: "bassTrombone",
  tuba: "tuba",
  timpani: "timpani",
  glockenspiel: "glockenspiel",
  xylophone: "xylophone",
  marimba: "marimba",
  vibraphone: "vibraphone",
  celesta: "celesta",
};

const DB_ID_BY_PIPELINE_ROLE: Record<string, string> = {
  violins1: "violin_1",
  violins2: "violin_2",
  violas: "viola",
  cellos: "cello",
  horns: "french_horn",
  flutes: "flute",
  oboes: "oboe",
  clarinets: "clarinet_bb",
  bassoons: "bassoon",
  trumpets: "trumpet_bb",
  trombones: "tenor_trombone",
  piccolo: "piccolo",
  englishHorn: "english_horn",
  bassClarinet: "bass_clarinet",
  doubleBass: "double_bass",
  bassTrombone: "bass_trombone",
  tuba: "tuba",
  timpani: "timpani",
  glockenspiel: "glockenspiel",
  xylophone: "xylophone",
  marimba: "marimba",
  vibraphone: "vibraphone",
  celesta: "celesta",
};

function adaptProfile(db: DbProfile): PipelineInstrumentProfile {
  const role = ROLE_MAP[db.id];
  if (!role) throw new Error(`No generation role mapping for instrument database id: ${db.id}`);
  return {
    id: db.id,
    role,
    displayName: db.displayName,
    family: FAMILY_MAP[db.family],
    transpositionSemitones: -db.transpositionSemitones,
    writtenRange: { low: db.rangeWritten.professionalMin, high: db.rangeWritten.professionalMax },
    comfortableRange: { low: db.rangeWritten.practicalMin, high: db.rangeWritten.practicalMax },
    registers: db.registers,
    carryingPowerWeight: db.carryingPowerWeight,
    unisonBlendingGroup: db.unisonBlendingGroup,
  };
}

const SUPPLEMENTAL_PROFILES: PipelineInstrumentProfile[] = [
  {
    id: "Harp_Section",
    role: "harp",
    family: "keys",
    writtenRange: { low: 23, high: 104 },
    comfortableRange: { low: 40, high: 88 },
    carryingPowerWeight: 0.35,
  },
  {
    id: "Piano_Section",
    role: "piano",
    family: "keys",
    writtenRange: { low: 21, high: 108 },
    comfortableRange: { low: 36, high: 92 },
    carryingPowerWeight: 0.6,
  },
];

/**
 * Converts the full 23-instrument database to pipeline profiles. Database and
 * pipeline transposition signs differ, so this adapter is the sole negation point.
 */
export function dbInstrumentIdForPipelineRole(role: string): string | undefined {
  return DB_ID_BY_PIPELINE_ROLE[role];
}

export function buildPipelineProfiles(): PipelineInstrumentProfile[] {
  return [...INSTRUMENT_DATABASE.map(adaptProfile), ...SUPPLEMENTAL_PROFILES.map((profile) => ({ ...profile }))];
}

export function pipelineRoleForDbInstrument(id: string): string | undefined {
  return ROLE_MAP[id];
}

export function databaseProfileForPipelineRole(role: string): DbProfile | undefined {
  const dbId = DB_ID_BY_PIPELINE_ROLE[role];
  return dbId ? INSTRUMENT_DATABASE.find((profile) => profile.id === dbId) : undefined;
}
