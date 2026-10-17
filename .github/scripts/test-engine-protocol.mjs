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
//         score CC#22; default routing sums main+aux into the master (peak
//         ≈1.287), outputRouting [{busIndex:1,mute:true}] leaves main only
//         (peak ≈0.787) — both proven by peaks (phases MO-1..MO-5).
//       Stage 3d-3: state persistence — captureState of the DEFAULT state is
//         byte-EXACT (the fixture's state is one raw float32 masterScale,
//         4 bytes = 1.0f); a re-host WITH an embedded state (masterScale
//         0.5) must APPLY it (the play peak HALVES to ≈0.787) and the
//         capture→restore→capture round-trip must be byte-IDENTICAL — the
//         proof that a project-embedded state survives a restart.
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

// ─── Stage 3d-4: MULTI-INSTANCE mode (argv[3]="multi", argv[4]=fixture dir) ──
// The universal-hosting completion proof, against the SAME free test VST3
// hosted TWICE under DIFFERENT instance ids (no plugin-name logic anywhere —
// the second instance is the SAME binary; universality is the point):
//   plugins[]  = [{instanceId:"inst-a",...},{instanceId:"inst-b",...}]
//   routing    = {t1:{inst:"inst-a",ch:1}, t2:{inst:"inst-b",ch:1}}  ← SAME wire
//                channel 1 on BOTH instances (per-instance namespaces prove
//                independently — internally wide channels 1 and 17).
// Asserts, all over the wire:
//   TWO plugin_state loaded receipts, each with its instanceId + channels [1];
//   BOTH instances audible: the summed peak EXCEEDS the single-instance
//     maximum (1.574 pinned by host mode) — one instance alone cannot;
//   dispatch ledger carries BOTH wide channels (c=1 inst-a, c=17 inst-b) —
//     per-instance routing is REAL, not a receipt claim;
//   mid-play SAME-set reload → reuse receipts per instance (no re-instantiate);
//   mid-play CHANGED-set load (only inst-a) → load_rejected (rolling guard);
//   editors: openEditor inst-b OPENS (Windows CI; headless runs tolerate
//     editor_unavailable "no display"), a repeat RAISES (focused), inst-a
//     opens a SECOND SIMULTANEOUS window, each closes by id;
//   captureState → one pluginSavedState PER INSTANCE (distinct instanceIds);
//   Stage 3f-6 PUBLISH-SAFE phase (M-13..M-17): the slow-state marker file
//     (SCORCH_TESTVST_SLOWSTATE_FILE, engine-process env) is created mid-
//     session, so every PREPARED test-synth instance's getStateInformation
//     stalls 10 s — the stand-in for the real Falcon/BBCSO hang (JUCE's
//     creation-time state handshake stays fast: a being-created instance is
//     not prepared yet). A replace load retires TWO live slow instances;
//     the assertions are: the NEW set's plugin_state loaded receipts arrive
//     < 5 s after the load (the 3f-6 reorder — they precede the captures),
//     a FOLLOWING load is processed (the pre-fix worker wedged forever after
//     "init started (async)"; post-fix it waits for the message thread to
//     drain the unkillable 10 s stalls — JUCE's createPluginInstance also
//     round-trips through it), the deferred captures' pluginSavedState
//     broadcasts all land (the drain proof), and a post-drain load proves
//     the fast capture path still ENDS (not TIMEOUTS).
//   clean shutdown.
const MULTI_META = { bpm: 120, ppqn: 960, timeSignature: { numerator: 4, denominator: 4 }, endTick: 8448 };
const multiEvents = [
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 7, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 11, data2: 127, timestampTicks: 0, trackId: "t1" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 7, data2: 127, timestampTicks: 0, trackId: "t2" },
  { eventType: "CONTROL_CHANGE", channel: 1, data1: 11, data2: 127, timestampTicks: 0, trackId: "t2" },
  { eventType: "NOTE_ON", channel: 1, data1: 60, data2: 100, timestampTicks: 480, trackId: "t1" },
  { eventType: "NOTE_OFF", channel: 1, data1: 60, data2: 0, timestampTicks: 8448, trackId: "t1" },
  { eventType: "NOTE_ON", channel: 1, data1: 67, data2: 100, timestampTicks: 960, trackId: "t2" },
  { eventType: "NOTE_OFF", channel: 1, data1: 67, data2: 0, timestampTicks: 8448, trackId: "t2" },
];
let multiPhase = 0, multiScanSent = false;
let multiScanPlugin = null;
const multiReloadSame = () => ({
  type: "load", seq: 2, events: multiEvents, meta: MULTI_META,
  plugins: [
    { instanceId: "inst-a", uid: multiScanPlugin.uid, path: multiScanPlugin.path, name: multiScanPlugin.name },
    { instanceId: "inst-b", uid: multiScanPlugin.uid, path: multiScanPlugin.path, name: multiScanPlugin.name },
  ],
  routing: { t1: { inst: "inst-a", ch: 1 }, t2: { inst: "inst-b", ch: 1 } },
});
const multiReloadChanged = () => ({
  type: "load", seq: 3, events: multiEvents, meta: MULTI_META,
  plugins: [
    { instanceId: "inst-a", uid: multiScanPlugin.uid, path: multiScanPlugin.path, name: multiScanPlugin.name },
  ],
  routing: { t1: { inst: "inst-a", ch: 1 }, t2: { inst: "inst-a", ch: 2 } },
});
let multiStateOk = 0, multiLoaded = new Set(), multiReuseOk = 0, multiRejectOk = false;
let multiPeak = 0, multiLedger = [], multiWideA = false, multiWideB = false;
let multiEdOpenB = false, multiEdFocusB = false, multiEdOpenA = false, multiEdCloseA = false, multiEdCloseB = false;
let multiCapIds = new Set(), multiHeadlessSkip = false;
// Stage 3e-1: capability handshake per instance (loaded receipts and
// capabilities must match 1:1 for BOTH instances — initial load + reuse).
const multiCapsCount = {};
const multiLoadedCount = {};
// Stage 3f-6 publish-safe phase: the marker file the ENGINE's env var names
// (its existence makes every test-synth getStateInformation stall 10 s),
// plus the send timestamps of the two probe loads. The env var is set by
// desktop.yml for the ENGINE process AND inherited by this script, so both
// sides agree on the exact path; the tmpdir default covers local runs.
const multiSlowMarker = process.env.SCORCH_TESTVST_SLOWSTATE_FILE || path.join(os.tmpdir(), "scorch-3f6-slowstate.marker");
let multiTSlowLoad = 0, multiTFastLoad = 0, multiTFinalLoad = 0;
// Stage 3f-6 drain-wait: the stalled retire captures complete LATER on the
// message thread (each stall occupies the MM for its full 10 s — unkillable
// from the host side, exactly like the real Falcon symptom) and each
// completion broadcasts its pluginSavedState. JUCE's createPluginInstance
// ALSO round-trips through the message thread, so a following load's
// instantiate can only run once the MM has drained. The final probe load is
// therefore sent only after ALL THREE deferred captures (inst-a + inst-b
// from seq 4, inst-slow from seq 5) have been seen — the drain proof.
const multiDrainTargets = new Set(["inst-a", "inst-b", "inst-slow"]);
const multiDrained = new Set();

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
    console.error(`TIMEOUT at step ${step} phase=${multiPhase} (scan=${multiScanPlugin ? "ok" : "none"} loaded=${[...multiLoaded].join(",")} reuse=${multiReuseOk} reject=${multiRejectOk} peak=${multiPeak.toFixed(3)} wideA=${multiWideA} wideB=${multiWideB} editors=${multiEdOpenB}/${multiEdFocusB}/${multiEdOpenA}/${multiEdCloseA}/${multiEdCloseB} headlessSkip=${multiHeadlessSkip} captures=${[...multiCapIds].join(",")} entries=${multiLedger.length})`);
  } else {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} load=${loadOk} noDeviceErr=${noDeviceErrOk} pongAfterErr=${pongAfterErrOk} stillFunctional=${stillFunctionalOk})`);
  }
  process.exit(1);
// 3f-2: scan mode now waits out the ProbeHangDummy 90 s probe timeout (plus
// the describe stage and the fast probes) — 180 s budget. 3f-6: multi mode
// grows the publish-safe phase (slow-capture replace + following load) whose
// 10 s message-thread stalls run ASYNCHRONOUSLY to the assertions — the 5 s
// loaded-receipt bound is asserted EXPLICITLY per phase below — but the
// wall-clock budget still covers them: 90 s.
}, mode === "scan" ? 180000 : mode === "host" ? 60000 : mode === "multi" ? 90000 : 30000);

// scan-mode flags
let scanSent = false, scanResultOk = false, aliveAfterCrashOk = false, defaultScanOk = false;
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
  // (= stop 1's tick), dispatched at sample 0 of the resume buffer. Pitch 62
  // (gated at its grid time, audible again after the unmute) re-attacks too —
  // the straddle scan works on the authored score; the CURRENT mute state
  // decides audibility (the same unmute-restores-sound contract as phase C).
  for (const [ch, pitch] of [[1, 60], [1, 62], [2, 64], [2, 67]]) {
    const re = hostEntries.find((e) => e.k === 1 && e.c === ch && e.a === pitch && e.b === 80 && e.s === 0 && e.t === hostStopTick1);
    if (!re) fail(`resume: no GENTLE re-attack of ch${ch} pitch ${pitch} (vel 80, s=0, t=${hostStopTick1}) — straddling sustain not resumed`);
  }
  // No replay burst: NO past event may re-dispatch at the resume buffer. The
  // pre-resume note-ons (480/960/6144... plus the ORIGINAL vel-100 sends) must
  // not reappear with s=0 at the resume tick.
  const burst = hostEntries.filter((e) => e.s === 0 && e.t === hostStopTick1 && e.b === 100);
  if (burst.length > 0) fail(`resume: ${burst.length} FULL-VELOCITY events re-dispatched at sample 0 of the resume buffer — the replay burst is back`);
  // Redundant CC#32 suppressed (ledger kind 6) at its compensated position.
  const suppressed = hostEntries.find((e) => e.k === 6 && e.c === 1 && e.a === 32 && e.b === 42 && e.t === dispatchTick(7200));
  if (!suppressed) fail(`resume: CC#32=42@7200 was not SUPPRESSED (expected a kind-6 record at t=${dispatchTick(7200)}) — the bow-scrape pluck is back`);
  // Genuine change SENT at its compensated position.
  const sent = hostEntries.find((e) => e.k === 2 && e.c === 1 && e.a === 32 && e.b === 20 && e.t === dispatchTick(7600));
  if (!sent) fail(`resume: genuine CC#32 change (42→20) not dispatched at t=${dispatchTick(7600)} — articulation suppression is over-eager`);
  console.log(`[test] resume ✓ 3 gentle re-attacks (vel 80 @ s=0, t=${hostStopTick1}); CC#32=42@7200 SUPPRESSED (k=6); genuine CC#32=20@7600 SENT`);
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

// Stage 3f-6: when the message thread has DRAINED (all three deferred
// retire-capture broadcasts seen) and the marker is disarmed (M-14, phase
// >= 15), send the final probe load — the fast-path proof: its retire
// capture completes within the 3000 ms budget (END receipt, not TIMEOUT)
// and its loaded receipts arrive in milliseconds.
function maybeFinish3f6Drain() {
  if (multiPhase !== 15 || multiDrained.size < multiDrainTargets.size) return;
  console.log("[test] phase M-15 ✓ message thread DRAINED (inst-a + inst-b + inst-slow deferred captures all completed) — final probe load (fast capture path)");
  multiPhase = 16;
  multiTFinalLoad = Date.now();
  ws.send(JSON.stringify({
    type: "load", seq: 6, events: multiEvents, meta: MULTI_META,
    plugins: [
      { instanceId: "inst-final", uid: multiScanPlugin.uid, path: multiScanPlugin.path, name: multiScanPlugin.name },
    ],
    routing: { t1: { inst: "inst-final", ch: 1 } },
  }));
}

ws.addEventListener("open", () => {
  console.log(`[test] connected to ws://127.0.0.1:${port} (mode=${mode}), waiting for hello...`);
});

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  console.log("[test] RX:", JSON.stringify(msg).slice(0, 140));
  step++;

  if (mode === "multi") {
    // ── Stage 3d-4: MULTI-INSTANCE hosting proof (see header docs) ──
    // Stage 3e-1 collection: per-instance capability handshake counts.
    if (msg.type === "plugin_state" && msg.state === "loaded") {
      const iid = msg.instanceId || "hosted";
      multiLoadedCount[iid] = (multiLoadedCount[iid] ?? 0) + 1;
    } else if (msg.type === "plugin_capabilities") {
      const iid = msg.instanceId || "hosted";
      multiCapsCount[iid] = (multiCapsCount[iid] ?? 0) + 1;
    }
    if (msg.type === "hello" && multiPhase === 0) {
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.8.3") fail(`expected 0.8.3, got ${msg.engineVersion}`);
      if (!fixtureDir) fail("multi mode requires a fixture dir argument");
      console.log("[test] hello OK (0.8.3) — scanning for the stand-in host plugin...");
      multiPhase = 1;
      ws.send(JSON.stringify({ type: "scan", dirs: [fixtureDir] }));
    } else if (msg.type === "scan_result" && multiPhase === 1) {
      const valid = (msg.plugins ?? []).find((p) => p.name === "Scorch Test Synth");
      if (!valid) fail(`multi mode: stand-in plugin not found in scan (${JSON.stringify(msg.plugins)})`);
      multiScanPlugin = valid;
      console.log(`[test] stand-in found: "${valid.name}" — loading TWO instances (inst-a + inst-b, both ch1)`);
      multiPhase = 2;
      ws.send(JSON.stringify({ type: "dispatch_log", enable: true }));
      ws.send(JSON.stringify({
        type: "load",
        seq: 1,
        events: multiEvents,
        meta: MULTI_META,
        plugins: [
          { instanceId: "inst-a", uid: valid.uid, path: valid.path, name: valid.name },
          { instanceId: "inst-b", uid: valid.uid, path: valid.path, name: valid.name },
        ],
        routing: { t1: { inst: "inst-a", ch: 1 }, t2: { inst: "inst-b", ch: 1 } },
      }));
    } else if (msg.type === "dispatch" && multiPhase >= 2) {
      for (const e of msg.entries ?? []) {
        multiLedger.push(e);
        if (e.k === 1 && e.c === 1) multiWideA = true;    // inst-a wide channel 1
        if (e.k === 1 && e.c === 17) multiWideB = true;   // inst-b wide channel 17 (slot 1 + ch 1)
      }
    } else if (msg.type === "plugin_state" && multiPhase === 2 && msg.state === "loaded") {
      if (msg.instanceId !== "inst-a" && msg.instanceId !== "inst-b") {
        fail(`multi: plugin_state loaded must carry a known instanceId, got ${msg.instanceId}`);
      }
      if (multiLoaded.has(msg.instanceId)) fail(`multi: duplicate plugin_state for ${msg.instanceId}`);
      multiLoaded.add(msg.instanceId);
      if (JSON.stringify(msg.channels) !== "[1]") fail(`multi: ${msg.instanceId} channels must be [1], got ${JSON.stringify(msg.channels)}`);
      if (typeof msg.latencyMs !== "number" || msg.latencyMs >= 100) fail(`multi: ${msg.instanceId} latencyMs must be < 100, got ${msg.latencyMs}`);
      if (multiLoaded.size === 2) {
        multiStateOk = 2;
        console.log("[test] phase M-1 ✓ BOTH instances loaded (inst-a + inst-b, each channels [1], latency < 100ms) — playing");
        multiPhase = 3;
        ws.send(JSON.stringify({ type: "transport", command: "play", tick: 0 }));
      }
    } else if (msg.type === "state" && multiPhase === 3 && msg.playing) {
      multiPeak = Math.max(multiPeak, msg.peak ?? 0);
      if (msg.tick >= 2400) {
        // Peak + routing asserts — then the mid-play reload probes.
        if (multiPeak <= 1.0) fail(`multi: peak ${multiPeak.toFixed(3)} does not exceed 1.0 — single-instance contributions cap at ≈0.787, so the second instance is not audible in the SUMMED mix`);
        if (!multiWideA || !multiWideB) fail(`multi: dispatch ledger missing wide-channel proof (c1=${multiWideA} c17=${multiWideB}) — per-instance routing broken`);
        console.log(`[test] phase M-2 ✓ both instances audible (summed peak ${multiPeak.toFixed(3)} > 1.0, single-source cap ≈0.787) + wide-channel ledger proof (c=1 AND c=17)`);
        console.log("[test] phase M-3 — SAME-set reload mid-play (reuse fast path, seq 2)...");
        multiPhase = 4;
        ws.send(JSON.stringify(multiReloadSame()));
      }
    } else if (msg.type === "plugin_state" && multiPhase === 4 && msg.state === "loaded") {
      multiReuseOk++;
      if (multiReuseOk === 2) {
        console.log("[test] phase M-4 ✓ SAME-set reload REUSED both live instances (no re-instantiate) — sending CHANGED set (must REJECT, seq 3)");
        multiPhase = 5;
        ws.send(JSON.stringify(multiReloadChanged()));
      }
    } else if (msg.type === "error" && multiPhase === 5 && msg.code === "load_rejected") {
      multiRejectOk = true;
      console.log(`[test] phase M-5 ✓ changed plugin set REJECTED while playing ("${msg.detail}") — stopping`);
      multiPhase = 6;
      ws.send(JSON.stringify({ type: "transport", command: "stop" }));
    } else if (msg.type === "state" && multiPhase === 6 && msg.playing === false) {
      console.log("[test] phase M-6 ✓ clean stop after the guard sequence — editor windows (per-instance)...");
      multiPhase = 7;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "inst-b" }));
    } else if (msg.type === "editorOpened" && multiPhase === 7) {
      if (msg.instanceId !== "inst-b") fail(`multi: editorOpened must echo inst-b, got ${msg.instanceId}`);
      if (!msg.width || msg.width <= 0 || !msg.height || msg.height <= 0) fail(`multi: editorOpened lacks real geometry: ${JSON.stringify(msg)}`);
      multiEdOpenB = true;
      console.log(`[test] phase M-7 ✓ inst-b editor OPENED ${msg.width}x${msg.height} — repeat must RAISE, then inst-a must open a SECOND window`);
      multiPhase = 8;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "inst-b" }));
    } else if (msg.type === "editorOpened" && multiPhase === 8) {
      if (msg.instanceId !== "inst-b" || msg.focused !== true) fail(`multi: repeat openEditor must focus inst-b, got ${JSON.stringify(msg)}`);
      multiEdFocusB = true;
      console.log("[test] phase M-8 ✓ repeat RAISED inst-b's window (focused, one editor per instance) — opening inst-a's editor SIMULTANEOUSLY");
      multiPhase = 9;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "inst-a" }));
    } else if (msg.type === "editorOpened" && multiPhase === 9) {
      if (msg.instanceId !== "inst-a") fail(`multi: second editor must be inst-a, got ${msg.instanceId}`);
      if (msg.focused === true) fail("multi: inst-a's first open must OPEN, not focus");
      multiEdOpenA = true;
      console.log("[test] phase M-9 ✓ TWO SIMULTANEOUS editors (inst-a + inst-b) — closing each by id");
      multiPhase = 10;
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "inst-a" }));
    } else if (msg.type === "editorClosed" && multiPhase === 10) {
      if (msg.instanceId !== "inst-a") fail(`multi: editorClosed must echo inst-a, got ${msg.instanceId}`);
      multiEdCloseA = true;
      multiPhase = 11;
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "inst-b" }));
    } else if (msg.type === "editorClosed" && multiPhase === 11) {
      if (msg.instanceId !== "inst-b") fail(`multi: editorClosed must echo inst-b, got ${msg.instanceId}`);
      multiEdCloseB = true;
      console.log("[test] phase M-11 ✓ editors closed cleanly per instance — state capture (per instance)...");
      multiPhase = 12;
      ws.send(JSON.stringify({ type: "captureState" }));
    } else if (msg.type === "pluginSavedState" && multiPhase === 12) {
      if (!msg.instanceId || (msg.instanceId !== "inst-a" && msg.instanceId !== "inst-b")) {
        fail(`multi: pluginSavedState must carry a known instanceId, got ${msg.instanceId}`);
      }
      multiCapIds.add(msg.instanceId);
      if (multiCapIds.size === 2) {
        // Stage 3f-6 PUBLISH-SAFE probe: arm the slow-state marker, then
        // replace BOTH live instances. Every PREPARED test-synth instance's
        // getStateInformation now stalls 10 s (a being-created instance is
        // not prepared yet — JUCE's creation handshake stays fast) — the
        // exact shape the user's engine.log showed ("prepared (async)" for
        // all instances, then NO loaded receipts and every later load stuck
        // behind "init started (async)"). The worker must publish the new
        // set and speak within 5 s REGARDLESS.
        console.log("[test] phase M-12 ✓ state captured PER INSTANCE (inst-a + inst-b, distinct ids) — 3f-6 publish-safe probe: arming slow-state marker, replacing the set");
        multiPhase = 13;
        try { fs.unlinkSync(multiSlowMarker); } catch {}
        fs.writeFileSync(multiSlowMarker, "slow");
        multiTSlowLoad = Date.now();
        ws.send(JSON.stringify({
          type: "load", seq: 4, events: multiEvents, meta: MULTI_META,
          plugins: [
            { instanceId: "inst-slow", uid: multiScanPlugin.uid, path: multiScanPlugin.path, name: multiScanPlugin.name },
          ],
          routing: { t1: { inst: "inst-slow", ch: 1 } },
        }));
      }
    } else if (msg.type === "plugin_state" && multiPhase === 13 && msg.state === "loaded") {
      if (msg.instanceId !== "inst-slow") fail(`multi: publish-safe load must report inst-slow, got ${msg.instanceId}`);
      if (JSON.stringify(msg.channels) !== "[1]") fail(`multi: inst-slow channels must be [1], got ${JSON.stringify(msg.channels)}`);
      const dt = Date.now() - multiTSlowLoad;
      if (dt > 5000) fail(`multi: 3f-6 publish-safe FAILED — the NEW set's loaded receipts took ${dt} ms (> 5000 ms) — the init worker blocked behind the retired instances' captures`);
      console.log(`[test] phase M-13 ✓ NEW set live + loaded receipts in ${dt} ms (< 5000 ms) while BOTH retired captures stall 10 s on the message thread — sending the FOLLOWING load (pre-fix, the worker never got here)`);
      multiPhase = 14;
      multiTFastLoad = Date.now();
      ws.send(JSON.stringify({
        type: "load", seq: 5, events: multiEvents, meta: MULTI_META,
        plugins: [
          { instanceId: "inst-fast", uid: multiScanPlugin.uid, path: multiScanPlugin.path, name: multiScanPlugin.name },
        ],
        routing: { t1: { inst: "inst-fast", ch: 1 } },
      }));
    } else if (msg.type === "plugin_state" && multiPhase === 14 && msg.state === "loaded") {
      if (msg.instanceId !== "inst-fast") fail(`multi: following load must report inst-fast, got ${msg.instanceId}`);
      const dt = Date.now() - multiTFastLoad;
      if (dt > 30000) fail(`multi: FOLLOWING load not processed in ${dt} ms — the init worker is still wedged`);
      console.log(`[test] phase M-14 ✓ FOLLOWING load processed (${dt} ms after send) — the worker survived the slow captures. Disarming marker, waiting for the message thread to DRAIN (deferred captures complete)...`);
      multiPhase = 15;
      try { fs.unlinkSync(multiSlowMarker); } catch {}
      maybeFinish3f6Drain();
    } else if (msg.type === "plugin_state" && multiPhase === 16 && msg.state === "loaded") {
      if (msg.instanceId !== "inst-final") fail(`multi: post-drain load must report inst-final, got ${msg.instanceId}`);
      const dt = Date.now() - multiTFinalLoad;
      if (dt > 5000) fail(`multi: post-drain load took ${dt} ms (> 5000 ms) — capture path did not recover`);
      console.log(`[test] phase M-17 ✓ post-drain load processed (${dt} ms; its retire capture completes — END receipt, not TIMEOUT) — shutdown`);
      // Hold the shutdown ~1500 ms so seq-6's retire capture OBSERVABLY
      // completes: the engine.log END receipt is a desktop.yml assertion, and
      // an instant shutdown could race the capture's done flag into an
      // "engine exiting" timeout instead.
      setTimeout(finishAndShutdown, 1500);
      multiPhase = 17;
    } else if (msg.type === "pluginSavedState" && multiPhase >= 13) {
      // Deferred retire captures broadcast their blob when the message thread
      // finally gets to them (up to ~10 s after the init thread stopped
      // waiting). Collect them for the M-15 drain proof.
      if (msg.instanceId && multiDrainTargets.has(msg.instanceId)) {
        multiDrained.add(msg.instanceId);
        console.log(`[test] deferred capture completed on the message thread: ${msg.instanceId} (${multiDrained.size}/${multiDrainTargets.size})`);
      }
      maybeFinish3f6Drain();
    } else if (msg.type === "error" && msg.code === "editor_unavailable" && multiPhase === 7 && !multiHeadlessSkip) {
      // Headless host (local validation): the display guard answers
      // editor_unavailable — tolerate ONLY that detail and skip the window
      // phases (Windows CI proves the real geometry path via host-mode J/K/L
      // AND this mode's strict branches).
      if (!/no display/i.test(msg.detail ?? "")) fail(`multi: unexpected editor_unavailable detail: ${msg.detail}`);
      multiHeadlessSkip = true;
      console.log(`[test] phase M-7 (headless) editor_unavailable tolerated ("${msg.detail}") — skipping to state capture`);
      multiPhase = 12;
      ws.send(JSON.stringify({ type: "captureState" }));
    } else if (msg.type === "error" && multiPhase >= 13) {
      fail(`multi: 3f-6 publish-safe phase got error: ${msg.code} ${msg.detail ?? ""}`);
    } else if (msg.type === "error" && multiPhase >= 2 && !multiRejectOk) {
      fail(`multi mode: unexpected error: ${msg.code} ${msg.detail ?? ""}`);
    }
    return;
  }

  if (mode === "host") {
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
          console.log("[test] phase L2 ✓ the editor-pause probe answered AFTER the editor closed (+ 2 s resume) — shutdown");
          finishAndShutdown();
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
      console.log(`[test] stand-in host found: "${valid.name}" uid=${valid.uid} — enabling dispatch_log + loading`);
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
    } else if (msg.type === "dispatch" && hostPhase >= 2) {
      for (const e of msg.entries ?? []) hostEntries.push(e);
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
      console.log("[test] phase G ✓ same-plugin mid-play reload ACKED (live instance reused, no re-instantiate) — sending DIFFERENT-plugin load (must be REJECTED, seq 4)");
      hostPhase = 11;
      ws.send(JSON.stringify({
        type: "load",
        seq: 4,
        events: HOST_EVENTS,
        meta: HOST_META,
        channels: { t1: 1, t2: 2 },
        plugin: { uid: hostValidUid + "0", path: hostValidPath, name: hostValidName },
      }));
    } else if (msg.type === "error" && hostPhase === 11 && msg.code === "load_rejected" && !hostRejectOk) {
      hostRejectOk = true;
      console.log(`[test] phase H ✓ plugin-change load REJECTED while playing (detail: "${msg.detail}") — waiting for proof the transport still plays`);
    } else if (msg.type === "state" && hostPhase === 11 && hostRejectOk && msg.playing) {
      hostPlayingAfterReject = true;
      console.log("[test] phase H ✓ transport STILL PLAYING after rejection — stopping");
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
          // CC#21=64 → masterScale 64/127 ≈ 0.504 ⇒ peak ≈ 1.574×0.504 ≈ 0.793.
          if (!(peakMax > 0.65 && peakMax < 0.90)) fail(`CC-diverged state did not apply in-render — peak must be ≈0.79, got ${peakMax.toFixed(3)} (frames: ${hostStatePlayStates.length})`);
          console.log(`[test] phase N ✓ state DIVERGED through the score (peak ${peakMax.toFixed(3)} ≈ half of 1.574) — stopping to capture the diverged state`);
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
          // The RESTORED state (masterScale ≈ 0.504 from the embed) must apply.
          if (!(peakMax > 0.65 && peakMax < 0.90)) fail(`restored state did not APPLY — peak must be ≈0.79 (the embedded value), got ${peakMax.toFixed(3)} (frames: ${hostStatePlayStates2.length})`);
          hostStateRestoreOk = true;
          console.log(`[test] phase P ✓ restored state APPLIED (peak ${peakMax.toFixed(3)} ≈ half of 1.574 — setStateInformation took effect) — stopping, round-trip capture`);
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
          if (!(pk > 1.05 && pk < 1.45)) fail(`multi-out DEFAULT routing: master peak ${pk.toFixed(3)} must be main+aux ≈1.287 (main-only cap ≈0.787) — aux bus not summed`);
          console.log(`[test] phase MO-2 ✓ default routing: master peak ${pk.toFixed(3)} ≈ main (0.787) + aux (0.5) — stopping`);
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
          if (!(pk > 0.65 && pk < 0.95)) fail(`multi-out MUTED routing: master peak ${pk.toFixed(3)} must be main-only ≈0.787 — the muted aux bus still contributed`);
          console.log(`[test] phase MO-5 ✓ aux muted via outputRouting: master peak ${pk.toFixed(3)} = main only — stopping, editor phases`);
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
      if (msg.engineVersion !== "0.8.3") fail(`expected 0.8.3, got ${msg.engineVersion}`);
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

  if (mode === "null-audio") {
    // ── Full protocol suite + RESUME contract (null device) ──
    if (msg.type === "hello" && !helloOk) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (msg.engineVersion !== "0.8.3") fail(`expected 0.8.3, got ${msg.engineVersion}`);
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
    // Stage 3e-1: both instances must have received capabilities, exactly
    // once per loaded receipt (initial load + mid-play reuse = 2 each).
    const capsOk = ["inst-a", "inst-b"].every((iid) =>
      (multiCapsCount[iid] ?? 0) > 0 && multiCapsCount[iid] === (multiLoadedCount[iid] ?? 0));
    const editorOk = multiHeadlessSkip || (multiEdOpenB && multiEdFocusB && multiEdOpenA && multiEdCloseA && multiEdCloseB);
    allOk = multiStateOk === 2 && multiReuseOk === 2 && multiRejectOk &&
            multiWideA && multiWideB && multiPeak > 1.0 && multiCapIds.size === 2 && capsOk && editorOk;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL MULTI-INSTANCE TESTS PASSED (3d-4):");
      console.log("  TWO instances of ONE plugin: scan → plugins[]+routing → 2× plugin_state loaded (per-instance ids)");
      console.log(`  summed output: peak ${multiPeak.toFixed(3)} > 1.0 (single-source cap ≈0.787 — BOTH instances audible in the mix)`);
      console.log("  per-instance routing: dispatch ledger wide channels c=1 (inst-a) AND c=17 (inst-b)");
      console.log("  mid-play SAME-set reload → both instances REUSED (no re-instantiate)");
      console.log("  mid-play CHANGED-set load → load_rejected (rolling guard, set form)");
      console.log(multiHeadlessSkip
        ? "  editors: SKIPPED on this headless host (editor_unavailable tolerated; Windows CI proves the window path)"
        : "  editors: inst-b opens → repeat raises (focused) → inst-a opens a SECOND SIMULTANEOUS window → per-id closes");
      console.log("  captureState → one pluginSavedState PER INSTANCE (distinct instanceIds)");
      console.log(`  3e-1 capability handshake: one plugin_capabilities per loaded receipt per instance (${JSON.stringify(multiCapsCount)})`);
      console.log("========================================");
      process.exit(0);
    } else {
      console.error(`FAILED: loaded=${[...multiLoaded].join(",")} reuse=${multiReuseOk} reject=${multiRejectOk} wideA=${multiWideA} wideB=${multiWideB} peak=${multiPeak.toFixed(3)} caps=${[...multiCapIds].join(",")} capsCount=${JSON.stringify(multiCapsCount)} editors=${multiEdOpenB}/${multiEdFocusB}/${multiEdOpenA}/${multiEdCloseA}/${multiEdCloseB} headlessSkip=${multiHeadlessSkip}`);
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
    allOk = helloOk && hostScanSent && hostHwndSetOk && hostPluginStateOk && hostPhase >= 13;
    if (allOk) {
      console.log("");
      console.log("========================================");
      console.log("ALL HOSTING TESTS PASSED (3c-2 + 3c close-out, stand-in host):");
      console.log('  plugin host by id: scan → load(uid,path) → plugin_state loaded');
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
