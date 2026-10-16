/**
 * Module 8.11 — Persistence: autosave, startup restore and mix overrides.
 *
 * App-layer ONLY (no generation/engine changes, no RNG, no schemaVersion
 * change — the autosave is APP STATE, not the project schema; the schema
 * guards below just use the project's own schemaVersion field).
 *
 * P1 — autosave writes the FULL project to localStorage under
 *      "scorch.autosave.v1", debounced in the App-layer effect (~800 ms),
 *      quota errors caught with a warn-once.
 * P2 — startup restore = localStorage → validateProject → fallback chain
 *      (fixture). A saved payload whose schemaVersion ≠ 1 is DISCARDED
 *      (future-schema safeness).
 * P3 — corrupt/invalid payload → caller boots the fixture with one warn + toast
 *      (the App shows "saved project was invalid, loaded default").
 * P6 — undo/redo history is deliberately NOT persisted (documented choice:
 *      restoring stacks of immer snapshots across sessions invites stack
 *      corruption bugs for zero user value — the project itself is saved).
 * P7 — mix panel overrides live under "scorch.mix.v1" (preview-only constants;
 *      the preview reads them at schedule time, code defaults as fallback).
 */
import type { Project } from "../shared/schema/types";
import { validateProject } from "../shared/schema/validate";

export const AUTOSAVE_KEY = "scorch.autosave.v1";
export const MIX_KEY = "scorch.mix.v1";
export const EXPECTED_SCHEMA_VERSION = 1;

export interface AutosaveEnvelope {
  savedAt: string;
  schemaVersion: number;
  project: Project;
}

let quotaWarned = false;

/** P1 — serialize + validate-encode the whole project; quota/serialization errors caught, warn once. */
export function saveAutosave(project: Project): { ok: boolean; error?: string } {
  try {
    const envelope: AutosaveEnvelope = {
      savedAt: new Date().toISOString(),
      schemaVersion: project.schemaVersion,
      project,
    };
    window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(envelope));
    return { ok: true };
  } catch (error) {
    if (!quotaWarned) {
      quotaWarned = true;
      console.warn("[scorch] autosave failed (saving disabled this session?)", error instanceof Error ? error.message : error);
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export interface AutosaveResult {
  ok: boolean;
  project?: Project;
  reason?: "parse" | "validate" | "version";
}

/** P2/P3 — restore with the full fallback contract; NEVER throws. */
export function loadAutosave(): AutosaveResult {
  try {
    const raw = window.localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return { ok: false, reason: "parse" }; // nothing saved = plain fixture boot (no warn)
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "parse" }; // P3: garbage payload
    }
    const envelope = parsed as Partial<AutosaveEnvelope> | null;
    if (!envelope || typeof envelope !== "object" || !envelope.project) return { ok: false, reason: "parse" };
    if (envelope.schemaVersion !== EXPECTED_SCHEMA_VERSION) return { ok: false, reason: "version" }; // P2 version guard
    const validated = validateProject(envelope.project);
    if (!validated.ok) return { ok: false, reason: "validate" }; // P3: fails schema → fixture boot
    return { ok: true, project: validated.project };
  } catch {
    // storage itself unavailable (privacy mode etc.) — boot the fixture, never crash
    return { ok: false, reason: "parse" };
  }
}

// ---------- Mix panel (P7) ----------

export interface MixOverrides {
  masterGain?: number;
  trims?: Record<string, number>;
}

/** Parse overrides from the persisted mix record; NaN/invalid entries dropped. */
export function parseMixRecord(raw: string | null): MixOverrides | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<MixOverrides> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const clean: MixOverrides = {};
    if (typeof parsed.masterGain === "number" && Number.isFinite(parsed.masterGain) && parsed.masterGain > 0) {
      clean.masterGain = parsed.masterGain;
    }
    if (parsed.trims && typeof parsed.trims === "object") {
      const trims: Record<string, number> = {};
      for (const [role, value] of Object.entries(parsed.trims)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1.5) trims[role] = value;
      }
      if (Object.keys(trims).length) clean.trims = trims;
    }
    return clean.masterGain !== undefined || clean.trims !== undefined ? clean : null;
  } catch {
    return null; // P3-class guard for the mix record too
  }
}

export function readMixOverrides(): MixOverrides | null {
  try {
    return parseMixRecord(window.localStorage.getItem(MIX_KEY));
  } catch {
    return null;
  }
}

export function saveMixOverrides(mix: MixOverrides): { ok: boolean; error?: string } {
  try {
    window.localStorage.setItem(MIX_KEY, JSON.stringify(mix));
    return { ok: true };
  } catch (error) {
    if (!quotaWarned) {
      quotaWarned = true;
      console.warn("[scorch] mix overrides could not be saved", error instanceof Error ? error.message : error);
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function clearMixOverrides(): void {
  try {
    window.localStorage.removeItem(MIX_KEY);
  } catch {
    /* storage unavailable — nothing to clear */
  }
}

// ─── Stage 3f-2 — extra scan directories ("scanner must not lose plugins") ──
// The scan dialog's free-text box (one folder path per line, no folder picker,
// no new Tauri permissions) persists here and rides EVERY scan message
// together with the shell's default folders.
export const SCAN_DIRS_KEY = "scorch.scanDirs";

/** Read the persisted extra scan dirs; tolerate garbage (returns []). */
export function readExtraScanDirs(): string[] {
  try {
    const raw = window.localStorage.getItem(SCAN_DIRS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    return [];
  }
}

/** Persist the extra scan dirs (already-normalized list). */
export function saveExtraScanDirs(dirs: string[]): void {
  try {
    window.localStorage.setItem(SCAN_DIRS_KEY, JSON.stringify(dirs));
  } catch {
    /* storage unavailable — the box still works for this session */
  }
}
