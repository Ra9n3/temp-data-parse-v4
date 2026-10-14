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
import { BUILT_IN_PROFILES } from "../plugins/expressionMaps";
import type { ExportTrackMode } from "../export/midi";
import { exportMergedMidi, exportPerTrackMidi } from "../export/midi";
import { exportProjectJson } from "../export/json";
import { MASTER_GAIN, ROLE_PREVIEW_GAIN_TRIM } from "../audio/usePlayback";
import { type MixOverrides, clearMixOverrides, readMixOverrides, saveMixOverrides } from "../state/persistence";
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
}: {
  open: boolean;
  state: PluginScanState;
  onClose: () => void;
  onPick: (id: string, name: string) => void;
  /** Module 9: picking a built-in expression map creates the group with
   * profileId set (instead of a scanned pluginId) and assigns the track. */
  onPickProfile: (profileId: string, name: string) => void;
  onState: (s: PluginScanState) => void;
}) {
  const [query, setQuery] = useState("");
  const [loaded, setLoaded] = useState(0);
  const total = MOCK_PLUGINS.length;

  useEffect(() => {
    if (!open || state !== "scanning") return;
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
  }, [open, state, total, onState]);

  const plugins = useMemo(() => {
    const q = query.trim().toLowerCase();
    return MOCK_PLUGINS.filter((p) => !p.failed).filter((p) =>
      pluginDisplayName(p.rawName).toLowerCase().includes(q),
    );
  }, [query]);

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
      </div>
      <div className="text-[11px] text-stone-500">Scan directory: {DEFAULT_SCAN_DIR}</div>
      <div className="mt-3 min-h-[220px] rounded-lg border border-white/10 bg-black/30 p-3">
        {state === "scanning" && (
          <div className="flex h-[200px] flex-col items-center justify-center gap-3 text-stone-300">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-orange-400 border-t-transparent" />
            <div>
              Scanning... {loaded} of {total} plugins loaded
            </div>
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
              onClick={() => onState("scanning")}
            >
              Scan Plugins
            </button>
          </div>
        )}
        {state === "loaded" && (
          <ul className="max-h-[280px] space-y-1 overflow-auto">
            {plugins.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(p.id, pluginDisplayName(p.rawName));
                    onClose();
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-white/5"
                >
                  <Ph name="plug" className="h-4 w-4 text-orange-300" />
                  {pluginDisplayName(p.rawName)}
                </button>
              </li>
            ))}
            {MOCK_PLUGINS.filter((p) => p.failed).map((p) => (
              <li key={p.id} className="flex items-center gap-2 px-2 py-1 text-xs text-red-400">
                <Ph name="warning" className="h-3.5 w-3.5" />
                Failed: {pluginDisplayName(p.rawName)}
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
}: {
  track: Track;
  project: Project;
  onChange: (notes: Note[]) => void;
  onClose: () => void;
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
