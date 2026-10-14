import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { HEADER_WIDTH, ROW_HEIGHT, RULER_HEIGHT, ADD_ROW_HEIGHT, MIN_PPT, MAX_PPT } from "../constants";
import { TrackHeader } from "./TrackHeader";
import { Ph } from "../icons";
import {
  FAMILIES,
  FAMILY_COLORS,
  PITCH_CLASS_NAMES,
  SECTION_PRESETS,
  type Chord,
  type Family,
  type Project,
  type Section,
  type Track,
} from "../shared/schema/types";
import { parseChord, type ChordQuality } from "../shared/schema/chords";
import type { PitchClass } from "../shared/schema/types";
import {
  barToTick,
  projectEndTick,
  snapTick,
  tickToBar,
  ticksPerBar,
  ticksPerBeat,
} from "../shared/schema/time";
import { makeId } from "../shared/schema/factory";
import { cn } from "../utils/cn";

type Drag =
  | { kind: "section-new"; a: number; b: number }
  | { kind: "section-resize"; id: string; edge: "l" | "r" }
  | { kind: "chord-new"; a: number; b: number; startX: number; releaseX: number | null }
  | { kind: "chord-resize"; id: string; edge: "l" | "r" };

// Chord v2 gesture policy: a press on empty chords-lane space is a CLICK when
// the pointer stays within CLICK_MOVE_PX (3px) of its start position for the
// whole gesture (mouse-up records the release X so we compare total travel,
// not just the final cursor position); anything beyond that is a DRAG.
const CLICK_MOVE_PX = 3;

interface Props {
  project: Project;
  pixelsPerTick: number;
  playheadTick: number;
  pluginLabels: Record<string, string>;
  audioBuffer: AudioBuffer | null;
  audioName: string;
  selectedTrackId: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onPixelsPerTick: (n: number) => void;
  onSeek: (tick: number) => void;
  onPatchProject: (patch: Partial<Project>) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onToggleLock: (id: string) => void;
  onOpenVst: (id: string) => void;
  onLoadAudio: () => void;
  onAddTrack: (family: Family) => void;
  onSelectTrack: (id: string | null) => void;
  onOpenPianoRoll: (id: string) => void;
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function drawTimelineGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  dpr: number,
  ppt: number,
  tpBar: number,
  tpb: number,
  ruler = false,
) {
  const bars = Math.ceil(width / (tpBar * ppt));
  const beatsPerBar = Math.round(tpBar / tpb);
  ctx.font = "600 11px 'JetBrains Mono', monospace";

  for (let bar = 0; bar < bars; bar++) {
    for (let beat = 0; beat < beatsPerBar; beat++) {
      const tick = bar * tpBar + beat * tpb;
      const x = Math.round(tick * ppt * dpr) / dpr;
      if (x >= width) continue;
      const isBar = beat === 0;
      ctx.fillStyle = isBar
        ? ruler
          ? "rgba(255,255,255,0.18)"
          : "rgba(255,255,255,0.08)"
        : ruler
          ? "rgba(255,255,255,0.08)"
          : "rgba(255,255,255,0.04)";
      // Patch 2a — the 24px ruler: bar lines run the FULL band, beat ticks sit
      // in the lower half, numbers baseline 19 (no dead 44-era offsets).
      const top = ruler ? (isBar ? 0 : 14) : 0;
      ctx.fillRect(x, top, 1, height - top);
      if (ruler && isBar) {
        ctx.fillStyle = "#a8a29e";
        ctx.fillText(String(bar + 1), x + 5, 19);
      }
    }
  }
}

function TimelineGrid({
  width,
  height,
  ppt,
  tpBar,
  tpb,
}: {
  width: number;
  height: number;
  ppt: number;
  tpBar: number;
  tpb: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const redraw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.ceil(width * dpr));
    canvas.height = Math.max(1, Math.ceil(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawTimelineGrid(ctx, width, height, dpr, ppt, tpBar, tpb);
  }, [width, height, ppt, tpBar, tpb]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0" style={{ width, height }} />;
}

function useContainerWidth(ref: RefObject<HTMLDivElement | null>) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const updateWidth = () => setWidth(Math.max(0, element.clientWidth - HEADER_WIDTH));
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function useWindowResizeRedraw(redraw: () => void) {
  useEffect(() => {
    window.addEventListener("resize", redraw);
    return () => window.removeEventListener("resize", redraw);
  }, [redraw]);
}

function useCanvasRedraw(
  ref: RefObject<HTMLCanvasElement | null>,
  redraw: () => void,
) {
  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const observer = new ResizeObserver(redraw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [ref, redraw]);
}

export function Arranger(props: Props) {
  const {
    project,
    pixelsPerTick: ppt,
    playheadTick,
    pluginLabels,
    audioBuffer,
    audioName,
    selectedTrackId,
    scrollRef,
    onPixelsPerTick,
    onSeek,
    onPatchProject,
    onToggleMute,
    onToggleSolo,
    onToggleLock,
    onOpenVst,
    onLoadAudio,
    onAddTrack,
    onSelectTrack,
    onOpenPianoRoll,
  } = props;

  const ts = project.timeSignature;
  const tpBar = ticksPerBar(ts);
  const tpb = ticksPerBeat(ts);
  const endTick = projectEndTick(project);
  const containerWidth = useContainerWidth(scrollRef);
  const timelineWidth = Math.max((endTick + tpBar * 3) * ppt, containerWidth || 800);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [selSection, setSelSection] = useState<string | null>(null);
  const [selChord, setSelChord] = useState<string | null>(null);
  const [editingChord, setEditingChord] = useState<string | null>(null);
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const tickFromEvent = useCallback(
    (e: { clientX: number }, lane: HTMLElement) => {
      const rect = lane.getBoundingClientRect();
      const x = e.clientX - rect.left;
      return snapTick(Math.max(0, x / ppt), tpb / 2);
    },
    [ppt, tpb],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let zoomTimeout: number | null = null;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (zoomTimeout) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left - HEADER_WIDTH + el.scrollLeft;
      const tick = x / ppt;
      const next = Math.min(MAX_PPT, Math.max(MIN_PPT, ppt * (e.deltaY > 0 ? 0.9 : 1.1)));
      onPixelsPerTick(next);
      requestAnimationFrame(() => {
        el.scrollLeft = tick * next - (e.clientX - rect.left - HEADER_WIDTH);
      });
      zoomTimeout = window.setTimeout(() => {
        zoomTimeout = null;
      }, 16);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (zoomTimeout) window.clearTimeout(zoomTimeout);
    };
  }, [ppt, onPixelsPerTick, scrollRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "Delete" || e.key === "Backspace") {
        if (selChord) {
          onPatchProject({ chords: project.chords.filter((c) => c.id !== selChord) });
          setSelChord(null);
        } else if (selSection) {
          onPatchProject({ sections: project.sections.filter((s) => s.id !== selSection) });
          setSelSection(null);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selChord, selSection, project.chords, project.sections, onPatchProject]);

  const onMove = useCallback(
    (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const lane = document.querySelector<HTMLElement>("[data-drag-lane]");
      if (!lane) return;
      const t = tickFromEvent(e, lane);
      if (d.kind === "section-new") setDrag({ ...d, b: t });
      if (d.kind === "chord-new") setDrag({ ...d, b: t, releaseX: e.clientX });
    },
    [tickFromEvent],
  );

  const onUp = useCallback(() => {
    const d = dragRef.current;
    setDrag(null);
    if (!d) return;
    if (d.kind === "section-new") {
      const a = Math.min(d.a, d.b);
      const b = Math.max(d.a, d.b);
      if (b - a < tpb) return;
      const startBar = tickToBar(a, ts);
      const lengthBars = Math.max(1, Math.round((b - a) / tpBar));
      const used = new Set(project.sections.map((s) => s.name));
      const name = SECTION_PRESETS.find((n) => !used.has(n)) ?? "Custom";
      onPatchProject({
        sections: [...project.sections, { id: makeId("sec"), name, startBar, lengthBars }],
      });
    }    if (d.kind === "chord-new") {
      // Chord v2 — click vs. drag. CLICK (whole-gesture travel < 3px, see the
      // CLICK_MOVE_PX note above): chord snapped to the START of the clicked
      // bar, one full bar long. DRAG: start snapped to the nearest BEAT,
      // end = EXACT release tick (no end-snapping, user-requested exact
      // length), duration ≥ half beat. Either way the new chord is selected
      // and its editor opens immediately.
      // CLICK_MOVE_PX lives beside the Drag type (documented there).
      const click = Math.abs((d.releaseX ?? d.startX) - d.startX) < CLICK_MOVE_PX;
      const bar0 = Math.max(0, Math.floor(d.a / tpBar)) * tpBar;
      const start = click ? bar0 : Math.round(d.a / tpb) * tpb;
      const dur = click ? tpBar : Math.max(tpb / 2, d.b - start);
      const id = makeId("ch");
      onPatchProject({
        chords: [...project.chords, { id, symbol: "C", startTick: start, durationTicks: dur }],
      });
      setSelChord(id);
      setEditingChord(id);
    }
  }, [project.chords, project.sections, onPatchProject, tpBar, tpb, ts]);

  useEffect(() => {
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onMove, onUp]);

  const rows = `${RULER_HEIGHT}px repeat(${project.tracks.length}, ${ROW_HEIGHT}px) ${ADD_ROW_HEIGHT}px`;

  return (
    <div
      ref={scrollRef}
      data-arranger-scroll
      className="scorch-scroll min-h-0 flex-1 overflow-auto bg-[#0b0c10]"
    >
      <div
        className="relative"
        style={{
          display: "grid",
          gridTemplateColumns: `${HEADER_WIDTH}px ${timelineWidth}px`,
          gridTemplateRows: rows,
          width: HEADER_WIDTH + timelineWidth,
        }}
      >
        <div
          className="sticky top-0 left-0 z-40 flex items-end border-b border-r border-white/10 bg-[#12141c] px-3 pb-1"
          style={{ width: HEADER_WIDTH }}
        >
          <span className="font-mono text-[10px] text-stone-500">BAR / BEAT</span>
        </div>
        {/* Patch 2b — the ruler band: OPAQUE (solid #12141c canvas + solid row
         * bg), overflow-hidden, and strictly ABOVE every lane layer so content
         * scrolls UNDER it invisibly. Explicit z hierarchy (audit result):
         * lanes 0 < lane blocks z-10 < ruler z-30 < sticky headers z-40 <
         * playhead z-[45] < in-row editor popups z-[50] < app dialogs z-[60] <
         * toasts z-[70]. */}
        <div
          className="sticky top-0 z-30 overflow-hidden border-b border-white/10 bg-[#12141c]"
          style={{ zIndex: 30 }}
          onMouseDown={(e) => onSeek(tickFromEvent(e, e.currentTarget))}
        >
          <Ruler width={timelineWidth} height={RULER_HEIGHT} ppt={ppt} tpBar={tpBar} tpb={tpb} />
        </div>

        {project.tracks.map((track) => (
          <TrackRow
            key={track.id}
            track={track}
            project={project}
            ppt={ppt}
            timelineWidth={timelineWidth}
            tpBar={tpBar}
            tpb={tpb}
            pluginLabel={track.role === "audio" ? audioName || "Load audio" : (pluginLabels[track.id] ?? "No plugin")}
            audioBuffer={audioBuffer}
            selected={selectedTrackId === track.id}
            selSection={selSection}
            selChord={selChord}
            editingChord={editingChord}
            editingSection={editingSection}
            drag={drag}
            tickFromEvent={tickFromEvent}
            onToggleMute={() => onToggleMute(track.id)}
            onToggleSolo={() => onToggleSolo(track.id)}
            onToggleLock={() => onToggleLock(track.id)}
            onOpenVst={() => onOpenVst(track.id)}
            onLoadAudio={onLoadAudio}
            onSelectTrack={() => onSelectTrack(track.id)}
            onOpenPianoRoll={() => onOpenPianoRoll(track.id)}
            onSelectSection={(id) => {
              setSelSection(id);
              setSelChord(null);
            }}
            onSelectChord={(id) => {
              setSelChord(id);
              setSelSection(null);
            }}
            onEditChord={setEditingChord}
            onEditSection={setEditingSection}
            onPatchProject={onPatchProject}
            onStartDrag={setDrag}
          />
        ))}

        <div className="sticky left-0 z-20 border-r border-white/10 bg-[#12141c]">
          <div className="relative flex h-full items-center px-3">
            <button
              type="button"
              onClick={() => setAddOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-xs text-stone-300 ring-1 ring-white/10 hover:bg-white/10"
            >
              <Ph name="plus" className="h-3.5 w-3.5" />
              Add Track
            </button>
            {addOpen && (
              <div className="absolute bottom-10 left-3 z-[50] w-40 rounded-md border border-white/10 bg-[#1a1d27] py-1 shadow-xl">
                {FAMILIES.filter((f) => f !== "structure" && f !== "audio").map((f) => (
                  <button
                    key={f}
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs capitalize text-stone-200 hover:bg-white/5"
                    onClick={() => {
                      onAddTrack(f);
                      setAddOpen(false);
                    }}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: FAMILY_COLORS[f] }} />
                    {f}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="border-t border-white/5 bg-[#0e1016]" />

        {/* Playhead: patch 2b hierarchy — starts exactly at the ruler's bottom
         * edge (top derives from RULER_HEIGHT) and rides ABOVE the sticky
         * header tier. */}
        <div
          className="pointer-events-none absolute z-[45] w-0.5 bg-gradient-to-b from-amber-300 via-orange-400 to-rose-500"
          style={{
            left: HEADER_WIDTH + playheadTick * ppt,
            top: RULER_HEIGHT,
            height: project.tracks.length * ROW_HEIGHT,
          }}
        />
      </div>
    </div>
  );
}

function TrackRow(props: {
  track: Track;
  project: Project;
  ppt: number;
  timelineWidth: number;
  tpBar: number;
  tpb: number;
  pluginLabel: string;
  audioBuffer: AudioBuffer | null;
  selected: boolean;
  selSection: string | null;
  selChord: string | null;
  editingChord: string | null;
  editingSection: string | null;
  drag: Drag | null;
  tickFromEvent: (e: { clientX: number }, lane: HTMLElement) => number;
  onToggleMute: () => void;
  onToggleSolo: () => void;
  onToggleLock: () => void;
  onOpenVst: () => void;
  onLoadAudio: () => void;
  onSelectTrack: () => void;
  onOpenPianoRoll: () => void;
  onSelectSection: (id: string | null) => void;
  onSelectChord: (id: string | null) => void;
  onEditChord: (id: string | null) => void;
  onEditSection: (id: string | null) => void;
  onPatchProject: (patch: Partial<Project>) => void;
  onStartDrag: (d: Drag) => void;
}) {
  const { track, project, ppt, timelineWidth, tpBar, tpb } = props;
  return (
    <>
      <div
        data-header-id={track.id}
        className={cn("sticky left-0 z-20 border-r border-white/10", props.selected && "ring-1 ring-inset ring-orange-400/40")}
        style={{ width: HEADER_WIDTH }}
      >
        <TrackHeader
          track={track}
          pluginLabel={props.pluginLabel}
          onMute={props.onToggleMute}
          onSolo={props.onToggleSolo}
          onLock={props.onToggleLock}
          onOpenVst={props.onOpenVst}
          onLoadAudio={props.onLoadAudio}

        />
      </div>
      <div
        data-lane-id={track.id}
        data-drag-lane={track.role === "structure" || track.role === "chords" ? true : undefined}
        className="relative border-b border-white/5"
        style={{
          width: timelineWidth,
          height: ROW_HEIGHT,
          backgroundColor: "#101218",
        }}
        onClick={props.onSelectTrack}
        onDoubleClick={() => {
          if (track.family !== "structure" && track.family !== "audio") props.onOpenPianoRoll();
        }}
      >
        <TimelineGrid width={timelineWidth} height={ROW_HEIGHT} ppt={ppt} tpBar={tpBar} tpb={tpb} />
        {track.role === "structure" && (
          <StructureLane
            project={project}
            ppt={ppt}
            selectedId={props.selSection}
            editingId={props.editingSection}
            drag={props.drag}
            tickFromEvent={props.tickFromEvent}
            onSelect={props.onSelectSection}
            onEdit={props.onEditSection}
            onPatch={props.onPatchProject}
            onStartDrag={props.onStartDrag}
          />
        )}
        {track.role === "chords" && (
          <ChordsLane
            project={project}
            ppt={ppt}
            selectedId={props.selChord}
            editingId={props.editingChord}
            drag={props.drag}
            tickFromEvent={props.tickFromEvent}
            onSelect={props.onSelectChord}
            onEdit={props.onEditChord}
            onPatch={props.onPatchProject}
            onStartDrag={props.onStartDrag}
          />
        )}
        {track.role === "audio" && (
          <AudioLane
            project={project}
            ppt={ppt}
            width={timelineWidth}
            buffer={props.audioBuffer}
            onPatch={props.onPatchProject}
          />
        )}
        {track.family !== "structure" && track.family !== "audio" && (
          <MidiLane
            notes={track.notes}
            color={track.color}
            width={timelineWidth}
            height={ROW_HEIGHT}
            ppt={ppt}
            low={track.lowestNote}
            high={track.highestNote}
          />
        )}
      </div>
    </>
  );
}

function dynamicLabel(value: number): string {
  if (value < 0.2) return "pp";
  if (value < 0.4) return "p";
  if (value < 0.6) return "mp";
  if (value < 0.8) return "mf";
  if (value < 0.95) return "f";
  return "ff";
}

function StructureLane({
  project,
  ppt,
  selectedId,
  editingId,
  drag,
  tickFromEvent,
  onSelect,
  onEdit,
  onPatch,
  onStartDrag,
}: {
  project: Project;
  ppt: number;
  selectedId: string | null;
  editingId: string | null;
  drag: Drag | null;
  tickFromEvent: (e: { clientX: number }, lane: HTMLElement) => number;
  onSelect: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onPatch: (patch: Partial<Project>) => void;
  onStartDrag: (d: Drag) => void;
}) {
  const tpBar = ticksPerBar(project.timeSignature);
  const preview =
    drag?.kind === "section-new"
      ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) }
      : null;
  return (
    <div
      className="absolute inset-0"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-block]")) return;
        const t = tickFromEvent(e, e.currentTarget);
        onStartDrag({ kind: "section-new", a: t, b: t });
        onSelect(null);
      }}
    >
      {project.sections.map((s) => {
        const x = barToTick(s.startBar, project.timeSignature) * ppt;
        const w = s.lengthBars * tpBar * ppt;
        return (
          <div
            key={s.id}
            data-block
            className={cn(
              "absolute top-2 bottom-2 overflow-hidden rounded-md border bg-zinc-500/25 px-2 text-xs font-semibold text-zinc-100",
              selectedId === s.id ? "border-amber-400" : "border-zinc-500/40",
            )}
            style={{ left: x, width: Math.max(24, w) }}
            onMouseDown={(e) => {
              e.stopPropagation();
              onSelect(s.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEdit(s.id);
            }}
          >
            <Edge
              side="l"
              onMouseDown={(e) => {
                e.stopPropagation();
                onStartDrag({ kind: "section-resize", id: s.id, edge: "l" });
              }}
            />
            {editingId === s.id ? (
              <SectionNameEditor
                section={s}
                onDone={(name) => {
                  onPatch({
                    sections: project.sections.map((x) => (x.id === s.id ? { ...x, name } : x)),
                  });
                }}
              />
            ) : (
              <span className="block truncate pt-1">{s.name}</span>
            )}
            <div className="absolute bottom-1 left-2 right-2 z-10 flex items-center gap-1" onMouseDown={(event) => event.stopPropagation()}>
              <span className="text-[8px] text-stone-400" title="pianissimo">pp</span>
              <input aria-label={`${s.name} dynamic level`} aria-valuetext={dynamicLabel(s.targetDynamic ?? 0.55)} title={`Section dynamics: ${dynamicLabel(s.targetDynamic ?? 0.55)}`} type="range" min={0} max={100} value={Math.round((s.targetDynamic ?? 0.55) * 100)} className="min-w-0 flex-1 accent-amber-400"
                onChange={(event) => onPatch({ sections: project.sections.map((item) => item.id === s.id ? { ...item, targetDynamic: Number(event.target.value) / 100 } : item) })} />
              <span className="text-[8px] text-stone-400" title="fortissimo">ff</span>
              <div role="group" aria-label={`${s.name} energy density`} className="flex shrink-0 gap-px">
                {(["Sparse", "Balanced", "Dense", "Tutti"] as const).map((density, index) => <button key={density} type="button" aria-label={`${s.name} density ${density}`} aria-pressed={(s.densityLevel ?? "Balanced") === density} title={density} className={cn("rounded px-1 py-0.5 text-[8px]", (s.densityLevel ?? "Balanced") === density ? "bg-amber-500/40 text-amber-100" : "bg-black/50 text-stone-500 hover:text-stone-200")} onClick={() => onPatch({ sections: project.sections.map((item) => item.id === s.id ? { ...item, densityLevel: density } : item) })}>{["Sp", "Ba", "De", "Tu"][index]}</button>)}
              </div>
            </div>
            <Edge
              side="r"
              onMouseDown={(e) => {
                e.stopPropagation();
                onStartDrag({ kind: "section-resize", id: s.id, edge: "r" });
              }}
            />
          </div>
        );
      })}
      {preview && (
        <div
          className="pointer-events-none absolute top-2 bottom-2 rounded-md border border-dashed border-amber-400/60 bg-amber-400/10"
          style={{ left: preview.a * ppt, width: Math.max(8, (preview.b - preview.a) * ppt) }}
        />
      )}
      {drag?.kind === "section-resize" && (
        <ResizeSectionLive
          drag={drag}
          project={project}
          ppt={ppt}
          tickFromEvent={tickFromEvent}
          onPatch={onPatch}
        />
      )}
    </div>
  );
}

function ResizeSectionLive({
  drag,
  project,
  ppt,
  tickFromEvent,
  onPatch,
}: {
  drag: Extract<Drag, { kind: "section-resize" }>;
  project: Project;
  ppt: number;
  tickFromEvent: (e: { clientX: number }, lane: HTMLElement) => number;
  onPatch: (patch: Partial<Project>) => void;
}) {
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const lane = document.querySelector<HTMLElement>("[data-drag-lane]");
      if (!lane) return;
      const t = tickFromEvent(e, lane);
      const s = project.sections.find((x) => x.id === drag.id);
      if (!s) return;
      const ts = project.timeSignature;
      const tpBar = ticksPerBar(ts);
      const start = barToTick(s.startBar, ts);
      const end = start + s.lengthBars * tpBar;
      let ns = start;
      let ne = end;
      if (drag.edge === "l") ns = Math.min(t, end - tpBar);
      else ne = Math.max(t, start + tpBar);
      const startBar = tickToBar(ns, ts);
      const lengthBars = Math.max(1, Math.round((ne - ns) / tpBar));
      onPatch({
        sections: project.sections.map((x) => (x.id === s.id ? { ...x, startBar, lengthBars } : x)),
      });
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, [drag, project, tickFromEvent, onPatch, ppt]);
  return null;
}

function ChordsLane({
  project,
  ppt,
  selectedId,
  editingId,
  drag,
  tickFromEvent,
  onSelect,
  onEdit,
  onPatch,
  onStartDrag,
}: {
  project: Project;
  ppt: number;
  selectedId: string | null;
  editingId: string | null;
  drag: Drag | null;
  tickFromEvent: (e: { clientX: number }, lane: HTMLElement) => number;
  onSelect: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onPatch: (patch: Partial<Project>) => void;
  onStartDrag: (d: Drag) => void;
}) {
  const preview =
    drag?.kind === "chord-new" ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) } : null;
  return (      <div
      className="absolute inset-0"
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest("[data-block]")) return;
        const t = tickFromEvent(e, e.currentTarget);
        // Chord v2 — record tick AND screen X; nothing is created until
        // mouse-up decides click vs. drag (CLICK_MOVE_PX policy above).
        onStartDrag({ kind: "chord-new", a: t, b: t, startX: e.clientX, releaseX: null });
        onSelect(null);
      }}
    >
      {project.chords.map((c) => {
        const parsed = parseChord(c.symbol);
        const invalid = !parsed.ok;
        return (
          <div
            key={c.id}
            data-block
            className={cn(
              "absolute top-2 bottom-2 overflow-hidden rounded-md border px-1.5 font-mono text-[11px] font-medium",
              invalid ? "border-red-500 bg-red-500/20 text-red-200" : "border-sky-500/40 bg-sky-500/15 text-sky-100",
              selectedId === c.id && "ring-1 ring-amber-300",
            )}
            style={{ left: c.startTick * ppt, width: Math.max(20, c.durationTicks * ppt) }}
            onMouseDown={(e) => {
              e.stopPropagation();
              onSelect(c.id);
            }}
            onDoubleClick={(e) => {
              e.stopPropagation();
              onEdit(c.id);
            }}
          >
            <Edge
              side="l"
              onMouseDown={(e) => {
                e.stopPropagation();
                onStartDrag({ kind: "chord-resize", id: c.id, edge: "l" });
              }}
            />
            {editingId === c.id ? (
              <ChordEditor chord={c} onDone={(symbol) => {
                const quality = parsed.ok ? parsed.chord.quality === "minor" || parsed.chord.quality.startsWith("m") ? "Min" : parsed.chord.quality === "diminished" || parsed.chord.quality === "dim7" ? "Dim" : parsed.chord.quality === "augmented" || parsed.chord.quality === "aug7" ? "Aug" : parsed.chord.quality === "sus2" ? "Sus2" : parsed.chord.quality === "sus4" || parsed.chord.quality === "7sus4" ? "Sus4" : "Maj" : undefined;
                onPatch({ chords: project.chords.map((x) => x.id === c.id ? { ...x, symbol, quality, extensions: parsed.ok ? parsed.chord.extensions : [], bassOverride: parsed.ok ? parsed.chord.bass ?? undefined : undefined } : x) });
                onEdit(null);
              }} />
            ) : (
              <span className="block truncate pt-3">{c.symbol}</span>
            )}
            <Edge
              side="r"
              onMouseDown={(e) => {
                e.stopPropagation();
                onStartDrag({ kind: "chord-resize", id: c.id, edge: "r" });
              }}
            />
          </div>
        );
      })}
      {preview && (
        <div
          className="pointer-events-none absolute top-2 bottom-2 rounded-md border border-dashed border-sky-400/60 bg-sky-400/10"
          style={{ left: preview.a * ppt, width: Math.max(8, (preview.b - preview.a) * ppt) }}
        />
      )}
      {drag?.kind === "chord-resize" && (
        <ResizeChordLive drag={drag} project={project} tickFromEvent={tickFromEvent} onPatch={onPatch} />
      )}
    </div>
  );
}

function ResizeChordLive({
  drag,
  project,
  tickFromEvent,
  onPatch,
}: {
  drag: Extract<Drag, { kind: "chord-resize" }>;
  project: Project;
  tickFromEvent: (e: { clientX: number }, lane: HTMLElement) => number;
  onPatch: (patch: Partial<Project>) => void;
}) {
  const tpb = ticksPerBeat(project.timeSignature);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const lane = document.querySelector<HTMLElement>("[data-drag-lane]");
      if (!lane) return;
      const t = tickFromEvent(e, lane);
      const c = project.chords.find((x) => x.id === drag.id);
      if (!c) return;
      let start = c.startTick;
      let end = c.startTick + c.durationTicks;
      if (drag.edge === "l") start = Math.min(t, end - tpb);
      else end = Math.max(t, start + tpb);
      onPatch({
        chords: project.chords.map((x) =>
          x.id === c.id ? { ...x, startTick: start, durationTicks: Math.max(tpb, end - start) } : x,
        ),
      });
    };
    window.addEventListener("mousemove", move);
    return () => window.removeEventListener("mousemove", move);
  }, [drag, project, tickFromEvent, onPatch, tpb]);
  return null;
}

function ChordEditor({ chord, onDone }: { chord: Chord; onDone: (symbol: string) => void }) {
  const [v, setV] = useState(chord.symbol);
  const parsed = parseChord(v);
  const parsedRoot = parsed.ok ? parsed.chord.root : 0;
  const parsedBass = parsed.ok ? parsed.chord.bass : null;
  const rootName = PITCH_CLASS_NAMES[parsedRoot];
  const parsedQuality = parsed.ok ? parsed.chord.quality : "major";
  const quality = parsedQuality === "minor" || parsedQuality === "m7" || parsedQuality === "m7b5" || parsedQuality === "m6" || parsedQuality === "m9" ? "minor"
    : parsedQuality === "diminished" || parsedQuality === "dim7" ? "diminished"
    : parsedQuality === "augmented" || parsedQuality === "aug7" ? "augmented"
    : parsedQuality === "sus2" ? "sus2" : parsedQuality === "sus4" || parsedQuality === "7sus4" ? "sus4" : "major";
  const extensionNames = ["7", "maj7", "9", "b9", "#9", "11", "#11", "13", "b13"];
  const selectedExtensions = parsed.ok ? parsed.chord.extensions : [];
  const update = (nextRoot: string = rootName, nextQuality: ChordQuality | string = quality, nextExtensions: string[] = selectedExtensions, nextBass: PitchClass | null = parsedBass) => {
    const qualityToken = nextQuality === "major" ? "" : nextQuality === "minor" ? "m" : nextQuality === "diminished" ? "dim" : nextQuality === "augmented" ? "aug" : nextQuality === "sus2" || nextQuality === "sus4" ? nextQuality : "";
    const extensionOrder = ["maj7", "7", "b9", "#9", "9", "#11", "11", "b13", "13"];
    const formattedExtensions = [...nextExtensions].sort((left, right) => extensionOrder.indexOf(left) - extensionOrder.indexOf(right));
    let prefix = `${nextRoot}${qualityToken}`;
    if (nextQuality === "major" || nextQuality === "minor") {
      const hasMajorSeventh = formattedExtensions.includes("maj7");
      const hasSeventh = formattedExtensions.includes("7");
      const hasNinth = formattedExtensions.includes("9");
      if (hasMajorSeventh) prefix = `${nextRoot}${nextQuality === "minor" ? "mmaj7" : "maj7"}`;
      else if (hasSeventh) prefix = `${nextRoot}${nextQuality === "minor" ? "m7" : "7"}`;
      else if (hasNinth) prefix = `${nextRoot}${nextQuality === "minor" ? "m9" : "9"}`;
    }
    const consumedExtension = prefix.endsWith("maj7") ? "maj7" : prefix.endsWith("m7") || prefix.endsWith("7") ? "7" : prefix.endsWith("m9") || prefix.endsWith("9") ? "9" : null;
    const extensionSuffix = formattedExtensions.filter((extension) => extension !== consumedExtension).join("");
    const bassSuffix = nextBass === null ? "" : `/${PITCH_CLASS_NAMES[nextBass]}`;
    setV(`${prefix}${extensionSuffix}${bassSuffix}`);
  };

  return (
    <div className="absolute inset-1 z-[50] overflow-auto rounded bg-[#131720] p-1.5 shadow-xl" onMouseDown={(event) => event.stopPropagation()}>
      <div className="flex gap-1"><select aria-label="Chord root" className="w-12 rounded bg-black/60 text-[10px]" value={parsedRoot} onChange={(e) => update(PITCH_CLASS_NAMES[Number(e.target.value)])}>{PITCH_CLASS_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}</select><input aria-label="Chord symbol" autoFocus value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") onDone(v.trim() || chord.symbol); if (e.key === "Escape") onDone(chord.symbol); e.stopPropagation(); }} className={cn("min-w-0 flex-1 rounded bg-black/50 px-1 py-0.5 text-[10px] outline-none", parsed.ok ? "text-sky-100" : "text-red-300")} /><select aria-label="Slash chord bass" className="w-12 rounded bg-black/60 text-[10px]" value={parsedBass === null ? "none" : parsedBass} onChange={(e) => update(rootName, quality, selectedExtensions, e.target.value === "none" ? null : Number(e.target.value) as PitchClass)}><option value="none">/—</option>{PITCH_CLASS_NAMES.map((name, index) => <option key={name} value={index}>/{name}</option>)}</select></div>
      <div role="group" aria-label="Chord quality" className="mt-1 flex flex-wrap gap-0.5">{[["major", "Maj"], ["minor", "Min"], ["diminished", "Dim"], ["augmented", "Aug"], ["sus2", "Sus2"], ["sus4", "Sus4"]].map(([value, label]) => <button key={value} type="button" aria-pressed={quality === value} className={cn("rounded px-1 py-0.5 text-[9px]", quality === value ? "bg-sky-500/40 text-white" : "bg-white/5 text-stone-400")} onClick={() => update(rootName, value)}>{label}</button>)}</div>
      <div className="mt-1 flex flex-wrap gap-0.5">{extensionNames.map((extension) => { const active = selectedExtensions.includes(extension); return <button key={extension} type="button" aria-pressed={active} className={cn("rounded px-1 py-0.5 text-[9px]", active ? "bg-orange-500/40 text-orange-100" : "bg-white/5 text-stone-400")} onClick={() => update(rootName, quality, active ? selectedExtensions.filter((item) => item !== extension) : [...selectedExtensions, extension])}>{extension}</button>; })}</div>
      <button type="button" disabled={!parsed.ok} className="mt-1 rounded bg-sky-500/30 px-2 py-0.5 text-[9px] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => { if (parsed.ok) onDone(v.trim()); }}>Apply</button>
    </div>
  );
}

function SectionNameEditor({ section, onDone }: { section: Section; onDone: (name: string) => void }) {
  const v = section.name;
  return (
    <select
      autoFocus
      value={SECTION_PRESETS.includes(v as (typeof SECTION_PRESETS)[number]) ? v : "__custom"}
      onChange={(e) => {
        if (e.target.value === "__custom") {
          const n = window.prompt("Section name", v);
          onDone((n ?? v).trim() || v);
        } else onDone(e.target.value);
      }}
      onBlur={() => onDone(v)}
      className="mt-2 w-full rounded bg-black/50 text-[11px]"
    >
      {SECTION_PRESETS.map((n) => (
        <option key={n}>{n}</option>
      ))}
      <option value="__custom">Custom…</option>
    </select>
  );
}

function Edge({ side, onMouseDown }: { side: "l" | "r"; onMouseDown: (e: ReactMouseEvent) => void }) {
  return (
    <div
      onMouseDown={onMouseDown}
      className={cn("absolute top-0 h-full w-1.5 cursor-ew-resize", side === "l" ? "left-0" : "right-0")}
    />
  );
}

function MidiLane({
  notes,
  color,
  width,
  height,
  ppt,
  low,
  high,
}: {
  notes: Track["notes"];
  color: string;
  width: number;
  height: number;
  ppt: number;
  low: number;
  high: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const redraw = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(width * dpr));
    c.height = Math.max(1, Math.floor(height * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const [r, g, b] = hexRgb(color);
    const span = Math.max(1, high - low);
    const nh = Math.max(3, height / Math.min(span + 1, 36) - 1);
    for (const n of notes) {
      const x = n.startTick * ppt;
      const w = Math.max(2, n.durationTicks * ppt);
      const y = ((high - n.pitch) / span) * (height - nh - 6) + 3;
      const br = 0.28 + (n.velocity / 127) * 0.72;
      ctx.fillStyle = `rgba(${r},${g},${b},${br})`;
      ctx.fillRect(x, y, w, nh);
    }
  }, [notes, color, width, height, ppt, low, high]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      redraw();
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0" style={{ width, height }} />;
}

function AudioLane({
  project,
  ppt,
  width,
  buffer,
  onPatch,
}: {
  project: Project;
  ppt: number;
  width: number;
  buffer: AudioBuffer | null;
  onPatch: (patch: Partial<Project>) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const redraw = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const h = ROW_HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.max(1, Math.floor(width * dpr));
    c.height = Math.max(1, Math.floor(h * dpr));
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    if (!buffer) {
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      ctx.font = "11px Inter, sans-serif";
      ctx.fillText("Load wav / mp3 / flac — click Load audio in the header", 12, h / 2 + 4);
      return;
    }
    const data = buffer.getChannelData(0);
    const bpm = project.bpm;
    const offsetTicks = (project.referenceAudio.offsetMs / 60000) * bpm * 960;
    const durTicks = (buffer.duration / 60) * bpm * 960;
    const x0 = offsetTicks * ppt;
    const ww = durTicks * ppt;
    const samples = Math.max(1, Math.floor(ww));
    const block = Math.max(1, Math.floor(data.length / samples));
    ctx.fillStyle = "rgba(251, 146, 60, 0.85)";
    const mid = h / 2;
    for (let i = 0; i < samples; i++) {
      let m = 0;
      const start = i * block;
      for (let j = 0; j < block; j++) m = Math.max(m, Math.abs(data[start + j] || 0));
      const ph = m * (h * 0.42);
      ctx.fillRect(x0 + i, mid - ph, 1, ph * 2);
    }
  }, [buffer, width, ppt, project.bpm, project.referenceAudio.offsetMs]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ro = new ResizeObserver(() => {
      redraw();
    });
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw]);

  return (
    <>
      <canvas ref={ref} className="pointer-events-none absolute inset-0" style={{ width, height: ROW_HEIGHT }} />
      <label className="absolute right-2 top-2 z-10 flex items-center gap-1 rounded bg-black/50 px-1.5 py-0.5 font-mono text-[10px] text-stone-400">
        offset
        <input
          type="number"
          value={project.referenceAudio.offsetMs}
          onChange={(e) =>
            onPatch({
              referenceAudio: { ...project.referenceAudio, offsetMs: Number(e.target.value) || 0 },
            })
          }
          className="w-14 bg-transparent text-amber-200 outline-none"
        />
        ms
      </label>
    </>
  );
}

function Ruler({
  width,
  height,
  ppt,
  tpBar,
  tpb,
}: {
  width: number;
  height: number;
  ppt: number;
  tpBar: number;
  tpb: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const redraw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.ceil(width * dpr));
    canvas.height = Math.max(1, Math.ceil(height * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = "#12141c";
    ctx.fillRect(0, 0, width, height);
    drawTimelineGrid(ctx, width, height, dpr, ppt, tpBar, tpb, true);
  }, [width, height, ppt, tpBar, tpb]);

  useCanvasRedraw(ref, redraw);
  useWindowResizeRedraw(redraw);

  return <canvas ref={ref} className="block" style={{ width, height }} />;
}
