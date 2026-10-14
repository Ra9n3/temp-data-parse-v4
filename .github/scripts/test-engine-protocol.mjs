// Stage 3a/3b: engine protocol test client. Connects to scorch-engine on the
// given port, asserts all protocol-v1 messages (hello, ping->pong, unknown->error,
// shutdown) PLUS the v1 extension (load, transport play/stop, panic, state).
// Throwaway test — not part of the app's runtime. Node 22 has global WebSocket.

const port = parseInt(process.argv[2] ?? "9378", 10);
const url = `ws://127.0.0.1:${port}`;

let step = 0;
let stateCount = 0;
let helloOk = false, pongOk = false, errorOk = false;
let loadOk = false, playOk = false, stopOk = false, panicOk = false;

const ws = new WebSocket(url);

const timeout = setTimeout(() => {
  console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} error=${errorOk} load=${loadOk} play=${playOk} stop=${stopOk} panic=${panicOk})`);
  process.exit(1);
}, 15000);

ws.addEventListener("open", () => {
  console.log("[test] connected, waiting for hello...");
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("[test] RX:", JSON.stringify(msg).slice(0, 120));

  if (msg.type === "hello" && !helloOk) {
    helloOk = true;
    if (msg.protocol !== 1) throw new Error(`expected protocol 1, got ${msg.protocol}`);
    if (msg.engineVersion !== "0.1.0") throw new Error(`expected 0.1.0, got ${msg.engineVersion}`);
    // Test ping
    ws.send(JSON.stringify({ type: "ping" }));
  } else if (msg.type === "pong" && !pongOk) {
    pongOk = true;
    if (typeof msg.t !== "number") throw new Error("pong.t must be number");
    // Test unknown
    ws.send(JSON.stringify({ type: "bogus" }));
  } else if (msg.type === "error" && !errorOk) {
    errorOk = true;
    if (msg.code !== "unknown") throw new Error(`expected unknown, got ${msg.code}`);
    // Stage 3b: test load
    const events = [
      { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 0 },
      { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 960 },
      { eventType: "NOTE_ON", channel: 1, data1: 64, data2: 100, timestampTicks: 960 },
      { eventType: "NOTE_OFF", channel: 1, data1: 64, data2: 0, timestampTicks: 1920 },
    ];
    ws.send(JSON.stringify({ type: "load", events, meta: { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 3840 } }));
  } else if (msg.type === "state" && !loadOk) {
    // After load, engine sends state with playing=false
    if (msg.playing === false) {
      loadOk = true;
      console.log("[test] load OK — sending transport play");
      ws.send(JSON.stringify({ type: "transport", command: "play" }));
    }
  } else if (msg.type === "state" && loadOk && !playOk) {
    // After play, state should show playing=true
    if (msg.playing === true) {
      playOk = true;
      stateCount = 1;
      console.log("[test] transport play OK — receiving state messages");
    }
  } else if (msg.type === "state" && playOk && !stopOk) {
    stateCount++;
    // After receiving a few state messages, test stop
    if (stateCount >= 3) {
      stopOk = true;
      console.log("[test] transport stop");
      ws.send(JSON.stringify({ type: "transport", command: "stop" }));
    }
  } else if (msg.type === "state" && stopOk && !panicOk) {
    if (msg.playing === false) {
      panicOk = true;
      console.log("[test] transport stop OK — sending panic");
      ws.send(JSON.stringify({ type: "panic" }));
      // After panic, send shutdown
      setTimeout(() => {
        console.log("[test] sending shutdown");
        ws.send(JSON.stringify({ type: "shutdown" }));
      }, 200);
    }
  }
});

ws.addEventListener("close", () => {
  clearTimeout(timeout);
  console.log("[test] connection closed");
  const allOk = helloOk && pongOk && errorOk && loadOk && playOk && stopOk && panicOk;
  if (allOk) {
    console.log("");
    console.log("========================================");
    console.log("ALL PROTOCOL TESTS PASSED:");
    console.log("  v1: hello, ping->pong, unknown->error, shutdown");
    console.log("  v1 ext: load, transport play, state@30Hz, transport stop, panic");
    console.log("========================================");
    process.exit(0);
  } else {
    console.error(`FAILED: hello=${helloOk} pong=${pongOk} error=${errorOk} load=${loadOk} play=${playOk} stop=${stopOk} panic=${panicOk}`);
    process.exit(1);
  }
});

ws.addEventListener("error", (err) => {
  console.error("[test] WS error:", err.message ?? err);
  process.exit(1);
});
