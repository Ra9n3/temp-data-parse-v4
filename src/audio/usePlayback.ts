import { useCallback, useEffect, useRef, useState } from "react";
import type { Note, Project, Track } from "../shared/schema/types";
import { projectEndTick, secondsToTicks, ticksPerBar, ticksPerBeat, ticksToSeconds } from "../shared/schema/time";
import { acousticWeightForTrack } from "../generation/balance";

export interface PlaybackState {
  playheadTick: number;
  playing: boolean;
  looping: boolean;
  metronome: boolean;
}

interface Voices {
  osc: OscillatorNode;
  gain: GainNode;
  stopAt: number;
}

// Module 8.7 B4 — master bus: voices sum into one GainNode → DynamicsCompressor
// (threshold −18 dB, ratio 3:1) → makeup gain (~+4 dB) → destination. DynamicsCom-
// pressorNode has no makeup parameter, so the ~+4 dB rides a post-compressor gain.
interface MasterBus {
  input: GainNode;
  compressor: DynamicsCompressorNode;
  makeup: GainNode;
}

/** Module 8.8 B1 / Module 8.9 v2 — per-ROLE preview gain trims.
 *
 * Module 8.9 recalibrated this map with a SOLVER over scripts/loudness-audit.ts
 * v2 (20 seeds × user project + fixture, p90 vs horn-reference median, A3-
 * corrected low-frequency weight V2-boost). Root failure of v1: 3 seeds —
 * on seeds 6/15 the tuba never sounded (it is a BASS carrier on 13/20 seeds)
 * and the discount pitch curve unfairly weighted low registers.
 *
 * Constants (p90 brought inside the ±10% band on the user project, primary,
 * per established convention; fixture positions documented — the horn reference
 * itself differs ~2× between projects, so some do not intersect):
 *   tuba 1 → 0.198 (p90 505% → ~100%), bassTrombone 1 → 0.219 (457% → ~100%),
 *   doubleBass 0.60 → 0.408 (147% → ~100%), cellos 1 → 0.699 (143% → ~100%),
 *   clarinets 1 → 0.714 (140% → ~100%), bassoons 1 → 0.715 (140% → ~100%),
 *   trumpets 0.21 / trombones 0.21 UNTOUCHED (93% / 100% — in band).
 * Horns = 1.0 (the reference). Everything below band on both projects stays
 * at 1.0 (no boosting of quiet roles).
 */
export const ROLE_PREVIEW_GAIN_TRIM: Record<string, number> = {
  trumpets: 0.21, // in band (93%) — untouched by the v2 solver
  trombones: 0.21, // in band (100%) — untouched by the v2 solver
  tuba: 0.198,
  bassTrombone: 0.219,
  doubleBass: 0.408,
  cellos: 0.699,
  clarinets: 0.714,
  bassoons: 0.715,
};

function createMasterBus(ctx: AudioContext): MasterBus {
  const input = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.ratio.value = 3;
  const makeup = ctx.createGain();
  makeup.gain.value = Math.pow(10, 4 / 20); // ~+4 dB makeup
  input.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(ctx.destination);
  return { input, compressor, makeup };
}

function familyWave(family: string): OscillatorType {
  if (family === "strings") return "sawtooth";
  if (family === "brass") return "sawtooth";
  if (family === "woodwinds") return "triangle";
  if (family === "keys") return "triangle";
  if (family === "percussion") return "square";
  return "sine";
}

export function usePlayback(
  project: Project,
  audioBuffer: AudioBuffer | null,
) {
  const [playheadTick, setPlayheadTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [looping, setLooping] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const playheadRef = useRef(0);
  const playingRef = useRef(false);
  const loopingRef = useRef(false);
  const metroRef = useRef(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const originRef = useRef({ ctxTime: 0, tick: 0 });
  const rafRef = useRef<number>(0);
  const voicesRef = useRef<Voices[]>([]);
  const scheduledRef = useRef(new Set<string>());
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const projectRef = useRef(project);
  const bufferRef = useRef(audioBuffer);
  const lastMetroRef = useRef(-1);
  const masterRef = useRef<MasterBus | null>(null);

  projectRef.current = project;
  bufferRef.current = audioBuffer;
  playheadRef.current = playheadTick;
  playingRef.current = playing;
  loopingRef.current = looping;
  metroRef.current = metronome;

  const getCtx = useCallback(async () => {
    if (!ctxRef.current) {
      ctxRef.current = new AudioContext();
      masterRef.current = createMasterBus(ctxRef.current); // Module 8.7 B4 master bus
    }
    if (ctxRef.current.state === "suspended") await ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const stopVoices = useCallback(() => {
    const now = ctxRef.current?.currentTime ?? 0;
    for (const v of voicesRef.current) {
      try {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
        v.gain.gain.linearRampToValueAtTime(0, now + 0.03);
        v.osc.stop(now + 0.04);
      } catch {
        /* already stopped */
      }
    }
    voicesRef.current = [];
    scheduledRef.current.clear();
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        /* already stopped */
      }
      sourceRef.current = null;
    }
  }, []);

  const audibleTracks = useCallback((p: Project): Track[] => {
    const inst = p.tracks.filter((t) => t.family !== "structure" && t.family !== "audio");
    const anySolo = inst.some((t) => t.soloed);
    return inst.filter((t) => !t.muted && (!anySolo || t.soloed));
  }, []);

  const schedule = useCallback(
    (ctx: AudioContext, fromTick: number, toTick: number) => {
      const p = projectRef.current;
      const bpm = p.bpm;
      const origin = originRef.current;
      const tracks = audibleTracks(p);
      for (const t of tracks) {
        for (const n of t.notes) {
          if (n.isKeySwitch) continue; // key-switch notes are export-only; never scheduled
          if (n.startTick < fromTick || n.startTick >= toTick) continue;
          const key = `${t.id}:${n.startTick}:${n.pitch}:${n.durationTicks}`;
          if (scheduledRef.current.has(key)) continue;
          scheduledRef.current.add(key);
          const startSec = origin.ctxTime + ticksToSeconds(n.startTick - origin.tick, bpm);
          const durSec = Math.max(0.03, ticksToSeconds(n.durationTicks, bpm));
          if (startSec + durSec < ctx.currentTime - 0.02) continue;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const filter = ctx.createBiquadFilter();
          osc.type = familyWave(t.family);
          osc.frequency.value = 440 * Math.pow(2, (n.pitch - 69) / 12);
          osc.detune.value = n.detuneCents ?? 0; // intonation + anti-flanging detune audible in preview
          filter.type = "lowpass";
          filter.frequency.value = t.family === "strings" ? 2200 : t.family === "brass" ? 2800 : 4200;
          // Module 8.6 B4 — preview CC honesty: MIDI export sends CC7 as a static
          // per-track acoustic-carrying fader and CC11 as per-note expression;
          // the oscillator preview applies the same two factors as plain gains so
          // the chorus audibly opens up in-app (louder track weight × louder
          // balance-stage CC11). Manually authored notes without balance metadata
          // fall back to neutral unity. Export is untouched.
          const cc7Gain = acousticWeightForTrack(t);
          const cc11Gain = n.dynamics ? (n.dynamics.cc11Value / 127) : 1;
          // Module 8.7 B4: base per-note peak 0.035 → 0.05 (headroom now handled by the master bus compressor).
          // Module 8.8 B1: per-role preview trim (brass taming; see ROLE_PREVIEW_GAIN_TRIM).
          const peak = 0.05 * (ROLE_PREVIEW_GAIN_TRIM[t.role] ?? 1) * (n.velocity / 127) * cc7Gain * cc11Gain * (t.family === "percussion" ? 1.6 : 1);
          const atk = t.family === "strings" ? 0.04 : t.family === "percussion" ? 0.005 : 0.015;
          const when = Math.max(ctx.currentTime, startSec);
          gain.gain.setValueAtTime(0, when);
          gain.gain.linearRampToValueAtTime(peak, when + atk);
          gain.gain.setValueAtTime(peak, when + Math.max(atk, durSec * 0.7));
          gain.gain.linearRampToValueAtTime(0, when + durSec);
          osc.connect(filter);
          filter.connect(gain);
          gain.connect(masterRef.current!.input); // through the master bus, not straight to destination
          try {
            osc.start(when);
            osc.stop(when + durSec + 0.02);
          } catch {
            continue;
          }
          voicesRef.current.push({ osc, gain, stopAt: when + durSec });
        }
      }
      if (voicesRef.current.length > 64) {
        const extra = voicesRef.current.splice(0, voicesRef.current.length - 64);
        for (const v of extra) {
          try {
            v.osc.stop();
          } catch {
            /* */
          }
        }
      }
    },
    [audibleTracks],
  );

  const click = useCallback((ctx: AudioContext, when: number, accent: boolean) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = accent ? 1400 : 900;
    gain.gain.setValueAtTime(0.07, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.06);
  }, []);

  const tick = useCallback(() => {
    const ctx = ctxRef.current;
    const p = projectRef.current;
    if (!ctx || !playingRef.current) return;
    const elapsed = ctx.currentTime - originRef.current.ctxTime;
    let current = originRef.current.tick + secondsToTicks(elapsed, p.bpm);
    const end = projectEndTick(p);
    const loopEnd = end;
    const loopStart = 0;
    if (loopingRef.current && current >= loopEnd) {
      const over = current - loopEnd;
      current = loopStart + (over % Math.max(1, loopEnd - loopStart));
      originRef.current = { ctxTime: ctx.currentTime, tick: current };
      scheduledRef.current.clear();
      if (sourceRef.current) {
        try {
          sourceRef.current.stop();
        } catch {
          /* */
        }
        sourceRef.current = null;
      }
    } else if (!loopingRef.current && current >= end) {
      current = end;
      playingRef.current = false;
      setPlaying(false);
      stopVoices();
    }
    playheadRef.current = current;
    setPlayheadTick(current);

    const look = current + secondsToTicks(0.2, p.bpm);
    schedule(ctx, current, look);

    if (metroRef.current) {
      const tpb = ticksPerBeat(p.timeSignature);
      const beat = Math.floor(current / tpb);
      if (beat !== lastMetroRef.current && beat >= 0) {
        lastMetroRef.current = beat;
        const tpBar = ticksPerBar(p.timeSignature);
        const inBar = ((current % tpBar) + tpBar) % tpBar;
        click(ctx, ctx.currentTime, inBar < tpb * 0.5);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [click, schedule, stopVoices]);

  const startAudioFile = useCallback(
    async (ctx: AudioContext, fromTick: number) => {
      const buf = bufferRef.current;
      const p = projectRef.current;
      if (!buf) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      const t = ticksToSeconds(fromTick, p.bpm) - p.referenceAudio.offsetMs / 1000;
      if (t >= buf.duration) return;
      if (t >= 0) src.start(0, t);
      else src.start(ctx.currentTime + -t, 0);
      sourceRef.current = src;
    },
    [],
  );

  const play = useCallback(async () => {
    const ctx = await getCtx();
    const from = playheadRef.current;
    originRef.current = { ctxTime: ctx.currentTime, tick: from };
    scheduledRef.current.clear();
    lastMetroRef.current = -1;
    setPlaying(true);
    playingRef.current = true;
    await startAudioFile(ctx, from);
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
  }, [getCtx, startAudioFile, tick]);

  const stop = useCallback(() => {
    setPlaying(false);
    playingRef.current = false;
    cancelAnimationFrame(rafRef.current);
    stopVoices();
  }, [stopVoices]);

  const rewind = useCallback(() => {
    stop();
    playheadRef.current = 0;
    setPlayheadTick(0);
  }, [stop]);

  const seek = useCallback(
    (tickValue: number) => {
      const t = Math.max(0, tickValue);
      playheadRef.current = t;
      setPlayheadTick(t);
      if (playingRef.current) {
        void (async () => {
          stopVoices();
          const ctx = await getCtx();
          originRef.current = { ctxTime: ctx.currentTime, tick: t };
          scheduledRef.current.clear();
          await startAudioFile(ctx, t);
        })();
      }
    },
    [getCtx, startAudioFile, stopVoices],
  );

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current);
      stopVoices();
      void ctxRef.current?.close();
    };
  }, [stopVoices]);

  return {
    playheadTick,
    playing,
    looping,
    metronome,
    play,
    stop,
    rewind,
    seek,
    setLooping,
    setMetronome,
  };
}

export type { Note };
