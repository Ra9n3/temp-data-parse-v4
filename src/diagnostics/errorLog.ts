// Stage 3b polish — error.log rider.
//
// Every uncaught error and unhandled promise rejection in the webview is
// appended (via the Rust shell) to %APPDATA%/scorch/error.log — the field
// diagnostic the by-ear test reports depend on ("read the logged stack").
// The rider is fire-and-forget: it must NEVER throw, never block, and never
// recurse (a failing logger degrades to console.error only).
//
// Transport handlers (enginePlay/engineStop/… in App.tsx) additionally wrap
// their bodies in try/catch → writeErrorLog, so a handler throw is captured
// with a live stack even if a future refactor removes the global window
// listeners. Outside Tauri (vite web preview) there is no shell to write to —
// the rider degrades to console output with the same formatting.

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let installed = false;
let probed = false;
let cachedInvoke: TauriInvoke | null = null;

/** Probe the Tauri v2 internals once; null outside the desktop shell. */
function getInvoke(): TauriInvoke | null {
  if (probed) return cachedInvoke;
  probed = true;
  try {
    const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: TauriInvoke } })
      .__TAURI_INTERNALS__;
    if (internals && typeof internals.invoke === "function") {
      cachedInvoke = internals.invoke.bind(internals);
    }
  } catch {
    cachedInvoke = null;
  }
  return cachedInvoke;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Append one timestamped entry to %APPDATA%/scorch/error.log (or console). */
export function writeErrorLog(source: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] [${source}] ${describe(err)}`.slice(0, 8000);
  const invoke = getInvoke();
  if (!invoke) {
    // Web preview (no Tauri shell) — same content, console destination.
    console.error("[scorch] error.log >", line);
    return;
  }
  try {
    void invoke("append_error_log", { line }).catch(() => {
      /* the logger must never surface its own failures */
    });
  } catch {
    /* ditto */
  }
}

/**
 * Global riders: window "error" + "unhandledrejection" → error.log.
 * Called once from main.tsx before React mounts so even mount-time throws
 * are captured.
 */
export function installGlobalErrorLog(): void {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (e) => {
    writeErrorLog(
      "uncaught",
      e.error ?? `${e.message} (${e.filename}:${e.lineno}:${e.colno})`,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    writeErrorLog("unhandled-rejection", e.reason);
  });
}
