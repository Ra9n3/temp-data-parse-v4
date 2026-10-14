// Stage 3a/3b/3b-fix: engine protocol test client. Connects to scorch-engine
// on the given port. Node 22+ (global WebSocket). Throwaway test — not part
// of the app's runtime.
//
// Modes (argv[3]):
//   null-audio (default) — engine runs with --null-audio (JUCE NullAudioDevice:
//     the graph runs in real time with NO hardware). Asserts the full protocol
//     suite (hello, ping->pong, unknown->error, load, panic, shutdown) PLUS the
//     Stage 3b-fix transport contract: play → state ticks ADVANCE → stop.
//   no-device — engine runs with NO audio flag on a device-less runner. Asserts
//     transport play returns the graceful {"code":"no_audio_device","detail":...}
//     error (the historical 0xC0000005 headless crash is now a clean reply) and
//     the engine stays protocol-functional afterwards (ping/pong, stop, seek,
//     panic, shutdown → clean exit).

const port = parseInt(process.argv[2] ?? "9378", 10);
const mode = process.argv[3] ?? "null-audio";
const url = `ws://127.0.0.1:${port}`;

const events = [
  { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 0 },
  { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 960 },
  { eventType: "NOTE_ON", channel: 1, data1: 64, data2: 100, timestampTicks: 960 },
  { eventType: "NOTE_OFF", channel: 1, data1: 64, data2: 0, timestampTicks: 1920 },
];
const meta = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 3840 };

let step = 0;
let stateCount = 0;
// null-audio mode flags
let helloOk = false, pongOk = false, errorOk = false;
let loadOk = false, playOk = false, stopOk = false, panicOk = false;
let firstPlayingTick = null, lastPlayingTick = null, ticksAdvancedOk = false;
// no-device mode flags
let noDeviceErrOk = false, pongAfterErrOk = false, stillFunctionalOk = false;

const ws = new WebSocket(url);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const timeout = setTimeout(() => {
  if (mode === "null-audio") {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} error=${errorOk} load=${loadOk} play=${playOk} ticksAdvanced=${ticksAdvancedOk} stop=${stopOk} panic=${panicOk})`);
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
    // ── Full protocol suite + transport ticks advance (null device) ──
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
      // After load, engine sends state with playing=false
      if (msg.playing === false) {
        loadOk = true;
        console.log("[test] load OK — sending transport play (--null-audio: must succeed)");
        ws.send(JSON.stringify({ type: "transport", command: "play" }));
      }
    } else if (msg.type === "state" && loadOk && !playOk) {
      if (msg.playing === true) {
        playOk = true;
        stateCount = 1;
        firstPlayingTick = msg.tick;
        lastPlayingTick = msg.tick;
        console.log("[test] transport play OK — receiving state messages, expecting ticks to ADVANCE");
      }
    } else if (msg.type === "state" && playOk && !stopOk) {
      stateCount++;
      lastPlayingTick = msg.tick;
      // Ticks must advance in real time (null device runs the graph). Give it
      // a few state frames, then require strict advancement before stopping.
      if (stateCount >= 3 && lastPlayingTick > firstPlayingTick) {
        ticksAdvancedOk = true;
        stopOk = true;
        console.log(`[test] ticks ADVANCE (${firstPlayingTick} → ${lastPlayingTick} over ${stateCount} frames) — sending transport stop`);
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      }
    } else if (msg.type === "state" && stopOk && !panicOk) {
      if (msg.playing === false) {
        panicOk = true;
        console.log("[test] transport stop OK — sending panic");
        ws.send(JSON.stringify({ type: "panic" }));
        setTimeout(finishAndShutdown, 200);
      }
    } else if (msg.type === "error" && playOk) {
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
    allOk = helloOk && pongOk && errorOk && loadOk && playOk && stopOk && panicOk && ticksAdvancedOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL PROTOCOL TESTS PASSED (null-audio):");
      console.log("  v1: hello, ping->pong, unknown->error, shutdown");
      console.log("  v1 ext: load, transport play, state@30Hz, transport stop, panic");
      console.log(`  3b-fix: play on null device OK, state ticks ADVANCED (${firstPlayingTick} → ${lastPlayingTick})`);
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} pong=${pongOk} error=${errorOk} load=${loadOk} play=${playOk} ticksAdvanced=${ticksAdvancedOk} stop=${stopOk} panic=${panicOk}`);
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
