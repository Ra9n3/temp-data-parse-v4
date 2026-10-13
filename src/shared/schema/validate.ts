import { parseChord } from "./chords";
import { builtInProfileById } from "../../plugins/expressionMaps";
import {
  DEFAULT_EXPRESSION_MAPPING,
  DEFAULT_GENERATION_SETTINGS,
  FAMILIES,
  MODE_NAMES,
  SCHEMA_VERSION,
  type ModeName,
  type Project,
  type Track,
} from "./types";

export type ValidationResult =
  | { ok: true; errors: string[]; project: Project }
  | { ok: false; errors: string[]; project: null };

const FAM_SET = new Set<string>(FAMILIES);
const MODE_SET = new Set<string>(MODE_NAMES);
const DENOMINATORS = new Set([1, 2, 4, 8, 16, 32]);

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);
}

function isNum(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function uniqueIds(ids: string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (!id) {
      errors.push(`${label} has an empty id`);
      continue;
    }
    if (seen.has(id)) errors.push(`${label} duplicate id "${id}"`);
    seen.add(id);
  }
}

function validateTrack(track: Track, index: number, errors: string[]): void {
  const p = `tracks[${index}] (${track?.name ?? track?.id ?? "?"})`;
  if (!track || typeof track !== "object") {
    errors.push(`${p} is not an object`);
    return;
  }
  if (typeof track.id !== "string" || !track.id) errors.push(`${p}.id must be a non-empty string`);
  if (typeof track.name !== "string" || !track.name) errors.push(`${p}.name must be a non-empty string`);
  if (!FAM_SET.has(track.family)) errors.push(`${p}.family "${track.family}" is not a known family`);
  if (typeof track.color !== "string") errors.push(`${p}.color must be a string`);
  if (typeof track.role !== "string" || !track.role) errors.push(`${p}.role must be a non-empty string`);
  if (!isInt(track.lowestNote) || track.lowestNote < 0 || track.lowestNote > 127) {
    errors.push(`${p}.lowestNote must be an integer 0–127`);
  }
  if (!isInt(track.highestNote) || track.highestNote < 0 || track.highestNote > 127) {
    errors.push(`${p}.highestNote must be an integer 0–127`);
  }
  if (isInt(track.lowestNote) && isInt(track.highestNote) && track.lowestNote > track.highestNote) {
    errors.push(`${p}.lowestNote (${track.lowestNote}) is above highestNote (${track.highestNote})`);
  }
  for (const flag of ["locked", "muted", "soloed", "frozen"] as const) {
    if (typeof track[flag] !== "boolean") errors.push(`${p}.${flag} must be a boolean`);
  }
  const expression = track.expressionMapping ?? DEFAULT_EXPRESSION_MAPPING;
  if (!Number.isInteger(expression.dynamicCC) || expression.dynamicCC < 0 || expression.dynamicCC > 127
    || !Number.isInteger(expression.expressionCC) || expression.expressionCC < 0 || expression.expressionCC > 127
    || !Number.isInteger(expression.brightnessCC) || expression.brightnessCC < 0 || expression.brightnessCC > 127
    || !Number.isInteger(expression.sustainCC) || expression.sustainCC < 0 || expression.sustainCC > 127) {
    errors.push(`${p}.expressionMapping CC values must be integers 0–127`);
  }
  if (track.expressionMapping !== undefined && (!track.expressionMapping || typeof track.expressionMapping !== "object")) errors.push(`${p}.expressionMapping must be an object`);
  if (typeof expression.preset !== "string" || !["Spitfire UACC", "VSL Synchron", "SINE", "Kontakt Standard", "Custom"].includes(expression.preset)) {
    errors.push(`${p}.expressionMapping.preset is invalid`);
  }
  if (track.libraryGroupId !== null && typeof track.libraryGroupId !== "string") {
    errors.push(`${p}.libraryGroupId must be a string or null`);
  }
  if (!isInt(track.midiChannel) || track.midiChannel < 1 || track.midiChannel > 16) {
    errors.push(`${p}.midiChannel must be an integer 1–16`);
  }
  if (!Array.isArray(track.notes)) {
    errors.push(`${p}.notes must be an array`);
    return;
  }
  track.notes.forEach((note, ni) => {
    const np = `${p}.notes[${ni}]`;
    if (!note || typeof note !== "object") {
      errors.push(`${np} is not an object`);
      return;
    }
    if (!isInt(note.pitch) || note.pitch < 0 || note.pitch > 127) {
      errors.push(`${np}.pitch must be an integer 0–127`);
    }
    if (!isInt(note.startTick) || note.startTick < 0) {
      errors.push(`${np}.startTick must be an integer ≥ 0`);
    }
    if (!isInt(note.durationTicks) || note.durationTicks <= 0) {
      errors.push(`${np}.durationTicks must be an integer > 0`);
    }
    if (!isInt(note.velocity) || note.velocity < 1 || note.velocity > 127) {
      errors.push(`${np}.velocity must be an integer 1–127`);
    }
    if (note.detuneCents !== undefined && (!isNum(note.detuneCents) || note.detuneCents < -15 || note.detuneCents > 15)) errors.push(`${np}.detuneCents must be between -15 and 15`);
    if (note.technique !== undefined && (typeof note.technique !== "string" || !note.technique.trim() || note.technique.length > 32)) {
      errors.push(`${np}.technique must be a non-empty string up to 32 chars`);
    }
    if (note.bowDirection !== undefined && !["DOWN_BOW", "UP_BOW", "UNDEFINED"].includes(note.bowDirection)) {
      errors.push(`${np}.bowDirection is invalid`);
    }
    if (note.pitchBendPoints !== undefined) {
      if (!Array.isArray(note.pitchBendPoints)) errors.push(`${np}.pitchBendPoints must be an array`);
      else note.pitchBendPoints.forEach((point, pi) => {
        if (!point || !isNum(point.cents) || point.cents < -200 || point.cents > 200) errors.push(`${np}.pitchBend cents`);
        if (!point || !isInt(point.tick) || point.tick < 0) errors.push(`${np}.pitchBend tick must be an integer ≥ 0`);
        void pi;
      });
    }
    if (note.isKeySwitch !== undefined && typeof note.isKeySwitch !== "boolean") errors.push(`${np}.isKeySwitch must be a boolean`);
    if (note.isDoubling !== undefined && typeof note.isDoubling !== "boolean") errors.push(`${np}.isDoubling must be a boolean`);
    if (note.auxInstrumentId !== undefined && (typeof note.auxInstrumentId !== "string" || note.auxInstrumentId.length === 0 || note.auxInstrumentId.length > 32)) errors.push(`${np}.auxInstrumentId must be a string of at most 32 characters`);
    if (note.cc74Offset !== undefined && (typeof note.cc74Offset !== "number" || !Number.isFinite(note.cc74Offset))) errors.push(`${np}.cc74Offset must be a finite number`);
    if (note.dynamics !== undefined) {
      if (!note.dynamics || typeof note.dynamics !== "object"
        || !Number.isInteger(note.dynamics.cc11Value) || note.dynamics.cc11Value < 0 || note.dynamics.cc11Value > 127
        || !Number.isInteger(note.dynamics.cc74Value) || note.dynamics.cc74Value < 0 || note.dynamics.cc74Value > 127
        || typeof note.dynamics.attenuationActive !== "boolean") {
        errors.push(`${np} note dynamics CC values must be integers 0–127 and attenuationActive boolean`);
      }
    }
  });
}

export function validateProject(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["Project must be an object"], project: null };
  }
  const p = input as Partial<Project> & Record<string, unknown>;

  if (p.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION} (got ${String(p.schemaVersion)})`);
  }
  if (typeof p.name !== "string") errors.push("name must be a string");
  if (!isNum(p.bpm) || p.bpm < 20 || p.bpm > 400) {
    errors.push("bpm must be a number between 20 and 400");
  }
  if (!Array.isArray(p.tempoMap) || p.tempoMap.length < 1) {
    errors.push("tempoMap must be a non-empty array (v1 uses one entry)");
  } else {
    p.tempoMap.forEach((e, i) => {
      if (!e || !isInt(e.tick) || e.tick < 0) errors.push(`tempoMap[${i}].tick must be an integer ≥ 0`);
      if (!e || !isNum(e.bpm) || e.bpm < 20 || e.bpm > 400) {
        errors.push(`tempoMap[${i}].bpm must be 20–400`);
      }
    });
  }
  if (
    !p.timeSignature ||
    !isInt(p.timeSignature.numerator) ||
    p.timeSignature.numerator < 1 ||
    p.timeSignature.numerator > 32
  ) {
    errors.push("timeSignature.numerator must be an integer 1–32");
  }
  if (!p.timeSignature || !isInt(p.timeSignature.denominator) || !DENOMINATORS.has(p.timeSignature.denominator)) {
    errors.push("timeSignature.denominator must be 1, 2, 4, 8, 16, or 32");
  }
  if (!isInt(p.key) || p.key < 0 || p.key > 11) {
    errors.push("key must be an integer pitch class 0–11");
  }
  if (typeof p.mode !== "string" || !MODE_SET.has(p.mode)) {
    errors.push(`mode must be one of: ${MODE_NAMES.join(", ")}`);
  }
  if (p.generationSettings !== undefined) {
    const settings = p.generationSettings as typeof DEFAULT_GENERATION_SETTINGS;
    if (!settings || typeof settings !== "object") errors.push("generationSettings must be an object");
    else {
      if (!["Epic Cinematic", "Classical Symphonic", "Chamber Strings", "Pop/Rock Studio Orchestra", "Jazz Big Band", "Custom"].includes(settings.orchestralStyle)) errors.push("generationSettings.orchestralStyle is invalid");
      if (!settings.orchestration || typeof settings.orchestration !== "object") errors.push("generationSettings.orchestration must be an object");
      else {
        for (const group of ["woodwinds", "brass", "strings", "percussion", "rhythm"] as const) {
          if (typeof settings.orchestration.enabledGroups?.[group] !== "boolean") errors.push(`generationSettings.orchestration.enabledGroups.${group} must be boolean`);
        }
        if (!["Pairs", "Threes + Auxiliaries", "Chamber Ensemble"].includes(settings.orchestration.woodwindsSize)) errors.push("generationSettings.orchestration.woodwindsSize is invalid");
        if (!["Standard", "Cinematic Double Brass"].includes(settings.orchestration.brassSize)) errors.push("generationSettings.orchestration.brassSize is invalid");
        if (!["Full Symphonic (16/14/12/10/8)", "Medium Studio", "Chamber"].includes(settings.orchestration.stringsSize)) errors.push("generationSettings.orchestration.stringsSize is invalid");
        if (!["OVERTONE_SPREAD", "DROP_2", "SEMI_OPEN", "CLOSED", "OPEN_SPREAD", "CLUSTER"].includes(settings.orchestration.voicingStyle)) errors.push("generationSettings.orchestration.voicingStyle is invalid");
        if (settings.orchestration.woodwindEnsemble !== undefined && !["THREES_LARGE", "PAIRS_CHAMBER"].includes(settings.orchestration.woodwindEnsemble)) errors.push("woodwind ensemble config: generationSettings.orchestration.woodwindEnsemble is invalid");
      if (settings.themes !== undefined) {
        if (!settings.themes || typeof settings.themes !== "object") errors.push("generationSettings.themes must be an object");
        else for (const flag of ["germ", "nct", "counterline"] as const) {
          if (settings.themes[flag] !== undefined && typeof settings.themes[flag] !== "boolean") errors.push(`generationSettings.themes.${flag} must be boolean`);
        }
      }
        const doublingConfig = settings.orchestration.doubling;
        if (doublingConfig !== undefined) {
          if (!doublingConfig || typeof doublingConfig !== "object") errors.push("doubling config");
          else {
            if (doublingConfig.enabled !== undefined && typeof doublingConfig.enabled !== "boolean") errors.push("doubling config");
            if (doublingConfig.maxDoublesPerNote !== undefined
              && (!Number.isInteger(doublingConfig.maxDoublesPerNote) || doublingConfig.maxDoublesPerNote < 1 || doublingConfig.maxDoublesPerNote > 4)) {
              errors.push("doubling config");
            }
            for (const [key, value] of [["preferredWoodwindDisposition", doublingConfig.preferredWoodwindDisposition], ["preferredBrassDisposition", doublingConfig.preferredBrassDisposition]] as const) {
              if (value !== undefined && !["JUXTAPOSITION", "INTERLOCKING", "ENCLOSURE", "OVERLAPPING"].includes(value as string)) {
                errors.push(`doubling config: orchestration.${key} is invalid`);
              }
            }
            const antiFlanging = doublingConfig.antiFlanging;
            if (antiFlanging !== undefined) {
              if (!antiFlanging || typeof antiFlanging !== "object") errors.push("doubling config");
              else {
                const [detuneMin = 0, detuneMax = 0] = antiFlanging.detuneRangeCents ?? [];
                if (detuneMin < -15 || detuneMax > 15) errors.push("doubling config: detune range within ±15");
                const [delayMin = 0, delayMax = 0] = antiFlanging.delayRangeMs ?? [];
                if (delayMin < 0 || delayMax > 50 || delayMin > delayMax) errors.push("doubling config: delay range 0–50ms");
                if (antiFlanging.filterCutoffJitterPercent !== undefined
                  && (typeof antiFlanging.filterCutoffJitterPercent !== "number" || !Number.isFinite(antiFlanging.filterCutoffJitterPercent))) {
                  errors.push("doubling config");
                }
                for (const flag of ["enableMicroDetune", "enableMicroDelay"] as const) {
                  if (antiFlanging[flag] !== undefined && typeof antiFlanging[flag] !== "boolean") errors.push("doubling config");
                }
              }
            }
          }
        }
        const balanceConfig = settings.orchestration.balance;
        if (balanceConfig !== undefined) {
          if (!balanceConfig || typeof balanceConfig !== "object") errors.push("balance config");
          else {
            const windowing = balanceConfig.windowing;
            if (windowing !== undefined) {
              if (!windowing || typeof windowing !== "object"
                || (windowing.enabled !== undefined && typeof windowing.enabled !== "boolean")
                || (windowing.allowOctaveEscape !== undefined && typeof windowing.allowOctaveEscape !== "boolean")
                || (windowing.minGapMs !== undefined && (!isNum(windowing.minGapMs) || windowing.minGapMs < 0 || windowing.minGapMs > 2000))
                || (windowing.searchWindowMs !== undefined && (!isNum(windowing.searchWindowMs) || windowing.searchWindowMs < 0 || windowing.searchWindowMs > 2000))) {
                errors.push("balance config: windowing gap values must be 0–2000ms");
              }
            }
            const attenuation = balanceConfig.attenuation;
            if (attenuation !== undefined) {
              if (!attenuation || typeof attenuation !== "object"
                || (attenuation.lowFluteFactor !== undefined && (!isNum(attenuation.lowFluteFactor) || attenuation.lowFluteFactor < 0 || attenuation.lowFluteFactor > 1))
                || (attenuation.brassDominanceFactor !== undefined && (!isNum(attenuation.brassDominanceFactor) || attenuation.brassDominanceFactor < 0 || attenuation.brassDominanceFactor > 1))
                || (attenuation.combinedFloor !== undefined && (!isNum(attenuation.combinedFloor) || attenuation.combinedFloor < 0 || attenuation.combinedFloor > 1))) {
                errors.push("balance config: attenuation factors must be 0–1");
              }
            }
            if (balanceConfig.cc11Floor !== undefined && (!isNum(balanceConfig.cc11Floor) || balanceConfig.cc11Floor < 10 || balanceConfig.cc11Floor > 127)) errors.push("balance config: cc11Floor must be 10–127");
          }
        }
        const arrangementConfig = settings.arrangement;
        if (arrangementConfig !== undefined) {
          if (!arrangementConfig || typeof arrangementConfig !== "object") errors.push("arrangement config");
          else {
            for (const key of ["enableAutoBuildStaggering", "enableTransitionGestures"] as const) {
              if (arrangementConfig[key] !== undefined && typeof arrangementConfig[key] !== "boolean") {
                errors.push(`arrangement config: ${key} must be boolean`);
              }
            }
            if (arrangementConfig.breakdownExposedLayer !== undefined
              && !["SOLO_CELLO", "SOLO_WOODWIND", "HARP_PAD", "PIANO_ONLY"].includes(arrangementConfig.breakdownExposedLayer)) {
              errors.push("arrangement config: breakdownExposedLayer is invalid");
            }
            const rotationConfig = arrangementConfig.rotation;
            if (rotationConfig !== undefined) {
              if (!rotationConfig || typeof rotationConfig !== "object") errors.push("rotation config must be an object");
              else {
                if (rotationConfig.enabled !== undefined && typeof rotationConfig.enabled !== "boolean") errors.push("rotation config: enabled must be boolean");
                if (rotationConfig.restBars !== undefined && (!Number.isInteger(rotationConfig.restBars) || rotationConfig.restBars < 2 || rotationConfig.restBars > 4)) errors.push("rotation config: restBars must be an integer between 2 and 4");
                if (rotationConfig.restTriggerBars !== undefined && (!Number.isInteger(rotationConfig.restTriggerBars) || rotationConfig.restTriggerBars < 1)) errors.push("rotation config: restTriggerBars must be a positive integer");
                if (rotationConfig.maxActiveTracks !== undefined) {
                  if (!rotationConfig.maxActiveTracks || typeof rotationConfig.maxActiveTracks !== "object") errors.push("rotation config: maxActiveTracks must be an object");
                  else for (const cap of Object.values(rotationConfig.maxActiveTracks)) {
                    if (cap !== undefined && (!Number.isInteger(cap) || cap < 1)) errors.push("rotation config: maxActiveTracks values must be positive integers");
                  }
                }
              }
            }
          }
        }
        const themesConfig = settings.themes;
        if (themesConfig !== undefined) {
          if (!themesConfig || typeof themesConfig !== "object") errors.push("generationSettings.themes must be an object");
          else {
            for (const key of ["germ", "nct", "counterline"] as const) {
              if (themesConfig[key] !== undefined && typeof themesConfig[key] !== "boolean") {
                errors.push(`generationSettings.themes.${key} must be boolean`);
              }
            }
          }
        }
        const voiceLeadingConfig = settings.orchestration.voiceLeadingConfig;
        if (voiceLeadingConfig !== undefined) {
          if (!voiceLeadingConfig || typeof voiceLeadingConfig !== "object") errors.push("generationSettings.orchestration.voiceLeadingConfig must be an object");
          else {
            const entries: Array<[keyof typeof voiceLeadingConfig, "weight" | "penalty"]> = [
              ["weightStepMinimization", "weight"],
              ["weightCommonToneRetention", "weight"],
              ["weightContraryMotion", "weight"],
              ["penaltyParallelFifths", "penalty"],
              ["penaltyLowIntervalViolation", "penalty"],
            ];
            for (const [key, kind] of entries) {
              const value = voiceLeadingConfig[key];
              if (value === undefined) continue;
              if (typeof value !== "number" || !Number.isFinite(value)) {
                errors.push(`generationSettings.orchestration.voiceLeadingConfig.${key} must be a finite number`);
              } else if (kind === "weight" && value < 0) {
                errors.push("voiceLeadingConfig weights");
              } else if (kind === "penalty" && value < 1) {
                errors.push("voiceLeadingConfig penalties");
              }
            }
          }
        }
      }
      if (!settings.humanization || typeof settings.humanization !== "object") errors.push("generationSettings.humanization must be an object");
      else {
        for (const [key, max] of [["intensity", 100], ["rubato", 100], ["intonationCents", 15]] as const) {
          const value = settings.humanization[key];
          if (!isNum(value) || value < 0 || value > max) errors.push(`generationSettings.humanization.${key} must be between 0 and ${max}`);
        }
        if (typeof settings.humanization.latencyCompensation !== "boolean") errors.push("generationSettings.humanization.latencyCompensation must be boolean");
        for (const [role, ms] of Object.entries(settings.humanization.latencyCompensationMs ?? {})) {
          if (!isNum(ms) || ms < 0 || ms > 500) errors.push(`generationSettings.humanization.latencyCompensationMs.${role} must be between 0 and 500`);
        }
      }
    }
  }

  if (!Array.isArray(p.sections)) errors.push("sections must be an array");
  else {
    uniqueIds(p.sections.map((s) => s?.id), "sections", errors);
    p.sections.forEach((s, i) => {
      if (!s || typeof s.name !== "string") errors.push(`sections[${i}].name must be a string`);
      if (!s || !isInt(s.startBar) || s.startBar < 1) {
        errors.push(`sections[${i}].startBar must be an integer ≥ 1 (bars are 1-indexed)`);
      }
      if (!s || !isInt(s.lengthBars) || s.lengthBars < 1) {
        errors.push(`sections[${i}].lengthBars must be an integer ≥ 1`);
      }
      if (s?.targetDynamic !== undefined && (!isNum(s.targetDynamic) || s.targetDynamic < 0 || s.targetDynamic > 1)) {
        errors.push(`sections[${i}].targetDynamic must be between 0 and 1`);
      }
      if (s?.densityLevel !== undefined && !["Sparse", "Balanced", "Dense", "Tutti"].includes(s.densityLevel)) {
        errors.push(`sections[${i}].densityLevel is invalid`);
      }
      if (s?.buildCurveType !== undefined && !["LINEAR", "EXPONENTIAL", "STEPPED"].includes(s.buildCurveType)) {
        errors.push(`sections[${i}].buildCurveType is invalid`);
      }
    });
  }

  if (!Array.isArray(p.chords)) errors.push("chords must be an array");
  else {
    uniqueIds(p.chords.map((c) => c?.id), "chords", errors);
    p.chords.forEach((c, i) => {
      if (!c || typeof c.symbol !== "string") errors.push(`chords[${i}].symbol must be a string`);
      if (!c || !isInt(c.startTick) || c.startTick < 0) {
        errors.push(`chords[${i}].startTick must be an integer ≥ 0`);
      }
      if (!c || !isInt(c.durationTicks) || c.durationTicks <= 0) {
        errors.push(`chords[${i}].durationTicks must be an integer > 0`);
      }
      if (c && typeof c.symbol === "string" && c.symbol.trim()) {
        const parsed = parseChord(c.symbol);
        if (!parsed.ok) {
          errors.push(`chords[${i}].symbol "${c.symbol}" is invalid: ${parsed.error}`);
        }
      }
    });
  }

  if (!p.referenceAudio || typeof p.referenceAudio !== "object") {
    errors.push("referenceAudio must be an object { path, offsetMs }");
  } else {
    if (typeof p.referenceAudio.path !== "string") errors.push("referenceAudio.path must be a string");
    if (!isNum(p.referenceAudio.offsetMs)) errors.push("referenceAudio.offsetMs must be a number");
  }

  if (!Array.isArray(p.libraryGroups)) errors.push("libraryGroups must be an array");
  else {
    uniqueIds(p.libraryGroups.map((g) => g?.id), "libraryGroups", errors);
    p.libraryGroups.forEach((g, i) => {
      if (!g || typeof g.name !== "string") errors.push(`libraryGroups[${i}].name must be a string`);
      if (g && g.pluginId !== null && typeof g.pluginId !== "string") {
        errors.push(`libraryGroups[${i}].pluginId must be a string or null`);
      }
      if (g && g.pluginState !== null && typeof g.pluginState !== "string") {
        errors.push(`libraryGroups[${i}].pluginState must be a string or null`);
      }
      if (g && g.keySwitchMap !== undefined) {
        if (typeof g.keySwitchMap !== "object" || Array.isArray(g.keySwitchMap)) errors.push(`libraryGroups[${i}].keySwitchMap must be an object`);
        else for (const [technique, noteNumber] of Object.entries(g.keySwitchMap)) {
          if (!isInt(noteNumber as number) || (noteNumber as number) < 0 || (noteNumber as number) > 127) {
            errors.push(`libraryGroups[${i}].keySwitchMap note numbers`);
          }
          if (typeof technique !== "string" || !technique.trim()) errors.push(`libraryGroups[${i}].keySwitchMap keys must be non-empty strings`);
        }
      }
      if (g && g.preTriggerDelayMs !== undefined && (!isNum(g.preTriggerDelayMs) || g.preTriggerDelayMs < 0 || g.preTriggerDelayMs > 1000)) {
        errors.push(`libraryGroups[${i}].preTriggerDelayMs must be between 0 and 1000`);
      }
      if (g && g.profileId !== undefined) {
        if (typeof g.profileId !== "string" || !g.profileId) errors.push(`libraryGroup profileId must be a non-empty string`);
        else if (!builtInProfileById(g.profileId)) {
          errors.push(`libraryGroup profile ${JSON.stringify(g.profileId)} does not resolve to a built-in expression map`);
        }
      }
    });
  }

  if (!Array.isArray(p.tracks)) errors.push("tracks must be an array");
  else {
    uniqueIds(p.tracks.map((t) => t?.id), "tracks", errors);
    p.tracks.forEach((t, i) => validateTrack(t as Track, i, errors));
    const groupIds = new Set((p.libraryGroups ?? []).map((g) => g?.id).filter(Boolean));
    p.tracks.forEach((t, i) => {
      if (t?.libraryGroupId && !groupIds.has(t.libraryGroupId)) {
        errors.push(
          `tracks[${i}] (${t.name ?? t.id}) references missing libraryGroupId "${t.libraryGroupId}"`,
        );
      }
    });
  }

  if (errors.length) return { ok: false, errors, project: null };
  return { ok: true, errors: [], project: p as Project };
}

export function isModeName(v: string): v is ModeName {
  return MODE_SET.has(v);
}
