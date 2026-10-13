import { MODE_NAMES, SCHEMA_VERSION } from "./types";

/** JSON Schema (draft-07) matching the Project contract. */
export const PROJECT_JSON_SCHEMA = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://scorch.app/schema/project.json",
  title: "ScorchProject",
  type: "object",
  additionalProperties: true,
  required: [
    "schemaVersion",
    "name",
    "bpm",
    "tempoMap",
    "timeSignature",
    "key",
    "mode",
    "sections",
    "chords",
    "referenceAudio",
    "tracks",
    "libraryGroups",
  ],
  properties: {
    schemaVersion: { type: "integer", const: SCHEMA_VERSION },
    name: { type: "string" },
    bpm: { type: "number", minimum: 20, maximum: 400 },
    tempoMap: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["tick", "bpm"],
        properties: {
          tick: { type: "integer", minimum: 0 },
          bpm: { type: "number", minimum: 20, maximum: 400 },
        },
      },
    },
    timeSignature: {
      type: "object",
      required: ["numerator", "denominator"],
      properties: {
        numerator: { type: "integer", minimum: 1, maximum: 32 },
        denominator: { type: "integer", enum: [1, 2, 4, 8, 16, 32] },
      },
    },
    key: { type: "integer", minimum: 0, maximum: 11 },
    mode: { type: "string", enum: [...MODE_NAMES] },
    generationSettings: {
      type: "object",
      required: ["orchestralStyle", "orchestration", "humanization"],
      properties: {
        orchestralStyle: { type: "string", enum: ["Epic Cinematic", "Classical Symphonic", "Chamber Strings", "Pop/Rock Studio Orchestra", "Jazz Big Band", "Custom"] },
        orchestration: {
          type: "object",
          properties: {
            balance: {
              type: "object",
              properties: {
                windowing: { type: "object", properties: { enabled: { type: "boolean" }, minGapMs: { type: "number", minimum: 0, maximum: 2000 }, searchWindowMs: { type: "number", minimum: 0, maximum: 2000 }, allowOctaveEscape: { type: "boolean" } } },
                attenuation: { type: "object", properties: { lowFluteFactor: { type: "number", minimum: 0, maximum: 1 }, brassDominanceFactor: { type: "number", minimum: 0, maximum: 1 }, combinedFloor: { type: "number", minimum: 0, maximum: 1 } } },
                cc11Floor: { type: "number", minimum: 10, maximum: 127 },
              },
            },
          },
        },
        humanization: { type: "object" },
        themes: {
          type: "object",
          properties: {
            germ: { type: "boolean" },
            nct: { type: "boolean" },
            counterline: { type: "boolean" },
          },
        },
        arrangement: {
          type: "object",
          properties: {
            enableAutoBuildStaggering: { type: "boolean" },
            enableTransitionGestures: { type: "boolean" },
            breakdownExposedLayer: { type: "string", enum: ["SOLO_CELLO", "SOLO_WOODWIND", "HARP_PAD", "PIANO_ONLY"] },
          },
        },
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "startBar", "lengthBars"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string" },
          startBar: { type: "integer", minimum: 1 },
          lengthBars: { type: "integer", minimum: 1 },
          targetDynamic: { type: "number", minimum: 0, maximum: 1 },
          densityLevel: { type: "string", enum: ["Sparse", "Balanced", "Dense", "Tutti"] },
          buildCurveType: { type: "string", enum: ["LINEAR", "EXPONENTIAL", "STEPPED"] },
        },
      },
    },
    chords: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "symbol", "startTick", "durationTicks"],
        properties: {
          id: { type: "string", minLength: 1 },
          symbol: { type: "string" },
          startTick: { type: "integer", minimum: 0 },
          durationTicks: { type: "integer", minimum: 1 },
          quality: { type: "string", enum: ["Maj", "Min", "Dim", "Aug", "Sus2", "Sus4"] },
          extensions: { type: "array", items: { type: "string" } },
          bassOverride: { type: "integer", minimum: 0, maximum: 11 },
        },
      },
    },
    referenceAudio: {
      type: "object",
      required: ["path", "offsetMs"],
      properties: {
        path: { type: "string" },
        offsetMs: { type: "number" },
      },
    },
    libraryGroups: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "name", "pluginId", "pluginState"],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string" },
          pluginId: { type: ["string", "null"] },
          pluginState: { type: ["string", "null"] },
        },
      },
    },
    tracks: {
      type: "array",
      items: {
        type: "object",
        required: [
          "id",
          "name",
          "family",
          "color",
          "role",
          "lowestNote",
          "highestNote",
          "locked",
          "muted",
          "soloed",
          "libraryGroupId",
          "midiChannel",
          "frozen",
          "notes",
        ],
        properties: {
          id: { type: "string", minLength: 1 },
          name: { type: "string" },
          family: {
            type: "string",
            enum: ["structure", "audio", "strings", "brass", "woodwinds", "percussion", "keys"],
          },
          color: { type: "string" },
          role: { type: "string" },
          lowestNote: { type: "integer", minimum: 0, maximum: 127 },
          highestNote: { type: "integer", minimum: 0, maximum: 127 },
          locked: { type: "boolean" },
          muted: { type: "boolean" },
          soloed: { type: "boolean" },
          expressionMapping: {
            type: "object",
            required: ["preset", "dynamicCC", "expressionCC", "brightnessCC", "sustainCC"],
            properties: {
              preset: { type: "string", enum: ["Spitfire UACC", "VSL Synchron", "SINE", "Kontakt Standard", "Custom"] },
              dynamicCC: { type: "integer", minimum: 0, maximum: 127 },
              expressionCC: { type: "integer", minimum: 0, maximum: 127 },
              brightnessCC: { type: "integer", minimum: 0, maximum: 127 },
              sustainCC: { type: "integer", minimum: 0, maximum: 127 },
            },
          },
          libraryGroupId: { type: ["string", "null"] },
          midiChannel: { type: "integer", minimum: 1, maximum: 16 },
          frozen: { type: "boolean" },
          notes: {
            type: "array",
            items: {
              type: "object",
              required: ["pitch", "startTick", "durationTicks", "velocity"],
              properties: {
                pitch: { type: "integer", minimum: 0, maximum: 127 },
                startTick: { type: "integer", minimum: 0 },
                durationTicks: { type: "integer", minimum: 1 },
                velocity: { type: "integer", minimum: 1, maximum: 127 },
                detuneCents: { type: "number", minimum: -15, maximum: 15 },
                isDoubling: { type: "boolean" },
                cc74Offset: { type: "number" },
                dynamics: {
                  type: "object",
                  required: ["cc11Value", "cc74Value", "attenuationActive"],
                  properties: {
                    cc11Value: { type: "integer", minimum: 0, maximum: 127 },
                    cc74Value: { type: "integer", minimum: 0, maximum: 127 },
                    attenuationActive: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
