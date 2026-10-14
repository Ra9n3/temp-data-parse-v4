// Stage 3a: engine protocol test client. Connects to scorch-engine on the
// given port, asserts the 4 protocol-v1 message types, exits 0 on success.
// Throwaway test — not part of the app's runtime. Node 22 has global WebSocket.

const port = parseInt(process.argv[2] ?? "9378", 10);
const url = `ws://127.0.0.1:${port}`;

let helloReceived = false;
let pongReceived = false;
let errorReceived = false;

const ws = new WebSocket(url);

const timeout = setTimeout(() => {
  console.error("TIMEOUT: test took too long");
  process.exit(1);
}, 10000);

ws.addEventListener("open", () => {
  console.log("[test] connected, waiting for hello...");
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("[test] received:", JSON.stringify(msg));

  if (msg.type === "hello" && !helloReceived) {
    helloReceived = true;
    if (msg.protocol !== 1) throw new Error(`expected protocol 1, got ${msg.protocol}`);
    if (msg.engineVersion !== "0.1.0") throw new Error(`expected engineVersion 0.1.0, got ${msg.engineVersion}`);
    // Test 2: send ping
    ws.send(JSON.stringify({ type: "ping" }));
  } else if (msg.type === "pong" && !pongReceived) {
    pongReceived = true;
    if (typeof msg.t !== "number") throw new Error("pong.t must be a number");
    // Test 3: send unknown message
    ws.send(JSON.stringify({ type: "bogus", data: "test" }));
  } else if (msg.type === "error" && !errorReceived) {
    errorReceived = true;
    if (msg.code !== "unknown") throw new Error(`expected code "unknown", got "${msg.code}"`);
    if (!msg.echo.includes("bogus")) throw new Error("echo should contain original message");
    // Test 4: shutdown
    ws.send(JSON.stringify({ type: "shutdown" }));
  }
});

ws.addEventListener("close", () => {
  clearTimeout(timeout);
  console.log("[test] connection closed");
  const allOk = helloReceived && pongReceived && errorReceived;
  if (allOk) {
    console.log("[test] ALL TESTS PASSED: hello, ping->pong, unknown->error, shutdown");
    process.exit(0);
  } else {
    console.error(`[test] FAILED: hello=${helloReceived} pong=${pongReceived} error=${errorReceived}`);
    process.exit(1);
  }
});

ws.addEventListener("error", (err) => {
  console.error("[test] WS error:", err.message ?? err);
  process.exit(1);
});
