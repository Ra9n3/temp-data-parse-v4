// Stage 3a/3b/3b-fix/3b-polish: engine protocol test client. Connects to
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

const port = parseInt(process.argv[2] ?? "9378", 10);
const mode = process.argv[3] ?? "null-audio";
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
  } else {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} load=${loadOk} noDeviceErr=${noDeviceErrOk} pongAfterErr=${pongAfterErrOk} stillFunctional=${stillFunctionalOk})`);
  }
  process.exit(1);
}, 20000);

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

  if (mode === "null-audio") {
    // ── Full protocol suite + RESUME contract (null device) ──
    if (msg.type === "hello" && !helloOk) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.1.0") fail(`expected 0.1.0, got ${msg.engineVersion}`);
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
  if (mode === "null-audio") {
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
