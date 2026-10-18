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
//     Stage 3c close-out (transport transitions are musical):
//       play(tick 480) must NOT replay the PAST events (tick 0/300 pitch 48 —
//         the F4-clamp resume-replay burst receipt),
//       stop mid-note = MUSICAL RELEASE (no instant kill),
//       resume must GENTLY RE-ATTACK the straddling note (velocity capped at
//         80, dispatched at sample 0 of the resume buffer).
//   no-device — engine runs with NO audio flag on a device-less runner. Asserts
//     transport play returns the graceful {"code":"no_audio_device","detail":...}
//     error (the historical 0xC0000005 headless crash is now a clean reply) and
//     the engine stays protocol-functional afterwards (ping/pong, stop, seek,
//     panic, shutdown → clean exit).
//   scan (argv[4] = fixture dir) — Stage 3c-1 + 3f-2: VST3 scan-protocol
//     proof with the DESCRIBE/PROBE split. Sends
//     {"type":"scan","dirs":[fixtureDir, fixtureDir/nested/L1/L2]} where the
//     fixture dir contains
//       * the VALID free test VST3 ("Scorch Test Synth", must be found with
//         its real name + vendor + isInstrument + classId),
//       * CrashDummy.vst3 (a VALID shared library that aborts inside
//         GetPluginFactory — kills its scan-worker child during DESCRIBE),
//       * CorruptDummy.vst3 (garbage bytes — graceful zero-type load failure),
//       * ProbeCrashDummy.vst3 nested 3 subfolder levels deep (describes via
//         its moduleinfo.json WITHOUT loading the binary; aborts in
//         GetPluginFactory when the PROBE loads it),
//       * ProbeHangDummy.vst3 (describes fine; sleeps forever in
//         GetPluginFactory — eats the 90 s probe timeout).
//     Asserts: the valid plugin is found and carries NO capabilities (the
//     split); the nested dummy appears EXACTLY ONCE (recursive scan + classId
//     dedup across the two dirs); the crash dummy appears as a failed entry
//     WITH exitCode+elapsedMs+stderrTail AND does not kill the scan or the
//     engine (ping→pong); the corrupt dummy is isolated silently; ALL THREE
//     scan_probes arrive (synth → capabilities with main out "Output" 2ch,
//     probe-crash → capabilitiesError, probe-hang → timeout capabilitiesError)
//     and remove no rows; a default-dir scan returns a clean (possibly empty)
//     result; shutdown → clean exit.
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
//       Stage 3c close-out: stop = MUSICAL RELEASE (the ledger shows the
//         release marker + EXACT note-offs for every held note — and NONE for
//         the never-dispatched gated pitch; NO CC120 All-Sound-Off at stop);
//         resume re-attacks the straddling notes gently (vel 80, at the
//         resume tick, sample 0); the redundant CC#32 (same value the channel
//         is already in) is SUPPRESSED (ledger kind 6) while a genuine change
//         is SENT; dispatch_log/dispatch protocol shape.
//       Stage 3d-1: editor windows — openEditor with NO live instance answers
//         editor_unavailable (normal reply, no crash); after the transport
//         phases, openEditor OPENS (real geometry), a repeat openEditor
//         RAISES the existing window (focused=true — ONE editor per
//         instance), closeEditor closes cleanly. The fixture ships a
//         deterministic 360x120 editor so a free plugin proves universality.
//       Stage 3f-3a: OWNED editor windows — right after hello the runner sends
//         {"type":"setHostWindow","hwnd":<real win32 holder HWND | 1>} (the
//         frontend does this on connect via the shell's main_window_hwnd()),
//         asserts the hostWindowSet ECHO, and Windows CI greps the
//         "[editor] host-owner applied hwnd=0x…” engine.log receipt (the
//         GWLP_HWNDPARENT owner application ran at editor open). Missing-hwnd
//         behaviour is proven in MULTI mode, which sends nothing.
//       Stage 3e-1: CAPABILITY HANDSHAKE — exactly one plugin_capabilities
//         per plugin_state "loaded" (per instance), whose facts match the
//         fixture (0 in / 2 out buses — main "Output" + aux "Aux Out",
//         stereo, enabled-by-default, latency 128, instrument + accepts-MIDI
//         + editor + 1 program); plugin_state carries classId and a reload
//         whose uid IS the class identifier string MATCHES (the preferred
//         key, phase R). Scan rows carry classId + capabilities too.
//       Stage 3e-3: MULTI-OUTPUT BUSES — the fixture's aux bus is armed via
//         score CC#22; M1: the aux-bus master fold AND the legacy ×2.0
//         hosted-output gain are BOTH named deferrals (aux buses stay
//         unconnected — only the main stereo bus drives the master; the
//         graph renders at unity). Default and muted-routing loads both
//         render main-only ≈0.394 (phases MO-1..MO-5 prove the main bus
//         through routing-bearing reloads; the fold/gain asserts return
//         with the routing milestone).
//       Stage 3d-3: state persistence — captureState of the DEFAULT state is
//         byte-EXACT (the fixture's state is one raw float32 masterScale,
//         4 bytes = 1.0f); a re-host WITH an embedded state (masterScale
//         0.5) must APPLY it (the play peak HALVES to ≈0.397 at unity) and
//         the capture→restore→capture round-trip must be byte-IDENTICAL —
//         the proof that a project-embedded state survives a restart.
//   scale — Stage 3c-hotfix: REAL-PROJECT-SIZED load. The CI gap was scale;
//     this closes it. A deterministic full-density fixture (16 channels × 27
//     bars, 13,824 events ≈ 1.1 MB serialized) is sent as ONE load message
//     and the loadAck receipt must round-trip EXACTLY: received == sent,
//     loaded == sent, skipped == 0, byteSize == bytes sent, seq echoed.
//     Negative paths: a load with non-array events must be REJECTED
//     (bad_load — the historical silently-empty-score path is closed) and a
//     load with one malformed event (JSON null number — the NaN class) must
//     be NAMED (skipped=1, firstErrorIndex=index). Then a clean load is
//     restored and the transport contract re-verified at scale (play → ticks
//     advance → stop).
//   latency (argv[4] = fixture dir) — Stage 3i: RUNTIME LATENCY TRACKING.
//     Loads the test synth (reports 128 samples from its constructor), starts
//     the transport, then drives the fixture's RESERVED CC#23 through a
//     scripted sequence of mid-play event loads and asserts — ALL over the
//     wire — that the engine detects and mini-republishes every latency
//     change WITHOUT a reload:
//       CC#23 v=1  (notified 1024) → the NEXT mid-play load's reuse
//                  plugin_state carries latencyMs ≈ 34.83 ((1024+512)/44.1)
//                  — the correction landed AND survived a mid-play load;
//       CC#23 v=0  (notified 0)    → next reuse latencyMs ≈ 11.61;
//       CC#23 v=10 (SILENT 2048 — no updateHostDisplay) → the 2000 ms
//                  message-thread safety net + its 2-identical-reads debounce
//                  must catch it → next reuse latencyMs ≈ 58.05;
//       CC#23 v=20 (NOTIFIED FLICKER: 40× 0↔1024 from INSIDE processBlock,
//                  settling at 1024) → the per-instance one-per-second rate
//                  limit holds (engine.log receipts counted by desktop.yml)
//                  and the final reuse latencyMs ≈ 34.83 (settled value).
//     Transport continuity: playing states keep streaming and the tick
//     ADVANCES across every correction window (no transportGen hiccup), no
//     error/load_rejected after the initial load, and plugin_state "loaded"
//     arrives EXACTLY 6× (1 initial + 5 mid-play reuse) — the corrections
//     ride the mini-republish, never a re-instantiate.
//     The engine.log receipts themselves ([latency] republish old→new pairs,
//     the deferred rate-limit receipt, publish summaries, and the Stage 3j
//     saw / debounce-confirmed lines + the final reuse latencySamples) are asserted by
//     desktop.yml after the session.

//   terminal (argv[4] = fixture dir) — 0.9.2: the INIT-QUEUE TERMINAL RECEIPT
//     INVARIANT + editor reopen + coalescing (field log 0.9.1, gate run 1).
//     One session drives all four CI scenarios (see the state block for the
//     full matrix): success (seq 12 loaded + play), failing plugin (seq 41
//     bogus path), superseded-by-newer-request (seq 40), artificially jammed
//     plugin (seq 10 — the fixture's first create sleeps JAM s; the engine's
//     watchdog declares it failed at TIMEOUT s with a wire plugin_state
//     error), plus the queued-behind declaration (seq 11), the coalescing
//     fold (seq 21 folds into seq 20), the editor reopen after "plugin set
//     reused" (openEditor after a mid-play reuse), and the load-carried
//     "openEditor":true intent (reuse + async). The per-seq exactly-one
//     terminal receipt counting, the stage receipts, and the >10s pending /
//     queued warnings are asserted on the engine.log side by desktop.yml.

// Stage 3f-3a runner-only imports: the Windows host-hwnd holder spawns a
// PowerShell WinForms form and reads its HWND from a file (everything else
// in this runner is dependency-free).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = parseInt(process.argv[2] ?? "9378", 10);
const mode = process.argv[3] ?? "null-audio";
const fixtureDir = process.argv[4] ?? "";
const url = `ws://127.0.0.1:${port}`;

// ─── Milestone 2: MULTI-INSTANCE mode (argv[3]="multi", argv[4]=fixture dir) ─
// The M2 completion proof: N live instances, per-instance MIDI routing,
// diff-based reuse, per-instance editors/state — against the free test VST3
// (TWO scan identities of the SAME source: "Scorch Test Synth" and
// "Scorch Test Synth B" — a diff "changed" entry swaps a REAL binary).
// No plugin-name logic in the ENGINE: the identities exist so CI can
// distinguish a re-instantiate from a keep.
//
// Phase machine (all receipts per-instance on the wire; the engine.log
// grammar — "set diff:", "instance kept/added/removed/changed", the
// exactly-one terminal per seq, and the plugin-side ordinal isolation — is
// asserted by desktop.yml against the log + the engine stdout):
//   M2-1  load 3 instances (inst-a/b/c = Synth A), routing t1/t2/t3 → ch1
//         each, distinct pitches 60/67/72 → 3× plugin_state loaded
//         (channels [1] each) + 3× capabilities;
//   M2-2  play → summed peak > 1.0 (three sources — one instance caps at
//         ≈0.79) + dispatch ledger wide channels c=1, c=17, c=33;
//   M2-3  MID-PLAY diff seq 2: inst-b → Synth B (CHANGED; a + c untouched)
//         → "kept 2, changed 1" on the log; wire: 3× loaded re-echo, NO
//         error, transport keeps rolling;
//   M2-4  MID-PLAY diff seq 3: ADD inst-d (Synth A, pitch 79, t4→d:1)
//         → kept 3, added 1; wire: 4× loaded; ledger gains c=49;
//   M2-5  MID-PLAY diff seq 4: PARTIAL UNLOAD — drop inst-c ({a,b,d} remain)
//         → kept 3, removed 1; wire: 3× loaded; the survivors keep playing;
//   M2-6  MID-PLAY score edit seq 5: same set {a,b,d}, one velocity edited
//         → EXACT set match → the reuse fast path ("instance kept" per
//         instance on the log; no queueing, no worker pass);
//   M2-7  stop → editors: openEditor inst-a OPENS, inst-b opens a SECOND
//         SIMULTANEOUS window, a repeat RAISES, per-id closes (headless runs
//         tolerate editor_unavailable "no display"; Windows CI proves the
//         real window path);
//   M2-8  captureState → one pluginSavedState PER live instance
//         (inst-a/inst-b/inst-d — distinct ids);
//   M2-9  clean shutdown, exit 0.
const MULTI_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 8448 };
// One part per instance, one DISTINCT pitch per part — the routing-isolation
// fixture: a leak (a part's note reaching a foreign instance) would surface
// on the plugin-side log as one pitch under TWO instance ordinals. t4 exists
// for the mid-play ADD phase (inst-d, pitch 79).
function multiPart(trackId, pitch, onTick = 480, offTick = 8448) {
  return [
    { eventType: "CONTROL_CHANGE", channel: 1, data1: 7, data2: 127, timestampTicks: 0, trackId },
    { eventType: "CONTROL_CHANGE", channel: 1, data1: 11, data2: 127, timestampTicks: 0, trackId },
    { eventType: "NOTE_ON", channel: 1, data1: pitch, data2: 100, timestampTicks: onTick, trackId },
    { eventType: "NOTE_OFF", channel: 1, data1: pitch, data2: 0, timestampTicks: offTick, trackId },
  ];
}
// t4's note fires at tick 3000 — AFTER the mid-play ADD (seq 3, sent at
// ~tick 2000) lands inst-d: a note-on for a not-yet-live instance would be
// dropped, so the ADD phase's wide-49 proof needs its part's event in the
// future at send time and comfortably past the seq-complete gate.
const PART_PITCH = { t1: 60, t2: 67, t3: 72, t4: 79 };
const PART_ON = { t1: 480, t2: 960, t3: 480, t4: 3000 };
const multiTracksFor = (ids) => ids.map((id) => ({ id, pitch: PART_PITCH[id], onTick: PART_ON[id] }));
const multiEventsFor = (ids) => multiTracksFor(ids).flatMap((t) => multiPart(t.id, t.pitch, t.onTick));
const multiEvents = multiEventsFor(["t1", "t2", "t3"]);

let multiPhase = 0, multiScanSent = false;
let multiScanPlugin = null;        // "Scorch Test Synth" (A)
let multiScanPluginB = null;       // "Scorch Test Synth B" (the diff identity)
const multiA = () => ({ uid: multiScanPlugin.uid, path: multiScanPlugin.path, name: multiScanPlugin.name });
const multiB = () => ({ uid: multiScanPluginB.uid, path: multiScanPluginB.path, name: multiScanPluginB.name });
// Per-instance loaded-receipt counts — the wire shape of every phase (a kept
// instance re-echoes exactly ONE loaded per load that includes it).
const multiLoadedCount = {};
const multiCapsCount = {};
let multiPeak = 0, multiLedger = [], multiWide = {};
let multiEdOpenA = false, multiEdOpenB = false, multiEdFocus = false,
    multiEdCloseA = false, multiEdCloseB = false, multiHeadlessSkip = false;
let multiCapIds = new Set();
let multiAckSeqs = new Set();
// Per-seq loaded-echo ledger: after loadAck(seq) the expected instance set is
// outstanding; each plugin_state loaded consumes the iid from the OLDEST seq
// still expecting it. A seq whose set drains is COMPLETE (the wire half of
// the terminal-receipt invariant — the log grammar is desktop.yml's).
const multiExpect = [];
const multiSendLoad = (seq, instanceSet, trackIds) => {
  multiExpect.push({ seq, set: new Set(instanceSet.map((p) => p.instanceId)) });
  ws.send(JSON.stringify({
    type: "load", seq,
    events: multiEventsFor(trackIds),
    meta: MULTI_META,
    plugins: instanceSet,
    routing: Object.fromEntries(instanceSet.map((p, i) => [trackIds[i], { inst: p.instanceId, ch: 1 }])),
  }));
};
const multiSeqComplete = (seq) => {
  console.log(`[test] seq ${seq} complete — every expected plugin_state loaded arrived (counts: ${JSON.stringify(multiLoadedCount)})`);
  if (seq === 1) {
    multiPhase = 3;
    ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
  } else if (seq === 2) { multiPhase = 5; }
  else if (seq === 3) { multiPhase = 7; }
  else if (seq === 4) { multiPhase = 9; }
  else if (seq === 5) {
    multiPhase = 11;
    ws.send(JSON.stringify({ type: "transport", command: "stop" }));
  }
};
// The editor + capture tail (M2-7/M2-8). Windowed hosts walk the open →
// second-window → raise → per-id-close chain; headless hosts (editor_
// unavailable) skip straight to the per-instance captures.
const multiEditorPhase = (headless) => {
  if (headless || multiHeadlessSkip) {
    console.log("[test] editors SKIPPED (headless host) — per-instance captures next");
    multiPhase = 18;   // the capture branch's phase gate
    multiCapIds.clear();
    ws.send(JSON.stringify({ type: "captureState" }));
    return;
  }
  multiPhase = 14;
  ws.send(JSON.stringify({ type: "openEditor", instanceId: "inst-a" }));
};

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

// Stage 3c-hotfix: deterministic full-density fixture — NO RNG (standing
// rule). 16 channels × 27 bars × 16 sixteenth-note slots = 6,912 note-ons +
// 6,912 note-offs = 13,824 events. Every field is a pure function of
// (channel, bar, slot) so the fixture is reproducible byte-for-byte.
function buildScaleFixture() {
  const out = [];
  for (let ch = 1; ch <= 16; ch++) {
    for (let bar = 0; bar < 27; bar++) {
      for (let n = 0; n < 16; n++) {
        const tick = (bar * 16 + n) * 240;
        const pitch = 36 + ((bar * 16 + ch + n) % 48);
        const vel = 40 + ((bar + ch + n) % 80);
        const dur = 120 + (n % 4) * 60;
        out.push({ eventType: "NOTE_ON", channel: ch, data1: pitch, data2: vel, timestampTicks: tick });
        out.push({ eventType: "NOTE_OFF", channel: ch, data1: pitch, data2: 0, timestampTicks: tick + dur });
      }
    }
  }
  out.sort((a, b) => a.timestampTicks - b.timestampTicks ||
    (a.eventType === "NOTE_OFF" ? -1 : 1) - (b.eventType === "NOTE_OFF" ? -1 : 1));
  return out;
}
const scaleEvents = buildScaleFixture();
const SCALE_SENT = scaleEvents.length;                       // 13,824
const scaleMeta = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 27 * 16 * 240 };
const scalePayload = JSON.stringify({ type: "load", seq: 1001, events: scaleEvents, meta: scaleMeta });
const SCALE_SENT_BYTES = scalePayload.length;

let step = 0;
// null-audio / no-device mode flags
let helloOk = false, pongOk = false, errorOk = false;
let loadAckOk = false, loadOk = false, play1Ok = false, adv1Ok = false, stopOk = false;
let play2Ok = false, adv2Ok = false, panicOk = false;
let midPlayAckOk = false;   // Stage 3c-regression: mid-play live-edit reload contract
let first1 = 0, last1 = 0, frames1 = 0, stopTick = 0, first2 = 0, last2 = 0, frames2 = 0;
// Stage 3c close-out: dispatch-ledger collection (null-audio) — the resume
// replay-burst + gentle re-attack asserts read what the engine ACTUALLY sent.
const ledgerEntries = [];
let noReplay48Ok = false, reattackOk = false;
// no-device mode flags
let noDeviceErrOk = false, pongAfterErrOk = false, stillFunctionalOk = false;
// scale mode flags (Stage 3c-hotfix)
let scalePhase = "handshake";
let scaleAckOk = false, negArrayOk = false, negEventOk = false, restoreOk = false;
let scalePlayOk = false, scaleTicksOk = false, scaleStopOk = false, scalePanicOk = false;
let scaleFirstTick = 0, scaleLastTick = 0, scaleStateFrames = 0;

// ─── Stage 3f-3a: the host-window handle (host mode) ────────────────────────
// The real frontend sends {"type":"setHostWindow","hwnd":<n>} on connect (the
// shell's main_window_hwnd() command). The runner mirrors that so the owner
// application is CI-verifiable: on win32 it spawns a PowerShell WinForms form
// and uses ITS real HWND — the engine's editor windows then get OWNED by a
// real window, and the "[editor] host-owner applied hwnd=0x…” receipt (which
// desktop.yml greps) proves SetWindowLongPtrW(GWLP_HWNDPARENT) actually ran.
// On non-win32 the owner path is compile-excluded engine-side; hwnd=1 is sent
// purely as the parse+store+echo proof. Multi mode deliberately sends
// NOTHING — its editor opens exercise the spec's missing-hwnd path ("keep
// today's behaviour and log it": "[editor] host-owner skipped (no host hwnd)").
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hostHwnd = null;            // number (host mode always resolves one or dies trying)
let hostHwndSetOk = false;      // hostWindowSet echo received with the matching hwnd
let hostHwndHolderProc = null;  // the PowerShell form process (killed at exit)
if (mode === "host") {
  if (process.platform === "win32") {
    const hwndFile = path.join(os.tmpdir(), `scorch-runner-hwnd-${process.pid}-${Date.now()}.txt`);
    // ShowDialog blocks (keeps the process — and the HWND — alive for the
    // whole run); the Add_Shown handler writes the handle once it exists.
    const psScript =
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null; " +
      "$f = New-Object System.Windows.Forms.Form; " +
      "$f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false; " +
      "$f.Add_Shown({ [IO.File]::WriteAllText($env:SCORCH_HWND_FILE, $f.Handle.ToString()) }); " +
      "[void]$f.ShowDialog()";
    hostHwndHolderProc = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      { env: { ...process.env, SCORCH_HWND_FILE: hwndFile }, stdio: "ignore" },
    );
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await sleep(250);
      try {
        const s = fs.readFileSync(hwndFile, "utf8").trim();
        if (s) {
          const n = Number(s);
          if (Number.isFinite(n) && n >= 1) { hostHwnd = n; break; }
        }
      } catch { /* file not written yet */ }
      if (hostHwndHolderProc.exitCode !== null) break;
    }
    if (hostHwnd === null) {
      try { hostHwndHolderProc.kill(); } catch { /* already gone */ }
      console.error("FAIL: 3f-3a could not acquire a real host HWND (PowerShell WinForms holder) — the owner-application proof cannot run on this Windows runner. The editor phases already depend on a working interactive session; this failure names the holder, not the engine.");
      process.exit(1);
    }
    console.log(`[test] host-hwnd holder: ${hostHwnd} (0x${hostHwnd.toString(16)}) — setHostWindow will be sent (owner application receipt-verified in engine.log)`);
    process.on("exit", () => { try { hostHwndHolderProc?.kill(); } catch { /* gone */ } });
  } else {
    hostHwnd = 1;   // parse+store+echo proof only — the owner apply is Windows-only engine-side
    console.log("[test] non-win32: setHostWindow parse-proof hwnd=1 (owner application is compile-excluded here)");
  }
}

const ws = new WebSocket(url);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};

const timeout = setTimeout(() => {
  if (mode === "null-audio") {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} error=${errorOk} loadAck=${loadAckOk} load=${loadOk} play1=${play1Ok} adv1=${adv1Ok} midPlayAck=${midPlayAckOk} stop=${stopOk} play2=${play2Ok} adv2=${adv2Ok} panic=${panicOk} ledger=${ledgerEntries.length})`);
  } else if (mode === "scale") {
    console.error(`TIMEOUT at step ${step} (phase=${scalePhase} scaleAck=${scaleAckOk} negArray=${negArrayOk} negEvent=${negEventOk} restore=${restoreOk} play=${scalePlayOk} ticks=${scaleTicksOk} stop=${scaleStopOk} panic=${scalePanicOk} sent=${SCALE_SENT} events/${SCALE_SENT_BYTES} bytes)`);
  } else if (mode === "scan") {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} scanSent=${scanSent} scanResult=${scanResultOk} aliveAfterCrash=${aliveAfterCrashOk} probes=${Object.keys(scanProbes).length}/3 asserted=${scanProbesAsserted} defaultScan=${defaultScanOk})`);
  } else if (mode === "host") {
    console.error(`TIMEOUT at step ${step} phase=${hostPhase} (scan=${hostScanSent} hostHwnd=${hostHwndSetOk} pluginState=${hostPluginStateOk} editorNeg=${hostEditorNegOk} editorOpen=${hostEditorOpenOk} editorFocus=${hostEditorFocusOk} editorClose=${hostEditorCloseOk} stateCap=${hostStateCaptureOk} stateRestore=${hostStateRestoreOk} stateRT=${hostStateRoundtripOk} reloadAck=${hostReloadAckOk} reject=${hostRejectOk} stillPlaying=${hostPlayingAfterReject} stops=${hostStopTick1}/${hostStopTick2} peaks A/B/C=${hostPeakA.toFixed(3)}/${hostPeakB.toFixed(3)}/${hostPeakC.toFixed(3)} entries=${hostEntries.length})`);
  } else if (mode === "multi") {
    console.error(`TIMEOUT at step ${step} phase=${multiPhase} (scanA=${multiScanPlugin ? "ok" : "none"} scanB=${multiScanPluginB ? "ok" : "none"} loaded=${JSON.stringify(multiLoadedCount)} acks=${[...multiAckSeqs].join(",")} peak=${multiPeak.toFixed(3)} wide=${JSON.stringify(multiWide)} editors=${multiEdOpenA}/${multiEdOpenB}/${multiEdFocus}/${multiEdCloseA}/${multiEdCloseB} headlessSkip=${multiHeadlessSkip} captures=${[...multiCapIds].join(",")} entries=${multiLedger.length})`);
  } else if (mode === "slowload") {
    console.error(`TIMEOUT at step ${step} phase=${slPhase} (scan=${slScanPlugin ? "ok" : "none"} ack=${slAckOk} ackMs=${slAckMs} loaded=${slLoadedOk} loadedMs=${slLoadedMs} play=${slPlayOk} ticks=${slTicksOk} peak=${slPeak.toFixed(3)} stop=${slStopOk})`);
  } else if (mode === "terminal") {
    console.error(`TIMEOUT at step ${step} phase=${trPhase} (scan=${trScanPlugin ? "ok" : "none"} jamAck=${trJamAckFast}@${trJamAckMs}ms jamErr=${trJamErr} queuedErr=${trQueuedErr} clean=${trCleanLoaded} ticks=${trPlayTicks} stop=${trStopped} reuse=${trReuseCount} edOpen=${trEditorOpenOk} edClose=${trEditorCloseOk} carried=${trEditorCarriedOk} headless=${trHeadlessSkip} supp=${trSuppLoaded} bogus2=${trBogus2Err})`);
  } else {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} load=${loadOk} noDeviceErr=${noDeviceErrOk} pongAfterErr=${pongAfterErrOk} stillFunctional=${stillFunctionalOk})`);
  }
  process.exit(1);
// 3f-2: scan mode now waits out the ProbeHangDummy 90 s probe timeout (plus
// the describe stage and the fast probes) — 180 s budget. 3f-6: multi mode
// grows the publish-safe phase (slow-capture replace + following load) whose
// 10 s message-thread stalls run ASYNCHRONOUSLY to the assertions — the 5 s
// loaded-receipt bound is asserted EXPLICITLY per phase below — but the
// wall-clock budget still covers them, plus the Stage 3h stall probe (a 2.5 s
// audio freeze + its tail): 120 s.
}, mode === "scan" ? 180000 : mode === "host" ? 150000 : mode === "multi" ? 120000 : mode === "latency" ? 90000 : mode === "slowload" ? 90000 : mode === "terminal" ? 150000 : 30000);

// scan-mode flags
let scanSent = false, scanResultOk = false, aliveAfterCrashOk = false, defaultScanOk = false;

// ── Stage 3i latency-mode state (see the header docs) ──
const LAT_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 115200 };
let latPhase = 0;              // 0 hello, 1 scanning, 2 loading, 3 playing, 4 sequence running
let latPlugin = null;
let latSeq = 10;               // mid-play event loads use seq 11..15 (seq 1 = the initial load)
let latLoadedReceipts = [];    // latencyMs per plugin_state "loaded" (1 initial + 5 reuse, IN ORDER)
let latLastTick = 0;           // last observed transport tick (playing states)
let latTickAtLoad = {};        // seq → tick when that load was SENT (each CC rides lastTick + 960)
let latErrorAfterLoad = false;
let latLedger = [];            // Phase 2: dispatch ledger entries (dispatch_log enabled after hello; the downbeat pre-fire proof reads it at close)

// ── M1-hotfix: slowload mode (the heavy-load death class, stand-in shape) ──
// The engine runs with SCORCH_TESTVST_SLOW_CREATE_S=6 (the fixture's
// CONSTRUCTOR sleeps 6 s = the cold-instantiate shape) and
// SCORCH_TESTVST_SLOW_PREPARE_N=1 / _S=6 (the FIRST prepareToPlay sleeps 6 s
// = the worker's create-time prepare; JUCE's wrapper early-outs
// identical-settings re-prepares, so the fixture sees exactly one prepare
// call per load). Wire assertions:
//   loadAck < 3 s after the send (the ASYNC ACK contract — the loadAck is
//     the enqueue receipt and must never wait behind plugin init; the old
//     fixed 4000 ms timer expired DURING the death/restart window of the
//     real Falcon loads and the user read "reload failed");
//   plugin_state loaded >= (create + prepare - 1) s after the send (the
//     worker really ran both sleeps — nothing shortcut the init);
//   play -> ticks ADVANCE -> audible peak -> clean stop (the engine is
//     fully alive behind a 12 s load).
// Engine.log side (asserted by desktop.yml), with the JUCE 8.0.4 fact this
// mode DOCUMENTED empirically: the VST3 wrapper serializes a plugin's cold
// constructor AND its first prepareToPlay against the message thread
// (MessageManagerLock inside the wrapper — the plugin's work freezes the MM
// no matter which thread calls it; createPluginInstance and prepareToPlay
// were both measured freezing the MM for the fixture's whole sleep). Those
// windows are STRUCTURAL — the stock AudioPluginHost has them too. What the
// hotfix guarantees is: (a) the engine SURVIVES them (every unresponsive
// window ends in a recovered receipt — the real Falcon loads died with the
// process instead), (b) the GLUE-OWNED phases (commit re-prepare early-out,
// worker-side retire capture, publish) never ADD a window — no unresponsive
// receipt after "[plugin] prepared (worker)".
const SLOW_CREATE_S = parseInt(process.env.SCORCH_TESTVST_SLOW_CREATE_S ?? "0", 10) || 0;
const SLOW_PREPARE_S = parseInt(process.env.SCORCH_TESTVST_SLOW_PREPARE_S ?? "0", 10) || 0;
const SLOW_TOTAL_MS = Math.max(0, (SLOW_CREATE_S + SLOW_PREPARE_S - 1)) * 1000;
const SLOW_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 8448 };
const slowEvents = [
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 7, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 11, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 480, trackId: "t1" },
  { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 8448, trackId: "t1" },
];
let slPhase = 0;        // 0 hello, 1 scan, 2 loading, 3 playing, 4 stopping
let slScanPlugin = null;
let slAckOk = false, slLoadedOk = false, slPlayOk = false, slTicksOk = false, slStopOk = false;
let slAckMs = -1, slLoadedMs = -1, slSendMs = 0, slPeak = 0;

// ── 0.9.2: terminal mode (the init-queue terminal-receipt invariant) ──
// The field evidence (gate run 1, engine 0.9.1): seq 2 and seq 8 logged
// "plugin init queued" and then NOTHING — a jammed init worker had no path
// to a terminal receipt, and later same-set reloads masked the jam by
// answering "plugin set reused". This mode drives all four CI scenarios in
// ONE session (engine env: SCORCH_TESTVST_SLOW_CREATE_N=1 jams ONLY the
// first create for SCORCH_TESTVST_SLOW_CREATE_S=JAM seconds;
// SCORCH_INIT_TERMINAL_TIMEOUT_MS=TIMEOUT*1000 declares stuck requests
// failed; every later create is instant):
//   seq 10  jammed init   → wire plugin_state error (terminal-timeout) at
//                           ~TIMEOUT s; log "init failed: seq=10 reason=
//                           terminal-timeout" + "init pending >10s" warnings;
//   seq 11  bogus path    → queues behind the jam (different set → no fold)
//                           → wire error (queued-behind-jammed-init); log
//                           "init queued >10s";
//   seq 12  clean reload  → loaded + play (the worker recovered after the
//                           jam; the abandoned result was discarded);
//   seq 13  mid-play same-set reload → REUSE, then openEditor(instanceId) —
//                           the editor-reopen-decoupled-from-load proof
//                           (Windows CI opens the real window; headless
//                           tolerates editor_unavailable "no display");
//   seq 14  mid-play reload with "openEditor":true → reuse + the editor
//                           opens from the LOAD-carried intent;
//   seq 20+21 same set back-to-back → 21 FOLDS into 20's in-flight init
//                           (log "init superseded: seq=21 by=20 (coalesced")
//                           — 20 loads, 21 never double-instantiates;
//   seq 40+41 different sets back-to-back → 40 superseded by 41 (the
//                           classic superseded-by-newer-request), 41 fails
//                           (bogus path → "init failed: seq=41").
// The exactly-one terminal receipt per seq is asserted on the engine.log
// side by desktop.yml (per-seq counting over the D5 slice); the wire side
// here proves the request-level outcomes and the editor reopen path.
const TR_JAM_S = parseInt(process.env.SCORCH_INIT_JAM_S ?? "20", 10) || 20;
const TR_TIMEOUT_S = parseInt(process.env.SCORCH_INIT_TIMEOUT_S ?? "12", 10) || 12;
const TR_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 8448 };
const trEvents = [
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 7, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 11, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 480, trackId: "t1" },
  { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 8448, trackId: "t1" },
];
let trPhase = 0;   // 0 hello, 1 scanning, 2 jam loading, 3 awaiting declared
                   // errors, 4 post-jam settle, 5 clean load, 6 playing,
                   // 7-9 editor reopen, 10 stop, 11 fold pair, 12 classic
                   // supersede pair, 13 done
let trScanPlugin = null;
let trJamAckFast = false, trJamErr = false, trQueuedErr = false;
let trCleanLoaded = false, trPlayPeak = 0, trPlayTicks = false, trStopped = false;
let trReuseCount = 0;             // reuse-path loaded receipts for inst-ok (13, 14)
let trEditorOpenOk = false, trEditorCloseOk = false;
let trEditorCarriedOk = false;    // the load-carried openEditor intent
let trHeadlessSkip = false;
let trSuppLoaded = false;         // seq 20 loaded (21 folded into it)
let trBogus2Err = false;          // seq 41 failed (40 superseded by it)
let trJamSendMs = 0, trJamAckMs = -1;
const trPluginBody = () => ({ uid: trScanPlugin.uid, path: trScanPlugin.path, name: trScanPlugin.name });
const trLoad = (seq, extra = {}) => ({
  type: "load", seq, events: trEvents, meta: TR_META, channels: { t1: 1 },
  plugin: trPluginBody(), ...extra,
});
const trBogusBody = () => ({ uid: "", path: "/nonexistent/bogus.vst3", name: "Bogus" });
// Milestone 1 resolves every instance to the reserved id "hosted" — the wire
// assertions below key on the RECEIPT DETAIL and the phase machine, never on
// the (client-invented) instance ids of the field log.

// The fixture's plugin_state latencyMs = (h->latencySamples + 512) / 44100 * 1000
// (the engine's standing receipts formula) — this helper is the EXPECTED value
// for a given corrected slotLatency.
const latLatencyMs = (samples) => (samples + 512) / 44100.0 * 1000.0;

function latEvents(ccVal) {
  const evs = [{ eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 0, trackId: "t1" }];
  if (ccVal === 10) {
    // Stage 3j: the RAPID PAIR — v=1 then v=10 half a second apart. The
    // second enqueue hits the one-per-second rate limit, stays pending, and
    // the engine's safety-net walk lands it ("debounce confirmed" receipt).
    // (A bare v=10 is NOT silent: JUCE's setLatencySamples auto-notifies.)
    evs.push({ eventType: "CONTROL_CHANGE", channel: 1, data1: 23, data2: 1,
               timestampTicks: latLastTick + 960, trackId: "t1" });
    evs.push({ eventType: "CONTROL_CHANGE", channel: 1, data1: 23, data2: 10,
               timestampTicks: latLastTick + 1920, trackId: "t1" });
  } else if (ccVal !== undefined)
    evs.push({ eventType: "CONTROL_CHANGE", channel: 1, data1: 23, data2: ccVal,
               timestampTicks: latLastTick + 960, trackId: "t1" });
  return evs;
}

function latSendLoad(ccVal) {
  latSeq += 1;
  latTickAtLoad[latSeq] = latLastTick;
  console.log(`[test] L: mid-play event load seq ${latSeq} (CC#23 ${ccVal === undefined ? "—" : "v=" + ccVal} at tick ${latLastTick + 960})`);
  ws.send(JSON.stringify({
    type: "load", seq: latSeq, events: latEvents(ccVal), meta: LAT_META,
    plugins: [{ instanceId: "inst-lat", uid: latPlugin.uid, path: latPlugin.path, name: latPlugin.name }],
    routing: { t1: { inst: "inst-lat", ch: 1 } },
  }));
}

// The CC#23 sequence (windows sized so every correction has landed before the
// NEXT load's reuse receipt reads h->latencySamples):
//   +0.5s  v=1  notified 1024   → lands ≤ ~3.2s (flag drain ≤ 2s timer + 100ms job)
//   +5.0s  v=0  notified 0
//   +9.5s  RAPID PAIR v=1+v=10  → 1024 republishes; the 2048 enqueue is
//          rate-limited, stays pending → the 2000 ms safety-net walk lands
//          it ("debounce confirmed") ≤ ~14.5s
//   +17.0s v=20 NOTIFIED FLICKER (40 toggles ≈ 1.9s, settles 1024) → rate-limited
//          publishes + final convergence ≤ ~4.5s post-settle
//   +26.0s probe load (no CC)   → its reuse receipt PROVES the settled 1024
function latRun() {
  console.log("[test] L: transport rolling — driving the CC#23 runtime-latency sequence");
  setTimeout(() => latSendLoad(1), 500);
  setTimeout(() => latSendLoad(0), 5000);
  setTimeout(() => latSendLoad(10), 9500);
  setTimeout(() => latSendLoad(20), 17000);
  setTimeout(() => latSendLoad(undefined), 26000);
  setTimeout(() => { console.log("[test] L: sequence complete — shutdown (engine.log receipts asserted by desktop.yml)"); finishAndShutdown(); }, 30500);
}
// Stage 3f-7: lazy-probe phase machine (silence → explicit-synth →
// explicit-crash → probeAll), the silence deadline, the probeAll receipt
// count, and whether the transport-pause probe ran.
let scanLazyPhase = "silence", scanLazyDeadline = 0, scanProbeAllCount = 0, scanPauseProbed = false;
// 3f-2 — background probe collection: classId → {kind, capabilities|error}
const scanProbes = {};
let scanProbesAsserted = false;
let scanSynthClassId = null, scanCrashClassId = null, scanHangClassId = null;
let postProbePongOk = false;
// host-mode flags + shared collection
let hostScanSent = false, hostPluginStateOk = false, hostPhase = 0;
// Stage 3f-7: the probe receipt (probe-on-load + the editor-pause probe) and
// whether the phase-31 probe was sent while the editor window was open.
let hostProbeReceiptOk = false, hostEditorPauseProbeSent = false;
// Stage 3d-1: editor-window contract flags.
let hostEditorNegOk = false, hostEditorOpenOk = false, hostEditorFocusOk = false, hostEditorCloseOk = false;
let hostHeadlessSkip = false;   // editor_unavailable("no display") tolerated like multi M-7
// Stage 3d-3: state-persistence flags + the playing-peak windows for the
// "state actually APPLIED" proofs. S0 = default capture, S1 = diverged.
let hostStateCaptureOk = false, hostStateRestoreOk = false, hostStateRoundtripOk = false;
let hostStateS0 = "", hostStateS1 = "";
const hostStatePlayStates = [];
const hostStatePlayStates2 = [];
let hostValidUid = "", hostValidPath = "", hostValidName = "";
// Milestone 2: the SECOND fixture identity — the mid-play plugin CHANGE
// (phase H) swaps the hosted binary for THIS one; the diff machinery retires
// the old node and instantiates the new one while the transport rolls.
let hostValidUidB = "", hostValidPathB = "", hostValidNameB = "";
let hostDiffLoadedOk = false;
// Stage 3e-1: capability-handshake collection — EXACTLY ONE plugin_capabilities
// per plugin_state "loaded" receipt (per instance), and the record's facts
// must match the free test VST3 (main out bus "Output", stereo, latency 128,
// instrument, accepts MIDI, editor, no inputs).
const hostCapsCount = {};   // instanceId → plugin_capabilities messages
const hostLoadedCount = {}; // instanceId → plugin_state loaded receipts
let hostFirstCaps = null;   // first capability record (fixture facts, close-time assert)
let hostClassId = "";       // the VST3 class identifier echoed by plugin_state
let hostReloadAckOk = false, hostRejectOk = false, hostPlayingAfterReject = false;
const hostEntries = [];   // accumulated dispatch ledger entries
const hostStates = [];    // {tick, peak} while playing (tick-correlated)
let hostPeakA = 0, hostPeakB = 0, hostPeakC = 0;   // assertion results
let hostLatency = 0, hostDeltaSamples = 0;
let hostStopTick1 = 0, hostStopTick2 = 0;          // 3c close-out stop positions
let hostReleaseWait = 0;                           // ledger-arrival wait (observation race)
// ── Milestone 1: the x10 clean unload/reload cycle (the lifetime gate) ──
// Each cycle: {"plugins": []} unload (state captured first) -> the editor
// probe answers editor_unavailable (the unload WIRE proof: nothing hosted)
// -> a fresh load -> a FRESH plugin_state loaded (new instance). Ten of
// them, then one final editor round-trip + play + dispatch proof.
const HOST_CYCLES = 10;
let hostCycIdx = 0;            // completed reloads
let hostCycPhase = 0;          // 0 idle | 1 unloading | 2 probing | 3 reloading
let hostCycEditorTries = 0;
let hostCycUnloadOk = 0, hostCycReloadOk = 0;
let hostCycEdOpen = false, hostCycEdClose = false;
let hostCycPlayOk = false, hostCycAdvOk = false, hostCycDispatch = 0, hostCycStopOk = false;

function hostCycleSendUnload() {
  hostCycPhase = 1;
  // The unload ride-along: a valid score (the engine's load gate parses
  // events before hosting) + the EXPLICIT empty plugins[] array = host zero.
  setTimeout(() => {
    ws.send(JSON.stringify({ type: "load", seq: 10000 + hostCycIdx * 10,
      events: HOST_EVENTS, meta: HOST_META, plugins: [] }));
    // The unload runs on the engine's async worker (worker-side state
    // capture first — the M1-hotfix moved it off the message thread — then
    // the message-thread job: editor close -> vendor removeNode). The editor
    // probe below is the
    // wire proof it landed; poll-retry absorbs the queue latency.
    // STALE-TIMER GUARD (the cycle-11 CI wedge): when the unload lands fast,
    // the machine moves on (reload -> the final editor round-trip + play
    // proof) — a probe timer firing after that must NOT re-arm phase 2 mid-
    // proof (it would re-open an editor over a ROLLING transport and the
    // retry loop can never see editor_unavailable, because nothing was
    // unloaded). Only arm the probe if the machine still waits for it.
    const cycleAtSend = hostCycIdx;
    setTimeout(() => {
      if (hostCycPhase !== 1 || hostCycIdx !== cycleAtSend) return;
      hostCycPhase = 2; hostCycEditorTries = 0;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
    }, 700);
  }, 120);
}
function hostCycleReload() {
  hostCycPhase = 3;
  ws.send(JSON.stringify({ type: "load", seq: 10001 + hostCycIdx * 10,
    events: HOST_EVENTS, meta: HOST_META, channels: { t1: 1, t2: 2 },
    plugin: { uid: hostValidUid, path: hostValidPath, name: hostValidName } }));
}

// Stage 3c close-out — MUSICAL STOP proof: at the stop tick the ledger must
// carry the release marker (ch=0 CC123 semantics — distinct from panic/mute
// CC120) and EXACT note-offs for the notes the engine HOLDS AT THAT STOP, and
// NONE for the never-dispatched gated pitch 62 (gating × release interaction).
// No CC120 may appear at/after the stop (instant kill is panic-only now).
// expectedHeld: stop 1 holds ONLY the post-unmute late note (the mute flush's
// CC120 genuinely killed 60/64 — the ledger must agree); stop 2 holds all
// three (the resume re-attacked them).
function assertHostRelease(stopTick, which, expectedHeld, forbidGated62) {
  const dump = hostEntries.filter((e) => e.c === 0 || e.k === 0)
    .slice(-24).map((e) => `k${e.k}/c${e.c}/a${e.a}/t${e.t}/s${e.s}`).join(" | ");
  const marker = hostEntries.find((e) => e.k === 2 && e.a === 123 && e.c === 0 && e.t === stopTick);
  if (!marker) fail(`stop ${which}: no musical-release marker (ch=0 CC123) at tick ${stopTick} — stop is not musical (last ch0/noteoff records: ${dump})`);
  for (const [ch, pitch] of expectedHeld) {
    const off = hostEntries.find((e) => e.k === 0 && e.c === ch && e.a === pitch && e.t === stopTick);
    if (!off) fail(`stop ${which}: no release NOTE_OFF for held note ch${ch} pitch ${pitch} at tick ${stopTick} — the plugin was amputated, not released`);
  }
  // Stop 1 only: pitch 62 was gated (never dispatched) and not yet resumed —
  // it cannot be held. By stop 2 the resume legitimately re-attacked it
  // (unmute restores audibility — same contract as the phase-C late note).
  if (forbidGated62 && hostEntries.some((e) => e.k === 0 && e.c === 1 && e.a === 62))
    fail("stop: release NOTE_OFF for pitch 62 — a never-dispatched (gated) note cannot be held");
  if (hostEntries.some((e) => e.k === 2 && e.a === 120 && e.t >= stopTick))
    fail(`stop ${which}: CC120 All-Sound-Off dispatched at/after the stop tick — instant kill is panic-only`);
}

// Stage 3c close-out — RESUME proof: straddling notes re-attack GENTLY (vel
// 80, sample 0, at the resume tick), a redundant CC#32 (same value the
// channel is already in) is SUPPRESSED (ledger kind 6), and a genuine change
// is SENT — all at their latency-compensated dispatch positions.
function assertResumeLedger() {
  const spt = 44100 * 60 / (120 * 960);
  const PLUGIN_LATENCY = 128;
  const dispatchTick = (gridTick) => Math.round((Math.floor(gridTick * spt) - PLUGIN_LATENCY) / spt);
  // Gentle re-attacks of the straddling held notes, at the resume tick
  // (= stop 1's tick). Pitch 62 (gated at its grid time, audible again after
  // the unmute) re-attacks too — the straddle scan works on the authored
  // score; the CURRENT mute state decides audibility (the same unmute-
  // restores-sound contract as phase C).
  // Phase 2 (downbeat-late pre-roll): the resume is a transport re-start —
  // the re-attacks PRE-FIRE into the muted pre-roll window at
  // s = -PLUGIN_LATENCY (the play-time max latency the play handler
  // snapshot), e.t clamps to the start tick (the position never precedes
  // it), and the audible attacks land exactly on the resume grid.
  for (const [ch, pitch] of [[1, 60], [1, 62], [2, 64], [2, 67]]) {
    const re = hostEntries.find((e) => e.k === 1 && e.c === ch && e.a === pitch && e.b === 80 && e.s === -PLUGIN_LATENCY && e.t === hostStopTick1);
    if (!re) fail(`resume: no GENTLE re-attack of ch${ch} pitch ${pitch} (vel 80, s=${-PLUGIN_LATENCY}, t=${hostStopTick1}) — straddling sustain not resumed (or the downbeat pre-roll is broken)`);
  }
  // No replay burst: NO past event may re-dispatch at the resume transport.
  // The pre-resume note-ons (480/960/6144... plus the ORIGINAL vel-100 sends)
  // must not reappear at the resume tick — Phase 2: scoped by TICK, because
  // a resurrection inside the muted pre-roll window would carry a NEGATIVE
  // e.s and the old s===0 scope would miss it.
  const burst = hostEntries.filter((e) => e.t === hostStopTick1 && e.b === 100);
  if (burst.length > 0) fail(`resume: ${burst.length} FULL-VELOCITY events re-dispatched at the resume tick ${hostStopTick1} — the replay burst is back`);
  // Redundant CC#32 suppressed (ledger kind 6) at its compensated position.
  const suppressed = hostEntries.find((e) => e.k === 6 && e.c === 1 && e.a === 32 && e.b === 42 && e.t === dispatchTick(7200));
  if (!suppressed) fail(`resume: CC#32=42@7200 was not SUPPRESSED (expected a kind-6 record at t=${dispatchTick(7200)}) — the bow-scrape pluck is back`);
  // Genuine change SENT at its compensated position.
  const sent = hostEntries.find((e) => e.k === 2 && e.c === 1 && e.a === 32 && e.b === 20 && e.t === dispatchTick(7600));
  if (!sent) fail(`resume: genuine CC#32 change (42→20) not dispatched at t=${dispatchTick(7600)} — articulation suppression is over-eager`);
  console.log(`[test] resume ✓ 3 gentle re-attacks (vel 80 @ s=${-PLUGIN_LATENCY} pre-fired, t=${hostStopTick1}); CC#32=42@7200 SUPPRESSED (k=6); genuine CC#32=20@7600 SENT`);
}

// Tick-correlated phase assertions (latency-immune): the mute flush leaves a
// ch=0 CC120 marker in the ledger; peaks are only compared within windows
// defined by ENGINE TICKS on either side of that marker.
function assertHostWindows() {
  const flush = hostEntries.find((e) => e.k === 2 && e.a === 120 && e.c === 0 && e.t > 200);
  if (!flush) fail("no mute-flush marker in the dispatch ledger (flush not recorded or gating never applied)");
  console.log(`[test] mute flush marker at tick ${flush.t}`);
  const SLACK = 128;  // ~2 state frames of tick slack around the marker
  // Phase A — UNMUTED window [200, flush−SLACK): the hosted plugin is audible.
  const before = hostStates.filter((s) => s.tick >= 200 && s.tick < flush.t - SLACK);
  hostPeakA = before.reduce((m, s) => Math.max(m, s.peak), 0);
  if (hostPeakA < 0.05) fail(`phase A: peak ${hostPeakA} while unmuted (ticks 200..${flush.t - SLACK}) — hosted plugin not audible`);
  // Phase B — MUTED window [flush+SLACK, 5200): silence + the gated note
  // (t=3840, scheduled INSIDE the window) must NEVER dispatch. Stage 3c-polish
  // F4: dispatch positions shift EARLIER by the plugin's reported latency, so
  // the gate proof is asserted by PITCH (d1=62) anywhere in the ledger —
  // shift-proof by construction.
  const during = hostStates.filter((s) => s.tick >= flush.t + SLACK && s.tick < 5200);
  hostPeakB = during.reduce((m, s) => Math.max(m, s.peak), 0);
  if (hostPeakB >= 0.02) fail(`phase B: peak ${hostPeakB} while muted (ticks ${flush.t + SLACK}..5200) — mute is not audible (gating broken)`);
  // The muted-window note (pitch 62, on@3840) must never dispatch INSIDE the
  // muted window. (Pre-3c-close-out this assert read e.d1 — a field the ledger
  // JSON never carried — so it was a silent no-op; the field is `a`, and the
  // window is scoped by tick because the close-out resume legitimately
  // re-attacks this note LATER, after the unmute.)
  if (hostEntries.some((e) => e.k === 1 && e.c === 1 && e.a === 62 && e.t >= flush.t + SLACK && e.t < 5200))
    fail("the muted-window note (pitch 62) WAS dispatched inside the muted window — gating does not run before the channel send");
  console.log(`[test] phase A ✓ unmuted peak=${hostPeakA.toFixed(3)}; phase B ✓ muted peak=${hostPeakB.toFixed(3)}, muted-window note gated`);
  // Phase C — after unmute the late note (grid t=6144, ch2) must dispatch + sound.
  // Stage 3c-polish F4: the ledger's t is the DISPATCH-time tick — shifted
  // earlier by the plugin latency for plugin-routed events.
  const spt = 44100 * 60 / (120 * 960);  // 22.96875 samples/tick
  const PLUGIN_LATENCY = 128;            // ScorchTestSynth setLatencySamples(128)
  const dispatchTick = (gridTick) => Math.round((Math.floor(gridTick * spt) - PLUGIN_LATENCY) / spt);
  const lateNote = hostEntries.find((e) => e.k === 1 && e.c === 2 && e.t === dispatchTick(6144));
  if (!lateNote) fail(`phase C: late note (grid t=6144, ch2) not in dispatch ledger at compensated t=${dispatchTick(6144)} — unmute did not restore audibility`);
  const after = hostStates.filter((s) => s.tick >= 6144 + 192 && s.tick < 6900);
  hostPeakC = after.reduce((m, s) => Math.max(m, s.peak), 0);
  if (hostPeakC < 0.05) fail(`phase C: peak ${hostPeakC} after unmute — late note not audible`);
  console.log(`[test] phase C ✓ late note dispatched + audible (peak=${hostPeakC.toFixed(3)})`);
  // UACC pre-trigger arithmetic: CC#32 exactly 38 ticks before its note —
  // BOTH are plugin-routed so the DELTA is shift-invariant.
  const cc32 = hostEntries.find((e) => e.k === 2 && e.a === 32 && e.c === 1);
  const note1 = hostEntries.find((e) => e.k === 1 && e.c === 1 && e.t === dispatchTick(480));
  if (!cc32) fail("dispatch ledger has no CC#32 articulation switch");
  if (!note1) fail(`dispatch ledger has no ch1 NOTE_ON at compensated t=${dispatchTick(480)}`);
  if (cc32.t !== dispatchTick(442)) fail(`CC#32 must dispatch at the compensated t=${dispatchTick(442)} (480 − 38 pre-trigger ticks, shifted by the plugin latency), got t=${cc32.t}`);
  hostDeltaSamples = note1.s - cc32.s;
  if (Math.abs(hostDeltaSamples - 38 * spt) > 1.5) fail(`pre-trigger sample delta ${hostDeltaSamples} ≠ 38 ticks (${38 * spt}) — scheduling not sample-accurate`);
  // Stage 3c-polish F4 — LATENCY COMPENSATION ARITHMETIC (exact): a
  // plugin-routed event at grid tick 480 must dispatch at EXACTLY
  // floor(480·spt) − 128 samples (sample-accurate, shifted by the reported
  // plugin latency so the audible attack lands on the grid).
  const expectedNoteSample = Math.floor(480 * spt) - PLUGIN_LATENCY;  // 11025 − 128 = 10897
  if (note1.s !== expectedNoteSample) fail(`latency compensation arithmetic broken: ch1 NOTE_ON dispatched at s=${note1.s}, expected EXACTLY ${expectedNoteSample} (grid ${Math.floor(480 * spt)} − ${PLUGIN_LATENCY} plugin latency)`);
  console.log(`[test] F4 latency compensation ✓ note dispatched at s=${note1.s} = grid ${Math.floor(480 * spt)} − ${PLUGIN_LATENCY} (plugin-reported latency)`);
  // Channel routing: ch2 dispatched into the hosted plugin (compensated tick).
  if (!hostEntries.some((e) => e.k === 1 && e.c === 2 && e.t === dispatchTick(960))) fail(`dispatch ledger has no ch2 NOTE_ON at compensated t=${dispatchTick(960)} — channel routing broken`);
  console.log(`[test] pre-trigger ✓ CC#32@t=${cc32.t} (s=${cc32.s}) → note@t=${note1.t} (s=${note1.s}), delta=${hostDeltaSamples} samples (${(hostDeltaSamples / 44.1).toFixed(2)}ms ≈ 20ms profile pre-trigger)`);
  console.log("[test] channel routing ✓ ch1 + ch2 dispatched into the hosted plugin");
}
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
  // Stage 3c close-out — articulation-aware resume: a REDUNDANT CC#32 (the
  // channel is already in 42 from the tick-442 switch) must be SUPPRESSED on
  // the resumed transport, and a GENUINE change (42 → 20) must be SENT. Both
  // sit AFTER the phase-C stop point (~6900) so pass 1 never reaches them.
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 32, data2: 42, timestampTicks: 7200, trackId: "t1", isArticulationSwitch: true },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 32, data2: 20, timestampTicks: 7600, trackId: "t1", isArticulationSwitch: true },
];
const HOST_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 8448 };

// Stage 3e-3 — MULTI-OUTPUT proof score: CC7/CC11 fader, CC21=127 NORMALIZES
// the fixture's masterScale (a JUCE module may carry the inner processor's
// state across host instantiates within one engine process — the phase-15
// diverged state would otherwise leak in; the score-owned CC21 makes the
// phase deterministic either way), CC#22 ARMS the fixture's aux bus, one
// sustained note. The aux bus emits a DISTINCT CONSTANT 0.25 per sample
// while armed + sounding: default routing → master peak ≈ (0.5·100/127 +
// 0.25)·2.0 ≈ 1.287 (main + aux summed); aux muted via outputRouting →
// master peak ≈ 0.787 (main only).
const MO_EVENTS = [
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 7, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 11, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 21, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 22, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 480, trackId: "t1" },
  { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 8448, trackId: "t1" },
];
const MO_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 8448 };
const moPeaksDefault = [];   // routing ABSENT → every bus sums to master
const moPeaksMuted = [];     // outputRouting [{busIndex:1, mute:true}] → main only

function finishAndShutdown() {
  console.log("[test] sending shutdown");
  ws.send(JSON.stringify({ type: "shutdown" }));
}

ws.addEventListener("open", () => {
  console.log(`[test] connected to ws://127.0.0.1:${port} (mode=${mode}), waiting for hello...`);
});

ws.addEventListener("message", (event) => {
  let msg;
  try {
    msg = JSON.parse(event.data);
  } catch (parseErr) {
    // A malformed engine frame is itself a defect — dump the RAW bytes so
    // the serializer bug is visible, then fail.
    console.error(`[test] MALFORMED ENGINE FRAME (${parseErr.message}):`);
    console.error(event.data);
    throw parseErr;
  }
  console.log("[test] RX:", JSON.stringify(msg).slice(0, 140));
  step++;

  if (mode === "multi") {
    // ── Milestone 2: the multi-instance + diff machine (see the header) ──
    if (msg.type === "plugin_state" && msg.state === "loaded") {
      const iid = msg.instanceId || "hosted";
      multiLoadedCount[iid] = (multiLoadedCount[iid] ?? 0) + 1;
      for (const entry of multiExpect) {
        if (entry.set.has(iid)) {
          entry.set.delete(iid);
          if (entry.set.size === 0) multiSeqComplete(entry.seq);
          break;
        }
      }
    } else if (msg.type === "plugin_capabilities") {
      const iid = msg.instanceId || "hosted";
      multiCapsCount[iid] = (multiCapsCount[iid] ?? 0) + 1;
    }
    if (msg.type === "hello" && multiPhase === 0) {
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.10.0") fail(`expected 0.10.0, got ${msg.engineVersion}`);
      if (!fixtureDir) fail("multi mode requires a fixture dir argument");
      console.log("[test] hello OK (0.10.0) — M2 multi-instance: scanning for BOTH fixture identities...");
      multiPhase = 1;
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && multiPhase === 1) {
      multiScanPlugin = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth");
      multiScanPluginB = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth B");
      if (!multiScanPlugin || !multiScanPluginB) fail(`multi mode: BOTH identities required (A="Scorch Test Synth", B="Scorch Test Synth B"), got ${JSON.stringify(msg.plugins)}`);
      console.log(`[test] identities: A uid=${multiScanPlugin.uid} | B uid=${multiScanPluginB.uid} — loading THREE instances (seq 1)`);
      multiPhase = 2;
      ws.send(JSON.stringify({ type: "dispatch_log", enable: true }));
      multiSendLoad(1, [
        { instanceId: "inst-a", ...multiA() },
        { instanceId: "inst-b", ...multiA() },
        { instanceId: "inst-c", ...multiA() },
      ], ["t1", "t2", "t3"]);
    } else if (msg.type === "dispatch" && multiPhase >= 2) {
      for (const e of msg.entries ?? []) {
        multiLedger.push(e);
        if (e.k === 1) multiWide[e.c] = (multiWide[e.c] ?? 0) + 1;   // NOTE_ONs per WIDE channel (ledger field: c)
      }
    } else if (msg.type === "error") {
      if (msg.code === "editor_unavailable") {
        // headless tolerance (the M-7 contract): the window phases skip.
        multiHeadlessSkip = true;
        console.log(`[test] editor_unavailable tolerated (headless host): "${msg.detail}"`);
        if (multiPhase >= 13) multiEditorPhase(true);
        return;
      }
      fail(`multi: unexpected error: ${JSON.stringify(msg)}`);
    } else if (msg.type === "loadAck") {
      multiAckSeqs.add(msg.seq);
    } else if (msg.type === "state") {
      multiPeak = Math.max(multiPeak, msg.peak ?? 0);
      if (multiPhase === 3 && msg.playing && msg.tick >= 1600) {
        if (multiPeak <= 1.0) fail(`multi: summed peak ${multiPeak.toFixed(3)} — three instances must exceed the single-source cap (~0.79)`);
        for (const c of [1, 17, 33]) if (!multiWide[c]) fail(`multi: no NOTE_ON dispatched on wide channel ${c} — per-instance routing broken (got ${JSON.stringify(multiWide)})`);
        console.log(`[test] phase M2-2 ✓ 3 instances audible + routed (peak ${multiPeak.toFixed(3)}, wide c=1/17/33 all present) — mid-play DIFF: inst-b → Synth B (seq 2)`);
        multiPhase = 4;
        multiSendLoad(2, [
          { instanceId: "inst-a", ...multiA() },
          { instanceId: "inst-b", ...multiB() },   // CHANGED binary
          { instanceId: "inst-c", ...multiA() },
        ], ["t1", "t2", "t3"]);
      } else if (multiPhase === 5 && msg.playing && msg.tick >= 2000) {
        console.log("[test] phase M2-3 ✓ diff applied while rolling (kept 2, changed 1) — mid-play ADD: inst-d (seq 3)");
        multiPhase = 6;
        multiSendLoad(3, [
          { instanceId: "inst-a", ...multiA() },
          { instanceId: "inst-b", ...multiB() },
          { instanceId: "inst-c", ...multiA() },
          { instanceId: "inst-d", ...multiA() },   // ADDED
        ], ["t1", "t2", "t3", "t4"]);
      } else if (multiPhase === 7 && msg.playing && msg.tick >= 3400) {
        if (!multiWide[49]) fail(`multi: inst-d added but no NOTE_ON on wide channel 49 (got ${JSON.stringify(multiWide)})`);
        console.log("[test] phase M2-4 ✓ instance ADDED mid-play (kept 3, added 1; wide c=49 live) — mid-play PARTIAL UNLOAD: drop inst-c (seq 4)");
        multiPhase = 8;
        multiSendLoad(4, [
          { instanceId: "inst-a", ...multiA() },
          { instanceId: "inst-b", ...multiB() },
          { instanceId: "inst-d", ...multiA() },
        ], ["t1", "t2", "t4"]);
      } else if (multiPhase === 9 && msg.playing && msg.tick >= 3800) {
        if ((msg.peak ?? 0) <= 0.35) fail(`multi: survivors' peak ${(msg.peak ?? 0).toFixed(3)} — the survivors must keep sounding through the partial unload (one live voice ≈ 0.394; a dead mix is 0.0)`);
        console.log("[test] phase M2-5 ✓ partial unload (kept 3, removed 1; survivors untouched) — score edit seq 5: SAME set, EXACT match → reuse fast path");
        multiPhase = 10;
        const seq5 = [
          { instanceId: "inst-a", ...multiA() },
          { instanceId: "inst-b", ...multiB() },
          { instanceId: "inst-d", ...multiA() },
        ];
        multiExpect.push({ seq: 5, set: new Set(seq5.map((p) => p.instanceId)) });
        ws.send(JSON.stringify({
          type: "load", seq: 5,
          events: multiEventsFor(["t1", "t2", "t4"])
            .map((e) => (e.trackId === "t1" && e.eventType === "NOTE_ON" ? { ...e, data2: 80 } : e)),   // the score edit
          meta: MULTI_META,
          plugins: seq5,
          routing: { t1: { inst: "inst-a", ch: 1 }, t2: { inst: "inst-b", ch: 1 }, t4: { inst: "inst-d", ch: 1 } },
        }));
      } else if (multiPhase === 11 && msg.playing === false) {
        console.log("[test] phase M2-6 ✓ score-edit reload reused the set (zero diff) + clean stop — editor phases next");
        multiPhase = 13;
        multiEditorPhase(false);
      }
    } else if (msg.type === "editorOpened" && multiPhase === 14 && !multiEdOpenA) {
      multiEdOpenA = true;
      console.log(`[test] M2-7 ✓ inst-a editor OPENED (${msg.width}x${msg.height}) — opening inst-b (a SECOND SIMULTANEOUS window)`);
      multiPhase = 15;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "inst-b" }));
    } else if (msg.type === "editorOpened" && multiPhase === 15 && !multiEdOpenB) {
      multiEdOpenB = true;
      console.log(`[test] M2-7 ✓ inst-b editor OPENED (TWO simultaneous windows) — repeat openEditor inst-a (must RAISE, not duplicate)`);
      multiPhase = 16;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "inst-a" }));
    } else if (msg.type === "editorOpened" && multiPhase === 16 && msg.instanceId === "inst-a" && multiEdOpenA && multiEdOpenB) {
      // The RAISE echo (focused:true) — a repeat request for an open window.
      multiEdFocus = true;
      console.log("[test] M2-7 ✓ repeat openEditor RAISED inst-a (focused:true) — closing by id");
      multiPhase = 17;
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "inst-a" }));
    } else if (msg.type === "editorClosed" && msg.instanceId === "inst-a" && multiPhase === 17) {
      multiEdCloseA = true;
      console.log("[test] M2-7 ✓ inst-a editor CLOSED — closing inst-b");
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "inst-b" }));
    } else if (msg.type === "editorClosed" && msg.instanceId === "inst-b" && multiEdCloseA && !multiEdCloseB) {
      multiEdCloseB = true;
      console.log("[test] M2-7 ✓ inst-b editor CLOSED — per-instance captures next");
      multiCapIds.clear();
      multiPhase = 18;
      ws.send(JSON.stringify({ type: "captureState" }));
    } else if (msg.type === "pluginSavedState") {
      if (msg.state === "too_large") fail(`multi: fixture state cannot be too_large (${msg.instanceId})`);
      if (msg.instanceId) multiCapIds.add(msg.instanceId);
      if (multiPhase >= 18 && ["inst-a", "inst-b", "inst-d"].every((id) => multiCapIds.has(id))) {
        console.log(`[test] M2-8 ✓ one pluginSavedState PER live instance (${[...multiCapIds].join(", ")}) — shutting down`);
        finishAndShutdown();
      }
    }
  } else if (mode === "slowload") {
    // ── M1-hotfix: the heavy-load death class (see the state block above) ──
    if (msg.type === "hello" && slPhase === 0) {
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.10.0") fail(`expected 0.9.2, got ${msg.engineVersion}`);
      if (!fixtureDir) fail("slowload mode requires a fixture dir argument");
      helloOk = true;
      console.log(`[test] hello OK (0.10.0) — slow-load knobs: create=${SLOW_CREATE_S}s prepareN=${process.env.SCORCH_TESTVST_SLOW_PREPARE_N ?? 0}(x${SLOW_PREPARE_S}s) — scanning...`);
      slPhase = 1;
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && slPhase === 1) {
      const valid = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`slowload: stand-in plugin not found in scan (${JSON.stringify(msg.plugins)})`);
      slScanPlugin = valid;
      console.log(`[test] stand-in found: "${valid.name}" — loading with the slow-create/slow-prepare knobs armed (seq 1)`);
      slPhase = 2;
      slSendMs = Date.now();
      ws.send(JSON.stringify({
        type: "load",
        seq: 1,
        events: slowEvents,
        meta: SLOW_META,
        channels: { t1: 1 },
        plugin: { uid: valid.uid, path: valid.path, name: valid.name },
      }));
    } else if (msg.type === "loadAck" && slPhase === 2 && msg.seq === 1) {
      slAckMs = Date.now() - slSendMs;
      slAckOk = slAckMs < 3000;
      if (!slAckOk) fail(`slowload: loadAck arrived after ${slAckMs} ms — the async ack contract is broken (loadAck is the ENQUEUE receipt; it must arrive while the fixture constructor is still sleeping ${SLOW_CREATE_S}s)`);
      console.log(`[test] loadAck OK after ${slAckMs} ms (< 3000 ms; the fixture constructor is still sleeping) — awaiting plugin_state loaded`);
    } else if (msg.type === "plugin_state" && slPhase === 2 && msg.state === "loaded" && msg.instanceId === "hosted") {
      slLoadedMs = Date.now() - slSendMs;
      if (SLOW_TOTAL_MS > 0 && slLoadedMs < SLOW_TOTAL_MS)
        fail(`slowload: plugin_state loaded arrived after ${slLoadedMs} ms — expected >= ${SLOW_TOTAL_MS} ms (create ${SLOW_CREATE_S}s + prepare ${SLOW_PREPARE_S}s must actually run on the worker)`);
      slLoadedOk = true;
      console.log(`[test] plugin_state LOADED after ${slLoadedMs} ms (>= ${SLOW_TOTAL_MS} ms floor) — the 12 s init ran to completion — playing`);
      slPhase = 3;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "plugin_state" && slPhase === 2 && msg.state === "error") {
      fail(`slowload: the slow load produced an ERROR receipt: ${msg.detail}`);
    } else if (msg.type === "state" && slPhase === 3 && msg.playing) {
      slPeak = Math.max(slPeak, msg.peak ?? 0);
      if (msg.tick >= 1200) {
        if (slPeak <= 0.05) fail(`slowload: peak ${slPeak.toFixed(3)} after the 12 s load — nothing audible (the plugin did not survive its own slow init)`);
        slPlayOk = true;
        slTicksOk = true;
        console.log(`[test] play ✓ tick ${msg.tick} advanced, peak ${slPeak.toFixed(3)} — engine alive behind the heavy load — stopping`);
        slPhase = 4;
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      }
    } else if (msg.type === "state" && slPhase === 4 && msg.playing === false) {
      slStopOk = true;
      console.log("[test] stop ✓ clean — slowload contract complete (engine.log [mm]-receipt absence asserted by desktop.yml)");
      finishAndShutdown();
    }
  } else if (mode === "terminal") {
    // ── 0.9.2: the init-queue terminal-receipt invariant (see the state block) ──
    if (msg.type === "hello" && trPhase === 0) {
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.10.0") fail(`expected 0.9.2, got ${msg.engineVersion}`);
      if (!fixtureDir) fail("terminal mode requires a fixture dir argument");
      helloOk = true;
      console.log(`[test] hello OK (0.10.0) — terminal-receipt knobs: jam=${TR_JAM_S}s timeout=${TR_TIMEOUT_S}s — scanning...`);
      trPhase = 1;
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && trPhase === 1) {
      const valid = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`terminal: stand-in plugin not found in scan (${JSON.stringify(msg.plugins)})`);
      trScanPlugin = valid;
      console.log(`[test] stand-in found: "${valid.name}" — sending the JAMMED load (seq 10, create sleeps ${TR_JAM_S}s)`);
      trPhase = 2;
      trJamSendMs = Date.now();
      ws.send(JSON.stringify(trLoad(10)));
    } else if (msg.type === "loadAck" && trPhase === 2 && msg.seq === 10) {
      trJamAckMs = Date.now() - trJamSendMs;
      trJamAckFast = trJamAckMs < 3000;
      if (!trJamAckFast) fail(`terminal: the jammed load's loadAck arrived after ${trJamAckMs} ms — the async ack contract is broken (the fixture constructor is sleeping ${TR_JAM_S}s; loadAck is the ENQUEUE receipt)`);
      console.log(`[test] jammed load's loadAck OK after ${trJamAckMs} ms (< 3000; the worker is jammed inside createPluginInstance) — queueing the bogus-path load behind it (seq 11)`);
      trPhase = 3;
      ws.send(JSON.stringify({
        type: "load", seq: 11, events: trEvents, meta: TR_META, channels: { t1: 1 },
        plugin: trBogusBody(),
      }));
      // The watchdog's declarations arrive at ~TIMEOUT s (both in one sweep).
      setTimeout(() => {
        if (trPhase === 3 && (!trJamErr || !trQueuedErr))
          fail(`terminal: the watchdog's terminal declarations never arrived (jamErr=${trJamErr} queuedErr=${trQueuedErr} after ${TR_TIMEOUT_S + 8}s)`);
      }, (TR_TIMEOUT_S + 8) * 1000);
    } else if (msg.type === "plugin_state" && msg.state === "error" && trPhase === 3) {
      if (/terminal-timeout/.test(msg.detail ?? "")) {
        trJamErr = true;
        console.log(`[test] seq 10 declared failed by the watchdog ✓ (wire error: "${msg.detail}")`);
      } else if (/queued-behind/.test(msg.detail ?? "")) {
        trQueuedErr = true;
        console.log(`[test] seq 11 (queued behind the jam) declared failed ✓ (wire error: "${msg.detail}")`);
        // The jam ends at ~TR_JAM_S + start; the errors arrive at ~TR_TIMEOUT_S
        // + start. Settle past the jam end (+ the worker's abandon/skip pass),
        // then run the clean reload.
        const settleMs = Math.max(1000, (TR_JAM_S - TR_TIMEOUT_S) * 1000 + 2500);
        console.log(`[test] settling ${Math.round(settleMs / 1000)}s past the jam end before the clean reload...`);
        setTimeout(() => {
          if (trPhase === 3 && trJamErr && trQueuedErr) {
            trPhase = 4;
            console.log("[test] sending the CLEAN reload (seq 12) — the worker recovered from the jam");
            ws.send(JSON.stringify(trLoad(12)));
          }
        }, settleMs);
      }
    } else if (msg.type === "plugin_state" && msg.state === "loaded" && msg.instanceId === "hosted" && trPhase <= 9) {
      if (trPhase === 4) {
        trCleanLoaded = true;
        console.log("[test] clean reload LOADED ✓ — the jammed worker recovered and the abandoned result was discarded — playing");
        trPhase = 6;
        ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
      } else if (trPhase === 6 || trPhase === 7 || trPhase === 8 || trPhase === 8.5) {
        // The mid-play reuse receipts (seq 13, then seq 14). Each one is
        // followed by editor work; the LAST one must not re-trigger.
        trReuseCount += 1;
        if (trReuseCount === 1) {
          trPhase = 7;
          console.log("[test] mid-play reload answered REUSED ✓ — sending openEditor: the editor reopen decoupled from load");
          ws.send(JSON.stringify({ type: "openEditor" }));
        } else if (trReuseCount === 2) {
          trPhase = 9;
          console.log("[test] load-carried openEditor (seq 14) reuse receipt ✓ — the editor was requested by the LOAD itself");
          // The editorOpened for the carried intent arrives next (phase 9).
        }
      } else {
        fail(`terminal: unexpected early-phase loaded receipt in phase ${trPhase}`);
      }
    } else if (msg.type === "state" && msg.playing === true && trPhase === 6) {
      trPlayPeak = Math.max(trPlayPeak, msg.peak ?? 0);
      // The score's note-on sits at tick 480 — read the peak at 1200 (the
      // slowload floor) so the note is actually sounding when we assert.
      if (msg.tick >= 1200 && !trPlayTicks) {
        if (trPlayPeak <= 0.05) fail(`terminal: peak ${trPlayPeak.toFixed(3)} after the clean reload — nothing audible (the plugin did not survive the jam window)`);
        trPlayTicks = true;
        console.log(`[test] play ✓ tick ${msg.tick} advanced, peak ${trPlayPeak.toFixed(3)} — sending the mid-play SAME-set reload (seq 13, expect REUSED)`);
        ws.send(JSON.stringify(trLoad(13)));
      }
    } else if (msg.type === "editorOpened" && trPhase === 7) {
      if (msg.focused === true) fail(`terminal: the first openEditor must OPEN, not focus: ${JSON.stringify(msg)}`);
      trEditorOpenOk = true;
      console.log(`[test] editor OPENED after "reused" ✓ (${msg.width}x${msg.height}) — the reopen is decoupled from load — closing`);
      trPhase = 8;
      ws.send(JSON.stringify({ type: "closeEditor" }));
    } else if (msg.type === "editorClosed" && trPhase === 8) {
      trEditorCloseOk = true;
      console.log("[test] editor CLOSED ✓ — sending the load-carried openEditor reload (seq 14, openEditor:true, mid-play reuse)");
      trPhase = 8;
      ws.send(JSON.stringify(trLoad(14, { openEditor: true })));
      // The seq-14 reuse receipt (phase 9 branch) then editorOpened (below).
      trPhase = 8.5;
    } else if (msg.type === "editorOpened" && trPhase === 9) {
      trEditorCarriedOk = true;
      console.log("[test] editor OPENED from the load-carried intent ✓ (reuse path honored openEditor:true) — closing");
      ws.send(JSON.stringify({ type: "closeEditor" }));
      setTimeout(() => {
        if (!trStopped) {
          console.log("[test] stopping the transport for the supersede pairs");
          ws.send(JSON.stringify({ type: "transport", command: "stop" }));
        }
      }, 300);
    } else if (msg.type === "error" && msg.code === "editor_unavailable" && (trPhase === 7 || trPhase === 9) && !trEditorOpenOk) {
      // Headless tolerance — SAME contract as host/multi: a display-less host
      // cannot create a window; the display guard answers editor_unavailable
      // ("no display …"). Windows CI has a real display and proves the open
      // path — this branch never fires there.
      if (!/no display/i.test(msg.detail ?? "")) fail(`terminal: unexpected editor_unavailable detail: ${msg.detail}`);
      trHeadlessSkip = true;
      console.log(`[test] editor_unavailable tolerated ("${msg.detail}") — headless; Windows CI proves the window path`);
      if (trPhase === 7) {
        trPhase = 8.5;
        ws.send(JSON.stringify(trLoad(14, { openEditor: true })));
      } else {
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      }
    } else if (msg.type === "state" && msg.playing === false && (trPhase === 9 || trPhase === 8.5) && !trStopped) {
      trStopped = true;
      console.log("[test] transport stopped ✓ — sending the COALESCING pair (seq 20 then 21, SAME set back-to-back)");
      trPhase = 11;
      ws.send(JSON.stringify(trLoad(20)));
      ws.send(JSON.stringify(trLoad(21)));   // must FOLD into 20's init
    } else if (msg.type === "plugin_state" && msg.state === "loaded" && msg.instanceId === "hosted" && trPhase === 11) {
      trSuppLoaded = true;
      console.log("[test] seq 20 LOADED ✓ (seq 21 folded into its init — one instantiate for both) — sending the classic supersede pair (seq 40 fixture, seq 41 bogus)");
      trPhase = 12;
      ws.send(JSON.stringify(trLoad(40)));
      ws.send(JSON.stringify({
        type: "load", seq: 41, events: trEvents, meta: TR_META, channels: { t1: 1 },
        plugin: trBogusBody(),
      }));
    } else if (msg.type === "plugin_state" && msg.state === "error" && trPhase === 12) {
      if (/no plugin types found/.test(msg.detail ?? "")) {
        trBogus2Err = true;
        console.log("[test] seq 41 failed fast (bogus path) ✓ — seq 40 was superseded by it (exactly-one terminal each, engine.log side) — shutting down");
        console.log("[test] terminal-receipt contract complete (wire side; the per-seq exactly-one counting + stage/pending receipts are asserted by desktop.yml)");
        finishAndShutdown();
      } else {
        fail(`terminal: unexpected error receipt in phase 12: ${JSON.stringify(msg)}`);
      }
    } else if (msg.type === "error" && trPhase >= 2 && trPhase <= 12) {
      const d = msg.detail ?? "";
      if (msg.code === "editor_unavailable") {
        // handled by the dedicated branch above; reaching here means the
        // phase didn't match — tolerate during the carried-intent window.
        if (trPhase === 8.5) return;   // the carried editor's unavailable (headless) — tolerated
        fail(`terminal: unexpected error: ${msg.code} ${d}`);
      } else if (msg.code === "load_rejected") {
        fail(`terminal: a load was REJECTED mid-sequence (${d})`);
      } else {
        fail(`terminal: unexpected error: ${msg.code} ${d}`);
      }
    }
  } else if (mode === "host") {
    // ── Stage 3c-2: hosting proof against the free test VST3 ──
    // COLLECT-then-ASSERT: state peaks are correlated to dispatch-ledger
    // markers by ENGINE TICK (never by arrival time), so runner-speed-dependent
    // message latency cannot skew the unmuted/muted windows.
    // Stage 3e-1 collection runs across ALL phases (loaded receipts happen
    // in phases 1/F/N/P and the classId reload; capabilities ride each).
    if (msg.type === "plugin_state" && msg.state === "loaded") {
      const iid = msg.instanceId || "hosted";
      hostLoadedCount[iid] = (hostLoadedCount[iid] ?? 0) + 1;
      if (msg.classId) hostClassId = msg.classId;
    } else if (msg.type === "plugin_capabilities") {
      const iid = msg.instanceId || "hosted";
      hostCapsCount[iid] = (hostCapsCount[iid] ?? 0) + 1;
      // Stage 3f-7 (item 1): this engine runs with SCORCH_TESTVST_INFTAIL=1 —
      // the fixture reports an INFINITE tail; the engine must serialize it as
      // null ("infinite"), never a bare inf (invalid JSON).
      if (msg.tailSeconds !== null) fail(`3f-7: tailSeconds must serialize as null for an infinite tail, got ${msg.tailSeconds}`);
      if (!hostFirstCaps) hostFirstCaps = msg;
    } else if (msg.type === "scan_probe") {
      // Stage 3f-7 (items 1+3): probe-ON-LOAD queues this automatically (the
      // engine probed the plugin it just loaded), and phase 31's explicit
      // probe (sent while the editor window is OPEN — the pause-gate proof)
      // answers after the editor closes + the 2 s resume delay. The receipt
      // must be a SUCCESS with tailSeconds null (infinite tail, valid JSON).
      if (msg.classId === hostClassId && msg.capabilities !== undefined) {
        if (msg.capabilities.tailSeconds !== null) fail(`3f-7: probe receipt tailSeconds must be null (infinite), got ${msg.capabilities.tailSeconds}`);
        if (typeof msg.capabilities.latencySamples !== "number") fail("probe receipt capabilities must carry numeric latencySamples");
        hostProbeReceiptOk = true;
        console.log(`[test] scan_probe ✓ probe receipt: capabilities with tailSeconds=null (infinite tail, valid JSON) — outcome=ok`);
        if (hostPhase === 33) {
          // Milestone 1: instead of shutting down, run the lifetime gate —
          // the x10 clean unload/reload cycle (the definition-of-done loop,
          // CI-side). finishAndShutdown fires after the cycle's final stop.
          console.log("[test] phase L2 ✓ the editor-pause probe answered AFTER the editor closed (+ 2 s resume)");
          console.log(`[test] milestone-1 cycle: ${HOST_CYCLES}× clean unload/reload starting...`);
          hostCycleSendUnload();
        }
      }
    }
    if (msg.type === "hello" && !hostScanSent) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (!fixtureDir) fail("host mode requires a fixture dir argument");
      // Stage 3f-3a: mirror the frontend's connect-time setHostWindow BEFORE
      // any editor work — even the negative path below runs under the same
      // conditions the real shell creates (host hwnd already announced).
      ws.send(JSON.stringify({ type: "setHostWindow", hwnd: hostHwnd }));
      // Stage 3d-1 NEGATIVE path FIRST: nothing is hosted yet — openEditor
      // must answer editor_unavailable (a NORMAL reply), not crash, not hang.
      console.log(`[test] hello OK — setHostWindow(hwnd=${hostHwnd}) sent — editor negative path first (no live instance)...`);
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
    } else if (msg.type === "hostWindowSet" && !hostHwndSetOk) {
      // Stage 3f-3a: the engine must ECHO the accepted hwnd (parse+store
      // round-trip over the wire). The owner application itself is proven by
      // the engine.log receipt (desktop.yml grep on Windows CI).
      if (msg.hwnd !== hostHwnd) fail(`hostWindowSet echo must carry the hwnd back unchanged, got ${JSON.stringify(msg)}`);
      hostHwndSetOk = true;
      console.log(`[test] setHostWindow echoed (hwnd=${msg.hwnd}) — subsequent editor windows will be owned by it`);
    } else if (msg.type === "error" && msg.code === "editor_unavailable" && hostPhase === 0 && !hostScanSent) {
      hostEditorNegOk = true;
      console.log(`[test] phase N ✓ openEditor with no live instance → editor_unavailable (detail: "${msg.detail}") — scanning for the stand-in host plugin...`);
      hostScanSent = true;
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && hostScanSent && hostPhase === 0) {
      const valid = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`host mode: stand-in plugin not found in scan (${JSON.stringify(msg.plugins)})`);
      hostValidUid = valid.uid; hostValidPath = valid.path; hostValidName = valid.name;
      // Milestone 2: the diff-replace counterpart must exist beside it.
      const validB = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth B");
      if (!validB) fail(`host mode: the M2 diff-replace identity "Scorch Test Synth B" not found in scan (${JSON.stringify(msg.plugins)})`);
      hostValidUidB = validB.uid; hostValidPathB = validB.path; hostValidNameB = validB.name;
      console.log(`[test] stand-in host found: "${valid.name}" uid=${valid.uid} (B: "${validB.name}" uid=${validB.uid}) — enabling dispatch_log + loading`);
      hostPhase = 1;
      ws.send(JSON.stringify({ type: "dispatch_log", enable: true }));
      ws.send(JSON.stringify({
        type: "load",
        seq: 1,
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
    } else if (msg.type === "dispatch" && hostPhase >= 2 && hostCycPhase < 5) {
      // hostCycPhase < 5: the cycle machine's FINAL-PROOF branch below
      // (phase 5 — "dispatch receipts flowing after N reloads" → stop →
      // shutdown) must see the dispatch receipts FIRST. This collector sits
      // earlier in the chain and would otherwise swallow every dispatch,
      // leaving the final proof waiting forever — invisible locally (the
      // headless host skips the editor phases and everything after, so the
      // final proof never ran until the full Windows CI path).
      for (const e of msg.entries ?? []) hostEntries.push(e);
    } else if (hostCycPhase === 2 && msg.type === "error" && msg.code === "editor_unavailable") {
      // The unload WIRE proof: after {"plugins": []}, nothing is hosted —
      // openEditor must answer editor_unavailable (the normal reply).
      hostCycUnloadOk++;
      console.log(`[test] cycle ${hostCycIdx + 1}/${HOST_CYCLES} ✓ unload landed (editor_unavailable: "${msg.detail}") — reloading`);
      hostCycleReload();
    } else if (hostCycPhase === 2 && msg.type === "editorOpened") {
      // RACE ABSORBER: the unload job had not landed yet when the probe ran.
      // Close the window and retry the probe (bounded). The re-probe timer
      // carries the same stale-fire guard as the send timer: if the unload
      // lands while this timer is pending, the machine has moved on (phase
      // 3+) and the re-probe must NOT re-arm phase 2 over a moved-on state.
      if (++hostCycEditorTries > 15) fail("cycle: the unload never landed (editor still opens after 15 retries)");
      console.log(`[test] cycle ${hostCycIdx + 1}: editor still open (unload in flight) — closing + retrying (${hostCycEditorTries}/15)`);
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "hosted" }));
      setTimeout(() => {
        if (hostCycPhase !== 2) return;
        ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
      }, 500);
    } else if (hostCycPhase === 3 && msg.type === "plugin_state" && msg.state === "loaded") {
      hostCycReloadOk++;
      if (msg.instanceId !== "hosted") fail(`cycle reload: instanceId must be "hosted", got ${msg.instanceId}`);
      hostCycIdx++;
      if (hostCycIdx < HOST_CYCLES) {
        console.log(`[test] cycle ${hostCycIdx}/${HOST_CYCLES} ✓ reloaded (fresh plugin_state loaded) — next unload`);
        setTimeout(hostCycleSendUnload, 150);
      } else {
        console.log(`[test] milestone-1 cycle ✓ ${HOST_CYCLES}/${HOST_CYCLES} clean unload/reload cycles — final editor round-trip + play proof`);
        hostCycPhase = 4;
        ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
      }
    } else if (hostCycPhase === 4 && msg.type === "editorOpened") {
      hostCycEdOpen = true;
      console.log("[test] cycle final ✓ editor reopens after the last reload — closing");
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "hosted" }));
    } else if (hostCycPhase === 4 && msg.type === "editorClosed") {
      hostCycEdClose = true;
      console.log("[test] cycle final ✓ editor closed — play + dispatch proof");
      hostCycPhase = 5;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (hostCycPhase === 5 && msg.type === "dispatch") {
      hostCycDispatch += (msg.entries ?? []).length;
      if (hostCycDispatch >= 3 && !hostCycPlayOk) {
        hostCycPlayOk = true;
        console.log(`[test] cycle final ✓ dispatch receipts flowing after ${HOST_CYCLES} reloads (${hostCycDispatch} entries) — stopping`);
        hostCycPhase = 6;
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      }
    } else if (hostCycPhase === 6 && msg.type === "state" && msg.playing === false) {
      hostCycStopOk = true;
      console.log("[test] cycle final ✓ clean stop — shutdown");
      finishAndShutdown();
    } else if (msg.type === "state" && hostPhase >= 2 && hostPhase <= 4) {
      if (msg.playing) hostStates.push({ tick: msg.tick, peak: msg.peak ?? 0 });
      // Phase DRIVING only — all assertions run at the end.
      if (hostPhase === 2 && msg.playing && msg.tick >= 1700) {
        console.log(`[test] phase A reached (tick ${msg.tick}) — muting t1+t2`);
        hostPhase = 3;
        ws.send(JSON.stringify({ type: "mix", mutedTracks: ["t1", "t2"], soloTracks: [] }));
      } else if (hostPhase === 3 && msg.playing && msg.tick >= 5200) {
        console.log(`[test] phase B reached (tick ${msg.tick}) — unmuting`);
        hostPhase = 4;
        ws.send(JSON.stringify({ type: "mix", mutedTracks: [], soloTracks: [] }));
      } else if (hostPhase === 4 && msg.playing && msg.tick >= 6900) {
        console.log("[test] phase C reached (tick " + msg.tick + ") — running assertions, then stop");
        assertHostWindows();
        hostPhase = 5;
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      }
    } else if (msg.type === "state" && (hostPhase === 5 || hostPhase === 7) && msg.playing === false) {
      // Stage 3c close-out — STOP = MUSICAL RELEASE. The transport stops; the
      // release tail may still ring on the first stopped frame (that is the
      // POINT), but the stand-in releases in 128 samples, so by the first
      // state frame (~33ms) the decay is complete. The REAL proof is in the
      // ledger: the CC123-semantics release marker + EXACT note-offs for every
      // held note, and NO CC120 (All Sound Off) at stop.
      // OBSERVATION RACE: the release batch is written by the NEXT AUDIO
      // BUFFER (≤12ms) while state frames arrive at 33Hz — the first stopped
      // frame can beat the ledger. Wait (bounded) for the release marker at
      // this stop's tick before asserting.
      const stopTick = msg.tick;
      const which = hostPhase === 5 ? 1 : 2;
      const have = hostEntries.some((e) => e.k === 2 && e.a === 123 && e.c === 0 && e.t === stopTick);
      if (!have && ++hostReleaseWait <= 30) return;   // ~1s ceiling, then assert anyway (fails with a dump)
      hostReleaseWait = 0;
      if (which === 1) {
        hostStopTick1 = stopTick;
        if ((msg.peak ?? 0) >= 0.02) fail(`after stop peak ${msg.peak} — release tail did not decay (stand-in releases in 128 samples)`);
        assertHostRelease(hostStopTick1, 1, [[2, 67]], true);
        console.log(`[test] phase D ✓ MUSICAL stop at tick ${hostStopTick1}: release marker + exact held-note offs in the ledger, NO CC120 — resuming`);
        hostPhase = 6;
        ws.send(JSON.stringify({ type: "transport", command: "play" }));
      } else {
        hostStopTick2 = stopTick;
        assertHostRelease(hostStopTick2, 2, [[1, 60], [1, 62], [2, 64], [2, 67]], false);
        console.log(`[test] phase E ✓ stop 2 also musical at tick ${hostStopTick2} — re-hosting SAME plugin while STOPPED (async init path, seq 2)`);
        hostPhase = 8;
        ws.send(JSON.stringify({
          type: "load",
          seq: 2,
          events: HOST_EVENTS,
          meta: HOST_META,
          channels: { t1: 1, t2: 2 },
          plugin: { uid: hostValidUid, path: hostValidPath, name: hostValidName },
        }));
      }
    } else if (msg.type === "state" && hostPhase === 6 && msg.playing && msg.tick >= 7700) {
      // Stage 3c close-out — RESUME: no replay burst, gentle re-attacks, and
      // articulation-aware CC#32 handling (suppressed redundant / sent change).
      assertResumeLedger();
      hostPhase = 7;
      ws.send(JSON.stringify({ type: "transport", command: "stop" }));
    } else if (msg.type === "plugin_state" && hostPhase === 8) {
      // Stage 3c-regression: plugin init is ASYNC — this plugin_state comes
      // from the init worker thread after the off-thread instantiate.
      if (msg.state !== "loaded") fail(`phase 8: plugin_state must be loaded, got ${msg.state} (${msg.detail ?? ""})`);
      console.log(`[test] phase F ✓ async re-host while stopped ("${msg.name}") — playing again`);
      hostPhase = 9;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "state" && hostPhase === 9 && msg.playing) {
      console.log("[test] phase G — sending SAME-plugin load mid-play (reuse fast path, seq 3)");
      hostPhase = 10;
      ws.send(JSON.stringify({
        type: "load",
        seq: 3,
        events: HOST_EVENTS,
        meta: HOST_META,
        channels: { t1: 1, t2: 2 },
        plugin: { uid: hostValidUid, path: hostValidPath, name: hostValidName },
      }));
    } else if (msg.type === "loadAck" && hostPhase === 10 && msg.seq === 3 && !hostReloadAckOk) {
      hostReloadAckOk = true;
      // Milestone 2: the wholesale mid-play rejection is GONE — a different
      // binary now APPLIES as a diff (capture old state → retire old node →
      // instantiate new → vendor swap) while the transport keeps rolling.
      // Phase H asserts the new contract: loadAck, the new binary's loaded
      // receipt, then transport continuity.
      console.log("[test] phase G ✓ same-plugin mid-play reload ACKED (live instance reused, no re-instantiate) — sending DIFFERENT-binary load mid-play (M2 diff, seq 4)");
      hostPhase = 11;
      ws.send(JSON.stringify({
        type: "load",
        seq: 4,
        events: HOST_EVENTS,
        meta: HOST_META,
        channels: { t1: 1, t2: 2 },
        plugin: { uid: hostValidUidB, path: hostValidPathB, name: hostValidNameB },
      }));
    } else if (msg.type === "loadAck" && hostPhase === 11 && msg.seq === 4 && !hostRejectOk) {
      hostRejectOk = true;   // the M2 diff was ACCEPTED (flag name kept for the timeout line)
      console.log("[test] phase H ✓ plugin-change load ACKED mid-play (M2 diff accepted) — waiting for the new binary's loaded receipt");
    } else if (msg.type === "plugin_state" && hostPhase === 11 && hostRejectOk && msg.state === "loaded" && !hostDiffLoadedOk) {
      if (msg.name !== "Scorch Test Synth B") fail(`phase H: the diff must land the B binary, got "${msg.name}"`);
      hostDiffLoadedOk = true;
      console.log(`[test] phase H ✓ CHANGED instance re-hosted mid-play ("${msg.name}") — waiting for proof the transport still plays`);
    } else if (msg.type === "error" && hostPhase === 11) {
      fail(`phase H: a mid-play plugin change must APPLY as a diff (M2), got an error: ${JSON.stringify(msg)}`);
    } else if (msg.type === "state" && hostPhase === 11 && hostDiffLoadedOk && msg.playing) {
      hostPlayingAfterReject = true;
      console.log("[test] phase H ✓ transport STILL PLAYING after the mid-play diff — stopping");
      hostPhase = 12;
      ws.send(JSON.stringify({ type: "transport", command: "stop" }));
    } else if (msg.type === "state" && hostPhase === 12) {
      if (msg.playing === false) {
        console.log("[test] phase I ✓ clean stop after the guard sequence — state persistence phases (3d-3, window-free so they run anywhere)");
        hostPhase = 13;
        // Stage 3d-3 M: capture the DEFAULT state. A hosted VST3's state
        // comes back through the JUCE WRAPPER container (opaque to the test
        // — a 4-byte processor state arrives as a 197-byte container), so
        // the asserts are FORMAT-AGNOSTIC: capture determinism + divergence
        // via CC#21 + application-by-peak + round-trip identity.
        ws.send(JSON.stringify({ type: "captureState" }));
      }
    } else if (msg.type === "pluginSavedState" && hostPhase === 13) {
      if (msg.state === "too_large") fail(`fixture state cannot be too_large (got ${msg.size} bytes)`);
      if (!msg.data || msg.size <= 0) fail(`default capture must carry data (size=${msg.size})`);
      hostStateS0 = msg.data;
      hostPhase = 14;
      console.log(`[test] phase M ✓ default state captured (${msg.size} bytes via the JUCE wrapper) — capture determinism check`);
      ws.send(JSON.stringify({ type: "captureState" }));
    } else if (msg.type === "pluginSavedState" && hostPhase === 14) {
      if (msg.data !== hostStateS0) fail("capture must be DETERMINISTIC (two captures of the same state differ — serialization is unstable)");
      hostStateCaptureOk = true;
      console.log("[test] phase M2 ✓ capture is deterministic (byte-identical) — loading a score that DIVERGES the state via CC#21 (fixture: value/127 → masterScale)");
      hostPhase = 15;
      ws.send(JSON.stringify({
        type: "load", seq: 5,
        events: [...HOST_EVENTS, { eventType: "CONTROL_CHANGE", channel: 1, data1: 21, data2: 64, timestampTicks: 0, trackId: "t1" }],
        meta: HOST_META, channels: { t1: 1, t2: 2 },
        plugin: { uid: hostValidUid, path: hostValidPath, name: hostValidName },
      }));
    } else if (msg.type === "plugin_state" && hostPhase === 15) {
      if (msg.state !== "loaded") fail(`phase N: diverge-load must host, got ${msg.state} (${msg.detail ?? ""})`);
      hostPhase = 16;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "state" && hostPhase === 16) {
      if (msg.playing) {
        hostStatePlayStates.push(msg.peak ?? 0);
        if (msg.tick >= 1700) {
          const peakMax = Math.max(...hostStatePlayStates);
          // CC#21=64 → masterScale 64/127 ≈ 0.504. M1: the graph renders at
          // UNITY — the legacy renderer's ×2.0 hosted-output gain is the named
          // deferral (returns with the routing milestone) — so the 2-voice
          // fixture level 0.787 scales to ≈0.397 (the legacy ×2 gain expected
          // ≈0.793).
          if (!(peakMax > 0.32 && peakMax < 0.47)) fail(`CC-diverged state did not apply in-render — peak must be ≈0.397 (unity graph render, ×2.0 gain deferred), got ${peakMax.toFixed(3)} (frames: ${hostStatePlayStates.length})`);
          console.log(`[test] phase N ✓ state DIVERGED through the score (peak ${peakMax.toFixed(3)} ≈ 0.787×0.504, unity) — stopping to capture the diverged state`);
          hostPhase = 17;
          ws.send(JSON.stringify({ type: "transport", command: "stop" }));
        }
      }
      // playing=false strays before the play lands are ignored.
    } else if (msg.type === "state" && hostPhase === 17 && msg.playing === false) {
      hostPhase = 18;
      ws.send(JSON.stringify({ type: "captureState" }));
    } else if (msg.type === "pluginSavedState" && hostPhase === 18) {
      if (msg.data === hostStateS0) fail("the diverged state must CAPTURE DIFFERENTLY from the default (masterScale 0.504 not reflected in getStateInformation)");
      hostStateS1 = msg.data;
      console.log(`[test] phase O ✓ diverged state captured (${msg.size} bytes, differs from default) — re-hosting WITH it embedded (the project-JSON round-trip)`);
      hostPhase = 19;
      ws.send(JSON.stringify({
        type: "load", seq: 6, events: HOST_EVENTS, meta: HOST_META,
        channels: { t1: 1, t2: 2 },
        plugin: { uid: hostValidUid, path: hostValidPath, name: hostValidName, state: hostStateS1 },
      }));
    } else if (msg.type === "plugin_state" && hostPhase === 19) {
      if (msg.state !== "loaded") fail(`phase P: re-host with embedded state must load, got ${msg.state} (${msg.detail ?? ""})`);
      hostPhase = 20;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "state" && hostPhase === 20) {
      if (msg.playing) {
        hostStatePlayStates2.push(msg.peak ?? 0);
        if (msg.tick >= 1700) {
          const peakMax = Math.max(...hostStatePlayStates2);
          // The RESTORED state (masterScale ≈ 0.504 from the embed) must
          // apply. Unity re-scope as phase N: 0.787×0.504 ≈ 0.397 (the ×2.0
          // hosted-output gain is the named M1 deferral).
          if (!(peakMax > 0.32 && peakMax < 0.47)) fail(`restored state did not APPLY — peak must be ≈0.397 (unity graph render, ×2.0 gain deferred; the embedded value), got ${peakMax.toFixed(3)} (frames: ${hostStatePlayStates2.length})`);
          hostStateRestoreOk = true;
          console.log(`[test] phase P ✓ restored state APPLIED (peak ${peakMax.toFixed(3)} ≈ 0.787×0.504, unity — setStateInformation took effect) — stopping, round-trip capture`);
          hostPhase = 21;
          ws.send(JSON.stringify({ type: "transport", command: "stop" }));
        }
      }
    } else if (msg.type === "state" && hostPhase === 21 && msg.playing === false) {
      hostPhase = 22;
      ws.send(JSON.stringify({ type: "captureState" }));
    } else if (msg.type === "pluginSavedState" && hostPhase === 22) {
      if (msg.data !== hostStateS1) fail("capture→restore→capture must be byte-IDENTICAL (the project embed survives a restart)");
      hostStateRoundtripOk = true;
      console.log("[test] phase Q ✓ capture→restore→capture byte-IDENTICAL — Stage 3e-1: re-hosting by VST3 CLASS ID (identifier-string matching, seq 7)");
      if (!hostClassId) fail("plugin_state 'loaded' carried no classId — the capability handshake key is missing");
      hostPhase = 23;
      ws.send(JSON.stringify({
        type: "load", seq: 7, events: HOST_EVENTS, meta: HOST_META,
        channels: { t1: 1, t2: 2 },
        plugin: { uid: hostClassId, path: hostValidPath, name: hostValidName },
      }));
    } else if (msg.type === "plugin_state" && hostPhase === 23 && msg.state === "loaded") {
      // Stage 3e-1: the load's uid was the FULL class identifier string —
      // the PREFERRED matching key. The engine must resolve it to the same
      // class (echoed classId) without the numeric-uid fallback.
      if (msg.classId !== hostClassId) fail(`classId reload must echo the same classId (got "${msg.classId}", want "${hostClassId}")`);
      console.log(`[test] phase R ✓ load by class identifier string MATCHED ("${hostClassId}") — Stage 3e-3: multi-output default routing (seq 8, aux ARMED via CC#22, NO outputRouting)`);
      hostPhase = 24;
      ws.send(JSON.stringify({
        type: "load", seq: 8, events: MO_EVENTS, meta: MO_META,
        channels: { t1: 1 },
        plugin: { uid: hostValidUid, path: hostValidPath, name: hostValidName },
      }));
    } else if (msg.type === "plugin_state" && hostPhase === 24 && msg.state === "loaded") {
      console.log("[test] phase MO-1 ✓ re-hosted — playing (default routing: every bus sums to master)");
      hostPhase = 25;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "state" && hostPhase === 25) {
      if (msg.playing) {
        moPeaksDefault.push(msg.peak ?? 0);
        if (msg.tick >= 2400) {
          const pk = Math.max(...moPeaksDefault);
          // M1 deferrals in force: the ×2.0 hosted-output gain AND the aux-bus
          // master fold are both deferred (aux buses stay UNCONNECTED — only
          // the main stereo bus drives the master). The MO score normalizes
          // masterScale to 1.0 (CC21=127), one sustained vel-100 voice →
          // fixture level 0.394, main-only. The default-vs-muted distinction
          // (MO-2 vs MO-5) collapses to the same main-only peak until the
          // routing milestone restores the fold.
          if (!(pk > 0.30 && pk < 0.50)) fail(`multi-out DEFAULT routing: master peak ${pk.toFixed(3)} must be main-only ≈0.394 (unity; aux fold + gain deferred) — main bus not rendered`);
          console.log(`[test] phase MO-2 ✓ default routing (M1: main-only, aux fold deferred): master peak ${pk.toFixed(3)} ≈ main (0.394) — stopping`);
          hostPhase = 26;
          ws.send(JSON.stringify({ type: "transport", command: "stop" }));
        }
      }
    } else if (msg.type === "state" && hostPhase === 26 && msg.playing === false) {
      console.log("[test] phase MO-3 — re-hosting with outputRouting [{busIndex:1, mute:true}] (aux muted, seq 9)");
      hostPhase = 27;
      ws.send(JSON.stringify({
        type: "load", seq: 9, events: MO_EVENTS, meta: MO_META,
        channels: { t1: 1 },
        plugin: { uid: hostValidUid, path: hostValidPath, name: hostValidName,
                  outputRouting: [{ busIndex: 1, gain: 1, mute: true }] },
      }));
    } else if (msg.type === "plugin_state" && hostPhase === 27 && msg.state === "loaded") {
      console.log("[test] phase MO-4 ✓ re-hosted with routing — playing (aux must be SILENT)");
      hostPhase = 28;
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "state" && hostPhase === 28) {
      if (msg.playing) {
        moPeaksMuted.push(msg.peak ?? 0);
        if (msg.tick >= 2400) {
          const pk = Math.max(...moPeaksMuted);
          // Unity main-only (see MO-2): the aux is unconnected in M1, so the
          // muted-routing load renders identically — the assert still proves
          // the routing-bearing reload renders the main bus cleanly.
          if (!(pk > 0.30 && pk < 0.50)) fail(`multi-out MUTED routing: master peak ${pk.toFixed(3)} must be main-only ≈0.394 (unity; aux fold + gain deferred)`);
          console.log(`[test] phase MO-5 ✓ aux muted via outputRouting (M1: main-only render): master peak ${pk.toFixed(3)} = main only — stopping, editor phases`);
          hostPhase = 29;
          ws.send(JSON.stringify({ type: "transport", command: "stop" }));
        }
      }
    } else if (msg.type === "state" && hostPhase === 29 && msg.playing === false) {
      console.log("[test] phase MO ✓ multi-output contract proven both ways — editor phases (3d-1: window work, proven on CI's desktop)");
      hostPhase = 30;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
    } else if (msg.type === "editorOpened" && hostPhase === 30) {
      if (msg.focused === true) fail(`first openEditor must OPEN (not focus): ${JSON.stringify(msg)}`);
      if (!msg.width || msg.width <= 0 || !msg.height || msg.height <= 0) fail(`editorOpened lacks real geometry: ${JSON.stringify(msg)}`);
      hostEditorOpenOk = true;
      console.log(`[test] phase J ✓ editor OPENED "${msg.name}" ${msg.width}x${msg.height} — repeat request must RAISE, not double-open`);
      hostPhase = 31;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
    } else if (msg.type === "editorOpened" && hostPhase === 31) {
      if (msg.focused !== true) fail(`repeat openEditor must re-echo editorOpened with focused=true (one editor per instance), got ${JSON.stringify(msg)}`);
      hostEditorFocusOk = true;
      console.log("[test] phase K ✓ repeat openEditor focused the existing window (ONE editor per instance) — requesting a probe DURING the open editor (pause gate), then closing");
      hostPhase = 32;
      hostEditorPauseProbeSent = true;
      ws.send(JSON.stringify({ type: "probe", classId: hostClassId }));   // 3f-7: must PAUSE while the editor is open
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "hosted" }));
    } else if (msg.type === "editorClosed" && hostPhase === 32) {
      hostEditorCloseOk = true;
      // Stage 3f-7 (item 2): the probe requested in phase 31 sat behind the
      // pause gate (editor open); it resumes 2 s after this close and its
      // receipt answers in phase 33 (the scan_probe branch above).
      console.log("[test] phase L ✓ editor CLOSED cleanly (protocol close; the X button and plugin unload converge on the same path) — waiting for the paused probe to resume and answer…");
      hostPhase = 33;
      setTimeout(() => {
        if (hostPhase === 33 && !hostProbeReceiptOk) fail("3f-7: the probe requested during the open editor never answered after the close — the pause gate stalled it");
      }, 15000);
    } else if (msg.type === "scan_probe" && hostPhase === 33 && hostEditorPauseProbeSent && !hostProbeReceiptOk) {
      fail(`the paused probe's receipt arrived without capabilities: ${JSON.stringify(msg).slice(0, 160)}`);
    } else if (msg.type === "error" && msg.code === "editor_unavailable" && hostPhase === 30 && !hostEditorOpenOk) {
      // Headless tolerance — SAME contract as multi M-7: a display-less host
      // (this box, disconnected RDP) cannot create a window; the engine's
      // display guard answers editor_unavailable("no display …") and the
      // runner skips J/K/L. Windows CI has a real display and proves the
      // real open/raise/close path — this branch never fires there.
      if (!/no display/i.test(msg.detail ?? "")) fail(`host: unexpected editor_unavailable detail: ${msg.detail}`);
      hostHeadlessSkip = true;
      console.log(`[test] phase J (headless) editor_unavailable tolerated ("${msg.detail}") — Windows CI proves the window path`);
      finishAndShutdown();
    } else if (msg.type === "error" && hostPluginStateOk && !hostRejectOk) {
      fail(`host mode: unexpected error mid-test: ${msg.code} ${msg.detail ?? ""}`);
    }
    return;
  }

  if (mode === "scan") {
    // ── Stage 3c-1 scan protocol + 3f-2 describe/probe split ──
    if (msg.type === "hello" && !helloOk) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.10.0") fail(`expected 0.9.2, got ${msg.engineVersion}`);
      if (!fixtureDir) fail("scan mode requires a fixture dir argument");
      console.log("[test] hello OK — sending scan of fixture dir + nested dir (dedup proof):", fixtureDir);
      scanSent = true;
      // TWO dirs: the fixture root AND the nested L1/L2 dir directly —
      // ProbeCrashDummy is reachable through BOTH walks (same classId), and
      // 3f-2 must keep exactly ONE row (first by path order wins).
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir, fixtureDir + "/nested/L1/L2"] }));
    } else if (msg.type === "scan_result" && scanSent && !scanResultOk) {
      scanResultOk = true;
      const plugins = Array.isArray(msg.plugins) ? msg.plugins : [];
      const failed = Array.isArray(msg.failed) ? msg.failed : [];
      const dirs = Array.isArray(msg.scannedDirs) ? msg.scannedDirs : [];
      if (dirs.length !== 2) fail(`expected 2 scannedDirs, got ${JSON.stringify(dirs)}`);
      // 1. The valid free test VST3 must be found with its real identity.
      const valid = plugins.find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`scan_result did not include "Scorch Test Synth" (plugins: ${JSON.stringify(plugins)})`);
      if (valid.vendor !== "Scorch Audio") fail(`vendor mismatch: ${valid.vendor}`);
      if (valid.isInstrument !== true) fail("test synth must report isInstrument=true");
      if (!valid.uid) fail("scan_result entries must carry a uid");
      if (!valid.classId) fail("scan_result rows must carry classId (3e-1)");
      // 3f-2 SPLIT PROOF: rows carry NO capability data at all — describe is
      // findAllTypesForFile ONLY. Capabilities arrive later via scan_probe.
      if (valid.capabilities !== undefined) fail("3f-2: scan rows must NOT carry capabilities (describe never instantiates)");
      if (valid.capabilitiesError !== undefined) fail("3f-2: scan rows must NOT carry capabilitiesError");
      console.log(`[test] valid plugin found: "${valid.name}" uid=${valid.uid} classId="${valid.classId}" — rows carry NO capabilities (split) ✓`);
      // 2. 3f-2: the nested probe-crash dummy is found by the RECURSIVE scan
      //    (3 subfolder levels) EXACTLY ONCE, despite being reachable from
      //    BOTH scanned dirs (classId dedup, first by path order).
      const crashRows = plugins.filter((p) => p.name === "ProbeCrashDummy");
      if (crashRows.length !== 1) fail(`ProbeCrashDummy must appear exactly once (recursive scan + classId dedup), got ${crashRows.length}: ${JSON.stringify(crashRows)}`);
      if (!/[\\/]nested[\\/]L1[\\/]L2[\\/]ProbeCrashDummy\.vst3$/i.test(crashRows[0].path)) fail(`ProbeCrashDummy must be the NESTED bundle, got ${crashRows[0].path}`);
      if (!crashRows[0].classId) fail("nested row must carry classId");
      scanCrashClassId = crashRows[0].classId;
      console.log(`[test] nested plugin found (once): ${crashRows[0].path} ✓ (recursive scan + dedup)`);
      // 3. The probe-HANG dummy row is present (top level).
      const hangRow = plugins.find((p) => p.name === "ProbeHangDummy");
      if (!hangRow || !hangRow.classId) fail(`ProbeHangDummy row missing or class-less: ${JSON.stringify(hangRow)}`);
      scanHangClassId = hangRow.classId;
      scanSynthClassId = valid.classId;
      // 4. The crash dummy must appear as a failed entry WITH DIAGNOSTICS.
      const crashFail = failed.find((f) => f.path.includes("CrashDummy"));
      if (!crashFail) fail(`crash dummy not recorded as failed — crash isolation broken (failed: ${JSON.stringify(failed)})`);
      if (!/crash|exit/i.test(crashFail.error ?? "")) fail(`crash dummy failure lacks crash evidence: ${crashFail.error}`);
      // 3f-2: EVERY failed entry carries exitCode + elapsedMs + stderrTail.
      for (const f of failed) {
        if (typeof f.exitCode !== "number") fail(`failed entry missing numeric exitCode: ${JSON.stringify(f).slice(0, 200)}`);
        if (typeof f.elapsedMs !== "number") fail(`failed entry missing numeric elapsedMs: ${JSON.stringify(f).slice(0, 200)}`);
        if (typeof f.stderrTail !== "string") fail(`failed entry missing stderrTail: ${JSON.stringify(f).slice(0, 200)}`);
      }
      console.log(`[test] crash dummy isolated with diagnostics: exit=${crashFail.exitCode} elapsed=${crashFail.elapsedMs}ms stderrTail=${crashFail.stderrTail.length} chars ✓`);
      // 5. The corrupt dummy fails GRACEFULLY (zero types — neither plugin nor failed).
      if (failed.some((f) => f.path.includes("CorruptDummy"))) fail("corrupt dummy must fail gracefully (zero types), not as a scan failure");
      if (plugins.some((p) => p.path.includes("CorruptDummy"))) fail("corrupt dummy must not yield plugin types");
      console.log("[test] corrupt dummy isolated silently (graceful zero-type load) ✓");
      // 6. Engine alive after the crash: ping must answer. 3f-7: probes are
      //    now LAZY — nothing streams until this script asks.
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "pong" && scanResultOk && !aliveAfterCrashOk) {
      aliveAfterCrashOk = true;
      // Stage 3f-7 (item 3) LAZY PROOF: after scan_result the engine must
      // NOT probe any row on its own. The OLD engine would have the first
      // probe receipt here within ~1 s (the crash dummy probes fast); a
      // 3 s silence window with ZERO scan_probe messages is the proof.
      console.log("[test] engine alive (ping→pong) ✓ — 3f-7: asserting 3 s of probe SILENCE (lazy — nothing probed without a request)…");
      scanLazyDeadline = Date.now() + 3000;
      // Drive the silence window: a ping at the deadline makes the phase
      // advance (the silence proof = NO scan_probe arrived in between).
      setTimeout(() => { if (scanLazyPhase === "silence") ws.send(JSON.stringify({ type: "ping" })); }, 3200);
    } else if (msg.type === "scan_probe" && scanResultOk && !scanProbesAsserted && scanLazyPhase === "silence") {
      fail(`3f-7 LAZY probing violated: a scan_probe arrived WITHOUT any probe request (${JSON.stringify(msg).slice(0, 160)}) — the engine still auto-probes rows`);
    } else if (msg.type === "pong" && scanLazyPhase === "silence" && Date.now() >= scanLazyDeadline) {
      // 3 s of pongs-driven time passed without any scan_probe — LAZY proven.
      scanLazyPhase = "explicit-synth";
      console.log("[test] phase L-1 ✓ 3 s of silence, ZERO scan_probes — probing is LAZY — requesting the visible synth row…");
      ws.send(JSON.stringify({ type: "probe", classId: scanSynthClassId }));
    } else if (msg.type === "scan_probe" && scanLazyPhase === "explicit-synth") {
      if (msg.classId !== scanSynthClassId) fail(`explicit probe must answer the synth row, got ${msg.classId}`);
      if (msg.capabilities === undefined) fail(`synth probe must SUCCEED, got: ${msg.capabilitiesError}`);
      const caps = msg.capabilities;
      const mainOut = (caps.buses ?? []).find((b) => !b.input && b.isMain);
      if (!mainOut || mainOut.name !== "Output" || mainOut.channels !== 2) {
        fail(`synth probe capabilities: main out bus must be "Output" 2ch, got ${JSON.stringify(mainOut ?? null)}`);
      }
      scanLazyPhase = "explicit-crash";
      console.log("[test] phase L-2 ✓ explicit probe → synth capabilities (Output 2ch main) — probing the crash row…");
      ws.send(JSON.stringify({ type: "probe", classId: scanCrashClassId }));
    } else if (msg.type === "scan_probe" && scanLazyPhase === "explicit-crash") {
      if (msg.classId !== scanCrashClassId) fail(`explicit probe must answer the crash row, got ${msg.classId}`);
      if (typeof msg.capabilitiesError !== "string" || msg.capabilitiesError.length === 0) fail("ProbeCrashDummy probe must FAIL (it aborts in GetPluginFactory)");
      scanLazyPhase = "probeAll";
      console.log(`[test] phase L-3 ✓ explicit probe → crash isolated ("${msg.capabilitiesError.slice(0, 60)}") — loading a minimal score (the transport only rolls with one), then "Probe all"…`);
      // The transport only plays with a loaded score — load 2 events (no
      // plugins, so no probe-on-load) BEFORE the pause proof.
      ws.send(JSON.stringify({
        type: "load", seq: 100,
        events: [
          { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 0 },
          { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 480 },
        ],
        meta: { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 1920 },
      }));
      ws.send(JSON.stringify({ type: "probeAll" }));
      // Mid-probeAll pause proof (item 2): roll the transport WHILE the
      // remaining probe children run. The play lands ~100 ms after probeAll —
      // the FIRST job dequeues instantly, but every LATER dequeue evaluates
      // the gate and must log "[probe] paused (reason=transport playing)"
      // (≥1 job is always still queued: 3 rows, the hang child runs 90 s).
      // Stop 4 s later → "[probe] resumed" 2 s after (PowerShell asserts the
      // engine.log lines).
      setTimeout(() => {
        console.log("[test] phase P-1 — rolling the transport DURING the probe batch (the probe thread must pause)…");
        ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
      }, 100);
      setTimeout(() => {
        console.log("[test] phase P-2 — stopping after 4 s (the probe thread resumes 2 s after all conditions clear)…");
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
      }, 4100);
    } else if (msg.type === "scan_probe" && scanLazyPhase === "probeAll") {
      // probeAll re-probes every row: crash (~1s), hang (90s), synth (~0.5s).
      // Duplicates are EXPECTED here (user intent); record per classId.
      const hasCaps = msg.capabilities !== undefined && typeof msg.capabilities === "object" && !Array.isArray(msg.capabilities);
      const hasErr = typeof msg.capabilitiesError === "string" && msg.capabilitiesError.length > 0;
      if (hasCaps === hasErr) fail(`scan_probe must carry EXACTLY ONE of capabilities/capabilitiesError: ${JSON.stringify(msg).slice(0, 200)}`);
      scanProbes[msg.classId] = hasCaps
        ? { kind: "capabilities", capabilities: msg.capabilities }
        : { kind: "error", error: msg.capabilitiesError };
      scanProbeAllCount++;
      console.log(`[test] scan_probe (probeAll ${scanProbeAllCount}/3) classId="${msg.classId}" → ${hasCaps ? "capabilities" : `capabilitiesError("${msg.capabilitiesError.slice(0, 80)}")`}`);
      const expected = [scanSynthClassId, scanCrashClassId, scanHangClassId].filter(Boolean);
      if (!scanProbesAsserted && expected.length === 3 && expected.every((c) => scanProbes[c])) {
        const synthProbe = scanProbes[scanSynthClassId];
        if (synthProbe.kind !== "capabilities") fail(`test synth probe must SUCCEED, got: ${synthProbe.error}`);
        const caps = synthProbe.capabilities;
        if (typeof caps.outputBuses !== "number" || caps.outputBuses < 1) fail(`synth probe capabilities must include an output bus: ${JSON.stringify(caps).slice(0, 200)}`);
        if (typeof caps.latencySamples !== "number") fail("synth probe capabilities must carry numeric latencySamples");
        const hangProbe = scanProbes[scanHangClassId];
        if (hangProbe.kind !== "error") fail("ProbeHangDummy probe must FAIL (90s timeout)");
        if (!/timeout/i.test(hangProbe.error)) fail(`ProbeHangDummy error must name the timeout, got: ${hangProbe.error}`);
        scanProbesAsserted = true;
        console.log("[test] probe contract asserted: synth=capabilities, crash=isolated error, hang=timeout error — rows never removed ✓ — default-dir scan");
        ws.send(JSON.stringify({ type: "ping" }));
      }
    } else if (msg.type === "pong" && scanProbesAsserted && !postProbePongOk) {
      postProbePongOk = true;
      console.log("[test] engine alive after ALL probes (ping→pong) ✓ — default-dir scan");
      ws.send(JSON.stringify({ type: "scan" }));  // no dirs → engine defaults (must not error/hang)
    } else if (msg.type === "scan_result" && scanProbesAsserted && postProbePongOk && !defaultScanOk) {
      defaultScanOk = true;
      if (!Array.isArray(msg.plugins) || !Array.isArray(msg.failed)) fail("default scan_result shape invalid");
      console.log(`[test] default-dir scan clean (plugins=${msg.plugins.length}, failed=${msg.failed.length}) ✓ — shutdown`);
      finishAndShutdown();
    }
    return;
  }

  if (mode === "latency") {
    // ── Stage 3i: runtime latency tracking (detect, then mini-republish) ──
    if (msg.type === "hello" && latPhase === 0) {
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.10.0") fail(`expected 0.9.2, got ${msg.engineVersion}`);
      if (!fixtureDir) fail("latency mode requires a fixture dir argument");
      helloOk = true;
      latPhase = 1;
      console.log("[test] hello OK (0.10.0) — scanning for the stand-in host plugin...");
      ws.send(JSON.stringify({ type: "dispatch_log", enable: true }));   // Phase 2: the pre-fire proof is ledger-based
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && latPhase === 1) {
      const valid = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`latency mode: stand-in plugin not found in scan (${JSON.stringify(msg.plugins)})`);
      latPlugin = valid;
      latPhase = 2;
      console.log(`[test] stand-in found: "${valid.name}" — loading inst-lat (reported latency 128 samples)`);
      ws.send(JSON.stringify({
        type: "load", seq: 1,
        events: latEvents(undefined), meta: LAT_META,
        plugins: [{ instanceId: "inst-lat", uid: valid.uid, path: valid.path, name: valid.name }],
        routing: { t1: { inst: "inst-lat", ch: 1 } },
      }));
    } else if (msg.type === "plugin_state" && msg.state === "loaded") {
      if (msg.instanceId !== "inst-lat") fail(`latency mode: plugin_state for unexpected instance ${msg.instanceId}`);
      latLoadedReceipts.push(msg.latencyMs);
      if (latLoadedReceipts.length === 1) {
        if (Math.abs(msg.latencyMs - latLatencyMs(128)) > 0.5)
          fail(`initial plugin_state latencyMs ${msg.latencyMs} ≠ the fixture's 128-sample expectation ${latLatencyMs(128).toFixed(2)}`);
        latPhase = 3;
        console.log(`[test] L: inst-lat loaded (latencyMs ${msg.latencyMs.toFixed(2)}) — transport play`);
        ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
      }
      // Receipts 2..6 are the mid-play REUSE receipts — their latencyMs values
      // ARE the wire proof that each correction landed AND survived a
      // mid-play load; validated in order at close.
    } else if (msg.type === "state" && latPhase === 3 && msg.playing === true) {
      latLastTick = msg.tick;
      latPhase = 4;
      latRun();
    } else if (msg.type === "state" && latPhase >= 4) {
      if (msg.playing !== true)
        fail(`latency mode: transport LEFT the playing state mid-sequence (playing=${msg.playing}, tick=${msg.tick}) — a correction disrupted the transport`);
      if (msg.tick < latLastTick)
        fail(`latency mode: transport tick REGRESSED (${latLastTick} → ${msg.tick}) — transportGen hiccup`);
      latLastTick = msg.tick;
    } else if (msg.type === "error" && latPhase >= 3) {
      latErrorAfterLoad = true;
      fail(`latency mode: engine sent error ${msg.code} mid-sequence — a correction disrupted the protocol`);
    } else if (msg.type === "load_rejected") {
      fail(`latency mode: mid-play load rejected — the same-set reload must take the reuse fast path: ${JSON.stringify(msg)}`);
    } else if (msg.type === "dispatch") {
      for (const e of msg.entries ?? []) latLedger.push(e);
    } else if (msg.type === "dispatch_log") {
      // ledger enable ack — entries stream alongside the run
    }
    return;
  }

  if (mode === "null-audio") {
    // ── Full protocol suite + RESUME contract (null device) ──
    if (msg.type === "hello" && !helloOk) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.10.0") fail(`expected 0.9.2, got ${msg.engineVersion}`);
      // Stage 3c close-out: the dispatch ledger streams what the engine
      // ACTUALLY dispatched — the replay-burst and re-attack asserts read it.
      ws.send(JSON.stringify({ type: "dispatch_log", enable: true }));
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "dispatch_log" && helloOk && !pongOk) {
      // ledger-enable ack — wait for the pong before the error probe
    } else if (msg.type === "dispatch") {
      for (const e of msg.entries ?? []) ledgerEntries.push(e);
    } else if (msg.type === "pong" && !pongOk) {
      pongOk = true;
      if (typeof msg.t !== "number") fail("pong.t must be number");
      ws.send(JSON.stringify({ type: "bogus" }));
    } else if (msg.type === "error" && !errorOk) {
      errorOk = true;
      if (msg.code !== "unknown") fail(`expected unknown, got ${msg.code}`);
      ws.send(JSON.stringify({ type: "load", seq: 1, events, meta }));
    } else if (msg.type === "loadAck" && !loadAckOk) {
      // Stage 3c-hotfix: the load receipt must name what the engine actually
      // parsed BEFORE any transport can be trusted.
      if (msg.received !== events.length || msg.loaded !== events.length || msg.skipped !== 0 || msg.firstErrorIndex !== -1) {
        fail(`loadAck receipt mismatch: ${JSON.stringify(msg)}`);
      }
      if (!(msg.byteSize > 0)) fail("loadAck.byteSize must be > 0");
      if (msg.seq !== 1) fail(`loadAck.seq must echo the sent seq 1, got ${msg.seq}`);
      loadAckOk = true;
      console.log(`[test] loadAck receipt OK (${events.length}/${events.length} loaded, 0 skipped, byteSize ${msg.byteSize})`);
    } else if (msg.type === "state" && !loadOk) {
      // After load, engine acks with the current transport truth (idle here).
      // Only counts once the loadAck receipt arrived — background states
      // stream at ~30Hz even when idle, so ignoring pre-ack states also
      // removes the old startup race.
      if (msg.playing === false && loadAckOk) {
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
          console.log(`[test] ticks ADVANCE (${first1} → ${last1} over ${frames1} frames) — sending mid-play reload (live-edit contract, seq 2)`);
          // Stage 3c-regression: a NON-plugin load on a rolling transport is
          // the live-edit reload — must be ACCEPTED (events swap is
          // per-buffer rescan-safe) and playback must continue.
          const events2 = events.map((e, i) => i === 2 ? { ...e, data2: 88 } : e);
          ws.send(JSON.stringify({ type: "load", seq: 2, events: events2, meta }));
        }
      }
    } else if (msg.type === "loadAck" && loadAckOk && msg.seq === 2 && !midPlayAckOk) {
      midPlayAckOk = true;
      if (msg.loaded !== events.length) fail(`mid-play reload: expected ${events.length} loaded, got ${msg.loaded}`);
      if (msg.skipped !== 0) fail(`mid-play reload: expected 0 skipped, got ${msg.skipped}`);
      console.log(`[test] mid-play reload ACKED while playing (${msg.loaded}/${msg.received}, byteSize ${msg.byteSize}) ✓ — sending transport stop`);
      ws.send(JSON.stringify({ type: "transport", command: "stop" }));
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
      ws.send(JSON.stringify({ type: "load", seq: 1, events, meta }));
    } else if (msg.type === "loadAck" && !loadAckOk) {
      // Stage 3c-hotfix: load receipts work with or without audio — same contract.
      if (msg.received !== events.length || msg.loaded !== events.length || msg.skipped !== 0 || msg.firstErrorIndex !== -1) {
        fail(`loadAck receipt mismatch: ${JSON.stringify(msg)}`);
      }
      loadAckOk = true;
      console.log(`[test] loadAck receipt OK (${events.length}/${events.length} loaded, 0 skipped, byteSize ${msg.byteSize})`);
    } else if (msg.type === "state" && loadOk && !noDeviceErrOk && msg.playing === true) {
      // Runner unexpectedly HAS a device — the graceful-error proof is void.
      fail("engine started playing — runner has an audio device; device-less assumption broken");
    } else if (msg.type === "state" && !loadOk) {
      if (msg.playing === false && loadAckOk) {
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
  } else if (mode === "scale") {
    // ── Stage 3c-hotfix: real-project-sized load + receipt round-trip ──
    if (msg.type === "hello" && scalePhase === "handshake") {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      ws.send(JSON.stringify({ type: "ping" }));
    } else if (msg.type === "pong" && scalePhase === "handshake") {
      pongOk = true;
      scalePhase = "scale-ack";
      console.log(`[test] sending SCALE load: ${SCALE_SENT} events, ${SCALE_SENT_BYTES} bytes (one message, seq 1001)`);
      ws.send(scalePayload);
    } else if (msg.type === "loadAck" && scalePhase === "scale-ack") {
      // THE receipt round-trip: what the engine parsed must equal what was
      // sent — byte-for-byte on the size, event-for-event on the counts.
      if (msg.seq !== 1001) fail(`scale loadAck.seq must echo 1001, got ${msg.seq}`);
      if (msg.received !== SCALE_SENT) fail(`scale receipt: received ${msg.received} != sent ${SCALE_SENT} — EVENTS LOST IN TRANSIT/PARSE`);
      if (msg.loaded !== SCALE_SENT) fail(`scale receipt: loaded ${msg.loaded} != sent ${SCALE_SENT} — EVENTS REJECTED SILENTLY`);
      if (msg.skipped !== 0 || msg.firstErrorIndex !== -1) fail(`scale receipt: unexpected skips: ${JSON.stringify(msg)}`);
      if (msg.byteSize !== SCALE_SENT_BYTES) fail(`scale receipt: byteSize ${msg.byteSize} != sent ${SCALE_SENT_BYTES} — PAYLOAD TRUNCATED/CORRUPTED`);
      scaleAckOk = true;
      console.log(`[test] scale loadAck OK: ${SCALE_SENT} events round-tripped exactly (${SCALE_SENT_BYTES} bytes == bytes)`);
      scalePhase = "neg-array";
      console.log("[test] negative A: load with events NOT an array — must be REJECTED (bad_load), not silently emptied");
      ws.send(JSON.stringify({ type: "load", seq: 1002, events: "not-an-array", meta }));
    } else if (msg.type === "error" && scalePhase === "neg-array") {
      if (msg.code !== "bad_load") fail(`negative A: expected bad_load, got ${msg.code}`);
      if (msg.echo !== "load") fail(`negative A: expected echo "load", got "${msg.echo}"`);
      negArrayOk = true;
      console.log(`[test] negative A OK: non-array events → bad_load (detail: "${msg.detail ?? ""}") — silent-empty-score path CLOSED`);
      scalePhase = "neg-event";
      const malformed = [
        { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 0 },
        { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 960 },
        { eventType: "NOTE_ON", channel: 1, data1: 64, data2: 100, timestampTicks: 960 },
        // Index 3 — the "one unserializable event" class: a null where a
        // number belongs (JSON.stringify renders NaN as null too).
        { eventType: "NOTE_ON", channel: 1, data1: 67, data2: 100, timestampTicks: null },
      ];
      console.log("[test] negative B: load with one malformed event (timestampTicks:null at index 3) — must be NAMED, not swallowed");
      ws.send(JSON.stringify({ type: "load", seq: 1003, events: malformed, meta }));
    } else if (msg.type === "loadAck" && scalePhase === "neg-event") {
      if (msg.seq !== 1003) fail(`negative B loadAck.seq must echo 1003, got ${msg.seq}`);
      if (msg.received !== 4) fail(`negative B: received ${msg.received} != 4`);
      if (msg.loaded !== 3) fail(`negative B: loaded ${msg.loaded} != 3`);
      if (msg.skipped !== 1) fail(`negative B: skipped ${msg.skipped} != 1`);
      if (msg.firstErrorIndex !== 3) fail(`negative B: firstErrorIndex ${msg.firstErrorIndex} != 3`);
      if (!msg.firstErrorReason || msg.firstErrorReason.length === 0) fail("negative B: firstErrorReason must name the problem");
      negEventOk = true;
      console.log(`[test] negative B OK: skipped=1, firstErrorIndex=3 ("${msg.firstErrorReason}") — offending event NAMED`);
      scalePhase = "restore";
      console.log("[test] restoring clean small load (seq 1004)");
      ws.send(JSON.stringify({ type: "load", seq: 1004, events, meta }));
    } else if (msg.type === "loadAck" && scalePhase === "restore") {
      if (msg.seq !== 1004 || msg.received !== events.length || msg.loaded !== events.length || msg.skipped !== 0) {
        fail(`restore receipt mismatch: ${JSON.stringify(msg)}`);
      }
      restoreOk = true;
      scalePhase = "play";
      console.log("[test] restore OK — sending transport play (transport contract re-verified post-scale)");
      ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
    } else if (msg.type === "state" && scalePhase === "play") {
      if (msg.playing === true) {
        scalePlayOk = true;
        scalePhase = "playing";
        scaleStateFrames = 1;
        scaleFirstTick = msg.tick;
        scaleLastTick = msg.tick;
        console.log("[test] transport play OK at scale — expecting ticks to ADVANCE");
      }
    } else if (msg.type === "state" && scalePhase === "playing") {
      scaleStateFrames++;
      scaleLastTick = msg.tick;
      if (scaleStateFrames >= 3 && scaleLastTick > scaleFirstTick) {
        scaleTicksOk = true;
        scaleStopOk = true;
        console.log(`[test] ticks ADVANCE at scale (${scaleFirstTick} → ${scaleLastTick} over ${scaleStateFrames} frames) — sending transport stop`);
        ws.send(JSON.stringify({ type: "transport", command: "stop" }));
        scalePhase = "stopping";
      }
    } else if (msg.type === "state" && scalePhase === "stopping") {
      if (msg.playing === false) {
        scalePanicOk = true;
        console.log("[test] transport stop OK — sending panic");
        ws.send(JSON.stringify({ type: "panic" }));
        scalePhase = "done";
        setTimeout(finishAndShutdown, 200);
      }
    } else if (msg.type === "error" && scalePhase !== "neg-array") {
      fail(`scale mode: unexpected error ${msg.code} in phase ${scalePhase}`);
    }
    return;
  }
});

ws.addEventListener("close", () => {
  clearTimeout(timeout);
  console.log("[test] connection closed");
  let allOk;
  if (mode === "null-audio") {
    // Stage 3c close-out — the dispatch-ledger contract, evaluated once the
    // stream is complete: (1) the PAST events (tick 0/300, pitch 48) must
    // NEVER dispatch — play(tick 480) and the resume at ~stopTick must both
    // skip them (the F4-clamp replay burst is fixed); (2) the straddling
    // note (480→1440) must be GENTLY RE-ATTACKED on the resume: vel capped
    // at 80 (original 100/88), sample 0, ledger t = the resume tick.
    noReplay48Ok = !ledgerEntries.some((e) => (e.k === 0 || e.k === 1) && e.a === 48);
    reattackOk = ledgerEntries.some((e) => e.k === 1 && e.a === 60 && e.b === 80 && e.s === 0 && e.t === stopTick);
    if (!noReplay48Ok) console.error(`FAIL: past events REPLAYED — pitch 48 appears ${ledgerEntries.filter((e) => (e.k === 0 || e.k === 1) && e.a === 48).length}× in the dispatch ledger (resume-replay burst)`);
    if (!reattackOk) console.error(`FAIL: no gentle re-attack of pitch 60 (vel 80, s=0, t=${stopTick}) — resume straddle handling broken`);
    allOk = helloOk && pongOk && errorOk && loadAckOk && loadOk && play1Ok && adv1Ok && stopOk && play2Ok && adv2Ok && panicOk && noReplay48Ok && reattackOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL PROTOCOL TESTS PASSED (null-audio):");
      console.log("  v1: hello, ping->pong, unknown->error, shutdown");
      console.log("  v1 ext: load + loadAck receipt, transport play, state@30Hz, transport stop, panic");
      console.log("  3c-hotfix: load receipt names received/loaded/skipped/byteSize");
      console.log(`  3b-fix: play on null device OK, state ticks ADVANCED (${first1} → ${last1})`);
      console.log(`  3b-polish RESUME: play(tick 480) started at ${first1} (NOT 0)`);
      console.log(`           stop KEPT position (tick ${stopTick})`);
      console.log(`           play WITHOUT tick RESUMED at ${first2} (stopped at ${stopTick}, NOT 0)`);
      console.log(`           ticks advanced after resume (${first2} → ${last2})`);
      console.log("  3c close-out: NO past-event replay (pitch 48 never dispatched);");
      console.log(`           straddling note GENTLY re-attacked on resume (vel 80 @ s=0, t=${stopTick})`);
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} pong=${pongOk} error=${errorOk} loadAck=${loadAckOk} load=${loadOk} play1=${play1Ok} adv1=${adv1Ok} stop=${stopOk} play2=${play2Ok} adv2=${adv2Ok} panic=${panicOk} noReplay48=${noReplay48Ok} reattack=${reattackOk}`);
      process.exit(1);
    }
  } else if (mode === "multi") {
    const expectAll = (n) => Object.values(multiLoadedCount).reduce((a, b) => a + b, 0) >= n;
    const capsOk = Object.keys(multiCapsCount).length >= 3 &&
      Object.entries(multiCapsCount).every(([k, v]) => v === (multiLoadedCount[k] ?? 0));
    allOk = multiScanPlugin && multiScanPluginB &&
      (multiLoadedCount["inst-a"] ?? 0) >= 5 && (multiLoadedCount["inst-b"] ?? 0) >= 5 &&
      (multiLoadedCount["inst-c"] ?? 0) === 3 && (multiLoadedCount["inst-d"] ?? 0) >= 3 &&
      multiAckSeqs.has(1) && multiAckSeqs.has(2) && multiAckSeqs.has(3) && multiAckSeqs.has(4) && multiAckSeqs.has(5) &&
      capsOk && multiPeak > 1.0 &&
      multiWide[1] > 0 && multiWide[17] > 0 && multiWide[33] > 0 && multiWide[49] > 0 &&
      (multiHeadlessSkip || (multiEdOpenA && multiEdOpenB && multiEdFocus && multiEdCloseA && multiEdCloseB)) &&
      multiCapIds.has("inst-a") && multiCapIds.has("inst-b") && multiCapIds.has("inst-d");
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL M2 MULTI-INSTANCE TESTS PASSED (diff-based reuse + per-instance routing):");
      console.log(`  3 instances hosted (a/b/c = Synth A), summed peak ${multiPeak.toFixed(3)} > 1.0 single-source cap`);
      console.log(`  routing isolation (engine side): wide channels c=1 ×${multiWide[1]}, c=17 ×${multiWide[17]}, c=33 ×${multiWide[33]}, c=49 ×${multiWide[49]} (part X reaches ONLY instance X)`);
      console.log(`  loaded-echo counts (initial + per-diff re-echo): ${JSON.stringify(multiLoadedCount)}`);
      console.log("  seq 2 CHANGED (b→Synth B), seq 3 ADDED (d), seq 4 REMOVED (c), seq 5 score-edit reuse — all five seqs ACKed with full echo sets");
      console.log(`  capabilities 1:1 with loads: ${JSON.stringify(multiCapsCount)}`);
      console.log(multiHeadlessSkip
        ? "  editors: SKIPPED on this headless host (editor_unavailable tolerated; Windows CI proves the window path)"
        : "  editors: inst-a + inst-b SIMULTANEOUS windows, repeat RAISES, per-id closes");
      console.log(`  per-instance captures: ${[...multiCapIds].join(", ")}`);
      console.log("  engine.log grammar (set diff/instance kept-added-removed-changed/exactly-one terminals/plugin-side ordinals): asserted by desktop.yml");
      console.log("========================================");
    } else {
      console.error(`FAILED: loaded=${JSON.stringify(multiLoadedCount)} acks=${[...multiAckSeqs].join(",")} caps=${JSON.stringify(multiCapsCount)} peak=${multiPeak.toFixed(3)} wide=${JSON.stringify(multiWide)} editors=${multiEdOpenA}/${multiEdOpenB}/${multiEdFocus}/${multiEdCloseA}/${multiEdCloseB} headless=${multiHeadlessSkip} captures=${[...multiCapIds].join(",")}`);
    }
  } else if (mode === "latency") {
    // ── Stage 3i close-time validation ──
    // The reuse receipts' latencyMs sequence IS the wire proof:
    //   #1 initial 128 → #2 (CC 1024 armed, pre-correction) 128 →
    //   #3 (after the 1024 correction) 1024 → #4 (after the 0 correction) 0 →
    //   #5 (after the SILENT 2048 correction — timer + debounce) 2048 →
    //   #6 (after the flicker settles at 1024 + drains) 1024.
    const expect = [128, 128, 1024, 0, 2048, 1024];
    const countOk = latLoadedReceipts.length === 6;
    const seqOk = countOk && expect.every((s, i) =>
      Math.abs(latLoadedReceipts[i] - latLatencyMs(s)) <= 0.5);
    // Transport continuity: the final tick must be past EVERY CC's dispatch
    // tick — the transport kept rolling through all five correction windows.
    const ticksOk = [11, 12, 13, 14, 15].every((sq) =>
      latLastTick > (latTickAtLoad[sq] ?? Number.MAX_SAFE_INTEGER) + 960);
    // Phase 2 (downbeat-late pre-roll) — the WIRE proof: the score's tick-0
    // NOTE_ON (ch1, plugin-routed, the play-time max latency is the
    // fixture's 128) must have PRE-FIRED into the muted pre-roll window at
    // s = -128 with the tick clamped to the start tick (0), and the old
    // clamp-to-0 dispatch must be GONE (a downbeat dispatched at s=0 lands
    // 128 samples late — the defect this stage fixes).
    const prefire = latLedger.find((e) => e.k === 1 && e.c === 1 && e.a === 60 && e.s === -128);
    const clamped0 = latLedger.some((e) => e.k === 1 && e.c === 1 && e.a === 60 && e.s === 0);
    if (!prefire) fail(`phase-2 pre-fire proof missing: no tick-0 NOTE_ON dispatched at s=-128 (pre-roll broken?) — ledger head: ${JSON.stringify(latLedger.slice(0, 8))}`);
    if (clamped0) fail("phase-2: the tick-0 NOTE_ON dispatched at s=0 — the downbeat-late clamp is back");
    if (prefire && prefire.t !== 0) fail(`phase-2: the pre-fired NOTE_ON carries t=${prefire.t}, expected the clamped start tick 0`);
    allOk = helloOk && countOk && seqOk && ticksOk && !latErrorAfterLoad && latPhase >= 4 && !!prefire && !clamped0;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL RUNTIME-LATENCY TESTS PASSED (3i):");
      console.log("  detected+republished: 128->1024 (notified), 1024->0 (notified), 0->1024->2048 (rapid pair — the 2048 enqueue rate-limited, landed by the 2000ms safety-net walk), flicker 0<->1024 rate-limited to settle 1024");
      console.log(`  reuse receipt latencyMs chain: [${latLoadedReceipts.map((v) => v.toFixed(2)).join(", ")}] — every correction survived a mid-play load (no re-instantiate)`);
      console.log(`  transport continuity: tick ${latLastTick} past every CC dispatch tick; playing never dropped; no error mid-sequence`);
      console.log(`  phase-2 downbeat pre-roll: tick-0 NOTE_ON pre-fired at s=${prefire ? prefire.s : "?"} (t=${prefire ? prefire.t : "?"}) — the audible attack lands on the grid; engine.log [transport] pre-roll receipt asserted by desktop.yml`);
      console.log("  engine.log receipts ([latency] republish old->new, deferred rate-limit, publish summaries) asserted by desktop.yml");
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} receipts=${latLoadedReceipts.length}/6 chain=[${latLoadedReceipts.map((v) => v.toFixed(2)).join(", ")}] expectMs=[${expect.map((s) => latLatencyMs(s).toFixed(2)).join(", ")}] ticks=${ticksOk}(last=${latLastTick}) err=${latErrorAfterLoad} phase=${latPhase}`);
      process.exit(1);
    }
  } else if (mode === "host") {
    // ── Stage 3e-1 capability-handshake asserts (close time, full stream) ──
    if (!hostFirstCaps) fail("no plugin_capabilities received — the capability handshake never happened");
    const capsForHosted = hostCapsCount["hosted"] ?? 0;
    const loadedForHosted = hostLoadedCount["hosted"] ?? 0;
    if (capsForHosted !== loadedForHosted) fail(`plugin_capabilities arrived ${capsForHosted}× but plugin_state loaded ${loadedForHosted}× for instance "hosted" — the handshake must be EXACTLY ONCE per instance`);
    const c = hostFirstCaps;
    if (c.inputBuses !== 0) fail(`capability record: inputBuses ${c.inputBuses} ≠ 0 (the test plugin has no input buses)`);
    if (c.outputBuses !== 2) fail(`capability record: outputBuses ${c.outputBuses} ≠ 2 (the fixture ships main "Output" + aux "Aux Out", 3e-3)`);
    if ((c.buses ?? []).length !== c.inputBuses + c.outputBuses) fail("capability record: buses[] length must equal inputBuses + outputBuses (every bus reported)");
    const mainOut = (c.buses ?? []).find((b) => !b.input && b.isMain);
    if (!mainOut) fail("capability record: no main OUTPUT bus entry");
    if (mainOut.name !== "Output") fail(`capability record: main out bus name "${mainOut.name}" ≠ "Output"`);
    if (mainOut.channels !== 2) fail(`capability record: main out channels ${mainOut.channels} ≠ 2 (stereo)`);
    if (mainOut.enabledByDefault !== true) fail("capability record: the test plugin's main out must be enabled by default");
    const auxOut = (c.buses ?? []).find((b) => !b.input && !b.isMain);
    if (!auxOut) fail("capability record: no aux OUTPUT bus entry (3e-3)");
    if (auxOut.name !== "Aux Out" || auxOut.channels !== 2) fail(`capability record: aux out must be "Aux Out" 2ch, got "${auxOut.name}" ${auxOut.channels}ch`);
    if (!c.classId || c.classId !== hostClassId) fail(`capability record classId must be non-empty and equal the plugin_state classId (got "${c.classId}", want "${hostClassId}")`);
    if (c.latencySamples !== 128) fail(`capability record latencySamples ${c.latencySamples} ≠ the fixture's reported 128`);
    if (c.isInstrument !== true || c.acceptsMidi !== true || c.producesMidi !== false || c.hasEditor !== true) {
      fail(`capability record identity flags wrong: ${JSON.stringify({ isInstrument: c.isInstrument, acceptsMidi: c.acceptsMidi, producesMidi: c.producesMidi, hasEditor: c.hasEditor })}`);
    }
    // numPrograms through the VST3 host wrapper is wrapper-dependent (JUCE-built
    // modules report 0 until they publish a ProgramList) — assert SHAPE, not the
    // inner value (documented in ASSUMPTIONS.md 3e-1).
    if (typeof c.numPrograms !== "number" || c.numPrograms < 0 || !Number.isInteger(c.numPrograms)) {
      fail(`capability record numPrograms must be a non-negative integer, got ${JSON.stringify(c.numPrograms)}`);
    }
    allOk = helloOk && hostScanSent && hostHwndSetOk && hostPluginStateOk && hostPhase >= 13 &&
            hostReloadAckOk && hostRejectOk && hostDiffLoadedOk && hostPlayingAfterReject;   // M2 mid-play diff
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL HOSTING TESTS PASSED (3c-2 + 3c close-out, stand-in host):");
      console.log('  plugin host by id: scan → load(uid,path) → plugin_state loaded');
      console.log('  M2 mid-play diff: same-set reuse ACKED; CHANGED binary (Synth A→B) applied while rolling; transport continuous');
      console.log(`  latency: ${hostLatency}ms (<100ms pinned CI assertion)`);
      console.log(`  pre-trigger: CC#32 at t=442, note at t=480 — 38 ticks (${hostDeltaSamples} samples ≈ 20ms) sample-accurate`);
      console.log('  channel routing: ch1 + ch2 dispatched (plugin stdout cross-checked in CI)');
      console.log(`  mute/solo gating AUDIBLE: peaks A/B/C = ${hostPeakA.toFixed(3)} / ${hostPeakB.toFixed(3)} / ${hostPeakC.toFixed(3)}`);
      console.log('  muted-window note never dispatched; unmute restores sound');
      console.log(`  MUSICAL stops at ticks ${hostStopTick1}/${hostStopTick2}: release marker + exact held-note offs, NO CC120`);
      console.log(`  RESUME: gentle re-attacks (vel 80) + redundant CC#32 SUPPRESSED (k=6) + genuine change SENT`);
      console.log(`  3e-1 handshake: plugin_capabilities ×${capsForHosted} == plugin_state loaded ×${loadedForHosted} ("hosted"); main out "Output" 2ch + aux "Aux Out" 2ch (3e-3); classId echo + identifier-string reload MATCHED`);
      console.log(`  3e-3 multi-output: default routing peak ${Math.max(...moPeaksDefault).toFixed(3)} = main+aux; aux muted via outputRouting peak ${Math.max(...moPeaksMuted).toFixed(3)} = main only`);
      console.log(hostHeadlessSkip
        ? "  editors: SKIPPED on this headless host (editor_unavailable tolerated; Windows CI proves the window path)"
        : "  editors: open → repeat RAISES (focused, one editor per instance) → clean close");
      console.log(`  3f-3a owned editors: setHostWindow echoed (hwnd=${hostHwnd}) — Windows CI additionally greps the "[editor] host-owner applied hwnd=0x…” receipt`);
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} scan=${hostScanSent} hostHwnd=${hostHwndSetOk} pluginState=${hostPluginStateOk} phase=${hostPhase} peaks=${hostPeakA.toFixed(3)}/${hostPeakB.toFixed(3)}/${hostPeakC.toFixed(3)} caps=${capsForHosted}/${loadedForHosted}`);
      process.exit(1);
    }
  } else if (mode === "scan") {
    allOk = helloOk && scanSent && scanResultOk && aliveAfterCrashOk && scanProbesAsserted && postProbePongOk && defaultScanOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL SCAN TESTS PASSED (3c-1 + 3f-2):");
      console.log('  scan protocol: scan → scan_result (plugins/failed/scannedDirs)');
      console.log('  valid test VST3 found with real name + vendor + uid + classId');
      console.log('  3f-2 SPLIT: rows carry NO capabilities — describe is findAllTypesForFile only');
      console.log('  3f-2 RECURSIVE SCAN: nested plugin (3 levels) found exactly ONCE (classId dedup across dirs)');
      console.log('  CRASH ISOLATION: worker crash → failed entry with exitCode+elapsedMs+stderrTail');
      console.log('  corrupt .vst3 → graceful zero types (no failed entry)');
      console.log('  3f-2 PROBES: synth=capabilities, probe-crash=isolated error, probe-hang=90s timeout error');
      console.log('  probe failures NEVER remove rows (rows went out with scan_result, untouched by probes)');
      console.log('  default-dir scan → clean (possibly empty) result');
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} scanSent=${scanSent} scanResult=${scanResultOk} aliveAfterCrash=${aliveAfterCrashOk} probes=${Object.keys(scanProbes).length}/3 asserted=${scanProbesAsserted} postProbePong=${postProbePongOk} defaultScan=${defaultScanOk}`);
      process.exit(1);
    }
  } else if (mode === "scale") {
    allOk = helloOk && pongOk && scaleAckOk && negArrayOk && negEventOk && restoreOk && scalePlayOk && scaleTicksOk && scaleStopOk && scalePanicOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL PROTOCOL TESTS PASSED (scale):");
      console.log(`  3c-hotfix scale: ${SCALE_SENT} events / ${SCALE_SENT_BYTES} bytes sent == received == loaded, 0 skipped, byteSize exact`);
      console.log("  negative A: non-array events → bad_load (silent-empty-score path CLOSED)");
      console.log("  negative B: malformed event → skipped, firstErrorIndex=3 NAMED");
      console.log(`  transport contract re-verified post-scale: ticks ADVANCED (${scaleFirstTick} → ${scaleLastTick})`);
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} pong=${pongOk} scaleAck=${scaleAckOk} negArray=${negArrayOk} negEvent=${negEventOk} restore=${restoreOk} play=${scalePlayOk} ticks=${scaleTicksOk} stop=${scaleStopOk} panic=${scalePanicOk}`);
      process.exit(1);
    }
  } else if (mode === "slowload") {
    allOk = helloOk && slScanPlugin != null && slAckOk && slLoadedOk && slPlayOk && slTicksOk && slStopOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL SLOW-LOAD TESTS PASSED (M1-hotfix heavy-load class):");
      console.log(`  loadAck ${slAckMs} ms after send (< 3000) — the async ack contract holds while the fixture constructor sleeps ${SLOW_CREATE_S} s`);
      console.log(`  plugin_state loaded ${slLoadedMs} ms after send (>= ${SLOW_TOTAL_MS} floor) — the full ${SLOW_CREATE_S}s create + ${SLOW_PREPARE_S}s worker prepare ran to completion`);
      console.log(`  engine alive behind the heavy load: tick advanced, peak ${slPeak.toFixed(3)}, clean stop`);
      console.log("  engine.log side: desktop.yml asserts every [mm] window RECOVERED, <= 2 windows, and none after the commit");
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} scan=${slScanPlugin ? "ok" : "none"} ack=${slAckOk}(${slAckMs}ms) loaded=${slLoadedOk}(${slLoadedMs}ms) play=${slPlayOk} ticks=${slTicksOk} stop=${slStopOk} phase=${slPhase}`);
      process.exit(1);
    }
  } else if (mode === "terminal") {
    allOk = helloOk && trScanPlugin != null && trJamAckFast && trJamErr && trQueuedErr &&
        trCleanLoaded && trPlayTicks && trReuseCount === 2 && trSuppLoaded && trBogus2Err &&
        (trEditorOpenOk || trHeadlessSkip);
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL TERMINAL-RECEIPT TESTS PASSED (0.9.2 invariant):");
      console.log(`  jammed init (seq 10, create ${TR_JAM_S}s): loadAck ${trJamAckMs} ms (< 3000) — the async ack contract holds behind the jam`);
      console.log("  watchdog declarations on the wire: seq 10 terminal-timeout + seq 11 queued-behind-jammed-init");
      console.log("  clean reload (seq 12) loaded + playable after the jam; the abandoned result was discarded");
      console.log(`  editor reopen decoupled from load: ${trHeadlessSkip ? "headless (editor_unavailable tolerated; Windows CI proves the window)" : "editor opened + closed after a mid-play reuse + the load-carried openEditor intent"}`);
      console.log("  coalescing: seq 21 folded into seq 20's in-flight init (one instantiate for both)");
      console.log("  classic supersede: seq 40 superseded by seq 41; seq 41 failed on the bogus path");
      console.log("  engine.log side: desktop.yml counts EXACTLY ONE terminal receipt per seq (10,11,12,20,21,40,41) + the stage/pending receipts");
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} scan=${trScanPlugin ? "ok" : "none"} jamAck=${trJamAckFast}@${trJamAckMs}ms jamErr=${trJamErr} queuedErr=${trQueuedErr} clean=${trCleanLoaded} ticks=${trPlayTicks} reuse=${trReuseCount}/2 supp=${trSuppLoaded} bogus2=${trBogus2Err} edOpen=${trEditorOpenOk} headless=${trHeadlessSkip} phase=${trPhase}`);
      process.exit(1);
    }
  } else {
    allOk = helloOk && pongOk && loadAckOk && loadOk && noDeviceErrOk && pongAfterErrOk && stillFunctionalOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL PROTOCOL TESTS PASSED (no-device):");
      console.log("  play WITHOUT a device → graceful no_audio_device error (no crash)");
      console.log("  load receipt (loadAck) still delivered without audio");
      console.log("  engine stayed protocol-functional: ping->pong, stop, seek, panic, shutdown");
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: hello=${helloOk} pong=${pongOk} loadAck=${loadAckOk} load=${loadOk} noDeviceErr=${noDeviceErrOk} pongAfterErr=${pongAfterErrOk} stillFunctional=${stillFunctionalOk}`);
      process.exit(1);
    }
  }
});

ws.addEventListener("error", (err) => {
  console.error("[test] WS error:", err.message ?? err);
  process.exit(1);
});
