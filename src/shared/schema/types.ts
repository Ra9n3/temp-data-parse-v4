/** Scorch project schema — fixed contract for all milestones. Time is ticks at 960 PPQ. */

export const SCHEMA_VERSION = 1;
export const PPQ = 960;

export type PitchClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export const PITCH_CLASS_NAMES = [
  "C",
  "C#",
  "D",
  "Eb",
  "E",
  "F",
  "F#",
  "G",
  "Ab",
  "A",
  "Bb",
  "B",
] as const;

export const PITCH_CLASS_LABELS: Record<number, string> = {
  0: "C",
  1: "C#",
  2: "D",
  3: "Eb",
  4: "E",
  5: "F",
  6: "F#",
  7: "G",
  8: "Ab",
  9: "A",
  10: "Bb",
  11: "B",
};

export type ModeName =
  | "ionian"
  | "dorian"
  | "phrygian"
  | "lydian"
  | "mixolydian"
  | "aeolian"
  | "locrian"
  | "harmonic-minor"
  | "melodic-minor"
  | "whole-tone"
  | "diminished-half-whole"
  | "diminished-whole-half";

export const MODE_NAMES: ModeName[] = [
  "ionian",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "aeolian",
  "locrian",
  "harmonic-minor",
  "melodic-minor",
  "whole-tone",
  "diminished-half-whole",
  "diminished-whole-half",
];

export const MODE_LABELS: Record<ModeName, string> = {
  ionian: "Ionian",
  dorian: "Dorian",
  phrygian: "Phrygian",
  lydian: "Lydian",
  mixolydian: "Mixolydian",
  aeolian: "Aeolian",
  locrian: "Locrian",
  "harmonic-minor": "Harmonic minor",
  "melodic-minor": "Melodic minor",
  "whole-tone": "Whole tone",
  "diminished-half-whole": "Diminished (half-whole)",
  "diminished-whole-half": "Diminished (whole-half)",
};

/** Semitone intervals from the tonic. */
export const MODE_INTERVALS: Record<ModeName, number[]> = {
  ionian: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  locrian: [0, 1, 3, 5, 6, 8, 10],
  "harmonic-minor": [0, 2, 3, 5, 7, 8, 11],
  "melodic-minor": [0, 2, 3, 5, 7, 9, 11],
  "whole-tone": [0, 2, 4, 6, 8, 10],
  "diminished-half-whole": [0, 1, 3, 4, 6, 7, 9, 10],
  "diminished-whole-half": [0, 2, 3, 5, 6, 8, 9, 11],
};

export type Family =
  | "structure"
  | "audio"
  | "strings"
  | "brass"
  | "woodwinds"
  | "percussion"
  | "keys";

export const FAMILIES: Family[] = [
  "structure",
  "audio",
  "strings",
  "brass",
  "woodwinds",
  "percussion",
  "keys",
];

export const FAMILY_COLORS: Record<Family, string> = {
  structure: "#6b7280",
  audio: "#6b7280",
  strings: "#3b82f6",
  brass: "#eab308",
  woodwinds: "#22c55e",
  percussion: "#ef4444",
  keys: "#a855f8",
};

export type InstrumentRole =
  | "structure"
  | "chords"
  | "audio"
  | "violins1"
  | "violins2"
  | "violas"
  | "cellos"
  | "horns"
  | "trumpets"
  | "trombones"
  | "tuba"
  | "flutes"
  | "oboes"
  | "clarinets"
  | "bassoons"
  | "timpani"
  | "piccolo"
  | "englishHorn"
  | "bassClarinet"
  | "doubleBass"
  | "bassTrombone"
  | "glockenspiel"
  | "xylophone"
  | "marimba"
  | "vibraphone"
  | "celesta"
  | "snare"
  | "cymbals"
  | "aux"
  | "piano"
  | "harp"
  | "custom";

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

export interface TempoMapEntry {
  tick: number;
  bpm: number;
}

export type SectionDensity = "Sparse" | "Balanced" | "Dense" | "Tutti";

/** Module 8: build-curve shape for transition ramps inside BUILD sections. */
export type BuildCurveType = "LINEAR" | "EXPONENTIAL" | "STEPPED";

export interface Section {
  id: string;
  name: string;
  /** 1-indexed bar number. */
  startBar: number;
  lengthBars: number;
  targetDynamic?: number;
  densityLevel?: SectionDensity;
  /** Module 8: optional build curve shape; only meaningful on BUILD sections. */
  buildCurveType?: BuildCurveType;
}

export type OrchestralStyle = "Epic Cinematic" | "Classical Symphonic" | "Chamber Strings" | "Pop/Rock Studio Orchestra" | "Jazz Big Band" | "Custom";
export type VoicingStyle = "OVERTONE_SPREAD" | "DROP_2" | "SEMI_OPEN" | "CLOSED" | "OPEN_SPREAD" | "CLUSTER";
/** Module 5: optional per-project voice-leading weights/penalties (merged over defaults at generation). */
export interface VoiceLeadingConfigPartial {
  weightStepMinimization?: number;
  weightCommonToneRetention?: number;
  weightContraryMotion?: number;
  penaltyParallelFifths?: number;
  penaltyLowIntervalViolation?: number;
}

/** Module 6: additive optional doubling/anti-flanging configuration. */
export interface DoublingConfigPartial {
  enabled?: boolean;
  maxDoublesPerNote?: number;
  preferredWoodwindDisposition?: "JUXTAPOSITION" | "INTERLOCKING" | "ENCLOSURE" | "OVERLAPPING";
  preferredBrassDisposition?: "JUXTAPOSITION" | "INTERLOCKING" | "ENCLOSURE" | "OVERLAPPING";
  antiFlanging?: {
    enableMicroDetune?: boolean;
    detuneRangeCents?: [number, number];
    enableMicroDelay?: boolean;
    delayRangeMs?: [number, number];
    filterCutoffJitterPercent?: number;
  };
}
export type ExpressionMapPreset = "Spitfire UACC" | "VSL Synchron" | "SINE" | "Kontakt Standard" | "Custom";

export interface BalanceConfigPartial {
  windowing?: {
    enabled?: boolean;
    minGapMs?: number;
    searchWindowMs?: number;
    allowOctaveEscape?: boolean;
  };
  attenuation?: {
    lowFluteFactor?: number;
    brassDominanceFactor?: number;
    combinedFloor?: number;
  };
  cc11Floor?: number;
}

export interface NoteDynamics {
  cc11Value: number;
  cc74Value: number;
  attenuationActive: boolean;
}

/** Addendum E/F/G: additive optional theme-engine switches (A/B testing each sub-engine). */
export interface ThemesSettingsPartial {
  germ?: boolean;
  nct?: boolean;
  counterline?: boolean;
}

/** Module 8: additive optional arrangement config (merged over defaults). */
export interface ArrangementConfigPartial {
  enableAutoBuildStaggering?: boolean;
  enableTransitionGestures?: boolean;
  breakdownExposedLayer?: "SOLO_CELLO" | "SOLO_WOODWIND" | "HARP_PAD" | "PIANO_ONLY";
  /** Module 8.5 rotation engine; absent = defaults (enabled true, restBars 2,
   * restTriggerBars 8, per-type active-track caps). */
  rotation?: RotationConfigPartial;
}

/** Module 8.5 rotation engine switches (additive optional). */
export interface RotationConfigPartial {
  enabled?: boolean;
  /** Breathing bars granted at a long-carry hand-off; clamped 2–4. */
  restBars?: number;
  /** A carrier that has carried at least this many bars before a boundary earns
   * the hand-off/rest treatment at the next section start. */
  restTriggerBars?: number;
  /** Cap on simultaneously active instrument roles per section type. */
  maxActiveTracks?: Partial<Record<"intro" | "verse" | "preChorus" | "chorus" | "build" | "breakdown" | "outro", number>>;
}

export interface OrchestrationSettings {
  enabledGroups: { woodwinds: boolean; brass: boolean; strings: boolean; percussion: boolean; rhythm: boolean };
  woodwindsSize: "Pairs" | "Threes + Auxiliaries" | "Chamber Ensemble";
  brassSize: "Standard" | "Cinematic Double Brass";
  stringsSize: "Full Symphonic (16/14/12/10/8)" | "Medium Studio" | "Chamber";
  voicingStyle: VoicingStyle;
  voiceLeadingConfig?: VoiceLeadingConfigPartial;
  doubling?: DoublingConfigPartial;
  balance?: BalanceConfigPartial;
}

export interface HumanizationSettings {
  intensity: number;
  rubato: number;
  intonationCents: number;
  latencyCompensation: boolean;
  latencyCompensationMs?: Partial<Record<InstrumentRole | Family | "custom", number>>;
}

export interface ExpressionMapping {
  preset: ExpressionMapPreset;
  dynamicCC: number;
  expressionCC: number;
  brightnessCC: number;
  sustainCC: number;
}

export const DEFAULT_ORCHESTRATION_SETTINGS: OrchestrationSettings = {
  enabledGroups: { woodwinds: true, brass: true, strings: true, percussion: true, rhythm: true },
  woodwindsSize: "Pairs",
  brassSize: "Standard",
  stringsSize: "Full Symphonic (16/14/12/10/8)",
  voicingStyle: "OVERTONE_SPREAD",
};
export const DEFAULT_HUMANIZATION_SETTINGS: HumanizationSettings = {
  intensity: 45, rubato: 0, intonationCents: 0, latencyCompensation: false,
};
export const DEFAULT_EXPRESSION_MAPPING: ExpressionMapping = {
  preset: "Kontakt Standard", dynamicCC: 1, expressionCC: 11, brightnessCC: 74, sustainCC: 64,
};

export interface ProjectGenerationSettings {
  orchestralStyle: OrchestralStyle;
  orchestration: OrchestrationSettings;
  humanization: HumanizationSettings;
  /** Addendum E/F/G: optional theme-engine switches; absent = all sub-engines on their default state (germ on, nct on, counterline on). */
  themes?: { germ?: boolean; nct?: boolean; counterline?: boolean };
  /** Module 8: optional arrangement config; absent = defaults (staggering on, gestures on, SOLO_CELLO). */
  arrangement?: ArrangementConfigPartial;
}

export const DEFAULT_GENERATION_SETTINGS: ProjectGenerationSettings = {
  orchestralStyle: "Classical Symphonic",
  orchestration: { ...DEFAULT_ORCHESTRATION_SETTINGS, enabledGroups: { ...DEFAULT_ORCHESTRATION_SETTINGS.enabledGroups } },
  humanization: { ...DEFAULT_HUMANIZATION_SETTINGS },
  /** Addendum E/F/G defaults are explicitly ON (createDefaultProject inherits them). */
  themes: { germ: true, nct: true, counterline: true },
};

export interface Chord {
  id: string;
  symbol: string;
  startTick: number;
  durationTicks: number;
  quality?: "Maj" | "Min" | "Dim" | "Aug" | "Sus2" | "Sus4";
  extensions?: string[];
  bassOverride?: number;
}

export interface ReferenceAudio {
  path: string;
  offsetMs: number;
}

export interface Note {
  /** MIDI note number 0–127. */
  pitch: number;
  startTick: number;
  durationTicks: number;
  /** 1–127 */
  velocity: number;
  /** Optional tuning offset in cents, rendered as MIDI pitch bend on export. */
  detuneCents?: number;
  /** Module 4: playing technique tag (see src/generation/articulation.ts); metadata only. */
  technique?: string;
  /** Module 4: string bowing direction. */
  bowDirection?: "DOWN_BOW" | "UP_BOW" | "UNDEFINED";
  /** Module 4: true for export-time key-switch notes; playback must never schedule these. */
  isKeySwitch?: boolean;
  /** Module 4: host-agnostic pitch-bend ramps (RIP/DOIT/FALL_OFF); cents clamped ±200 at export. */
  pitchBendPoints?: Array<{ tick: number; cents: number }>;
  /** Module 6: true when this note was generated by the doubling stage. */
  isDoubling?: boolean;
  /** Module 8.5: semantic role of the source event, stamped at the bake ONLY when
   * the rotation engine is enabled (rotation-off output stays byte-identical). */
  role?: string;
  /** Module 6: additive brightness-CC offset from the anti-flanging filter. */
  cc74Offset?: number;
  /** Module 7 deterministic balance output; absent on manually-authored notes. */
  dynamics?: NoteDynamics;
}

export interface Track {
  id: string;
  name: string;
  family: Family;
  color: string;
  role: InstrumentRole;
  lowestNote: number;
  highestNote: number;
  locked: boolean;
  muted: boolean;
  soloed: boolean;
  expressionMapping?: ExpressionMapping;
  libraryGroupId: string | null;
  /** 1–16, informational for export / hosting. */
  midiChannel: number;
  frozen: boolean;
  notes: Note[];
}

export interface LibraryGroup {
  id: string;
  name: string;
  pluginId: string | null;
  /** Base64 plugin state blob (getStateInformation). */
  pluginState: string | null;
  /** Module 4 (VST3-forward): technique → key-switch MIDI note 0–127. */
  keySwitchMap?: Record<string, number>;
  /** Module 4 (VST3-forward): ms a key-switch must precede its note (default 15). */
  preTriggerDelayMs?: number;
  /** Module 9 (VST3 expression-map profile): id resolving in
   * plugins/expressionMaps BUILT_IN_PROFILES. Present ⇒ the PROFILE export path
   * (profile.preTriggerOffsetMs owns the pre-trigger, reconciliation #2);
   * set both profileId and keySwitchMap ⇒ profileId wins (exporter warns). */
  profileId?: string;
}

export interface Project {
  schemaVersion: number;
  name: string;
  bpm: number;
  /** v1 uses a single entry at tick 0. */
  tempoMap: TempoMapEntry[];
  timeSignature: TimeSignature;
  /** 0 = C … 11 = B */
  key: PitchClass;
  mode: ModeName;
  generationSettings?: ProjectGenerationSettings;
  sections: Section[];
  chords: Chord[];
  referenceAudio: ReferenceAudio;
  tracks: Track[];
  libraryGroups: LibraryGroup[];
}

export interface InstrumentRange {
  low: number;
  high: number;
}

/** Starting instrument ranges (MIDI note numbers). Refine only with a documented reason. */
export const INSTRUMENT_RANGES: Record<string, InstrumentRange> = {
  violins1: { low: 55, high: 96 }, // G3–C7
  violins2: { low: 55, high: 93 }, // G3–A6
  violas: { low: 48, high: 88 }, // C3–E6
  cellos: { low: 28, high: 84 }, // E1–C6
  horns: { low: 41, high: 77 }, // F2–F5
  trumpets: { low: 52, high: 84 }, // E3–C6
  trombones: { low: 40, high: 77 }, // E2–F5
  tuba: { low: 26, high: 65 }, // D1–F4
  flutes: { low: 60, high: 96 }, // C4–C7
  oboes: { low: 58, high: 93 }, // Bb3–A6
  clarinets: { low: 50, high: 91 }, // D3–G6
  bassoons: { low: 34, high: 75 }, // Bb1–Eb5
  timpani: { low: 38, high: 57 }, // D2–A3
  piccolo: { low: 50, high: 84 },
  englishHorn: { low: 52, high: 84 },
  bassClarinet: { low: 22, high: 65 },
  doubleBass: { low: 12, high: 55 },
  bassTrombone: { low: 22, high: 65 },
  glockenspiel: { low: 43, high: 72 },
  xylophone: { low: 48, high: 84 },
  marimba: { low: 36, high: 96 },
  vibraphone: { low: 53, high: 89 },
  celesta: { low: 36, high: 84 },
  piano: { low: 21, high: 108 }, // A0–C8
  harp: { low: 23, high: 104 }, // Cb1 (B0)–G#7
  snare: { low: 38, high: 38 }, // GM acoustic snare
  cymbals: { low: 49, high: 49 }, // GM crash 1
  aux: { low: 36, high: 81 },
  custom: { low: 36, high: 96 },
  structure: { low: 0, high: 127 },
  chords: { low: 0, high: 127 },
  audio: { low: 0, high: 127 },
};

export const DEFAULT_SNARE_NOTE = 38;
export const DEFAULT_CYMBAL_NOTE = 49;

export const SECTION_PRESETS = [
  "Intro",
  "Verse",
  "Pre-Chorus",
  "Chorus",
  "Bridge",
  "Outro",
] as const;
