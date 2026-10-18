import { cloneProject, validateProject, type Project } from "../shared/schema";

export interface ExportedProject extends Project {
  exportedAt: string;
}

export function exportProjectJson(project: Project): string {
  const payload: ExportedProject = {
    ...cloneProject(project),
    exportedAt: new Date().toISOString(),
  };
  return JSON.stringify(payload, null, 2);
}

export function importProjectJson(text: string): { ok: true; project: Project } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (raw && typeof raw === "object" && "exportedAt" in raw) {
    const copy = { ...(raw as Record<string, unknown>) };
    delete copy.exportedAt;
    raw = copy;
  }
  const result = validateProject(raw);
  if (!result.ok) return { ok: false, errors: result.errors };
  return { ok: true, project: result.project };
}

export function projectsEqual(a: Project, b: Project): boolean {
  const strip = (p: Project) => {
    const c = cloneProject(p);
    return c;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}
