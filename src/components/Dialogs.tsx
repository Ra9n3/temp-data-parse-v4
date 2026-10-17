import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import JSZip from "jszip";
import { ScorchMark } from "./ScorchMark";
import { Ph } from "../icons";
import {
  DEFAULT_SCAN_DIR,
  MOCK_PLUGINS,
  pluginDisplayName,
  type PluginScanState,
} from "../plugins/mockService";
import type { ScanFailedEntry, ScannedPlugin } from "../engine/engineClient";
import { rowsNeedingProbe, swapPickerRows } from "../engine/engineClient";
import { BUILT_IN_PROFILES } from "../plugins/expressionMaps";
import type { ExportTrackMode } from "../export/midi";
import { exportMergedMidi, exportPerTrackMidi } from "../export/midi";
import { exportProjectJson } from "../export/json";
import { MASTER_GAIN, ROLE_PREVIEW_GAIN_TRIM } from "../audio/usePlayback";
import { type MixOverrides, clearMixOverrides, readMixOverrides, saveMixOverrides, readExtraScanDirs, saveExtraScanDirs } from "../state/persistence";
import type { Note, Project, Track } from "../shared/schema/types";
import { projectEndTick, ticksPerBar, ticksPerBeat } from "../shared/schema/time";
import { midiName } from "../generation/generate";
import type { TestResult } from "../tests/runTests";
import { cn } from "../utils/cn";

export interface ToastItem {
  id: string;
  kind: "ok" | "error" | "info";
  message: string;
}

export function Toasts({ items, onDismiss }: { items: ToastItem[]; onDismiss: (id: string) => void }) {
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-[70] flex w-80 flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            "pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-sm shadow-xl",
            t.kind === "ok" && "border-emerald-500/30 bg-emerald-950/90 text-emerald-100",
            t.kind === "error" && "border-red-500/30 bg-red-950/90 text-red-100",
            t.kind === "info" && "border-white/10 bg-zinc-900/95 text-stone-100",
          )}
        >
          <Ph name={t.kind === "error" ? "warning" : t.kind === "ok" ? "check" : "info"} className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">{t.message}</div>
          <button type="button" className="text-stone-400 hover:text-white" onClick={() => onDismiss(t.id)}>
            <Ph name="x" className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function VstBrowser({
  open,
  state,
  onClose,
  onPick,
  onPickProfile,
  onState,
  desktop,
}: {
  open: boolean;
  state: PluginScanState;
  onClose: () => void;
  /** Desktop real-scan picks pass the scanned path as the 3rd argument
   * (browser mock picks pass two — no on-disk binary to bind). */
  onPick: (id: string, name: string, path?: string) => void;
  /** Module 9: picking a built-in expression map creates the group with
   * profileId set (instead of a scanned pluginId) and assigns the track. */
  onPickProfile: (profileId: string, name: string) => void;
  onState: (s: PluginScanState) => void;
  /**
   * Stage 3c-1 — desktop REAL scan mode (engine present). When null (browser
   * preview), the browser-only MOCK scan stays exactly as it was. In desktop
   * mode the listing comes from the engine's crash-isolated VST3 scan (real
   * name + vendor), and failed entries come from the scan's isolation report.
   * Stage 3f-2: onScan carries the dialog's extra folder paths (one per line,
   * persisted under localStorage "scorch.scanDirs") alongside the shell's
   * defaults. Stage 3f-7 (item 3): the dialog requests capability probes for
   * the rows it actually SHOWS (lazy probing — the engine no longer probes
   * every row after a scan), and "Probe all" probes every row explicitly.
   */
  desktop?: { result: { plugins: ScannedPlugin[]; failed: ScanFailedEntry[] } | null; onScan: (extraDirs?: string[]) => void; onRequestProbe?: (classId: string) => void; onProbeAll?: () => void } | null;
}) {
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(0);
  // Stage 3f-2: extra scan folders, one path per line, persisted under
  // "scorch.scanDirs" (no folder picker, no new Tauri permissions — the
  // engine receives them with the scan message next to the shell defaults).
  const [extraDirsText, setExtraDirsText] = useState(() => readExtraScanDirs().join("\n"));
  const total = MOCK_PLUGINS.length;
  const isDesktop = desktop !== null;

  // Mock scan animation — BROWSER ONLY. Desktop mode is driven by the engine's
  // real scan_result (the caller flips the state when it arrives).
  useEffect(() => {
    if (!open || isDesktop || state !== "scanning") return;
    setLoaded(0);
    let n = 0;
    const id = window.setInterval(() => {
      n += 1;
      setLoaded(n);
      if (n >= total) {
        window.clearInterval(id);
        onState("loaded");
      }
    }, 180);
    return () => window.clearInterval(id);
  }, [open, isDesktop, state, total, onState]);

  const realPlugins = isDesktop ? (desktop?.result?.plugins ?? []) : [];
  const realFailed = isDesktop ? (desktop?.result?.failed ?? []) : [];

  const plugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (isDesktop) {
      return realPlugins.filter((p) => p.name.toLowerCase().includes(q));
    }
    return MOCK_PLUGINS.filter((p) => !p.failed).filter((p) =>
      pluginDisplayName(p.rawName).toLowerCase().includes(q),
    );
  }, [query, isDesktop, realPlugins]);

  // Stage 3f-7 (item 3): LAZY probing — request a capability probe for every
  // VISIBLE row that has neither capabilities nor a capabilitiesError yet.
  // Rows the user never sees are never probed; the engine's pause gate keeps
  // even these probes off a running load/editor/transport. The requested
  // set lives in the app (dedupes across dialogs).
  const onRequestProbe = isDesktop ? desktop?.onRequestProbe : undefined;
  useEffect(() => {
    if (!open || !isDesktop || onRequestProbe === undefined) return;
    for (const classId of rowsNeedingProbe(realPlugins)) onRequestProbe(classId);
  }, [open, isDesktop, realPlugins, onRequestProbe]);

  if (!open) return null;

  return (
    <Modal title="VST3 Browser" onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <div className="flex flex-1 items-center gap-2 rounded-md bg-black/40 px-2 py-1.5 ring-1 ring-white/10">
          <Ph name="search" className="h-4 w-4 text-stone-500" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plugins"
            className="w-full bg-transparent text-sm outline-none"
          />
        </div>
        {!isDesktop && (
          <select
            value={state}
            onChange={(e) => onState(e.target.value as PluginScanState)}
            className="rounded-md bg-black/40 px-2 py-1.5 text-xs ring-1 ring-white/10"
            title="Dev: mock scan state"
          >
            <option value="not_scanned">Not scanned</option>
            <option value="scanning">Scanning</option>
            <option value="empty">Empty</option>
            <option value="loaded">Loaded</option>
          </select>
        )}
        {isDesktop && (
          <button
            type="button"
            title="Probe every row of the last scan (capability details for the whole list) — probing pauses while a load, an editor, or playback is active"
            onClick={() => desktop?.onProbeAll?.()}
            className="shrink-0 rounded-md bg-white/10 px-2.5 py-1.5 text-xs text-stone-100 hover:bg-white/15"
          >
            Probe all
          </button>
        )}
      </div>
      <div className="text-[11px] text-stone-500">
        {isDesktop ? "Scan: standard VST3 directories (per-machine, per-user Programs, per-user) + extra folders below" : `Scan directory: ${DEFAULT_SCAN_DIR}`}
      </div>
      {isDesktop && (
        <div className="mt-2">
          <label className="text-[11px] uppercase tracking-wide text-stone-500" htmlFor="scorch-extra-scan-dirs">
            Extra folders (one path per line, saved locally)
          </label>
          <textarea
            id="scorch-extra-scan-dirs"
            value={extraDirsText}
            onChange={(e) => setExtraDirsText(e.target.value)}
            rows={2}
            spellCheck={false}
            placeholder={"D:\\Audio\\VST3\n\\\\nas\\share\\Plugins"}
            className="mt-1 w-full resize-y rounded-md bg-black/40 px-2 py-1.5 font-mono text-xs outline-none ring-1 ring-white/10 focus:ring-orange-400/40"
          />
        </div>
      )}
      <div className="mt-3 min-h-[220px] rounded-lg border border-white/10 bg-black/30 p-3">
        {state === "scanning" && (
          <div className="flex h-[200px] flex-col items-center justify-center gap-3 text-stone-300">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-orange-400 border-t-transparent" />
            <div>{isDesktop ? "Scanning VST3 directories…" : `Scanning... ${loaded} of ${total} plugins loaded`}</div>
          </div>
        )}
        {state === "empty" && (
          <div className="flex h-[200px] flex-col items-center justify-center gap-3 text-stone-400">
            <div>No VST3s found.</div>
            <button
              type="button"
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-stone-100"
              onClick={() => onState("not_scanned")}
            >
              Change Directory
            </button>
          </div>
        )}
        {state === "not_scanned" && (
          <div className="flex h-[200px] flex-col items-center justify-center gap-3 text-stone-400">
            <div>No scan performed.</div>
            <button
              type="button"
              className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-black"
              onClick={() => {
                if (isDesktop) {
                  // 3f-2: persist the extra dirs and ride them with the scan
                  // message (next to the shell's default folders).
                  const extras = extraDirsText.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean);
                  saveExtraScanDirs(extras);
                  desktop?.onScan(extras);
                  return;
                }
                onState("scanning");
              }}
            >
              Scan Plugins
            </button>
          </div>
        )}
        {state === "loaded" && (
          <ul className="max-h-[280px] space-y-1 overflow-auto">
            {plugins.map((p) => {
              const isReal = "vendor" in p;
              return (
                <li key={isReal ? (p as ScannedPlugin).uid : (p as { id: string }).id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (isReal) {
                        const r = p as ScannedPlugin;
                        onPick(r.uid, r.name, r.path);
                      } else {
                        const m = p as { id: string; rawName: string };
                        onPick(m.id, pluginDisplayName(m.rawName));
                      }
                      onClose();
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5"
                  >
                    <Ph name="plug" className="h-4 w-4 text-orange-300" />
                    <span className="flex-1">{isReal ? (p as ScannedPlugin).name : pluginDisplayName((p as { rawName: string }).rawName)}</span>
                    {isReal && <span className="text-[11px] text-stone-500">{(p as ScannedPlugin).vendor}</span>}
                  </button>
                </li>
              );
            })}
            {(isDesktop ? realFailed : MOCK_PLUGINS.filter((p) => p.failed)).map((p) => (
              <li key={"error" in p ? p.path : p.id} className="px-2 py-1 text-xs text-red-400">
                {"error" in p ? (
                  // Stage 3f-2: the failed list shows PATH + ERROR + ELAPSED —
                  // the diagnostics the scan carries per failed entry.
                  <>
                    <div className="flex items-start gap-2">
                      <Ph name="warning" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 break-all" title={p.path}>{p.path}</span>
                      {typeof p.elapsedMs === "number" && (
                        <span className="ml-auto shrink-0 whitespace-nowrap text-red-300/70">
                          {(p.elapsedMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                    <div className="pl-5 text-red-300/90" title={p.stderrTail}>{p.error}</div>
                  </>
                ) : (
                  <div className="flex items-center gap-2">
                    <Ph name="warning" className="h-3.5 w-3.5" />
                    Failed: {pluginDisplayName(p.rawName)}
                  </div>
                )}
              </li>
            ))}
            <li className="pt-2 text-[11px] uppercase tracking-wide text-stone-500">Built-in expression maps</li>
            {BUILT_IN_PROFILES.map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  title={typeof (profile.articulationMap as Record<string, unknown>)._note === "string"
                    ? (profile.articulationMap as unknown as Record<string, string>)._note
                    : "expression map profile"}
                  onClick={() => {
                    onPickProfile(profile.id, profile.profileName);
                    onClose();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5"
                >
                  <Ph name="sparkle" className="h-4 w-4 text-sky-300" />
                  <span className="flex-1">{profile.profileName}</span>
                  <span className="text-[11px] text-stone-500">{profile.vendor}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/**
 * Stage 3f-4 — swap the plugin from the pill. Lists the engine's scanned
 * plugins (instruments FIRST, search box — the PURE swapPickerRows pipeline
 * in engineClient.ts, unit-tested). Picking a row switches to the spec's
 * one-line confirm: "Replace <old> with <new>? Its saved sound state will be
 * discarded." — only then does the caller send the EXISTING load/replace
 * path for that instance group (previous instance retained on failure,
 * engine-side, 3d-4). "Remove plugin" runs the same confirm shape and
 * returns the track to the built-in test synth. Desktop rows only: the
 * picker drives REAL hosting (the web-preview mock has nothing to swap).
 */
export function PluginSwapDialog({
  open,
  currentName,
  plugins,
  affectedTracks,
  onClose,
  onReplace,
  onRemove,
  onRequestProbe,
}: {
  open: boolean;
  /** The plugin currently bound to the track (the <old> in the confirm). */
  currentName: string;
  plugins: ScannedPlugin[];
  /** Stage 3g — how many tracks ride the SAME group (shared instance).
   * > 1: the replace confirm must say "this changes N tracks" (every rider
   * swaps), and the remove confirm becomes an unlink (the instance survives
   * for the other riders). Absent/1 = today's texts. */
  affectedTracks?: number;
  onClose: () => void;
  onReplace: (pick: ScannedPlugin) => void;
  onRemove: () => void;
  /** Stage 3f-7 (item 3): the picker requests capability probes for the rows
   * it shows (lazy probing) — the app dedupes across dialogs. */
  onRequestProbe?: (classId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<"remove" | ScannedPlugin | null>(null);
  // Stage 3g — the swap target's group is shared when more than one track
  // points at it. The confirm texts name that consequence.
  const shared = (affectedTracks ?? 1) > 1;
  const riderCount = (affectedTracks ?? 1) - 1;
  // Fresh dialog per open: the search and any half-taken confirm must not
  // survive into the next swap (different track, different list).
  useEffect(() => {
    if (open) {
      setQuery("");
      setPending(null);
    }
  }, [open]);
  const rows = useMemo(() => swapPickerRows(plugins, query), [plugins, query]);
  // Stage 3f-7 (item 3): the picker requests probes for the VISIBLE rows
  // (the filtered pipeline) that have not been probed yet — lazy probing.
  useEffect(() => {
    if (!open || onRequestProbe === undefined) return;
    for (const classId of rowsNeedingProbe(rows)) onRequestProbe(classId);
  }, [open, rows, onRequestProbe]);
  if (!open) return null;
  return (
    <Modal title={pending ? "Confirm" : "Swap plugin"} onClose={onClose}>
      {pending ? (
        <div>
          <p className="text-sm leading-relaxed text-stone-200">
            {pending === "remove" ? (
              shared ? (
                <>
                  Remove <span className="font-semibold text-orange-300">{currentName}</span> from this
                  track? It is unlinked — the shared instance keeps serving the other{" "}
                  {riderCount === 1 ? "track" : <> {riderCount} tracks</>}.
                </>
              ) : (
                <>
                  Remove <span className="font-semibold text-orange-300">{currentName}</span>? Its saved
                  sound state will be discarded. The track returns to the built-in test synth.
                </>
              )
            ) : (
              <>
                Replace <span className="font-semibold text-orange-300">{currentName}</span> with{" "}
                <span className="font-semibold text-orange-300">{pending.name}</span>? Its saved sound
                state will be discarded.
                {shared && <> This changes {affectedTracks} tracks.</>}
              </>
            )}
          </p>
          {(!shared || pending !== "remove") && (
            <p className="mt-1.5 text-[11px] text-stone-500">Track MIDI channels stay unchanged.</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPending(null)}
              className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-stone-100 hover:bg-white/15"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (pending === "remove") onRemove();
                else onReplace(pending);
                onClose();
              }}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium text-black",
                pending === "remove" ? "bg-red-400 hover:bg-red-300" : "bg-orange-400 hover:bg-orange-300",
              )}
            >
              {pending === "remove" ? "Remove plugin" : "Replace"}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-2 rounded-md bg-black/40 px-2 py-1.5 ring-1 ring-white/10 focus-within:ring-orange-400/40">
            <Ph name="search" className="h-4 w-4 shrink-0 text-stone-500" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search scanned plugins (name or vendor)…"
              spellCheck={false}
              className="w-full bg-transparent text-sm text-stone-100 outline-none placeholder:text-stone-600"
            />
          </div>
          <div className="mt-3 min-h-[200px] max-h-[300px] overflow-auto rounded-lg border border-white/10 bg-black/30 p-2">
            {plugins.length === 0 ? (
              <div className="flex h-[180px] flex-col items-center justify-center gap-2 text-center text-stone-400">
                <div>No scanned plugins yet.</div>
                <div className="text-[11px] text-stone-500">
                  Run a scan in the VST browser first — the picker lists real scan results only.
                </div>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex h-[180px] items-center justify-center text-stone-400">
                Nothing matches "{query}".
              </div>
            ) : (
              <ul className="space-y-1">
                {rows.map((p) => (
                  <li key={p.uid + p.classId}>
                    <button
                      type="button"
                      onClick={() => setPending(p)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5"
                    >
                      <Ph name="plug" className="h-4 w-4 shrink-0 text-orange-300" />
                      <span className="min-w-0 flex-1 truncate">
                        {p.name}
                        {p.isInstrument ? (
                          <span className="ml-2 rounded bg-emerald-500/15 px-1 py-0.5 text-[10px] font-medium text-emerald-300">
                            instrument
                          </span>
                        ) : null}
                        {p.capabilitiesError && (
                          <Ph name="warning" className="ml-1.5 inline h-3.5 w-3.5 shrink-0 text-amber-400" />
                        )}
                      </span>
                      <span className="shrink-0 text-[11px] text-stone-500">
                        {[p.vendor, p.version].filter(Boolean).join(" · ")}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-3 border-t border-white/10 pt-3">
            <button
              type="button"
              onClick={() => setPending("remove")}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-red-300 hover:bg-red-500/10"
            >
              <Ph name="trash" className="h-4 w-4 shrink-0" />
              Remove plugin (back to the test synth)
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Stage 3g — the share-or-create offer. The picked plugin binary is already
 * hosted by at least one existing library group; the user chooses between
 * REUSING that instance (several tracks ride one group — the engine's 16
 * channels per instance) and today's behaviour (a fresh group + instance).
 * Several matches are listed BY THE NAMES OF THE TRACKS that use them
 * (spec step 1); one match needs no selection. The button texts are the
 * spec's, verbatim: "Share the existing <name> instance" / "Create a new
 * instance".
 */
export function PluginShareDialog({
  pluginName,
  candidates,
  onClose,
  onShare,
  onCreate,
}: {
  /** The picked plugin's display name (the <name> in the button texts). */
  pluginName: string;
  /** The matching groups (≥1 — the caller only opens the dialog then). */
  candidates: Array<{ groupId: string; name: string; trackNames: string[] }>;
  onClose: () => void;
  onShare: (groupId: string) => void;
  onCreate: () => void;
}) {
  const [chosen, setChosen] = useState(candidates[0]?.groupId ?? "");
  // Keep the selection valid if the candidate list changes while open.
  useEffect(() => {
    if (!candidates.some((c) => c.groupId === chosen)) setChosen(candidates[0]?.groupId ?? "");
  }, [candidates, chosen]);
  const multi = candidates.length > 1;
  return (
    <Modal title="Already hosted" onClose={onClose}>
      <p className="text-sm leading-relaxed text-stone-200">
        <span className="font-semibold text-orange-300">{pluginName}</span> is already hosted
        {multi ? ` by ${candidates.length} instances` : ""}:
      </p>
      <div className="mt-3 space-y-1.5">
        {candidates.map((c) => (
          <button
            key={c.groupId}
            type="button"
            onClick={() => setChosen(c.groupId)}
            className={cn(
              "flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left text-sm ring-1",
              multi && chosen === c.groupId
                ? "bg-orange-500/10 ring-orange-400/40"
                : "bg-black/30 ring-white/10 hover:bg-white/5",
            )}
          >
            <Ph name={multi ? (chosen === c.groupId ? "check" : "plug") : "plug"} className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", multi && chosen === c.groupId ? "text-orange-300" : "text-stone-500")} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-stone-100">{c.name}</span>
              <span className="block text-[11px] text-stone-500">
                used by {c.trackNames.join(", ")}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-stone-500">
        Sharing puts this track on the same instance (a free channel of its 16 is assigned). A new
        instance costs its own load.
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            onCreate();
            onClose();
          }}
          className="rounded-md bg-white/10 px-3 py-1.5 text-sm text-stone-100 hover:bg-white/15"
        >
          Create a new instance
        </button>
        <button
          type="button"
          disabled={!chosen}
          onClick={() => {
            onShare(chosen);
            onClose();
          }}
          className="rounded-md bg-orange-400 px-3 py-1.5 text-sm font-medium text-black hover:bg-orange-300 disabled:opacity-50"
        >
          Share the existing {pluginName} instance
        </button>
      </div>
    </Modal>
  );
}

export function ExportDialog({
  open,
  project,
  selectedTrackIds,
  onClose,
  onToast,
}: {
  open: boolean;
  project: Project;
  selectedTrackIds: string[];
  onClose: () => void;
  onToast: (kind: ToastItem["kind"], message: string) => void;
}) {
  const [mode, setMode] = useState<ExportTrackMode>("all");
  if (!open) return null;

  const download = (data: BlobPart, filename: string, mime: string) => {
    const blob = new Blob([data], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Modal title="Export" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="text-stone-400">Tracks</div>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["all", "All tracks"],
              ["selected", "Selected tracks"],
              ["unlocked", "All except locked"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setMode(id)}
              className={cn(
                "rounded-full px-3 py-1 text-xs ring-1",
                mode === id ? "bg-orange-500 text-black ring-orange-400" : "bg-white/5 text-stone-300 ring-white/10",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            className="rounded-md bg-white/10 px-3 py-2 text-left hover:bg-white/15"
            onClick={() => {
              download(exportProjectJson(project), `${slug(project.name)}.scorch.json`, "application/json");
              onToast("ok", "JSON project exported");
            }}
          >
            JSON project (.scorch.json)
          </button>
          <button
            type="button"
            className="rounded-md bg-white/10 px-3 py-2 text-left hover:bg-white/15"
            onClick={() => {
              const bytes = exportMergedMidi(project, mode, selectedTrackIds);
              download(bytes as BlobPart, `${slug(project.name)}.mid`, "audio/midi");
              onToast("ok", "Merged Type 1 MIDI exported (960 PPQ)");
            }}
          >
            MIDI — single Type 1 file
          </button>
          <button
            type="button"
            className="rounded-md bg-white/10 px-3 py-2 text-left hover:bg-white/15"
            onClick={async () => {
              const files = exportPerTrackMidi(project, mode, selectedTrackIds);
              const zip = new JSZip();
              for (const f of files) zip.file(f.filename, f.data);
              const blob = await zip.generateAsync({ type: "blob" });
              download(blob, `${slug(project.name)}-tracks.zip`, "application/zip");
              onToast("ok", `${files.length} per-track MIDI files packed`);
            }}
          >
            MIDI — per-track files (zip)
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-stone-500">
          Routing groups do not affect export — tracks that share a library still write as separate MIDI tracks.
          Drop the merged file into Fender Studio: File → Import MIDI, tempo should read {project.bpm} BPM at 960 PPQ.
        </p>
      </div>
    </Modal>
  );
}

export function TestsPanel({
  open,
  results,
  running,
  onClose,
  onRun,
}: {
  open: boolean;
  results: TestResult[] | null;
  running: boolean;
  onClose: () => void;
  onRun: () => void;
}) {
  if (!open) return null;
  const pass = results?.filter((r) => r.pass).length ?? 0;
  const fail = results?.filter((r) => !r.pass).length ?? 0;
  return (
    <Modal title="Acceptance tests" onClose={onClose} wide>
      <div className="mb-3 flex items-center gap-2">
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className="rounded-md bg-orange-500 px-3 py-1.5 text-sm font-medium text-black disabled:opacity-50"
        >
          {running ? "Running…" : "Run tests"}
        </button>
        {results && (
          <div className="font-mono text-xs text-stone-400">
            {pass} pass / {fail} fail
          </div>
        )}
      </div>
      <div className="max-h-[420px] overflow-auto font-mono text-xs">
        {results?.map((r) => (
          <div key={r.name} className="border-b border-white/5 py-2">
            <div className="flex gap-2">
              <span className={r.pass ? "text-emerald-400" : "text-red-400"}>{r.pass ? "PASS" : "FAIL"}</span>
              <span className="text-stone-200">{r.name}</span>
              <span className="ml-auto text-stone-500">{r.ms.toFixed(1)}ms</span>
            </div>
            <div className="mt-0.5 pl-10 text-stone-500">{r.detail}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

const MIX_TRIM_ROLES = ["trumpets", "trombones", "tuba", "bassTrombone", "doubleBass", "cellos", "clarinets", "bassoons"] as const;

/** Module 8.11 P7 — Mix panel (Dev menu → Mix…): read/write display of the
 * preview-only mix constants (MASTER_GAIN and ROLE_PREVIEW_GAIN_TRIM). Values
 * persist to localStorage ("scorch.mix.v1") and take effect on the next
 * playback; generation behavior is untouched (out of scope by design).
 * Reset-to-code-defaults clears the record. */
export function MixDialog({
  open,
  onClose,
  toast,
}: {
  open: boolean;
  onClose: () => void;
  toast: (kind: "ok" | "error" | "info", message: string) => void;
}) {
  const codeDefaults = useMemo(() => ({ masterGain: MASTER_GAIN, trims: ROLE_PREVIEW_GAIN_TRIM }), []);
  const [record, setRecord] = useState<MixOverrides>(() => readMixOverrides() ?? {});
  useEffect(() => {
    if (open) setRecord(readMixOverrides() ?? {});
  }, [open]);
  if (!open) return null;
  const currentGain = record.masterGain ?? codeDefaults.masterGain;
  const mutate = (next: MixOverrides) => {
    setRecord(next);
    const saved = saveMixOverrides(next);
    if (saved.ok) toast("info", "Mix overrides saved — applies on next playback");
    else toast("error", `Mix override save failed: ${saved.error ?? "storage unavailable"}`);
  };
  const trimRow = (label: string, role: string) => {
    const value = record.trims?.[role] ?? codeDefaults.trims[role];
    const codeDefault = codeDefaults.trims[role];
    const overridden = record.trims?.[role] !== undefined;
    return (
      <div key={role} className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-xs text-stone-300">
        <label className="text-right" title={overridden ? "overridden (persists in localStorage)" : "code default"}>
          {label}{overridden ? " *" : ""}
        </label>
        <input
          aria-label={`${label} preview trim`}
          type="number"
          step={0.01}
          min={0.05}
          max={1.5}
          className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-stone-100"
          value={value}
          onChange={(e) => {
            const parsed = Number(e.target.value);
            if (!Number.isFinite(parsed) || parsed <= 0) return;
            mutate({ masterGain: record.masterGain, trims: { ...record.trims, [role]: parsed } });
          }}
        />
        <span className="text-stone-500">dflt {codeDefault}
          {overridden && (
            <button type="button" className="ml-1 underline hover:text-stone-300" title="restore code default"
              onClick={() => { const trims = { ...record.trims }; delete trims[role]; mutate({ masterGain: record.masterGain, trims }); }}>
              ↺
            </button>
          )
        }</span>
      </div>
    );
  };
  return (
    <Modal title="Mix — preview levels" onClose={onClose}>
      <div className="grid grid-cols-1 gap-2 text-sm text-stone-300">
        <div className="text-xs text-stone-500">Preview-only constants from usePlayback. Edits persist locally and apply on the next playback; generation and export are untouched.</div>
        <div className="grid grid-cols-[110px_1fr_auto] items-center gap-2 text-xs text-stone-300">
          <label className="text-right" title={record.masterGain !== undefined ? "overridden (persists in localStorage)" : "code default"}>
            Master gain{record.masterGain !== undefined ? " *" : ""}
          </label>
          <input
            aria-label="Master gain"
            type="number"
            step={0.05}
            min={0.1}
            max={40}
            className="rounded border border-white/10 bg-black/40 px-1.5 py-0.5 text-stone-100"
            value={currentGain}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (!Number.isFinite(parsed) || parsed <= 0) return;
              mutate({ masterGain: parsed, trims: record.trims });
            }}
          />
          <span className="text-stone-500">dflt {codeDefaults.masterGain}
            {record.masterGain !== undefined && (
              <button type="button" className="ml-1 underline hover:text-stone-300" title="restore code default"
                onClick={() => mutate({ trims: record.trims })}>
                ↺
              </button>
            )}
          </span>
        </div>
        <div className="mt-1 border-t border-white/10 pt-2">
          {MIX_TRIM_ROLES.map((role) => trimRow(role, role))}
        </div>
        <button
          type="button"
          className="mt-2 w-full rounded border border-white/10 bg-white/5 px-2 py-1.5 text-xs text-stone-200 hover:bg-white/10"
          onClick={() => {
            clearMixOverrides();
            setRecord({});
            toast("info", "Mix reset to code defaults");
          }}
        >
          Reset to code defaults
        </button>
      </div>
    </Modal>
  );
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <Modal title="About Scorch" onClose={onClose}>
      <div className="flex gap-4">
        <ScorchMark className="h-16 w-16 rounded-xl" />
        <div className="text-sm leading-relaxed text-stone-300">
          <p className="font-semibold text-stone-100">Scorch</p>
          <p>Orchestral MIDI generator with a DAW-style arranger. Not a DAW — no audio recording, mixing, or mastering.</p>
          <p className="mt-2 text-stone-500">
            Set key, mode, BPM and meter, sketch chords and sections, then Compose All. Export JSON or MIDI into Fender Studio
            (or any DAW) to finish.
          </p>
          <p className="mt-2 text-stone-500">Web preview of M0–M3. VST hosting / JUCE engine is not installed in this build.</p>
        </div>
      </div>
    </Modal>
  );
}

export function PianoRoll({
  track,
  project,
  onChange,
  onClose,
  onPreviewNote,
}: {
  track: Track;
  project: Project;
  onChange: (notes: Note[]) => void;
  onClose: () => void;
  /** Stage 3d-2 — note-preview-on-click (webview preview): fires for the
   * pitch of a note being ADDED (creation click). Clicking an existing note
   * still deletes it (unchanged semantics — preview is on creation). */
  onPreviewNote?: (pitch: number) => void;
}) {
  const tpBar = ticksPerBar(project.timeSignature);
  const tpb = ticksPerBeat(project.timeSignature);
  const end = projectEndTick(project);
  const low = track.lowestNote;
  const high = track.highestNote;
  const rows = high - low + 1;
  const rowH = 16;
  const ppt = 0.04;
  const width = end * ppt;
  const height = rows * rowH;

  const onBgClick = (e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left + e.currentTarget.scrollLeft;
    const y = e.clientY - rect.top + e.currentTarget.scrollTop;
    const startTick = Math.round(x / ppt / (tpb / 2)) * (tpb / 2);
    const pitch = high - Math.floor(y / rowH);
    if (pitch < low || pitch > high) return;
    onChange([
      ...track.notes,
      { pitch, startTick: Math.max(0, startTick), durationTicks: tpb, velocity: 90 },
    ]);
    onPreviewNote?.(pitch); // Stage 3d-2: hear the pitch you just placed
  };

  return (
    <div className="flex h-64 shrink-0 flex-col border-t border-white/10 bg-[#101218]">
      <div className="flex items-center justify-between border-b border-white/5 px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2 text-stone-300">
          <Ph name="piano" className="h-4 w-4 text-orange-300" />
          Piano roll — {track.name}
          <span className="text-stone-500">click to add · drag × to delete</span>
        </div>
        <button type="button" onClick={onClose} className="text-stone-400 hover:text-white">
          <Ph name="x" className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto scorch-scroll" onClick={onBgClick}>
        <div className="relative" style={{ width, height }}>
          {Array.from({ length: rows }, (_, i) => {
            const pitch = high - i;
            const black = [1, 3, 6, 8, 10].includes(pitch % 12);
            return (
              <div
                key={pitch}
                className={cn("absolute left-0 right-0 border-b border-white/5", black ? "bg-black/30" : "bg-white/[0.02]")}
                style={{ top: i * rowH, height: rowH }}
              >
                <span className="sticky left-0 font-mono px-1 text-[9px] text-stone-600">{midiName(pitch)}</span>
              </div>
            );
          })}
          {Array.from({ length: Math.ceil(end / tpBar) }, (_, b) => (
            <div
              key={b}
              className="absolute top-0 h-full border-l border-white/10"
              style={{ left: b * tpBar * ppt }}
            />
          ))}
          {track.notes.map((n, i) => (
            <button
              key={`${n.pitch}-${n.startTick}-${i}`}
              type="button"
              title={`${midiName(n.pitch)} vel ${n.velocity}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(track.notes.filter((_, j) => j !== i));
              }}
              className="absolute rounded-sm bg-orange-400/80 hover:bg-red-400"
              style={{
                left: n.startTick * ppt,
                width: Math.max(4, n.durationTicks * ppt),
                top: (high - n.pitch) * rowH + 1,
                height: rowH - 2,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={cn("max-h-[90vh] overflow-auto rounded-xl border border-white/10 bg-[#161821] p-4 shadow-2xl", wide ? "w-[720px]" : "w-[480px]")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-100">{title}</h2>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-white">
            <Ph name="x" className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scorch";
}
