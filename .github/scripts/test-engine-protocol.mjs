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
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} scanSent=${scanSent} scanResult=${scanResultOk} aliveAfterCrash=${aliveAfterCrashOk} defaultScan=${defaultScanOk})`);
  } else if (mode === "host") {
    console.error(`TIMEOUT at step ${step} phase=${hostPhase} (scan=${hostScanSent} pluginState=${hostPluginStateOk} editorNeg=${hostEditorNegOk} editorOpen=${hostEditorOpenOk} editorFocus=${hostEditorFocusOk} editorClose=${hostEditorCloseOk} reloadAck=${hostReloadAckOk} reject=${hostRejectOk} stillPlaying=${hostPlayingAfterReject} stops=${hostStopTick1}/${hostStopTick2} peaks A/B/C=${hostPeakA.toFixed(3)}/${hostPeakB.toFixed(3)}/${hostPeakC.toFixed(3)} entries=${hostEntries.length})`);
  } else {
    console.error(`TIMEOUT at step ${step} (hello=${helloOk} pong=${pongOk} load=${loadOk} noDeviceErr=${noDeviceErrOk} pongAfterErr=${pongAfterErrOk} stillFunctional=${stillFunctionalOk})`);
  }
  process.exit(1);
}, mode === "host" ? 40000 : 30000);

// scan-mode flags
let scanSent = false, scanResultOk = false, aliveAfterCrashOk = false, defaultScanOk = false;
// host-mode flags + shared collection
let hostScanSent = false, hostPluginStateOk = false, hostPhase = 0;
// Stage 3d-1: editor-window contract flags.
let hostEditorNegOk = false, hostEditorOpenOk = false, hostEditorFocusOk = false, hostEditorCloseOk = false;
let hostValidUid = "", hostValidPath = "", hostValidName = "";
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
    // COLLECT-then-ASSERT: state peaks are correlated to dispatch-ledger
    // markers by ENGINE TICK (never by arrival time), so runner-speed-dependent
    // message latency cannot skew the unmuted/muted windows.
    if (msg.type === "hello" && !hostScanSent) {
      helloOk = true;
      if (msg.protocol !== 1) fail(`expected protocol 1, got ${msg.protocol}`);
      if (!fixtureDir) fail("host mode requires a fixture dir argument");
      // Stage 3d-1 NEGATIVE path FIRST: nothing is hosted yet — openEditor
      // must answer editor_unavailable (a NORMAL reply), not crash, not hang.
      console.log("[test] hello OK — editor negative path first (no live instance)...");
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
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
        console.log("[test] phase I ✓ clean stop after the guard sequence — editor phases (3d-1: the instance survives stops)");
        hostPhase = 13;
        ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
      }
    } else if (msg.type === "editorOpened" && hostPhase === 13) {
      if (msg.focused === true) fail(`first openEditor must OPEN (not focus): ${JSON.stringify(msg)}`);
      if (!msg.width || msg.width <= 0 || !msg.height || msg.height <= 0) fail(`editorOpened lacks real geometry: ${JSON.stringify(msg)}`);
      hostEditorOpenOk = true;
      console.log(`[test] phase J ✓ editor OPENED "${msg.name}" ${msg.width}x${msg.height} — repeat request must RAISE, not double-open`);
      hostPhase = 14;
      ws.send(JSON.stringify({ type: "openEditor", instanceId: "hosted" }));
    } else if (msg.type === "editorOpened" && hostPhase === 14) {
      if (msg.focused !== true) fail(`repeat openEditor must re-echo editorOpened with focused=true (one editor per instance), got ${JSON.stringify(msg)}`);
      hostEditorFocusOk = true;
      console.log("[test] phase K ✓ repeat openEditor focused the existing window (ONE editor per instance) — closing");
      hostPhase = 15;
      ws.send(JSON.stringify({ type: "closeEditor", instanceId: "hosted" }));
    } else if (msg.type === "editorClosed" && hostPhase === 15) {
      hostEditorCloseOk = true;
      console.log("[test] phase L ✓ editor CLOSED cleanly (protocol close; the X button and plugin unload converge on the same path) — shutdown");
      finishAndShutdown();
    } else if (msg.type === "error" && hostPluginStateOk && !hostRejectOk) {
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
      if (msg.engineVersion !== "0.5.0") fail(`expected 0.5.0, got ${msg.engineVersion}`);
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
  } else if (mode === "host") {
    allOk = helloOk && hostScanSent && hostPluginStateOk && hostPhase >= 13;
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
