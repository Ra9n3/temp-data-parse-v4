/**
 * Module 9 — VST3 expression map profiles: pure adapter layer between the
 * semantic score (Note[]) and physical MIDI streams. Three concerns live here:
 *
 *  1. loadProfile — validates an expression-map JSON against the Vst3Profile
 *     canonical schema (error style mirrors shared/schema/validate.ts).
 *  2. BUILT_IN_PROFILES — the registry of shipped profiles (src/presets/vst3/),
 *     validated once at module load; malformed shipped data throws immediately.
 *  3. vst3EventAdapter — PURE, DETERMINISTIC semantic→physical translation.
 *     NO RNG anywhere in this module (Salt registry note: the adapter consumes
 *     no salt; every input fully determines every output, including event
 *     ordering, so determinism tests are unaffected by this layer).
 *
 * Reconciliation decisions encoded here (authoritative for this module):
 *  #1 TWO PATHS: a group with profileId takes the profile path (this adapter);
 *     a group with only keySwitchMap keeps the byte-identical legacy M4 path
 *     inside export/midi.ts. Both set ⇒ profileId wins and the exporter warns
 *     "[scorch] profile overrides legacy keySwitchMap".
 *  #2 Pre-trigger ownership: profile.preTriggerOffsetMs applies on the profile
 *     path; group.preTriggerDelayMs applies ONLY on the legacy path.
 *  #3 CC74 semantics: cc74Scale scales our brightness values (default 1). BBCSO
 *     ships 0.5 because its CC74 is attack TIGHTNESS, not brightness — the
 *     value is conservative, half-strength, NOT inverted; tunable data.
 *  #4 UACC is latching: CC is emitted only when the articulation CHANGES across
 *     the sorted note stream (state machine; no redundant CC spam).
 *  #5 Latching key switches: NOTE_OFF immediately BEFORE the next different
 *     articulation's KS note-on (same tick, earlier in stream order), else at
 *     the last note end / end of track. Momentary (isLatching: false) note-off
 *     lands at the musical note's end.
 *  #6 fallbackKeySwitchNote: stored on the def, used ONLY when the adapter is
 *     called with preferKeySwitches: true (then UACC profiles emit KS fallbacks
 *     instead of CC). Exporter default: false. When preferKeySwitches is set
 *     but a mapped technique has no fallback note, that trigger is skipped with
 *     a one-line warning (never fabricated).
 *  #7 Vibrato/Portamento CC fields are schema-accepted hooks; the adapter
 *     emits NOTHING for them (no fabrication). Future-stage only.
 *  #8 PROGRAM_CHANGE: the adapter emits the stream event; export/midi.ts
 *     feature-detects @tonejs/midi support and warns-and-skips when the writer
 *     can't render it. The JUCE engine consumes the stream natively.
 *  #9 MIDI_CHANNEL: the adapter assigns channels per event (1–16); the @tonejs
 *     writer splits one project track into one tonejs track per used channel.
 *  #10 Unmapped techniques pass through: no articulation trigger is emitted,
 *     but dynamic/expression/filter CC, sustain and bends stay identical.
 */

import { msToTicks } from "../shared/schema/time";
import { CC74_OFFSETS, type ArticulationTechnique } from "../generation/articulation";
import type { Note } from "../shared/schema/types";
import bbcsoJson from "../presets/vst3/spitfire_bbcso_standalone.json";
import uviJson from "../presets/vst3/uvi_orchestral_suite.json";
import vslJson from "../presets/vst3/vsl_synchron.json";
import sineJson from "../presets/vst3/sine_orchestral_tools.json";
import kontaktJson from "../presets/vst3/kontakt_factory.json";

export type TriggerType = "KEY_SWITCH" | "UACC_CC" | "MIDI_CHANNEL" | "PROGRAM_CHANGE";
export type Vst3TriggerMode = "KEY_SWITCH" | "UACC" | "MIDI_CHANNEL" | "PROGRAM_CHANGE";

export interface ArticulationTriggerDef {
  triggerType: TriggerType;
  /** 0–127, required for KEY_SWITCH (loader warns when ≥ 36 — above cello low C
   * is not a real key-switch convention, but it stays a warning, not an error). */
  keySwitchNote?: number;
  /** Default true for KEY_SWITCH (latching per reconciliation #5); false = momentary. */
  isLatching?: boolean;
  /** 0–127 CC number, required for UACC_CC. */
  ccNumber?: number;
  /** 0–127 CC value, required for UACC_CC. */
  ccValue?: number;
  /** 1–16, required for MIDI_CHANNEL (reconciliation #9). */
  targetMidiChannel?: number;
  /** 0–127, required for PROGRAM_CHANGE. */
  programNumber?: number;
  /** Stored but unused unless the adapter runs with preferKeySwitches: true. */
  fallbackKeySwitchNote?: number;
}

export interface Vst3CcMappings {
  dynamicCc: number;
  expressionCc: number;
  filterCutoffCc: number;
  /** Schema hooks only — the adapter emits nothing for these (decision #7). */
  vibratoCc?: number;
  sustainCc?: number;
  volumeCc?: number;
}

export interface Vst3Profile {
  id: string;
  profileName: string;
  vendor: string;
  triggerMode: Vst3TriggerMode;
  /** 0–100 ms; owns the pre-trigger on the profile path (decision #2). */
  preTriggerOffsetMs: number;
  ccMappings: Vst3CcMappings;
  /** Required when triggerMode is UACC (the UACC CC number, e.g. 32 for BBCSO). */
  uaccControlChange?: number;
  /** Brightness scale, default 1; BBCSO ships 0.5 (see decision #3). */
  cc74Scale?: number;
  /** Keys ⊆ ArticulationTechnique (loader-enforced). */
  articulationMap: Record<string, ArticulationTriggerDef>;
}

/**
 * DIVERGENCE FROM SPEC (documented): the PhysicalMidiStreamEvent eventType
 * union gains "PITCH_BEND". Bends must survive the profile path or brass
 * gestures (RIP/DOIT/FALL_OFF) die there — the spec's union lacked them.
 * Encoding: data1 = 0 (LSB), data2 = 0–127 MSB, 64 = no bend
 * (~±200 cents range, matching the exporter's legacy bend clamp).
 */
export interface PhysicalMidiStreamEvent {
  eventType: "NOTE_ON" | "NOTE_OFF" | "CONTROL_CHANGE" | "PROGRAM_CHANGE" | "PITCH_BEND";
  /** 1–16 (decision #9). */
  channel: number;
  data1: number;
  data2: number;
  /** Absolute ticks. */
  timestampTicks: number;
  /** True for the articulation trigger events (KS note-on / UACC CC). */
  isArticulationSwitch?: boolean;
  /** Stage 3c — owning track id (engine load path only; export streams never
   * set it). The engine uses it for per-track mute/solo gating + routing. */
  trackId?: string;
}

/** Full runtime list of legal articulationMap keys (mirrors the union in
 * generation/articulation.ts, which is type-only). */
export const ARTICULATION_TECHNIQUES: readonly ArticulationTechnique[] = [
  // strings
  "LEGATO", "DETACHE", "PORTATO", "MARTELE", "SPICCATO", "JETE", "SALTANDO",
  "PIZZICATO_STD", "PIZZICATO_SECCO", "BARTOK_SNAP", "BOWED_TREMOLO",
  "FINGERED_TREMOLO", "SUL_PONTICELLO", "SUL_TASTO", "COL_LEGNO",
  // woodwinds
  "LEGATO_SLUR", "STACCATO_STANDARD", "STACCATO_DOUBLE_TRIPLE",
  "FLUTTERTONGUE", "TRILL_UNMEASURED",
  // brass
  "STANDARD_TONGUED", "FALL_OFF_SHORT", "FALL_OFF_LONG", "DOIT", "RIP",
  "SHAKE", "CUP_MUTE", "STRAIGHT_MUTE", "HARMON_MUTE",
  // default
  "STANDARD",
] as const;

const ARTICULATION_KEY_SET = new Set<string>(ARTICULATION_TECHNIQUES);
const TRIGGER_TYPE_SET = new Set<TriggerType>(["KEY_SWITCH", "UACC_CC", "MIDI_CHANNEL", "PROGRAM_CHANGE"]);
const clamped = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
const isInt = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Number.isInteger(n);

export type LoadProfileResult = { ok: true; profile: Vst3Profile } | { ok: false; errors: string[] }

/** Validate one expression-map JSON. Keys prefixed with "_" are ignored
 * (placeholder profiles carry a "_note" description that way). */
export function loadProfile(json: unknown): LoadProfileResult {
  const errors: string[] = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, errors: ["profile must be an object"] };
  }
  const p = json as Record<string, unknown>;
  const label = typeof p.profileName === "string" && p.profileName ? p.profileName : "profile";
  const need = (condition: boolean, message: string) => { if (!condition) errors.push(message); };

  for (const field of ["id", "profileName", "vendor"] as const) {
    need(typeof p[field] === "string" && (p[field] as string).length > 0, `${label}.${field} must be a non-empty string`);
  }
  need(
    p.triggerMode === "KEY_SWITCH" || p.triggerMode === "UACC" || p.triggerMode === "MIDI_CHANNEL" || p.triggerMode === "PROGRAM_CHANGE",
    `${label}.triggerMode must be one of KEY_SWITCH, UACC, MIDI_CHANNEL, PROGRAM_CHANGE`,
  );
  need(isInt(p.preTriggerOffsetMs) && p.preTriggerOffsetMs >= 0 && p.preTriggerOffsetMs <= 100, `${label}.preTriggerOffsetMs must be an integer 0–100`);
  if (typeof p.cc74Scale !== "undefined") {
    need(typeof p.cc74Scale === "number" && Number.isFinite(p.cc74Scale) && p.cc74Scale >= 0 && p.cc74Scale <= 2, `${label}.cc74Scale must be a finite number 0–2`);
  }
  if (p.triggerMode === "UACC") {
    need(isInt(p.uaccControlChange) && p.uaccControlChange >= 0 && p.uaccControlChange <= 127, `${label}.uaccControlChange must be an integer 0–127 in UACC mode`);
  }

  const cc = p.ccMappings as Vst3CcMappings | undefined;
  need(cc !== null && typeof cc === "object" && !Array.isArray(cc), `${label}.ccMappings must be an object`);
  if (cc && typeof cc === "object") {
    for (const field of ["dynamicCc", "expressionCc", "filterCutoffCc"] as const) {
      need(isInt(cc[field]) && (cc[field] as number) >= 0 && (cc[field] as number) <= 127, `${label}.ccMappings.${field} must be an integer 0–127`);
    }
    for (const field of ["vibratoCc", "sustainCc", "volumeCc"] as const) {
      if (cc[field] !== undefined) {
        need(isInt(cc[field]) && (cc[field] as number) >= 0 && (cc[field] as number) <= 127, `${label}.ccMappings.${field} must be an integer 0–127`);
      }
    }
  }

  const map = p.articulationMap;
  need(map !== null && typeof map === "object" && !Array.isArray(map), `${label}.articulationMap must be an object`);
  if (map && typeof map === "object") {
    for (const [technique, def] of Object.entries(map as Record<string, ArticulationTriggerDef>)) {
      need(ARTICULATION_KEY_SET.has(technique), `${label}.articulationMap key "${technique}" is not an ArticulationTechnique`);
      if (!def || typeof def !== "object") {
        errors.push(`${label}.articulationMap["${technique}"] must be an object`);
        continue;
      }
      need(def.triggerType !== undefined && TRIGGER_TYPE_SET.has(def.triggerType), `${label}.articulationMap["${technique}"].triggerType is invalid`);
      const d = def as ArticulationTriggerDef;
      if (d.triggerType === "KEY_SWITCH") {
        const warn = (message: string) => console.warn(`[scorch] ${label}: ${message}`);
        if (!isInt(d.keySwitchNote) || d.keySwitchNote < 0 || d.keySwitchNote > 127) {
          errors.push(`${label}.articulationMap["${technique}"].keySwitchNote must be an integer 0–127 for KEY_SWITCH`);
        } else if (d.keySwitchNote >= 36) {
          warn(`key-switch note ${d.keySwitchNote} for "${technique}" is ≥ 36 (above cello low C) — check the map`);
        }
        if (d.isLatching !== undefined && typeof d.isLatching !== "boolean") {
          errors.push(`${label}.articulationMap["${technique}"].isLatching must be a boolean`);
        }
      } else if (d.triggerType === "UACC_CC") {
        if (!isInt(d.ccNumber) || d.ccNumber < 0 || d.ccNumber > 127) {
          errors.push(`${label}.articulationMap["${technique}"].ccNumber must be an integer 0–127 for UACC_CC`);
        } else if (isInt(p.uaccControlChange) && d.ccNumber !== p.uaccControlChange) {
          errors.push(`${label}.articulationMap["${technique}"].ccNumber (${d.ccNumber}) differs from uaccControlChange (${p.uaccControlChange})`);
        }
        need(isInt(d.ccValue) && d.ccValue >= 0 && d.ccValue <= 127, `${label}.articulationMap["${technique}"].ccValue must be an integer 0–127 for UACC_CC`);
      } else if (d.triggerType === "MIDI_CHANNEL") {
        need(isInt(d.targetMidiChannel) && d.targetMidiChannel >= 1 && d.targetMidiChannel <= 16, `${label}.articulationMap["${technique}"].targetMidiChannel must be an integer 1–16 for MIDI_CHANNEL`);
      } else if (d.triggerType === "PROGRAM_CHANGE") {
        need(isInt(d.programNumber) && d.programNumber >= 0 && d.programNumber <= 127, `${label}.articulationMap["${technique}"].programNumber must be an integer 0–127 for PROGRAM_CHANGE`);
      }
      if (d.fallbackKeySwitchNote !== undefined && (!isInt(d.fallbackKeySwitchNote) || d.fallbackKeySwitchNote < 0 || d.fallbackKeySwitchNote > 127)) {
        errors.push(`${label}.articulationMap["${technique}"].fallbackKeySwitchNote must be an integer 0–127`);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    profile: p as unknown as Vst3Profile,
  };
}

/** The two profiles loaded and validated exactly once per process; a shipped
 * profile failing loadProfile is a build-time bug, so it throws. */
function jackIn(raw: Record<string, unknown>, source: string): Vst3Profile {
  const result = loadProfile(raw);
  if (!result.ok) throw new Error(`[scorch] shipped profile ${source} failed validation: ${result.errors.join("; ")}`);
  return result.profile;
}

const ids = new Set<string>();
function register(profile: Vst3Profile, source: string): Vst3Profile {
  if (ids.has(profile.id)) throw new Error(`[scorch] shipped profile ${source}: duplicate id "${profile.id}"`);
  ids.add(profile.id);
  return profile;
}

const profileFrom = (json: unknown, source: string) => register(jackIn(json as Record<string, unknown>, source), source);

/** Built-in expression map registry — validated at load; ids unique. */
export const BUILT_IN_PROFILES: Readonly<Vst3Profile[]> = [
  profileFrom(bbcsoJson, "spitfire_bbcso_standalone.json"),
  profileFrom(uviJson, "uvi_orchestral_suite.json"),
  profileFrom(vslJson, "vsl_synchron.json"),
  profileFrom(sineJson, "sine_orchestral_tools.json"),
  profileFrom(kontaktJson, "kontakt_factory.json"),
];

export function builtInProfileById(id: string): Vst3Profile | undefined {
  return BUILT_IN_PROFILES.find((profile) => profile.id === id);
}

const cc74BaseFor = (note: Note): number => {
  if (note.dynamics?.cc74Value !== undefined) return note.dynamics.cc74Value;
  const offset = note.technique ? CC74_OFFSETS[note.technique as keyof typeof CC74_OFFSETS] ?? 0 : 0;
  return clamped(64 + offset + (note.cc74Offset ?? 0), 0, 127);
};

interface AdapterOptions {
  /** Reconciliation #6: UACC profiles emit fallback KS notes instead of CC when set. */
  preferKeySwitches?: boolean;
  /** Absolute track-end tick for the all-notes-off and latching-KS close-off;
   * defaults to the last note end when omitted. */
  endTick?: number;
}

/**
 * PURE — semantic notes → physical MIDI stream events (decisions #1–#10 in the
 * module header). Same input ⇒ byte-identical output event list; every event
 * ordering (including the NOTE_OFF-before-NOTE_ON tie at the same tick) is
 * deterministic.
 */
export function vst3EventAdapter(notes: Note[], profile: Vst3Profile, bpm: number, opts?: AdapterOptions): PhysicalMidiStreamEvent[] {
  const cc74Scale = profile.cc74Scale ?? 1;
  const cutoff = opts?.endTick ?? Number.POSITIVE_INFINITY;
  const triggers = [...notes]
    .filter((note) => note.durationTicks > 0 && note.startTick < cutoff)
    .sort((a, b) => a.startTick - b.startTick || a.pitch - b.pitch || a.durationTicks - b.durationTicks);
  const trackEnd = opts?.endTick ?? triggers.reduce((max, note) => Math.max(max, note.startTick + note.durationTicks), 0);
  const preTriggerTicks = Math.round(msToTicks(profile.preTriggerOffsetMs, bpm));
  const events: PhysicalMidiStreamEvent[] = [];
  let lastTechnique: string | null = null;
  // Open latching-switch tracker — a local, so consecutive adapter calls are
  // independent (module state would leak between calls and break purity).
  let openSwitch: { note: number; channel: number; latching: boolean } | null = null;
  let lastNoteEnd = 0;

  for (const note of triggers) {
    const technique = note.technique ?? "STANDARD";
    const def = profile.articulationMap[technique];
    const start = Math.max(0, note.startTick);
    const end = Math.min(trackEnd, start + Math.max(1, note.durationTicks));
    lastNoteEnd = Math.max(lastNoteEnd, end);
    // Decision #10: unmapped techniques channel 1 (the profile base); mapped
    // MIDI_CHANNEL articulations route the WHOLE event group (trigger, note,
    // CCs, bends) to the def's target channel — that channel holds the patch.
    const channel = def && def.triggerType === "MIDI_CHANNEL" ? def.targetMidiChannel ?? 1 : 1;

    // Decision #4/#6: emit the articulation trigger ONLY when the articulation
    // CHANGES across the sorted note stream (latching semantics; no CC spam).
    if (def && (lastTechnique === null || lastTechnique !== technique)) {
      const triggerTick = Math.max(0, start - preTriggerTicks);
      const useKeySwitch = def.triggerType === "KEY_SWITCH" || (opts?.preferKeySwitches === true && def.fallbackKeySwitchNote !== undefined);
      if (def.triggerType === "UACC_CC" && opts?.preferKeySwitches === true && def.fallbackKeySwitchNote === undefined) {
        // Decision #6: preferKeySwitches swaps CC for the stored KS fallback;
        // none stored ⇒ no trigger (never fabricated), one-line warning.
        console.warn(`[scorch] preferKeySwitches requested but "${technique}" has no fallbackKeySwitchNote in ${profile.id} — trigger skipped`);
      } else if (useKeySwitch) {
        const ksNote = def.triggerType === "KEY_SWITCH" ? def.keySwitchNote : def.fallbackKeySwitchNote;
        if (openSwitch) {
          // Decision #5: close an open latching KS immediately before the next
          // articulation's KS note-on (same tick, earlier in stream order).
          events.push({ eventType: "NOTE_OFF", channel: openSwitch.channel, data1: openSwitch.note, data2: 0, timestampTicks: triggerTick });
          openSwitch = null;
        }
        if (ksNote !== undefined) {
          events.push({ eventType: "NOTE_ON", channel, data1: ksNote, data2: 64, timestampTicks: triggerTick, isArticulationSwitch: true });
          openSwitch = { note: ksNote, channel, latching: def.isLatching !== false };
        }
      } else if (def.triggerType === "UACC_CC" && def.ccNumber !== undefined && def.ccValue !== undefined) {
        // UACC CC (the default path for decision #1): latching by nature.
        events.push({ eventType: "CONTROL_CHANGE", channel, data1: def.ccNumber, data2: def.ccValue, timestampTicks: triggerTick, isArticulationSwitch: true });
      } else if (def.triggerType === "PROGRAM_CHANGE" && def.programNumber !== undefined) {
        // Decision #8: stream event only; the writer feature-detects rendering.
        events.push({ eventType: "PROGRAM_CHANGE", channel, data1: def.programNumber, data2: 0, timestampTicks: triggerTick, isArticulationSwitch: true });
      }
      // MIDI_CHANNEL defs carry no trigger event (decision #9): switching
      // articulation = continuing on the def's channel (applied above).
    }

    // Musical note + per-note CC automation (decisions #1/#10: identical CC/bend
    // handling for mapped and unmapped techniques alike, on the profile CC numbers).
    events.push({ eventType: "NOTE_ON", channel, data1: note.pitch, data2: note.velocity, timestampTicks: start });
    events.push({ eventType: "CONTROL_CHANGE", channel, data1: profile.ccMappings!.dynamicCc, data2: clamped(note.velocity, 0, 127), timestampTicks: start });
    events.push({ eventType: "CONTROL_CHANGE", channel, data1: profile.ccMappings!.expressionCc, data2: clamped(note.dynamics?.cc11Value ?? note.velocity, 0, 127), timestampTicks: start });
    events.push({ eventType: "CONTROL_CHANGE", channel, data1: profile.ccMappings!.filterCutoffCc, data2: clamped(Math.round(cc74BaseFor(note) * cc74Scale), 0, 127), timestampTicks: start });
    if (profile.ccMappings!.sustainCc !== undefined) {
      const sustain = profile.ccMappings!.sustainCc;
      events.push({ eventType: "CONTROL_CHANGE", channel, data1: sustain, data2: 127, timestampTicks: start });
      events.push({ eventType: "CONTROL_CHANGE", channel, data1: sustain, data2: 0, timestampTicks: end });
    }
    // DIVERGENCE (documented on the type): bends ride PITCH_BEND, not CC —
    // without them brass gestures (RIP/DOIT/FALL_OFF) would be lost here.
    if (note.pitchBendPoints?.length) {
      for (const point of note.pitchBendPoints) {
        const bend = Math.max(-1, Math.min(1, point.cents / 200));
        const tick = Math.min(Math.max(0, point.tick), end);
        events.push({ eventType: "PITCH_BEND", channel, data1: 0, data2: Math.round(bend * 64) + 64, timestampTicks: tick });
      }
      events.push({ eventType: "PITCH_BEND", channel, data1: 0, data2: 64, timestampTicks: end }); // reset after the ramp
    } else if (note.detuneCents) {
      const bend = Math.max(-1, Math.min(1, note.detuneCents / 200));
      events.push({ eventType: "PITCH_BEND", channel, data1: 0, data2: Math.round(bend * 64) + 64, timestampTicks: start });
      events.push({ eventType: "PITCH_BEND", channel, data1: 0, data2: 64, timestampTicks: end });
    }
    events.push({ eventType: "NOTE_OFF", channel, data1: note.pitch, data2: 0, timestampTicks: end });
    if (openSwitch && !openSwitch.latching) {
      // Decision #5 momentary mode: the KS releases with the musical note.
      events.push({ eventType: "NOTE_OFF", channel: openSwitch.channel, data1: openSwitch.note, data2: 0, timestampTicks: end });
      openSwitch = null;
    }
    lastTechnique = technique;
  }

  const allNotesOffTick = Math.max(trackEnd, lastNoteEnd);
  // Decision #5: an open latching KS closes right before all-notes-off.
  if (openSwitch) {
    events.push({ eventType: "NOTE_OFF", channel: openSwitch.channel, data1: openSwitch.note, data2: 0, timestampTicks: allNotesOffTick });
  }
  // All-notes-off on EVERY used channel at the track end (same convention as
  // the legacy writer; a channel-split profile must not fabricate a phantom
  // extra tonejs track just for a channel-1 CC123).
  const usedChannels = new Set(events.map((event) => event.channel));
  for (const channel of usedChannels) {
    events.push({ eventType: "CONTROL_CHANGE", channel, data1: 123, data2: 0, timestampTicks: allNotesOffTick });
  }
  return events;
}
