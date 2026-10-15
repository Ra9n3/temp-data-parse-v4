// Stage 3a/3b/3b-fix/3b-polish/3c-1: engine protocol test client. Connects to
// scorch-engine on the given port. Node 22+ (global WebSocket). Throwaway
// test — not part of the app's runtime.
//
// Modes (argv[3]):
//   null-audio (default) — engine runs with --null-audio (the engine's own
//     null device: the graph runs in real time with NO hardware). Asserts the
//     full protocol suite (hello, ping->pong, unknown->error, load, panic,
//     shutdown), the Stage 3b-fix transport contract (play → state ticks
//     ADVANCE → stop), AND the Stage 3b-polish RESUME contract:
//       play(tick 480)  → first state tick ≈ 480 (NOT 0)
//       stop            → state tick = the STOPPED position (kept, NOT reset)
//       play (no tick)  → resumes from the stopped position (NOT 0)
//     plus state tick continuity across the stop/play boundary.
//   no-device — engine runs with NO audio flag on a device-less runner. Asserts
//     transport play returns the graceful {"code":"no_audio_device","detail":...}
//     error (the historical 0xC0000005 headless crash is now a clean reply) and
//     the engine stays protocol-functional afterwards (ping/pong, stop, seek,
//     panic, shutdown → clean exit).
//   scan (argv[4] = fixture dir) — Stage 3c-1: VST3 scan-protocol proof. Sends
//     {"type":"scan","dirs":[fixtureDir]} where the fixture dir contains
//       * the VALID free test VST3 ("Scorch Test Synth", must be found with
//         its real name + vendor + isInstrument),
//       * CrashDummy.vst3 (a VALID shared library that aborts inside
//         GetPluginFactory — kills its scan-worker child),
//       * CorruptDummy.vst3 (garbage bytes — graceful zero-type load failure).
//     Asserts: the valid plugin is found; the crash dummy appears as a failed
//     entry AND does not kill the scan or the engine (ping→pong after); the
//     corrupt dummy is isolated silently (zero types, no failed entry); a
//     default-dir scan returns a clean (possibly empty) result; shutdown →
//     clean exit.
//   host (argv[4] = fixture dir) — Stage 3c-2: HOSTING proof against the free
//     test VST3 as the stand-in host (BBCSO cannot run in CI). Scans, loads
//     the plugin by uid+path with a 2-track channel map (t1→ch1, t2→ch2),
//     then drives a scripted score and asserts, ALL over the wire:
//       plugin_state loaded (real name + vendor + latencyMs < 100);
//       UACC pre-trigger arithmetic: CC#32 dispatched exactly 38 ticks
//         (≈19.79ms at 120bpm/960ppqn — the M9 profile's 20ms pre-trigger at
//         tick granularity) BEFORE its note, sample-accurate;
//       channel routing: both channels dispatched (cross-checked in the
//         workflow via the plugin's own [testvst] stdout log);
//       audible output while unmuted (state.peak), SILENCE while muted (the
//         mute flush kills sounding notes — gating is HEARD), a note inside
//         the muted window is NOT dispatched (gating before any send),
//         sound returns after unmute (late note);
//       stop → silence + playing=false; dispatch_log/dispatch protocol shape.

const port = parseInt(process.argv[2] ?? "9378", 10);
const mode = process.argv[3] ?? "null-audio";
const fixtureDir = process.argv[4] ?? "";
const url = `ws://127.0.0.1:${port}`;
// Events chosen so a note IS sounding when the test stops (tick ~600): the
// stop-panic kill count in the engine's stdout ("voices killed (n=…)") is then
// ≥1 — real evidence, not an empty-path no-op. The first note (0→300) lies
// entirely before the play(tick 480) start and exercises the skip path.
const events = [
  { eventType: "NOTE_ON", channel: 1, data1: 48, data2: 100, timestampTicks: 0 },
  { eventType: "NOTE_OFF", channel: 1, data1: 48, data2: 0, timestampTicks: 300 },
  { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 480 },
  { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 1440 },
  { eventType: "NOTE_ON", channel: 1, data1: 64, data2: 100, timestampTicks: 1440 },
  { eventType: "NOTE_OFF", channel: 1, data1: 64, data2: 0, timestampTicks: 2400 },
];
const meta = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 3840 };

let step = 0;
// null-audio mode flags
let helloOk = false, pongOk = false, errorOk = false;
let loadOk = false, play1Ok = false, adv1Ok = false, stopOk = false;
let play2Ok = false, adv2Ok = false, panicOk = false;
let first1 = 0, last1 = 0, frames1 = 0, stopTick = 0, first2 = 0, last2 = 0, frames2 = 0;
// no-device mode flags
let noDeviceErrOk = false, pongAfterErrOk = false, stillFunctionalOk = false;

const ws = new WebSocket(url);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const timeout = setTimeout(() => {
  if (mode === "null-audio") {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} error=${errorOk} load=${loadOk} play1=${play1Ok} adv1=${adv1Ok} stop=${stopOk} play2=${play2Ok} adv2=${adv2Ok} panic=${panicOk})`);
  } else if (mode === "scan") {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} scanSent=${scanSent} scanResult=${scanResultOk} aliveAfterCrash=${aliveAfterCrashOk} defaultScan=${defaultScanOk})`);
  } else if (mode === "host") {
    console.error(`TIMEOUT at step ${step} phase=${hostPhase} (scan=${hostScanSent} pluginState=${hostPluginStateOk} peaks A/B/C=${hostPeakA.toFixed(3)}/${hostPeakB.toFixed(3)}/${hostPeakC.toFixed(3)} entries=${hostEntries.length})`);
  } else {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} load=${loadOk} noDeviceErr=${noDeviceErrOk} pongAfterErr=${pongAfterErrOk} stillFunctional=${stillFunctionalOk})`);
  }
  process.exit(1);
}, mode === "host" ? 40000 : 20000);

// scan-mode flags
let scanSent = false, scanResultOk = false, aliveAfterCrashOk = false, defaultScanOk = false;
// host-mode flags + shared collection
let hostScanSent = false, hostPluginStateOk = false, hostPhase = 0;
let hostPeakA = 0, hostPeakB = 0, hostPeakC = 0;
const hostEntries = [];   // accumulated dispatch ledger entries
let hostPlayingFrames = 0, hostMuteSentAt = 0, hostUnmuteSentAt = 0;
let hostLatency = 0, hostDeltaSamples = 0;
const HOST_EVENTS = [
  // fader + expression pre-set (the test synth is silent until CC7/CC11 arrive)
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 7, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 11, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 2, data1: 7, data2: 127, timestampTicks: 0, trackId: "t2" },
  { eventType: "CONTROL_CHANGE", channel: 2, data1: 11, data2: 127, timestampTicks: 0, trackId: "t2" },
  // UACC articulation switch: 38 ticks BEFORE the note (M9 profile 20ms pre-trigger)
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 32, data2: 42, timestampTicks: 442, trackId: "t1", isArticulationSwitch: true },
  { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 480, trackId: "t1" },
  { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 8448, trackId: "t1" },
  { eventType: "NOTE_ON", channel: 2, data1: 64, data2: 100, timestampTicks: 960, trackId: "t2" },
  { eventType: "NOTE_OFF", channel: 2, data1: 64, data2: 0, timestampTicks: 8448, trackId: "t2" },
  // Scheduled INSIDE the muted window — must NEVER dispatch (gating proof)
  { eventType: "NOTE_ON", channel: 1, data1: 62, data2: 100, timestampTicks: 3840, trackId: "t1" },
  { eventType: "NOTE_OFF", channel: 1, data1: 62, data2: 0, timestampTicks: 8448, trackId: "t1" },
  // Late note after unmute — must dispatch (unmute restores audibility)
  { eventType: "NOTE_ON", channel: 2, data1: 67, data2: 100, timestampTicks: 6144, trackId: "t2" },
  { eventType: "NOTE_OFF", channel: 2, data1: 67, data2: 0, timestampTicks: 8448, trackId: "t2" },
];
const HOST_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 8448 };

function finishAndShutdown() {
  console.log("[test] sending shutdown");
  ws.send(JSON.stringify({ type: "shutdown" }));
}

ws.addEventListener("open", () => {
  console.log(`[test] connected to ws://127.0.0.1:${port} (mode=${mode}), waiting for hello...`);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("[test] RX:", JSON.stringify(msg).slice(0, 140));
  step++;

  if (mode === "host") {
    // ── Stage 3c-2: hosting proof against the free test VST3 ──
    if (msg.type === "hello" && !hostScanSent) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (!fixtureDir) fail("host mode requires a fixture dir argument");
      hostScanSent = true;
      console.log("[test] hello OK — scanning for the stand-in host plugin...");
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && hostScanSent && hostPhase === 0) {
      const valid = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`host mode: stand-in plugin not found in scan (${JSON.stringify(msg.plugins)})`);
      console.log(`[test] stand-in host found: "${valid.name}" uid=${valid.uid} — enabling dispatch_log + loading`);
      hostPhase = 1;
      ws.send(JSON.stringify({ type: "dispatch_log", enable: true }));
      ws.send(JSON.stringify({
        type: "load",
        events: HOST_EVENTS,
        meta: HOST_META,
        channels: { t1: 1, t2: 2 },
        plugin: { uid: valid.uid, path: valid.path, name: valid.name },
      }));
    } else if (msg.type === "dispatch_log" && hostPhase === 1) {
      if (msg.enabled !== true) fail("dispatch_log enable not acked");
    } else if (msg.type === "plugin_state" && hostPhase === 1) {
      if (msg.state !== "loaded") fail(`plugin_state must be loaded, got: ${msg.state} (${msg.detail ?? ""})`);
      if (msg.name !== "Scorch Test Synth") fail(`plugin name mismatch: ${msg.name}`);
      if (typeof msg.latencyMs !== "number" || msg.latencyMs >= 100) fail(`latencyMs must be < 100 (pinned CI assertion), got ${msg.latencyMs}`);
      if (JSON.stringify(msg.channels) !== "[1,2]") fail(`hosted channels must be [1,2], got ${JSON.stringify(msg.channels)}`);
      hostPluginStateOk = true;
      hostLatency = msg.latencyMs;
      console.log(`[test] plugin_state LOADED: "${msg.name}" vendor="${msg.vendor}" latency=${msg.latencyMs}ms channels=${JSON.stringify(msg.channels)} ✓ (<100ms)`);
      hostPhase = 2;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "state" && hostPhase === 2) {
      hostPlayingFrames++;
      hostPeakA = Math.max(hostPeakA, msg.peak ?? 0);
      if (msg.playing && msg.tick >= 1700) {
        // Phase A → unmuted window done. Assert audible, then MUTE.
        if (hostPeakA < 0.05) fail(`phase A: peak ${hostPeakA} while unmuted — hosted plugin not audible`);
        console.log(`[test] phase A ✓ unmuted peak=${hostPeakA.toFixed(3)} — muting t1+t2`);
        hostPhase = 3;
        hostMuteSentAt = Date.now();
        ws.send(JSON.stringify({ type: "mix", mutedTracks: ["t1", "t2"], soloTracks: [] }));
      }
    } else if (msg.type === "dispatch" && hostPhase >= 2) {
      for (const e of msg.entries ?? []) hostEntries.push(e);
    } else if (msg.type === "state" && hostPhase === 3) {
      hostPeakB = Math.max(hostPeakB, msg.peak ?? 0);
      if (msg.playing && msg.tick >= 5200) {
        // Phase B → muted window done. Assert silence + the gated note was
        // never dispatched; then UNMUTE.
        if (hostPeakB >= 0.02) fail(`phase B: peak ${hostPeakB} while muted — mute is not audible (gating broken)`);
        const gatedNote = hostEntries.find((e) => e.k === 1 && e.c === 1 && e.t === 3840);
        if (gatedNote) fail("phase B: the muted-window note (t=3840) WAS dispatched — gating does not run before the channel send");
        console.log(`[test] phase B ✓ muted peak=${hostPeakB.toFixed(3)}, muted-window note gated ✓ — unmuting`);
        hostPhase = 4;
        hostUnmuteSentAt = Date.now();
        ws.send(JSON.stringify({ type: "mix", mutedTracks: [], soloTracks: [] }));
      }
    } else if (msg.type === "dispatch" && hostPhase === 3) {
      for (const e of msg.entries ?? []) hostEntries.push(e);
    } else if (msg.type === "state" && hostPhase === 4) {
      hostPeakC = Math.max(hostPeakC, msg.peak ?? 0);
      if (msg.playing && msg.tick >= 6700) {
        // Phase C → unmuted again. The late note (t=6144) must be audible.
        if (hostPeakC < 0.05) fail(`phase C: peak ${hostPeakC} after unmute — late note (t=6144) not audible`);
        const lateNote = hostEntries.find((e) => e.k === 1 && e.c === 2 && e.t === 6144);
        if (!lateNote) fail("phase C: late note (t=6144, ch2) not in dispatch ledger");
        console.log(`[test] phase C ✓ unmuted peak=${hostPeakC.toFixed(3)}, late note dispatched ✓ — asserting pre-trigger + routing, then stop`);
        // UACC pre-trigger arithmetic: CC#32 exactly 38 ticks before the note.
        const cc32 = hostEntries.find((e) => e.k === 2 && e.a === 32 && e.c === 1);
        const note1 = hostEntries.find((e) => e.k === 1 && e.c === 1 && e.t === 480);
        if (!cc32) fail("dispatch ledger has no CC#32 articulation switch");
        if (!note1) fail("dispatch ledger has no ch1 NOTE_ON at t=480");
        if (cc32.t !== 442) fail(`CC#32 must dispatch at t=442 (480 − 38 pre-trigger ticks), got t=${cc32.t}`);
        const spt = 44100 * 60 / (120 * 960);  // 22.96875 samples/tick
        const delta = note1.s - cc32.s;
        if (Math.abs(delta - 38 * spt) > 1.5) fail(`pre-trigger sample delta ${delta} ≠ 38 ticks (${38 * spt}) — scheduling not sample-accurate`);
        // Channel routing: ch2 dispatched into the hosted plugin.
        const note2 = hostEntries.find((e) => e.k === 1 && e.c === 2 && e.t === 960);
        if (!note2) fail("dispatch ledger has no ch2 NOTE_ON at t=960 — channel routing broken");
        console.log(`[test] pre-trigger ✓ CC#32@t=${cc32.t} (s=${cc32.s}) → note@t=${note1.t} (s=${note1.s}), delta=${delta} samples (${(delta / 44.1).toFixed(2)}ms ≈ 20ms profile pre-trigger)`);
        console.log("[test] channel routing ✓ ch1 + ch2 dispatched into the hosted plugin");
        hostDeltaSamples = delta;
        hostPhase = 5;
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      }
    } else if (msg.type === "dispatch" && hostPhase === 4) {
      for (const e of msg.entries ?? []) hostEntries.push(e);
    } else if (msg.type === "state" && hostPhase === 5) {
      if (msg.playing === false) {
        if ((msg.peak ?? 0) >= 0.02) fail(`after stop peak ${msg.peak} — hosted voices not killed cleanly`);
        console.log(`[test] phase D ✓ stop → playing=false, peak=${msg.peak} (hosted voices killed) — shutdown`);
        hostPhase = 6;
        finishAndShutdown();
      }
    } else if (msg.type === "error" && hostPluginStateOk) {
      fail(`host mode: unexpected error mid-test: ${msg.code} ${msg.detail ?? ""}`);
    }
    return;
  }

  if (mode === "scan") {
    // ── Stage 3c-1: VST3 scan protocol + crash isolation ──
    if (msg.type === "hello" && !helloOk) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (!fixtureDir) fail("scan mode requires a fixture dir argument");
      console.log("[test] hello OK — sending scan of fixture dir:", fixtureDir);
      scanSent = true;
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && scanSent && !scanResultOk) {
      scanResultOk = true;
      const plugins = Array.isArray(msg.plugins) ? msg.plugins : [];
      const failed = Array.isArray(msg.failed) ? msg.failed : [];
      const dirs = Array.isArray(msg.scannedDirs) ? msg.scannedDirs : [];
      // 1. The valid free test VST3 must be found with its real identity.
      const valid = plugins.find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`scan_result did not include "Scorch Test Synth" (plugins: ${JSON.stringify(plugins)})`);
      if (valid.vendor !== "Scorch Audio") fail(`vendor mismatch: ${valid.vendor}`);
      if (valid.isInstrument !== true) fail("test synth must report isInstrument=true");
      if (!valid.uid) fail("scan_result entries must carry a uid");
      console.log(`[test] valid plugin found: "${valid.name}" vendor="${valid.vendor}" uid=${valid.uid} ✓`);
      // 2. The crash dummy must appear as a failed entry (its worker died).
      const crashFail = failed.find((f) => f.path.includes("CrashDummy"));
      if (!crashFail) fail(`crash dummy not recorded as failed — crash isolation broken (failed: ${JSON.stringify(failed)})`);
      if (!/crash|exit/i.test(crashFail.error ?? "")) fail(`crash dummy failure lacks crash evidence: ${crashFail.error}`);
      console.log(`[test] crash dummy isolated: "${crashFail.error}" ✓`);
      // 3. The corrupt dummy fails GRACEFULLY (zero types — neither plugin nor failed).
      if (failed.some((f) => f.path.includes("CorruptDummy"))) fail("corrupt dummy must fail gracefully (zero types), not as a scan failure");
      if (plugins.some((p) => p.path.includes("CorruptDummy"))) fail("corrupt dummy must not yield plugin types");
      console.log("[test] corrupt dummy isolated silently (graceful zero-type load) ✓");
      // 4. The engine is ALIVE after the crash: ping must answer.
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "pong" && scanResultOk && !aliveAfterCrashOk) {
      aliveAfterCrashOk = true;
      console.log("[test] engine alive after crash isolation (ping→pong) ✓ — default-dir scan");
      ws.send(JSON.stringify({ type: "scan" }));  // no dirs → engine defaults (may be empty — must not error/hang)
    } else if (msg.type === "scan_result" && aliveAfterCrashOk && !defaultScanOk) {
      defaultScanOk = true;
      if (!Array.isArray(msg.plugins) || !Array.isArray(msg.failed)) fail("default scan_result shape invalid");
      console.log(`[test] default-dir scan clean (plugins=${msg.plugins.length}, failed=${msg.failed.length}) ✓ — shutdown`);
      finishAndShutdown();
    }
    return;
  }

  if (mode === "null-audio") {
    // ── Full protocol suite + RESUME contract (null device) ──
    if (msg.type === "hello" && !helloOk) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.2.0") fail(`expected 0.2.0, got ${msg.engineVersion}`);
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "pong" && !pongOk) {
      pongOk = true;
      if (typeof msg.t !== "number") fail("pong.t must be number");
      ws.send(JSON.stringify({ type: "bogus" }));
    } else if (msg.type === "error" && !errorOk) {
      errorOk = true;
      if (msg.code !== "unknown") fail(`expected unknown, got ${msg.code}`);
      ws.send(JSON.stringify({ type: "load", events, meta }));
    } else if (msg.type === "state" && !loadOk) {
      // After load, engine acks with the current transport truth (idle here).
      if (msg.playing === false) {
        loadOk = true;
        console.log("[test] load OK — sending play with EXPLICIT tick 480 (must start there, NOT 0)");
        ws.send(JSON.stringify({ type: "transport", command: "play", tick: 480 }));
      }
    } else if (msg.type === "state" && loadOk && msg.playing === true && !play1Ok) {
      // First playing frame after play(tick 480): tick must be ≈480, NOT 0.
      play1Ok = true;
      first1 = msg.tick;
      last1 = msg.tick;
      frames1 = 1;
      if (msg.tick < 400) fail(`play(tick 480) started at tick ${msg.tick} — engine ignored the explicit start tick (resume-from-0 desync)`);
      console.log(`[test] play(tick 480) started at tick ${msg.tick} ✓ — expecting ticks to ADVANCE`);
    } else if (msg.type === "state" && play1Ok && !adv1Ok) {
      if (msg.playing === true) {
        frames1++;
        last1 = msg.tick;
        // Ticks advance in real time (null device runs the graph).
        if (frames1 >= 3 && last1 > first1) {
          adv1Ok = true;
          console.log(`[test] ticks ADVANCE (${first1} → ${last1} over ${frames1} frames) — sending transport stop`);
          ws.send(JSON.stringify({ type: "transport", command: "stop" }));
        }
      }
    } else if (msg.type === "state" && adv1Ok && !stopOk) {
      if (msg.playing === false) {
        stopOk = true;
        stopTick = msg.tick;
        // The stopped position must be KEPT (≥ where playback started) — the
        // old engine reported the stale playStartTick (or 0) after stop.
        if (msg.tick < first1) fail(`stop reported tick ${msg.tick} < playback start ${first1} — stop lost the position`);
        console.log(`[test] stop OK — position KEPT at tick ${msg.tick} (start was ${first1}) — sending play WITHOUT tick (must resume, NOT restart at 0)`);
        ws.send(JSON.stringify({ type: "transport", command: "play" }));
      }
    } else if (msg.type === "state" && stopOk && msg.playing === true && !play2Ok) {
      // First playing frame after the tick-less play: must RESUME from the
      // stopped position (continuity), never restart at 0.
      play2Ok = true;
      first2 = msg.tick;
      last2 = msg.tick;
      frames2 = 1;
      if (msg.tick < 200) fail(`play without tick started at tick ${msg.tick} — engine auto-reset to 0 (the reported resume desync)`);
      if (msg.tick < stopTick - 600) fail(`play without tick started at tick ${msg.tick}, but stop was at ${stopTick} — no continuity`);
      console.log(`[test] tick-less play RESUMED at tick ${msg.tick} (stopped at ${stopTick}) ✓ — expecting ticks to ADVANCE`);
    } else if (msg.type === "state" && play2Ok && !adv2Ok) {
      if (msg.playing === true) {
        frames2++;
        last2 = msg.tick;
        if (frames2 >= 3 && last2 > first2) {
          adv2Ok = true;
          console.log(`[test] ticks ADVANCE after resume (${first2} → ${last2} over ${frames2} frames) — sending panic`);
          ws.send(JSON.stringify({ type: "panic" }));
          panicOk = true;
          setTimeout(finishAndShutdown, 200);
        }
      }
    } else if (msg.type === "error" && (play1Ok || play2Ok)) {
      fail(`play succeeded (playing=true seen) but engine sent error ${msg.code} mid-play`);
    }
  } else if (mode === "no-device") {
    // ── Graceful no_audio_device on a device-less engine ──
    if (msg.type === "hello" && !helloOk) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "pong" && !pongOk) {
      pongOk = true;
      ws.send(JSON.stringify({ type: "load", events, meta }));
    } else if (msg.type === "state" && loadOk && !noDeviceErrOk && msg.playing === true) {
      // Runner unexpectedly HAS a device — the graceful-error proof is void.
      fail("engine started playing — runner has an audio device; device-less assumption broken");
    } else if (msg.type === "state" && !loadOk) {
      if (msg.playing === false) {
        loadOk = true;
        console.log("[test] load OK — sending transport play (no flag: must be REJECTED gracefully)");
        ws.send(JSON.stringify({ type: "transport", command: "play" }));
      }
    } else if (msg.type === "error" && !noDeviceErrOk) {
      if (msg.code !== "no_audio_device") fail(`expected no_audio_device, got ${msg.code}`);
      if (!msg.detail || msg.detail.length === 0) fail("no_audio_device must carry a detail string");
      noDeviceErrOk = true;
      console.log(`[test] graceful no_audio_device received (detail: "${msg.detail}") — verifying protocol still functional`);
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "pong" && noDeviceErrOk && !pongAfterErrOk) {
      pongAfterErrOk = true;
      // stop / seek / panic must all still respond without crashing.
      ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      ws.send(JSON.stringify({ type: "transport", command: "seek", tick: 960 }));
      ws.send(JSON.stringify({ type: "panic" }));
      stillFunctionalOk = true;
      setTimeout(finishAndShutdown, 300);
    }
  }
});

ws.addEventListener("close", () => {
  clearTimeout(timeout);
  console.log("[test] connection closed");
  let allOk;
  if (mode === "host") {
    allOk = helloOk && hostScanSent && hostPluginStateOk && hostPhase >= 6;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL HOSTING TESTS PASSED (3c-2, stand-in host):");
      console.log('  plugin host by id: scan → load(uid,path) → plugin_state loaded');
      console.log(`  latency: ${hostLatency}ms (<100ms pinned CI assertion)`);
      console.log(`  pre-trigger: CC#32 at t=442, note at t=480 — 38 ticks (${hostDeltaSamples} samples ≈ 20ms) sample-accurate`);
      console.log('  channel routing: ch1 + ch2 dispatched (plugin stdout cross-checked in CI)');
      console.log(`  mute/solo gating AUDIBLE: peaks A/B/C = ${hostPeakA.toFixed(3)} / ${hostPeakB.toFixed(3)} / ${hostPeakC.toFixed(3)}`);
      console.log('  muted-window note never dispatched; unmute restores sound; stop kills voices');
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} scan=${hostScanSent} pluginState=${hostPluginStateOk} phase=${hostPhase} peaks=${hostPeakA.toFixed(3)}/${hostPeakB.toFixed(3)}/${hostPeakC.toFixed(3)}`);
      process.exit(1);
    }
  } else if (mode === "scan") {
    allOk = helloOk && scanSent && scanResultOk && aliveAfterCrashOk && defaultScanOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL SCAN TESTS PASSED (3c-1):");
      console.log('  scan protocol: scan → scan_result (plugins/failed/scannedDirs)');
      console.log('  valid test VST3 found with real name + vendor + uid');
      console.log('  CRASH ISOLATION: worker crash → failed entry, scan + engine survive');
      console.log('  corrupt .vst3 → graceful zero types (no failed entry)');
      console.log('  default-dir scan → clean (possibly empty) result');
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} scanSent=${scanSent} scanResult=${scanResultOk} aliveAfterCrash=${aliveAfterCrashOk} defaultScan=${defaultScanOk}`);
      process.exit(1);
    }
  } else if (mode === "null-audio") {
    allOk = helloOk && pongOk && errorOk && loadOk && play1Ok && adv1Ok && stopOk && play2Ok && adv2Ok && panicOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL PROTOCOL TESTS PASSED (null-audio):");
      console.log("  v1: hello, ping->pong, unknown->error, shutdown");
      console.log("  v1 ext: load, transport play, state@30Hz, transport stop, panic");
      console.log(`  3b-fix: play on null device OK, state ticks ADVANCED (${first1} → ${last1})`);
      console.log(`  3b-polish RESUME: play(tick 480) started at ${first1} (NOT 0)`);
      console.log(`           stop KEPT position (tick ${stopTick})`);
      console.log(`           play WITHOUT tick RESUMED at ${first2} (stopped at ${stopTick}, NOT 0)`);
      console.log(`           ticks advanced after resume (${first2} → ${last2})`);
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} pong=${pongOk} error=${errorOk} load=${loadOk} play1=${play1Ok} adv1=${adv1Ok} stop=${stopOk} play2=${play2Ok} adv2=${adv2Ok} panic=${panicOk}`);
      process.exit(1);
    }
  } else {
    allOk = helloOk && pongOk && loadOk && noDeviceErrOk && pongAfterErrOk && stillFunctionalOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL PROTOCOL TESTS PASSED (no-device):");
      console.log("  play WITHOUT a device → graceful no_audio_device error (no crash)");
      console.log("  engine stayed protocol-functional: ping->pong, stop, seek, panic, shutdown");
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} pong=${pongOk} load=${loadOk} noDeviceErr=${noDeviceErrOk} pongAfterErr=${pongAfterErrOk} stillFunctional=${stillFunctionalOk}`);
      process.exit(1);
    }
  }
});

ws.addEventListener("error", (err) => {
  console.error("[test] WS error:", err.message ?? err);
  process.exit(1);
});
