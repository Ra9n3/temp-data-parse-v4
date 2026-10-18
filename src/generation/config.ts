import type { OrchestralStyle } from "../shared/schema/types";

export interface StyleMacroWeights {
  strings: number;
  brass: number;
  woodwinds: number;
  percussion: number;
  rhythm: number;
}

export const ORCHESTRAL_STYLE_WEIGHTS: Record<OrchestralStyle, StyleMacroWeights> = {
  "Epic Cinematic": { strings: 1, brass: 1, woodwinds: 0.65, percussion: 1, rhythm: 0.75 },
  "Classical Symphonic": { strings: 1, brass: 0.75, woodwinds: 0.8, percussion: 0.5, rhythm: 0.5 },
  "Chamber Strings": { strings: 1, brass: 0.2, woodwinds: 0.35, percussion: 0.1, rhythm: 0.35 },
  "Pop/Rock Studio Orchestra": { strings: 0.7, brass: 0.6, woodwinds: 0.45, percussion: 1, rhythm: 1 },
  "Jazz Big Band": { strings: 0.3, brass: 1, woodwinds: 0.8, percussion: 0.85, rhythm: 1 },
  Custom: { strings: 1, brass: 1, woodwinds: 1, percussion: 1, rhythm: 1 },
};

export function normalizeSectionName(name: string): string {
  return name.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ")
    .replace(/pre\s*chorus/, "pre-chorus").replace(/prechorus/, "pre-chorus");
}
