// scorch-engine — Stage 3c: VST3 hosting (BBCSO standalone) + scan.
// Protocol v1 EXTENSION (additive — v1 handshake messages unchanged):
//   client -> server: {"type":"load","events":[...],"meta":{bpm,ppqn,timeSignature,endTick}}
//   client -> server: {"type":"transport","command":"play"|"stop"|"seek","tick":<n?>}
//                     play: "tick" OPTIONAL (3b polish) — explicit start tick,
//                     or RESUME from the stopped position when omitted.
//                     Straddling notes (on before the start tick, off after)
//                     are GENTLY RE-ATTACKED at the start tick (3c close-out).
//                     stop: MUSICAL RELEASE (3c close-out) — held notes get
//                     real note-offs and synth voices fade ~15ms; instant kill
//                     is reserved for panic and the play-time pre-panic guard.
//   client -> server: {"type":"panic"}
//   client -> server: {"type":"scan","dirs":[...]?}   (3c-1, OPTIONAL dirs;
//                     default: %COMMONPROGRAMFILES%\VST3 +
//                     %LOCALAPPDATA%\Programs\Common\VST3 + %APPDATA%\VST3 on
//                     Windows, /usr/lib/vst3 + ~/.vst3 elsewhere; 3f-2: each
//                     dir is walked RECURSIVELY up to 4 subfolder levels, and
//                     a .vst3 hit is never descended into)
//   server -> client: {"type":"scan_result","plugins":[{name,vendor,version,
//                     uid,classId,isInstrument,path}],"failed":[{path,error,
//                     exitCode,elapsedMs,stderrTail}],"scannedDirs":[{dir,
//                     status}]}
//                     3f-2 DESCRIBE/PROBE SPLIT: a scan row is built ONLY
//                     from findAllTypesForFile (the --scan-worker child never
//                     instantiates; 20 s timeout). Duplicate classIds are
//                     deduped — first by scan order wins. Crash isolation
//                     still holds: each .vst3 is described by a CHILD copy of
//                     this exe (--scan-worker); a plugin that crashes or
//                     hangs during DESCRIBE kills only its worker.
//                     Failed entries carry diagnostics (3f-2): the exit code,
//                     the wall-clock elapsedMs, and the last 2000 chars of
//                     the worker's stderr (JUCE merges the child's stdout and
//                     stderr into one pipe — see handle_scan).
//   server -> client: {"type":"scan_probe","classId":...,"capabilities":{...}}
//                     | {"type":"scan_probe","classId":...,
//                        "capabilitiesError":"..."}  (3f-2, ADDITIVE) — a
//                     --probe-worker child runs createPluginInstance +
//                     prepareToPlay + buildCapabilityFields with a 90 s
//                     timeout. A probe failure, timeout or crash NEVER
//                     removes or changes the row in the list — the frontend
//                     merges capabilities into the stored row by classId, or
//                     keeps the row untouched with only its capabilitiesError
//                     annotation. LAZY since 3f-7: the scan does NOT probe
//                     rows automatically — probes run on
//   client -> engine: {"type":"probe","classId":"…"}   (3f-7, ADDITIVE — one
//                     row, typically because it is visible in the scan
//                     dialog or the picker), {"type":"probeAll"} (3f-7,
//                     ADDITIVE — every row of the last scan; the dialog's
//                     "Probe all" button), or automatically probe-ON-LOAD
//                     (a loaded plugin is probed once per session; a failed
//                     probe is retried on the next load). While a load is in
//                     progress, any editor window is open, or the transport
//                     plays, the probe thread pauses dequeueing (2 s resume
//                     delay, "[probe] paused/resumed" receipts).
//   server -> client: {"type":"engineDiagnostic","mm":"unresponsive"|"recovered",
//                      "seconds":<n>}  (3f-7, ADDITIVE) — the message-thread
//                     heartbeat (DIAGNOSTIC ONLY: it measures that no
//                     callAsync ran for >3 s; it does not claim a cause) so
//                     the frontend can name the condition in a late-loadAck
//                     toast.
//   server -> client: {"type":"state","playing":bool,"tick":<n>,"peak":<f>}  (~30Hz;
//                     while stopped, tick = the remembered stop position;
//                     "peak" (3c-2, additive) = max |output| of the last buffer)
// Existing v1 messages unchanged: hello, ping->pong, shutdown, unknown->error.
//
// Stage 3c-2 protocol additions (additive):
//   load: events gain optional "trackId"; eventTypes CONTROL_CHANGE /
//         PITCH_BEND / PROGRAM_CHANGE accepted (plugin path). Optional
//         "channels": {"<trackId>": <1..16>} — tracks routed into the hosted
//         plugin (collision → engine_channel_conflict). Optional "plugin":
//         {"uid","path","name"} — host ONE VST3 (the whole orchestra; BBCSO
//         standalone multi-timbral).
//   {"type":"mix","mutedTracks":[...],"solos":[...]} — per-TRACK mute/solo,
//         gated at dispatch BEFORE any channel send (notes AND CC).
//   {"type":"dispatch_log","enable":bool} → while on, the engine streams
//         {"type":"dispatch","entries":[{s,t,c,k,a,b},…]} (~30Hz): the
//         sample-accurate record of what was actually dispatched (CI asserts
//         pre-trigger arithmetic + gating from these).
//   {"type":"plugin_state","state":"loaded"|"error","name","vendor",
//         "latencyMs"|"detail"} — hosting outcome; on error ALL tracks fall
//         back to the built-in test synth (app never dead-ends).
//
// Stage 3d-1 protocol additions (additive):
//   {"type":"openEditor","instanceId"?:string} — request the hosted plugin's
//         editor window (engine-OWNED popup: a JUCE DocumentWindow created on
//         the MessageManager pump thread — see ASSUMPTIONS.md 3d-1 for the
//         engine-popup vs Tauri-HWND investigation). instanceId is an opaque
//         echo (default "hosted" — Scorch hosts ONE instance; the registry
//         map already supports several for future multi-plugin hosting).
//   {"type":"closeEditor","instanceId"?:string} — close it (window's own X
//         button converges on the same path).
//   server -> client: {"type":"editorOpened","instanceId","name","width",
//         "height"[,"focused":true]} — window is up (or focused if it was
//         already open: one editor per instance, a repeat request RAISES).
//   server -> client: {"type":"editorClosed","instanceId"} — gone (explicit
//         close, X button, or the plugin instance was replaced/unloaded).
//   error {"code":"editor_unavailable"} — no live instance, or the plugin
//         ships no editor (createEditor() == nullptr). Plugins MAY be
//         headless; that is a normal reply, not a crash.
//
// Stage 3d-3 protocol additions (additive):
//   load: the "plugin" object gains OPTIONAL "state" (base64) — the project
//         JSON's embedded plugin state (getStateInformation blob). Applied
//         after instantiate, BEFORE the real-device prepare (documented
//         order); restore failure NEVER kills hosting — the receipt names
//         it and the plugin runs on its default state.
//   {"type":"captureState"} — client asks the engine to capture the live
//         instance's state NOW (frontend sends on app close; best-effort).
//   server -> client: {"type":"pluginSavedState","uid","path","name",
//         "size":N,"data":base64[,"state":"too_large"]} — a captured state
//         blob for the project JSON. Triggers: editor close (user edits
//         happen in the editor), instance replacement (the OUTGOING
//         instance's state), and captureState. Blobs > 2 MiB arrive with
//         "state":"too_large" and NO data (the cap protects project JSON
//         parseability; the frontend warns).
//
// Stage 3e-1 protocol additions (additive — CAPABILITY HANDSHAKE):
//   server -> client: {"type":"plugin_capabilities","instanceId","name",
//         "vendor","version","isInstrument","acceptsMidi","producesMidi",
//         "isMidiEffect","hasEditor","numPrograms","latencySamples",
//         "tailSeconds","supportsDoublePrecision","inputBuses","outputBuses",
//         "classId","buses":[{input,index,name,channels,isMain,
//         enabledByDefault,layoutChangeable},…]} — sent ONCE per instance,
//         immediately after that instance's plugin_state "loaded". Built
//         right after createPluginInstance succeeds, from the plugin's OWN
//         defaults (before any host negotiation touches the buses).
//   plugin_state "loaded" gains "classId" — the full VST3 class identifier
//         string (PluginDescription::createIdentifierString()). load plugin
//         matching PREFERS this string; the legacy numeric uid stays the
//         fallback so saved projects still load. scan_result rows gain
//         "classId" (and, when the scan worker can instantiate the plugin,
//         a "capabilities" object with the same fields).
//
// Stage 3e-3 protocol additions (additive — MULTI-OUTPUT BUSES):
//   load: every hosted instance's output buses are ENABLED (main + all aux
//         the plugin allows; inputs stay disabled — no sidechain). Receipt
//         per instance lists each output bus + its channel count.
//   load: per-instance OPTIONAL "outputRouting": [{busIndex, gain, mute}].
//         Absent = default: bus 0 (main) mixes to master stereo as always
//         AND every other bus ALSO sums to master (nothing becomes silent).
//         Entries: mute skips the bus; gain (0..8) scales it before the
//         master bus. Malformed entries are skipped + receipt-named.
//         Applies at (re)instantiate; the mid-play reuse path keeps the
//         live instance's routing (changing it requires a stopped reload).
//
// Test synth: sine oscillator per note, voice allocation (steal oldest),
// gain envelope (attack/release ~10ms). Every NoteOn must sound, every NoteOff
// must stop. No VST3, no samples, no CC rendering. Loopback ONLY (127.0.0.1).
//
// AUDIO POLICY (Stage 3b-fix):
//   * Audio code is ALWAYS compiled — the SCORCH_ENGINE_AUDIO compile gate is
//     gone. A compile-time gate shipped mute installers (the user's by-ear
//     gate failed by construction).
//   * The AudioDeviceManager is NOT initialized at engine startup. It is
//     constructed on the FIRST transport play command only, so headless
//     machines (CI runners) boot cleanly.
//   * First transport play:
//       device found        → render normally
//       no device / failure → {"type":"error","code":"no_audio_device",
//                              "detail":"..."} and the engine stays
//                              protocol-functional (stop/seek/state respond)
//   * --null-audio: run the graph on the engine's built-in null device (a
//     minimal JUCE AudioIODevice — JUCE 8 no longer ships one) whose callback
//     thread paces the graph in real time with no hardware. Transport play
//     then SUCCEEDS and state ticks advance: CI verifies scheduling without
//     a sound card.
//   * --no-audio: forced device-less — play always answers no_audio_device
//     (deterministic error-path test without relying on runner hardware).
//   * Every audio init path is exception-wrapped: audio can never crash the
//     process (MSVC /EHa makes catch(...) catch SEH access violations too).

// MSVC needs _USE_MATH_DEFINES before <cmath> for M_PI.
// NOMINMAX prevents windows.h (pulled in by JUCE/IXWebSocket) from defining
// min/max macros that conflict with std::min/std::max/std::numeric_limits.
#ifdef _MSC_VER
#define _USE_MATH_DEFINES
#define NOMINMAX
#endif
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <iostream>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_processors/juce_audio_processors.h>
// Stage 3d-1: editor windows are juce::DocumentWindows. gui_basics is already
// linked (audio_processors requires it — AudioProcessorEditor is a Component);
// the explicit include documents that the engine now CREATES windows.
#include <juce_gui_basics/juce_gui_basics.h>

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace {

constexpr const char* kEngineVersion = "0.8.7";
constexpr int kProtocolVersion = 1;
constexpr int kDefaultPort = 9377;
constexpr int kMaxVoices = 64;
// ─── Stage 3d-4: MULTI-INSTANCE HOSTING ────────────────────────────────
// The universal-hosting completion: each hosted plugin instance owns a
// private 16-channel MIDI namespace. Internal ("WIDE") channel = slot*16 + ch
// (slot 0..7, ch 1..16) — the ledger/articulation/mute-flush fabric is indexed
// by wide channel, so per-instance state can never cross instances. Slot 0's
// wide channels are numerically identical to the legacy 1..16 space, so every
// single-instance receipt/assertion is byte-stable. Plugins only ever SEE
// their own 1..16 (realChOfWide at MidiBuffer time).
constexpr int kMaxInstances = 8;
constexpr int kWideChannels = kMaxInstances * 16;   // 128
inline int wideChannelOf(int slot, int ch) { return slot * 16 + ch; }
inline int slotOfWide(int wide) { return (wide - 1) >> 4; }          // 1..128 → 0..7
inline int realChOfWide(int wide) { return ((wide - 1) & 15) + 1; }  // → 1..16
constexpr double kAttackMs = 10.0;
// Stage 3c close-out — the release fade is the MUSICAL stop semantics: a
// normal transport stop releases voices over ~15ms instead of killing them.
constexpr double kReleaseMs = 15.0;
// Resume re-attacks (3c close-out): a straddling note (on before the resume
// tick, off after) re-attacks at the resume tick with a GENTLE velocity —
// capped at 80 so a mid-phrase re-entry never hits at full attack. Constant
// (not a CLI flag): deterministic, tuned once for the close-out.
constexpr uint8_t kReattackVelCap = 80;
constexpr uint8_t kEvFlagResumeReattack = 0x01;  // EngineEvent.flags bit

std::atomic<bool> g_should_exit{false};
bool g_nullAudio = false;      // --null-audio: JUCE null device (CI / device-less)
bool g_forcedNoAudio = false;  // --no-audio: forced device-less (play → no_audio_device)
// Stage 3c-polish F2 — conservative device buffer: stability before latency
// at this stage. Small driver defaults (128/256) glitch with a full orchestra
// streaming samples; 512 is the floor for BBCSO-class libraries. The ACTUAL
// opened values are logged (D1) — the driver may refuse the request.
int g_wantedBufferSize = 512;

// ─── Engine event (parsed from JSON load message) ───────────────────────────
enum : uint8_t {
    kEvNoteOff = 0, kEvNoteOn = 1, kEvCC = 2, kEvBend = 3, kEvPC = 4,
};
struct EngineEvent {
    uint8_t kind;    // kEv*
    uint8_t channel; // 1..16 (resolved at load; plugin-routed when in table)
    uint8_t data1;   // pitch / cc number / bend LSB / program
    uint8_t data2;   // velocity / cc value / bend MSB
    int64_t tick;    // timestampTicks
    uint32_t trackRef = 0;  // 1-based slot into the load's track table (0 = none)
    uint8_t flags = 0;      // kEvFlag* (resume re-attacks are synthetic)
};

// ─── Synth voice ────────────────────────────────────────────────────────────
struct Voice {
    int pitch = -1;
    double freq = 0;
    double phase = 0;
    double phaseInc = 0;
    double env = 0;          // 0..1
    bool active = false;     // note on, in attack/sustain
    bool releasing = false;  // in release phase
    int64_t age = 0;         // for steal-oldest
};

// ─── Stage 3c-polish (realtime audit D2): lock-free handoffs ────────────────
// The score is an IMMUTABLE snapshot published behind ONE atomic pointer.
// The audio callback loads it once per buffer — no mutex, no per-sample
// lock, no copy. Retired snapshots are freed by the init worker after a
// grace period (never on the audio thread).
struct ScoreSnapshot {
    std::vector<EngineEvent> events;   // tick-sorted at publish time
    double bpm = 120.0;
    int ppqn = 960;
    int64_t endTick = 0;
    // Stage 3e-2: the project's time signature rides the score snapshot —
    // the playhead publishes it (sanitized at parse: numerator 1..99,
    // denominator a power-of-two 1..64; otherwise the 4/4 default).
    int tsNumerator = 4;
    int tsDenominator = 4;
};
std::atomic<ScoreSnapshot*> g_score{nullptr};

// ─── Stage 3h — proof-based reclamation (retire = wait for PROOF, not time) ──
// The audio callback increments g_audioBufferSeq once per buffer (ONE relaxed
// fetch_add at the top of audioDeviceIOCallbackWithContext, right after the
// published-pointer loads; the real-device path and the EngineNullDevice path
// both run through that single callback). Buffers are STRICTLY SEQUENTIAL on
// the one audio thread, so the counter is a grace-period proof in the RCU
// sense:
//
//   publisher: store(new) → S = g_audioBufferSeq.load() → queue {old, S}
//   janitor frees {old, S} only when g_audioBufferSeq >= S + 2
//
// WHY THE CAPTURE IS AFTER THE STORE (a deliberate, proven deviation from the
// Stage 3h spec's "record before the atomic store"): let the store fall
// between increment #A and increment #(A+1) of the seq atomic. Buffers 1..A
// loaded the OLD pointer; buffer A+1 MAY have (its load and the store share
// the same window between those two increments); buffers A+2.. load NEW. A
// capture taken BEFORE the store can go stale: the publisher can be
// preempted between its seq load and the store, letting A grow arbitrarily
// past S — then "seq >= S + 2" fires while an OLD-holding buffer is still in
// flight, i.e. the exact use-after-free class this stage fixes. A capture
// taken AFTER the store satisfies S >= A always, so "seq >= S + 2 >= A + 2"
// proves increment #(A+2) happened, which (sequential buffers) proves buffer
// A+1 — the last possible OLD holder — FINISHED, under arbitrary preemption,
// on real devices and the null device alike. "+1" is not enough (buffer A+1
// may hold OLD); "+2" is exact. A buffer preempted between its load and its
// increment keeps the observed count below S + 2 by construction, so the
// condition cannot even be observed early.
//
// If the audio thread never advances (device closed/asleep, system sleep,
// --no-audio), the counter freezes and the entries simply stay queued —
// correct and intentional; the janitor names each deferred entry ONCE (rate
// limit) so the log stays honest, and process exit reclaims (the standing
// 3c teardown policy — the lists are deliberately NOT drained at exit).
struct HostedPlugin;   // defined below (lock-free published instance)
std::atomic<uint64_t> g_audioBufferSeq{0};
std::mutex g_retireMutex;
struct RetiredScoreRef {
    ScoreSnapshot* snapshot = nullptr;
    uint64_t swapSeq = 0;      // g_audioBufferSeq captured AFTER the publish store
    bool deferNamed = false;   // one "retire deferred" receipt per entry (rate limit)
};
struct RetiredPluginRef {
    HostedPlugin* plugin = nullptr;
    uint64_t swapSeq = 0;      // captured AFTER the g_instances store
    bool deferNamed = false;
};
std::vector<RetiredScoreRef> g_retiredScores;
std::vector<RetiredPluginRef> g_retiredPlugins;

// Stage 3h TEST-ONLY stall hook (the null-audio regression probe): when this
// env-named marker file EXISTS, the first audio buffer to observe the appear
// transition sleeps kTestAudioStallMs INSIDE the callback before touching
// anything — one long, deliberate freeze of the audio thread, so the buffer
// cannot finish and g_audioBufferSeq cannot advance while a swap publishes.
// This is the controllable "stalled audio thread" the old 250 ms grace
// silently assumed away (driver DPC spike / antivirus / plugin I/O). Set by
// desktop.yml for the D2 engine process and by local validation runs; a
// production engine never has it set, and the steady-state cost when unset
// is one predictable branch on an empty string. No lock, no allocation.
std::string g_testAudioStallFile;   // written once in main(), read-only afterward
constexpr int kTestAudioStallMs = 2500;

// Stage 3f-6: a retire capture runs on the MESSAGE thread (callAsync) while
// the init worker only WAITS up to 3000 ms for it — so when the budget
// expires the capture job can still be queued or mid-sleep inside a slow
// plugin's getStateInformation. The janitor must not free a HostedPlugin
// whose capture job has not finished dereferencing it: each armed record
// pairs the instance with the job's done flag and the janitor defers the
// free until the flag lands (a bounded leak if the message thread never
// runs the job — process exit reclaims, the standing 3c teardown policy).
struct PendingRetireCapture {
    HostedPlugin* plugin;
    std::shared_ptr<std::atomic<bool>> done;
    bool named = false;   // one "retire deferred" line per record
};
std::mutex g_retireCaptureMutex;                 // guards the vector only
std::vector<PendingRetireCapture> g_retireCaptures;

// Voice kill requests: stop/seek/panic/play set the flag; the NEXT audio
// buffer performs the kill itself (voices are audio-thread-owned). The
// active-voice count is recomputed by the callback each buffer so handlers
// can report an honest n= in their receipts without touching voices.
std::atomic<bool> g_voiceKillPending{false};
std::atomic<int> g_activeVoices{0};

// Mute-flush requests: per-channel flags (index 0 = channel 1). Handlers
// store true; the next buffer CC120-flushes the flagged channels and clears
// the flags. Dedupes by channel naturally; no mutex, no vector, no alloc.
// Stage 3d-4: indexed by WIDE channel (slot*16 + ch) — see below.
std::atomic<bool> g_muteFlushPending[kWideChannels] = {};

// ─── Stage 3c close-out — transport transitions are musical ─────────────────
// Musical-release request: stop / seek / end-of-score set this; the NEXT
// audio buffer (a) fades the synth voices over ~15ms (kReleaseMs) instead of
// the instant kill and (b) sends REAL note-offs for every note the engine
// knows is held in the plugin (the library's own release tail rings out).
// Instant kill (env=0 + CC120 All Sound Off) is reserved for panic and the
// play-time pre-panic guard (the doubled-audio finding).
std::atomic<bool> g_releasePending{false};

// Held-note ledger for the plugin path: per-channel pitch bits, OWNED BY THE
// AUDIO THREAD (set/cleared inside dispatchTo and the buffer-boundary
// servicing — never touched by WS threads). The count is mirrored to an
// atomic at each buffer boundary so handlers can log an honest "at request
// time" figure without touching audio-thread state.
juce::BigInteger g_heldPluginNotes[kWideChannels];   // 3d-4: wide-channel indexed
std::atomic<int> g_heldPluginNoteCount{0};

// Current articulation per channel (UACC CC#32 value), 0xFF = unknown. Seeded
// at play/seek from the score's PAST events (last CC#32 before the start tick
// per channel — the plugin retains its articulation across stops, so the
// engine's knowledge must too); updated by the audio thread as CC#32s
// dispatch. A CC#32 whose value equals the channel's current articulation is
// REDUNDANT (the library re-articulates = the audible bow-scrape pluck) and
// is suppressed — only genuine changes are sent. Reset to unknown at load.
std::atomic<uint8_t> g_articulation[kWideChannels] = {};   // 3d-4: wide-channel indexed
constexpr uint8_t kArticulationUnknown = 0xFF;
// Dispatch-ledger kind for SUPPRESSED (redundant) articulation sends —
// ledger-only marker (never an event kind) so CI can assert suppression.
constexpr uint8_t kEvCCSuppressed = 6;

// Stage 3c-polish F3 — hosted output gain (bounded local level fix, NOT the
// mix-v4 recalibration). Applied to the plugin path only, after render,
// before the master bus. Default 2.0 (+6dB): BBCSO's conservative output
// (~-18..-12 dBFS peaks) lands at a sane ~-6 dBFS with clipping headroom.
// --plugin-gain tunes it; peaks are reported so the user can iterate.
std::atomic<float> g_hostedOutputGain{2.0f};

// Session peak for the receipt pair: reset at play, maxed by the callback,
// logged at stop ("[stop] ... | session peak X").
std::atomic<float> g_playPeakMax{0.0f};

// ─── Engine state (shared between WS thread, audio thread, state thread) ────
// Stage 3b polish — position contract: lastTick is the SINGLE source of truth
// for "where the playhead is" whenever the transport is stopped (and the seed
// for play without an explicit tick). The audio callback re-commits it every
// buffer; stop/seek set it directly. currentTick() never reports a stale
// playStartTick again (the resume-from-0 desync bug).
struct EngineState {
    // Stage 3c-polish (realtime audit D2): the score, the voices and the
    // hosted plugin are NO LONGER shared under mutexes with the audio
    // callback. The score is published as an immutable snapshot behind ONE
    // atomic pointer (g_score); voices are OWNED by the audio thread with
    // kill requests self-serviced at buffer boundaries (g_voiceKillPending);
    // the hosted plugin SET is published behind ONE atomic shared_ptr
    // (g_instances — Stage 3d-4 multi-instance)
    // with worker-side retirement. The callback takes NO lock and performs
    // NO allocation.
    std::atomic<bool> playing{false};
    std::atomic<int64_t> playStartTick{0};   // tick at which playback started
    std::atomic<double> sampleRate{44100.0};
    std::atomic<int64_t> samplesProcessed{0}; // since play start
    std::atomic<int64_t> lastTick{0};         // position truth while stopped
    // Transport generation: bumped on every play/seek (and panic). An audio
    // callback buffer that started before the bump must NOT commit its
    // samplesProcessed/lastTick afterwards — a pre-seek/pre-play in-flight
    // buffer would otherwise clobber the new transport position.
    std::atomic<uint64_t> transportGen{0};
    // Phase 2 (downbeat-late pre-roll): the muted pre-roll window in samples
    // — the max plugin latency snapshot taken at play / rolling-seek time.
    // samplesProcessed BEGINS at -preRollSamples: the window primes the
    // plugins' latency lines with silence and PRE-FIRES the start-tick
    // events, so an attack dispatched at -latency becomes audible exactly at
    // sample 0 = the grid position of playStartTick. Position reporting
    // (currentTick, lastTick, the playhead, ledger ticks) clamps the window
    // at the start tick: the transport's POSITION never precedes it. Stable
    // for one transport generation (written only by play + rolling seek,
    // before the transportGen bump; read by the audio callback).
    std::atomic<int64_t> preRollSamples{0};

    // Audio-thread-owned. External code NEVER touches these: stop/seek/panic
    // set g_voiceKillPending and the next buffer performs the kill.
    Voice voices[kMaxVoices];
    int64_t voiceAge = 0;

    int64_t currentTick() const {
        if (!playing.load()) return lastTick.load();
        ScoreSnapshot* s = g_score.load(std::memory_order_acquire);
        const double b = s ? s->bpm : 120.0;
        const int q = s ? s->ppqn : 960;
        // Phase 2: the pre-roll window holds samplesProcessed < 0 — the
        // reported position stays pinned at the start tick until sample 0.
        return playStartTick.load() +
               static_cast<int64_t>(std::max<int64_t>(0, samplesProcessed.load()) /
                   (sampleRate.load() * 60.0 / (b * q)));
    }
};

EngineState g_engine;

// ─── engine.log — the engine's view of the world (Stage 3c-hotfix) ──────
// The Rust shell spawns this process with stdout/stderr piped to null, so
// std::cout lines are invisible in production (the user saw a silently
// EMPTY score with zero diagnostics). Everything needed to answer "why did
// the engine play an empty score" is appended here instead:
//   Windows: %APPDATA%\scorch\engine.log
//   Linux:   ~/.config/scorch/engine.log   (CI / local validation)
// Best-effort + mutex-guarded: a logging failure must NEVER break the
// protocol or the audio thread.
std::mutex g_engineLogMutex;

std::string withCommas(uint64_t n) {
    std::string s = std::to_string(n);
    for (int pos = static_cast<int>(s.size()) - 3; pos > 0; pos -= 3)
        s.insert(static_cast<size_t>(pos), ",");
    return s;
}

void engineLog(const std::string& line) {
    try {
        std::lock_guard<std::mutex> lock(g_engineLogMutex);
        auto now = std::chrono::system_clock::now();
        std::time_t tt = std::chrono::system_clock::to_time_t(now);
        std::tm tm{};
#ifdef _WIN32
        localtime_s(&tm, &tt);
#else
        localtime_r(&tt, &tm);
#endif
        long ms = static_cast<long>(
            std::chrono::duration_cast<std::chrono::milliseconds>(
                now.time_since_epoch()).count() % 1000);
        char stamp[40];
        std::snprintf(stamp, sizeof(stamp), "%04d-%02d-%02d %02d:%02d:%02d.%03ld",
                      tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                      tm.tm_hour, tm.tm_min, tm.tm_sec, ms);
        auto f = juce::File::getSpecialLocation(juce::File::userApplicationDataDirectory)
                     .getChildFile("scorch").getChildFile("engine.log");
        f.getParentDirectory().createDirectory();
        f.appendText(juce::String("[" + std::string(stamp) + "] " + line + "\n"));
    } catch (...) {
        // Swallow — logging must never crash the engine or the protocol.
    }
}

// ─── Stage 3f-7: JSON helpers shared by every capability writer ─────────
// A plugin-reported double can be non-finite (a synth may honestly report an
// INFINITE tail). Bare inf/-inf/nan are INVALID JSON — every JSON consumer
// (the frontend's JSON.parse, juce::JSON in the CI probe) rejects the whole
// message. Non-finite numbers serialize as null; for tailSeconds null means
// "infinite" (the frontend renders ∞). Finite values keep the %.6g form the
// capability record has always used.
std::string jsonNumberOrNul(double v) {
    if (std::isfinite(v)) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.6g", v);
        return std::string(buf);
    }
    return "null";
}

// Stage 3f-7 (4d): cheap WS message-type sniff for the arrival receipt — the
// first 64 bytes ONLY, no JSON parse, no allocation beyond the type token.
// Finds "type" then reads the quoted token after the colon; anything else is
// "unknown". Message contents are NEVER logged.
std::string wsPeekType(const std::string& message) {
    const size_t scan = std::min<size_t>(message.size(), 64);
    const std::string head = message.substr(0, scan);
    const auto key = head.find("\"type\"");
    if (key == std::string::npos) return "unknown";
    const auto colon = head.find(':', key + 6);
    if (colon == std::string::npos) return "unknown";
    const auto q1 = head.find('"', colon + 1);
    if (q1 == std::string::npos) return "unknown";
    const auto q2 = head.find('"', q1 + 1);
    if (q2 == std::string::npos || q2 == q1 + 1) return "unknown";
    std::string t = head.substr(q1 + 1, q2 - q1 - 1);
    // Sanitize: printable ASCII only, bounded — the token goes to engine.log.
    if (t.size() > 32) return "unknown";
    for (char& c : t)
        if (c < 0x20 || c > 0x7e) return "unknown";
    return t;
}

// ─── Stage 3c-2: routing / mix / hosted plugin / dispatch ledger ────────────
// RoutingTable (immutable snapshot, atomic shared_ptr swap): the track→channel
// assignment for the load, and the set of channels the HOSTED PLUGIN owns.
// Events whose resolved channel ∈ pluginChannels render through the plugin;
// everything else (percussion/keys tracks, legacy events) renders through the
// built-in test synth — the engine's fallback discipline.
struct RoutingTable {
    std::vector<std::string> trackNames;              // slot-1 → trackId
    std::unordered_map<std::string, uint32_t> slotOf; // trackId → 1-based slot
    std::unordered_map<std::string, int> channelOfTrack; // trackId → engine channel (plugin-routed only)
    std::unordered_set<int> pluginChannels;           // hosted plugin channels
    std::vector<int> slotChannel;                     // slot → channel (0 = NOT plugin-routed)
};

// MixState (immutable snapshot, atomic shared_ptr swap): per-track mute/solo,
// resolved to slots of the CURRENT routing table at mix time. Gating happens
// at dispatch, BEFORE any channel send (the carried 3c debt, now audible).
struct MixState {
    std::vector<uint8_t> muted, solo;  // indexed by track slot
    bool anySolo = false;
};

std::atomic<std::shared_ptr<const RoutingTable>> g_routing;
std::atomic<std::shared_ptr<const MixState>> g_mix;
std::atomic<bool> g_pendingPanic{false};  // stop/panic/seek → CC120 flush to plugin

// Mute/solo became AUDIBLE: tracks that just lost audibility get their hosted
// channels flushed (CC120) so already-sounding notes stop immediately — mute
// must be HEARD, not just gate future dispatches. Handoff is a fixed array of
// per-channel atomic flags (g_muteFlushPending, index 0 = channel 1): handlers
// store true, the next buffer flushes and clears. No mutex, no vector, no
// allocation on either side (Stage 3c-polish D2).

// WS-thread-only: the last mix request (trackId lists), re-resolved after
// every load (slots change with each new routing table).
struct LastMix { std::vector<std::string> muted, solo; };
std::mutex g_lastMixMutex;          // WS threads only — NEVER the audio thread
LastMix g_lastMix;                  // guarded by g_lastMixMutex

// Hosted plugin: VST3 instances for the whole orchestra (Stage 3d-4 —
// MULTI-instance: one instance per plugin-bearing library group; tracks of a
// group share its instance's 16-channel namespace, so a multi-timbral library
// like BBCSO keeps the one-instance channel-routing model AND a
// single-patch library gets its own instance per group). Each instance is
// IMMUTABLE after publication — the worker fully constructs and prepares it
// BEFORE the set swap, so the audio callback's plain atomic load needs no
// lock. Instances replaced by a swap are RETIRED (freed by the worker after
// a grace period — never on the audio thread).
// Stage 3e-3 — per-instance output-bus routing (optional, load message):
// {busIndex, gain, mute} per output bus. Absent = default (every bus sums to
// master at gain 1). Immutable after publish like the rest of the identity
// block; CHANGING it requires a stopped reload (the mid-play reuse path
// keeps the live instance untouched — documented in ASSUMPTIONS.md 3e-3).
struct BusRouting {
    int busIndex = 0;
    float gain = 1.0f;
    bool mute = false;
};
// ─── Stage 3i — runtime latency tracking (detect, then mini-republish) ─────
// WHY: InstanceSet::slotLatency (the F4 per-instance dispatch-early shift) was
// populated exactly twice per instance — at loadHostedPlugin's prepare and at
// audioDeviceAboutToStart — and never re-read afterwards. A VST3 plugin that
// changes its REPORTED latency at runtime (convolution IR loading, sampler
// re-buffering on patch change, look-ahead changes) therefore kept the WRONG
// shift forever: it played audibly early/late against the others until a
// reload. The fix follows "detect, then mini-republish": three producers feed
// ONE immutable-republish job (nothing on the audio thread changes except
// that a later buffer loads a corrected set — the exact mechanism the
// score/mix publishes already prove):
//   (1) a juce::AudioProcessorListener per hosted instance, registered right
//       after loadHostedPlugin's prepare and detached in ~HostedPlugin (so it
//       can never outlive the wrapper it is registered on). The callback MUST
//       stay allocation-free and lock-free: a plugin may notify from its own
//       realtime context (our audio thread inside processBlock), so the only
//       thing it does is store a per-instance atomic flag — scheduling the
//       read with MessageManager::callAsync would allocate on the notifying
//       thread. The flags are drained by the init worker's 100 ms loop (the
//       engine's existing plugin-facing worker — fast path, no debounce) and
//       by the message-thread timer below.
//   (2) a juce::Timer on the message thread (2000 ms) — the safety net for
//       plugins that change WITHOUT notifying, and the pump for the flags
//       set by (1). It also owns the 2-identical-reads debounce for the
//       walk path (wrappers wobble during startup/patch loads).
//   (3) audioDeviceAboutToStart, which re-prepares every live instance and
//       refreshes HostedPlugin::latencySamples but could never touch the
//       PUBLISHED set — it now feeds the same republish job with the freshly
//       prepared values.
// getLatencySamples() is read on the message thread or the init worker only
// (never the audio thread): it returns the wrapper's cached sample count,
// which JUCE refreshes when the plugin calls restartComponent(kLatencyChanged)
// (the VST3 wrapper forwards an inner updateHostDisplay(latencyChanged) to
// the host listeners). The validated correction is enqueued to the plugin
// init thread, which rebuilds a NEW immutable InstanceSet (same HostedPlugin
// pointers, same slots, same routing — ONLY slotLatency changes) and commits
// it through a compare_exchange_strong loop on g_instances. The published set
// is NEVER mutated in place — the immutability contract is load-bearing (the
// audio callback takes one acquire load per buffer and reasons on set
// identity; the old set frees via the shared_ptr refcount exactly like every
// other replaced set, and NO plugin is retired by a latency republish because
// every pointer is shared with the new set).
class LatencyListener : public juce::AudioProcessorListener {
public:
    explicit LatencyListener(std::atomic<bool>* flag) : notified(flag) {}
    void audioProcessorChanged(juce::AudioProcessor*, const ChangeDetails& details) override {
        // Realtime-safe by construction: one relaxed store, nothing else.
        if (details.latencyChanged) notified->store(true, std::memory_order_release);
    }
    void audioProcessorParameterChanged(juce::AudioProcessor*, int, float) override {}
    void audioProcessorParameterChangeGestureBegin(juce::AudioProcessor*, int) override {}
    void audioProcessorParameterChangeGestureEnd(juce::AudioProcessor*, int) override {}

private:
    std::atomic<bool>* notified;
};

struct HostedPlugin {
    std::unique_ptr<juce::AudioPluginInstance> instance;
    std::string name, vendor;
    double latencySamples = 0.0;
    // Stage 3c-regression: load identity. A mid-play load whose plugin field
    // matches the LIVE instance takes the reuse fast path (routing-only swap,
    // no re-instantiate); a DIFFERENT plugin on a rolling transport is
    // REJECTED — swapping instances mid-play was the empty-score regression.
    // Identity is immutable after publication (safe to read lock-free).
    std::string uid, path;
    // Stage 3d-4: instance identity = the frontend's libraryGroup id (stable
    // across reloads — the rebind key for editors, state capture and restore).
    // The legacy single-plugin field maps to the reserved id "hosted".
    std::string instanceId;
    int slot = 0;   // wide-channel namespace owner (0..kMaxInstances-1)
    // Stage 3e-1 — capability handshake: the full VST3 class identifier
    // string (PluginDescription::createIdentifierString()) and the
    // PRE-SERIALIZED capability fields captured at load time (before any
    // host bus negotiation). The fragment carries every field of the
    // plugin_capabilities message EXCEPT the {"type":…,"instanceId":…}
    // wrapper — the worker/reuse paths wrap it per recipient. Immutable after
    // publication like the rest of the identity block.
    std::string classId;
    std::string capabilitiesFields;
    // Stage 3e-3 — MULTI-OUTPUT BUSES: every output bus the plugin allows is
    // ENABLED at load (main + aux); input buses stay disabled (no sidechain
    // in this stage). outputBusChannels[b] = channel count of output bus b
    // (disabled buses report 0 and occupy no buffer channels — the table is
    // also the bus→procBuffer offset map); totalOutputChannels = Σ. Immutable
    // after publish (the audio thread reads them lock-free).
    std::vector<int> outputBusChannels;
    int totalOutputChannels = 0;
    std::vector<BusRouting> outputRouting;   // optional per-load routing
    // Stage 3i — runtime latency tracking (see the block above HostedPlugin).
    // The listener is registered right after the load-time prepare and stays
    // attached for the instance's whole life; the destructor detaches it so
    // the wrapper can never fire into a dying listener during its own
    // teardown (JUCE wrapper destruction can flush pending notifications).
    std::unique_ptr<LatencyListener> latencyListener;
    std::atomic<bool> latencyNotified{false};

    ~HostedPlugin() {
        if (latencyListener && instance)
            instance->removeListener(latencyListener.get());
    }
};
// Immutable slot-ordered set published behind ONE atomic shared_ptr (same
// publication pattern as RoutingTable/ScoreSnapshot — the audio callback
// takes one acquire load per buffer and never locks; shared_ptr refcount
// drops are the accepted pattern of this codebase, and actual PLUGIN
// destruction stays on the worker's retire path).
struct InstanceSet {
    HostedPlugin* slots[kMaxInstances] = {};      // slot → instance (nullptr = empty)
    int slotLatency[kMaxInstances] = {};          // F4 per-instance latency shift
    HostedPlugin* byId(const std::string& iid) const {
        for (int i = 0; i < kMaxInstances; ++i)
            if (slots[i] != nullptr && slots[i]->instanceId == iid) return slots[i];
        return nullptr;
    }
    HostedPlugin* first() const {
        for (int i = 0; i < kMaxInstances; ++i)
            if (slots[i] != nullptr) return slots[i];
        return nullptr;
    }
};
std::atomic<std::shared_ptr<const InstanceSet>> g_instances;
// Legacy convenience: max live latency, mirrored for receipts/compensation
// messages (the per-event F4 shift uses InstanceSet.slotLatency).
std::atomic<int> g_pluginLatencySamples{0};

// ─── Stage 3i implementation — detection state, producers, republish job ────
// THREAD MAP (audio safety):
//   * audio thread: NOTHING new. The LatencyListener callback stores one
//     atomic flag; a later buffer simply loads the corrected set.
//   * message thread (the juce::Timer pump): the 2000 ms safety-net walk
//     (2-identical-reads debounce) plus flag drains; audioDeviceAboutToStart
//     feeds the same enqueue path.
//   * plugin init thread: the 100 ms flag drain (the fast notified path), job
//     consumption, the CAS publish, and the receipts.
struct LatencyCorrection { std::string instanceId; int newValue; };

// ONE mutex guards the detection state (pending map + rate-limit stamps) AND
// the job queue. Taken by the message thread (timer), the init thread (its
// 100 ms flag drain + job consumption), and AboutToStart — NEVER by the audio
// thread (the listener callback is a bare atomic store).
std::mutex g_latencyJobMutex;
std::vector<std::vector<LatencyCorrection>> g_latencyJobs;       // queued mini-republish jobs
struct LatencyPending { int value = 0; bool deferNamed = false;
                         bool confirmedNamed = false; };   // 3j: receipt naming guards
std::unordered_map<std::string, LatencyPending> g_latencyPending;    // guarded by g_latencyJobMutex
std::unordered_map<std::string, std::chrono::steady_clock::time_point> g_latencyLastEnqueue;  // guarded by g_latencyJobMutex

// Enqueue a VALIDATED correction (value ≠ published). Message thread or init
// worker (never the audio thread). Rate limit: at most one enqueued republish
// per instance per second — the limit bites because the init worker's 100 ms
// flag drain can cluster enqueues (a notified plugin toggling rapidly), and a
// suppressed candidate STAYS pending so the safety net lands it once the
// window opens; the suppression is named ONCE per episode. Jobs coalesce per
// instance (an instance appears at most once across the whole queue), so a
// burst of detections collapses into one publish.
bool latencyTryEnqueue(const std::string& iid, int newVal) {
    std::lock_guard<std::mutex> lock(g_latencyJobMutex);
    const auto now = std::chrono::steady_clock::now();
    auto last = g_latencyLastEnqueue.find(iid);
    const bool rateLimited = last != g_latencyLastEnqueue.end() &&
        std::chrono::duration_cast<std::chrono::milliseconds>(now - last->second).count() < 1000;
    if (rateLimited) {
        auto& pend = g_latencyPending[iid];
        pend.value = newVal;
        if (!pend.deferNamed) {
            pend.deferNamed = true;   // named once per suppressed episode
            engineLog("[latency] republish deferred — rate limit (one per instance per second) instance=" +
                      iid + " pending=" + std::to_string(newVal) + " samples");
        }
        return false;
    }
    g_latencyLastEnqueue[iid] = now;
    g_latencyPending.erase(iid);
    for (auto& job : g_latencyJobs)
        for (auto& c : job)
            if (c.instanceId == iid) { c.newValue = newVal; return true; }   // coalesce
    if (!g_latencyJobs.empty()) { g_latencyJobs.front().push_back({iid, newVal}); return true; }
    g_latencyJobs.push_back(std::vector<LatencyCorrection>{LatencyCorrection{iid, newVal}});
    return true;
}

// The drain: (a) instances the plugin EXPLICITLY notified (latencyChanged
// flag) act immediately — the plugin confirmed the change, no debounce; (b)
// optionally (safety walk, message-thread timer only) every live instance is
// polled and a diff must be seen IDENTICAL on 2 consecutive polls before
// acting. Called from the init worker's 100 ms loop (flags) AND the message
// thread's 2000 ms timer (flags + walk).
void latencyDrain(bool safetyWalk) {
    const auto set = g_instances.load(std::memory_order_acquire);
    if (set == nullptr) {
        std::lock_guard<std::mutex> lock(g_latencyJobMutex);
        g_latencyPending.clear();
        return;
    }
    std::vector<std::pair<std::string, int>> notifiedNow;
    for (int s = 0; s < kMaxInstances; ++s) {
        HostedPlugin* h = set->slots[s];
        if (h == nullptr || !h->instance) continue;
        const bool flagged = h->latencyNotified.exchange(false, std::memory_order_acq_rel);
        const int published = set->slotLatency[s];
        if (flagged) {
            const int v = static_cast<int>(h->instance->getLatencySamples());
            if (v != published) notifiedNow.emplace_back(h->instanceId, v);
        }
        if (safetyWalk && !flagged) {
            const int v = static_cast<int>(h->instance->getLatencySamples());
            if (v == published) continue;
            // Decide under the lock, act OUTSIDE it (latencyTryEnqueue takes
            // the same non-recursive mutex — a nested call would deadlock).
            bool act = false;
            std::string sawLine, confirmedLine;
            {
                std::lock_guard<std::mutex> lock(g_latencyJobMutex);
                auto pit = g_latencyPending.find(h->instanceId);
                if (pit != g_latencyPending.end() && pit->second.value == v) {
                    act = true;   // second identical poll
                    if (!pit->second.confirmedNamed) {
                        pit->second.confirmedNamed = true;
                        confirmedLine = "[latency] debounce confirmed instance=" + h->instanceId +
                                        " value=" + std::to_string(v) +
                                        " samples (2 identical safety-net polls)";
                    }
                } else {
                    g_latencyPending[h->instanceId] = {v, false, false};   // (re)armed — wait one poll
                    sawLine = "[latency] saw instance=" + h->instanceId +
                              " current=" + std::to_string(v) +
                              " published=" + std::to_string(published) +
                              " samples — safety-net poll armed";
                }
            }
            // Log OUTSIDE the lock (engineLog takes its own mutex); the enqueue
            // takes g_latencyJobMutex again — order: log, then act.
            if (!sawLine.empty()) engineLog(sawLine);
            if (!confirmedLine.empty()) engineLog(confirmedLine);
            if (act) latencyTryEnqueue(h->instanceId, v);
        }
    }
    for (const auto& c : notifiedNow) latencyTryEnqueue(c.first, c.second);
    // A candidate whose instance vanished (retired/failed) is dropped — the
    // republish job re-checks against a fresh load anyway, this just keeps
    // the map from holding dead entries.
    std::lock_guard<std::mutex> lock(g_latencyJobMutex);
    for (auto it = g_latencyPending.begin(); it != g_latencyPending.end();) {
        if (set->byId(it->first) == nullptr) it = g_latencyPending.erase(it);
        else ++it;
    }
}

class LatencyWatchTimer : public juce::Timer {
public:
    void timerCallback() override { latencyDrain(true); }
};
LatencyWatchTimer* g_latencyWatch = nullptr;   // created ON the message thread (mm pump)

// The mini-republish job (plugin init thread): rebuild a NEW immutable set
// from a FRESH g_instances load, change ONLY slotLatency for the surviving
// candidates, and commit via a compare_exchange_strong loop — every retry
// rebuilds from the fresh value CAS deposited in `cur`, so a load publishing
// concurrently can never be clobbered (the loser re-applies onto the newer
// set). An instance gone between detection and publish is dropped silently.
// NO plugin is retired and NO retire queue is touched: every HostedPlugin
// pointer is shared with the new set; the replaced set container frees via
// the shared_ptr refcount (the audio thread's in-flight buffer reference is
// the accepted pattern — see the InstanceSet block).
struct LatencyApplied { HostedPlugin* h; int oldV; int newV; };
void latencyRepublishJob(std::vector<LatencyCorrection> candidates) {
    const auto t0 = std::chrono::steady_clock::now();
    for (int attempt = 0; attempt < 8 && !g_should_exit.load(); ++attempt) {
        auto cur = g_instances.load(std::memory_order_acquire);
        if (cur == nullptr) return;
        auto nextSet = std::make_shared<InstanceSet>(*cur);
        std::vector<LatencyApplied> applied;
        for (const auto& c : candidates) {
            HostedPlugin* h = nextSet->byId(c.instanceId);
            if (h == nullptr) continue;                       // gone — drop silently
            const int oldV = nextSet->slotLatency[h->slot];
            if (oldV == c.newValue) continue;                 // converged — no-op
            nextSet->slotLatency[h->slot] = c.newValue;
            // ONE WRITE DISCIPLINE (Stage 3j field invariant): the
            // h->latencySamples refresh happens BEFORE (not after) the set
            // swap — the same ordering as the load path (prepare writes it,
            // then the set publishes from it) and audioDeviceAboutToStart. It
            // is the value a future load rebuilds retained slotLatency from,
            // so a load racing this job must see the CORRECTED value, never
            // the pre-correction one — the resurrection window is closed,
            // not narrowed. If the CAS ultimately gives up, the safety net
            // re-detects (getLatencySamples still differs from the published
            // slot) and re-enqueues — the speculative write self-heals.
            h->latencySamples = static_cast<double>(c.newValue);
            applied.push_back({h, oldV, c.newValue});
        }
        if (applied.empty()) {
            engineLog("[latency] publish: no effective change after rebuild — skipped");
            return;
        }
        int maxLat = 0;
        for (int s = 0; s < kMaxInstances; ++s)
            if (nextSet->slotLatency[s] > maxLat) maxLat = nextSet->slotLatency[s];
        if (g_instances.compare_exchange_strong(cur, nextSet,
                                                std::memory_order_acq_rel,
                                                std::memory_order_acquire)) {
            // Committed — receipts only here. The h->latencySamples refresh already
            // happened in the collection loop, BEFORE the swap (the Stage 3j
            // one-write discipline: h never lags the published set on this
            // thread, so no later load can rebuild the stale value).
            for (auto& a : applied) {
                engineLog("[latency] republish instance=" + a.h->instanceId +
                          " old=" + std::to_string(a.oldV) +
                          " new=" + std::to_string(a.newV) +
                          " samples (stage 3i)" +
                          " — one buffer of timing discontinuity accepted");
            }
            g_pluginLatencySamples.store(maxLat, std::memory_order_release);
            const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - t0).count();
            engineLog("[latency] publish: swapped set corrected=" +
                      std::to_string(applied.size()) + " elapsed=" + std::to_string(ms) + "ms");
            return;
        }
        // CAS failed: `cur` now holds the newest set — loop and rebuild from it.
    }
    engineLog("[latency] publish: gave up after 8 CAS retries (the set kept changing) — the safety net will re-detect");
}

// ─── Stage 3d-1: plugin editor windows (engine-owned popup) ────────────────
// Mechanism (investigated, ASSUMPTIONS.md "Stage 3d-1"): editors are JUCE
// DocumentWindows created ON the MessageManager pump thread — the process's
// message thread, and the ONLY thread where Component work is legal. WS
// threads and the init worker only VALIDATE and SCHEDULE via
// MessageManager::callAsync. One editor per instance (a repeat request
// RAISES the existing window); the registry map supports multiple instances
// for future multi-plugin hosting. Editors belong to this process: engine
// death closes them with it — no orphan windows are possible by
// construction. Plugin retirement closes editors BEFORE the instance is
// retired (scheduled close lands on the message thread within the retire
// grace period, never racing the free).
class PluginEditorWindow;
std::mutex g_editorMutex;                                        // guards the map only
std::unordered_map<std::string, PluginEditorWindow*> g_editors;  // instanceId → window

// Stage 3d-4 hotfix — pending-open forensic record. An ACCEPTED openEditor
// used to have exactly one receipt-less death path: openEditorWindow's first
// guard silently returned when the instance was gone by the time the message
// thread ran the job (user evidence: "open requested" then 101s of silence —
// no opened, no refused, nothing). Worse, if a plugin's createEditor() never
// returns (UI wedge), NOTHING can ever speak because the message thread is
// the thing that's blocked. This record is written at accept (WS thread),
// marked started/cleared at every terminal path (message thread), and READ by
// the init worker's janitor loop (100ms cadence, zero new threads) which
// NAMES a pending open that survives >10s — distinguishing "message-thread
// job never ran (MM wedged elsewhere)" from "createEditor() has not
// returned (plugin UI wedge)". Log-only forensics: no protocol change.
struct PendingEditorOpen {
    std::string iid;
    std::chrono::steady_clock::time_point queuedAt{};
    std::chrono::steady_clock::time_point startedAt{};   // default = MM job not yet run
};
std::mutex g_pendingEditorMutex;
bool g_pendingEditorActive = false;
bool g_pendingEditorNamed = false;   // one named receipt per pending epoch
PendingEditorOpen g_pendingEditorOpen;

// Defined further down (JSON helpers + close converge point); forward-declared
// so the window class and open path can reference them.
std::string escape_json(const std::string& s);
void destroyEditorWindow(const std::string& iid, bool captureOnClose = true);
struct HostedPlugin;
void captureAndBroadcastState(const HostedPlugin& h, const char* trigger);
// Broadcast surface for message-thread-initiated events (editorClosed from
// the X button, editor_unavailable from createEditor failure): set once in
// main() before any thread can open an editor; the server outlives them all.
ix::WebSocketServer* g_wsServer = nullptr;
void broadcastJson(const std::string& msg) {
    if (g_wsServer == nullptr) return;
    for (auto& client : g_wsServer->getClients())
        if (client) client->send(msg);
}

// ── Stage 3f-3a: editor windows belong to the app (owned, not top-level) ────
// The frontend sends {"type":"setHostWindow","hwnd":<number>} once per fresh
// engine session (the Tauri shell resolves its main window's HWND via the new
// main_window_hwnd() command; browser dev and non-Windows shells never send
// it). When a PluginEditorWindow is SHOWN on Windows, the engine sets its
// OWNER to that window with SetWindowLongPtrW(GWLP_HWNDPARENT): no taskbar
// button, minimizes/restores with the app, stays above it, dies with it.
// This is OWNERSHIP, deliberately NOT SetParent() — the window stays a
// separate, movable top-level popup. A missing or invalid hwnd keeps
// today's behaviour and is LOGGED (spec point 4); nothing else depends on
// this message ever arriving.
static std::atomic<uintptr_t> g_hostHwnd{ 0 };

// Defined next to handle_open_editor (protocol handlers); forward-declared so
// the dispatch table can reference it regardless of definition order.
void handle_set_host_window(const juce::var& json, ix::WebSocket& ws);

#if defined(_WIN32)
// One-shot ownership application. Runs on the message thread immediately
// after the editor window is shown (the peer — and therefore the HWND —
// exists). Every terminal path SPEAKS: applied, or skipped/FAILED naming the
// exact class (no host hwnd / stale host hwnd / editor hwnd unavailable /
// SetWindowLongPtr error). The Windows-CI runner drives the "applied" path
// with a real PowerShell-WinForms window handle; desktop.yml greps the
// receipts (see workflow Test E receipt block).
static void applyHostWindowOwner(juce::DocumentWindow& win, const std::string& iid) {
    auto hexOf = [](uintptr_t v) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "0x%llx", static_cast<unsigned long long>(v));
        return std::string(buf);
    };
    const uintptr_t host = g_hostHwnd.load(std::memory_order_acquire);
    if (host == 0) {
        engineLog("[editor] host-owner skipped (no host hwnd) instance=" + iid);
        return;
    }
    if (IsWindow(reinterpret_cast<HWND>(host)) == FALSE) {
        engineLog("[editor] host-owner skipped (invalid host hwnd " + hexOf(host) + ") instance=" + iid);
        return;
    }
    HWND editorHwnd = nullptr;
    if (auto* peer = win.getPeer())
        editorHwnd = reinterpret_cast<HWND>(peer->getNativeHandle());
    if (editorHwnd == nullptr || IsWindow(editorHwnd) == FALSE) {
        engineLog("[editor] host-owner skipped (editor hwnd unavailable) instance=" + iid);
        return;
    }
    SetLastError(0);
    const LONG_PTR prev = SetWindowLongPtrW(editorHwnd, GWLP_HWNDPARENT, static_cast<LONG_PTR>(host));
    if (prev == 0 && GetLastError() != 0) {
        engineLog("[editor] host-owner FAILED (SetWindowLongPtr err=" + std::to_string(GetLastError()) + ") instance=" + iid);
        return;
    }
    engineLog("[editor] host-owner applied instance=" + iid + " hwnd=" + hexOf(host));
}
#else
// Non-Windows: there is no HWND-ownership concept; behaviour unchanged by
// design (spec point 4 keeps today's behaviour outside the shipped shell).
static void applyHostWindowOwner(juce::DocumentWindow&, const std::string&) {}
#endif

class PluginEditorWindow : public juce::DocumentWindow {
public:
    PluginEditorWindow(std::string instanceId, const juce::String& title)
        : juce::DocumentWindow(title, juce::Colour(0xff14161f),
                               juce::DocumentWindow::closeButton, true),
          iid(std::move(instanceId)) {}

    void closeButtonPressed() override {
        // Stage 3f-7 (4c): the moment the close button handler runs — BEFORE
        // any other work — so a close that never completes is visible in
        // engine.log by its last receipt.
        engineLog("[editor] closing requested instance=" + iid);
        // Runs on the message thread. Destroying self synchronously inside
        // the window's own callback is unsafe — schedule the deletion.
        // USER-initiated close → the state capture fires (3d-3).
        juce::MessageManager::callAsync([iid = this->iid] { destroyEditorWindow(iid, true); });
    }

    std::string iid;
};

// Message-thread side of open. A plugin may ship no editor — createEditor()
// returning null is the editor_unavailable path, a NORMAL reply.
// Stage 3d-4 hotfix: `owner` is resolved by the CALLER from the CURRENT
// instance set at message-thread run time — this function never trusts a
// pointer captured on another thread. Every terminal path now SPEAKS (the
// old first-guard silent return was the one receipt-less death of an
// accepted open) and clears the pending-open record the watchdog reads.
void openEditorWindow(const std::string& iid, HostedPlugin* owner) {
    auto clearPending = [&iid]() {
        std::lock_guard<std::mutex> pl(g_pendingEditorMutex);
        if (g_pendingEditorActive && g_pendingEditorOpen.iid == iid) {
            g_pendingEditorActive = false;
            g_pendingEditorNamed = false;
        }
    };
    {   // mark the MM job as STARTED (watchdog distinguishes queued-forever
        // from createEditor-never-returns)
        std::lock_guard<std::mutex> pl(g_pendingEditorMutex);
        if (g_pendingEditorActive && g_pendingEditorOpen.iid == iid)
            g_pendingEditorOpen.startedAt = std::chrono::steady_clock::now();
    }
    if (owner == nullptr || !owner->instance) {
        clearPending();
        // NAMED abandon — the instance retired between the WS-thread accept
        // and this message-thread run. The user must never see a silent
        // nothing after an accepted "open requested" again.
        broadcastJson(std::string("{\"type\":\"error\",\"code\":\"editor_unavailable\",\"echo\":\"openEditor\",\"detail\":\"instance retired before the editor window opened\"}"));
        engineLog("[editor] open abandoned — instance not live at message-thread run (requested id \"" + iid + "\")");
        return;
    }
    // Re-check on the message thread: two queued openEditor requests must
    // yield ONE window (second request raises).
    {
        std::lock_guard<std::mutex> lock(g_editorMutex);
        if (g_editors.count(iid) != 0) {
            if (auto* win = g_editors[iid]) win->toFront(true);
            broadcastJson(std::string("{\"type\":\"editorOpened\",\"instanceId\":\"") +
                          escape_json(iid) + "\",\"name\":\"" + escape_json(owner->name) +
                          "\",\"focused\":true}");
            engineLog("[editor] focus existing instance=" + iid + " (race re-check)");
            clearPending();
            return;
        }
    }
    auto* ed = owner->instance->createEditor();
    if (ed == nullptr) {
        clearPending();
        broadcastJson(std::string("{\"type\":\"error\",\"code\":\"editor_unavailable\",\"echo\":\"openEditor\",\"detail\":\"") +
                      escape_json(owner->name) + " ships no editor window\"}");
        engineLog("[editor] unavailable — createEditor() returned null (" + owner->name + ")");
        return;
    }
    // A window needs a display: on a headless host (CI box, disconnected
    // RDP session) editor creation is IMPOSSIBLE — answer editor_unavailable
    // instead of crashing the engine. (Empirical: without this guard the
    // engine died silently at getPrimaryDisplay()/peer creation on a
    // display-less Linux box.)
    const juce::Displays::Display* disp = juce::Desktop::getInstance().getDisplays().getPrimaryDisplay();
    if (disp == nullptr) {
        clearPending();
        delete ed;   // we own the orphan editor component — release it
        broadcastJson(std::string("{\"type\":\"error\",\"code\":\"editor_unavailable\",\"echo\":\"openEditor\",\"detail\":\"no display available for an editor window\"}"));
        engineLog("[editor] unavailable — no display (headless host)");
        return;
    }
    const int w = ed->getWidth() > 0 ? ed->getWidth() : 640;
    const int h = ed->getHeight() > 0 ? ed->getHeight() : 480;
    // DPI/usability clamp (perfection not required, usable always): a
    // 4K-native editor must still fit a 1080p work area.
    juce::Rectangle<int> work = disp->userArea;
    const int cw = juce::jmin(w, static_cast<int>(work.getWidth() * 0.85));
    const int ch = juce::jmin(h, static_cast<int>(work.getHeight() * 0.85));
    auto* win = new PluginEditorWindow(iid, owner->name);
    win->setUsingNativeTitleBar(true);
    win->setContentOwned(ed, true);   // the window owns the editor's lifetime
    win->setResizable(false, false);
    win->setBounds(juce::jmax(work.getX(), work.getCentreX() - cw / 2),
                   juce::jmax(work.getY(), work.getCentreY() - ch / 2), cw, ch);
    win->setVisible(true);
    // Stage 3f-3a: the window is SHOWN — its HWND exists; hand ownership to
    // the app's main window when one was announced via setHostWindow.
    applyHostWindowOwner(*win, iid);
    clearPending();   // terminal: the window is up and receipted below
    {
        std::lock_guard<std::mutex> lock(g_editorMutex);
        g_editors[iid] = win;
    }
    broadcastJson(std::string("{\"type\":\"editorOpened\",\"instanceId\":\"") + escape_json(iid) +
                  "\",\"name\":\"" + escape_json(owner->name) +
                  "\",\"width\":" + std::to_string(cw) + ",\"height\":" + std::to_string(ch) + "}");
    engineLog("[editor] opened instance=" + iid + " plugin=" + owner->name +
              " " + std::to_string(cw) + "x" + std::to_string(ch));
}

// Message-thread side of close. Every path (protocol close, X button,
// retirement) converges here; the map is the single source of truth.
// captureOnClose: USER-initiated closes (protocol closeEditor, the X button)
// trigger a 3d-3 state capture — edits happen in the editor, so the close is
// the natural commit point. Retirement closes (closeAllEditors*) pass false:
// the init worker captures the OUTGOING instance itself (trigger "replace")
// and a live-pointer race here would capture whichever instance is current.
void destroyEditorWindow(const std::string& iid, bool captureOnClose) {
    PluginEditorWindow* win = nullptr;
    {
        std::lock_guard<std::mutex> lock(g_editorMutex);
        auto it = g_editors.find(iid);
        if (it == g_editors.end()) return;   // already gone — idempotent
        win = it->second;
        g_editors.erase(it);
    }
    if (win != nullptr) {
        // Stage 3f-7 (4b): BEGIN before the first call into the plugin (the
        // editor destructor runs plugin code — editorBeingDeleted et al.),
        // END with the elapsed ms after it. A destructor that never returns
        // leaves the BEGIN line as the last receipt.
        const auto tc0 = std::chrono::steady_clock::now();
        engineLog("[editor] close BEGIN instance=" + iid);
        win->setVisible(false);
        delete win;   // setContentOwned(ed, true) frees the editor with the window
        const long long closeMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - tc0).count();
        engineLog("[editor] close END instance=" + iid + " " + std::to_string(closeMs) + " ms");
    }
    broadcastJson(std::string("{\"type\":\"editorClosed\",\"instanceId\":\"") + escape_json(iid) + "\"}");
    engineLog("[editor] closed instance=" + iid);
    if (captureOnClose) {
        // Stage 3d-4: capture the OWNING instance (by id), not "the" instance.
        if (auto set = g_instances.load(std::memory_order_acquire)) {
            HostedPlugin* h = set->byId(iid);
            if (h == nullptr) h = set->first();   // legacy id "hosted" may map to the first
            if (h != nullptr) captureAndBroadcastState(*h, "editor-close");
        }
    }
}

// Schedule-close helpers (callable from ANY thread; execution on the pump).
void closeEditorAsync(const std::string& iid) {
    juce::MessageManager::callAsync([iid] { destroyEditorWindow(iid, true); });
}
void closeAllEditorsAsync() {
    juce::MessageManager::callAsync([] {
        std::vector<std::string> ids;
        {
            std::lock_guard<std::mutex> lock(g_editorMutex);
            for (auto& kv : g_editors) ids.push_back(kv.first);
        }
        for (const auto& id : ids) destroyEditorWindow(id, false);
    });
}
// Shutdown path: schedule close-all and WAIT (bounded) so the pump actually
// runs it before stopDispatchLoop — clean window teardown on graceful exit.
// A hard kill needs nothing: the OS reaps the process's windows.
void closeAllEditorsAtShutdown() {
    std::atomic<bool> done{false};
    juce::MessageManager::callAsync([&done] {
        std::vector<std::string> ids;
        {
            std::lock_guard<std::mutex> lock(g_editorMutex);
            for (auto& kv : g_editors) ids.push_back(kv.first);
        }
        for (const auto& id : ids) destroyEditorWindow(id, false);
        done.store(true);
    });
    for (int i = 0; i < 50 && !done.load(); ++i)
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
}

// ─── Stage 3d-3: plugin state persistence ──────────────────────────────
// "Install library, use library": patches + mixer settings survive app
// restarts. The engine CAPTURES state (getStateInformation) at the moments
// edits actually happen and SHIPS the blob to the frontend, which EMBEDS it
// in the project JSON (LibraryGroup.pluginState — portability: projects
// carry their sound setup; no sidecar files). On instance recreation the
// frontend sends the blob back and the engine RESTORES it
// (setStateInformation) before the real-device prepare.
// Storage decision + rebind identity (pluginId+path, NOT volatile instance
// ids) documented in ASSUMPTIONS.md 3d-3.
constexpr size_t kMaxPluginStateBytes = 2 * 1024 * 1024;   // ~2 MiB/instance
// Capture the CURRENT live instance and broadcast the blob. Callable from
// the message thread AND the init worker (getStateInformation is host-callable
// from any thread; plugins guard internally). try/catch: a plugin that
// throws in getStateInformation must not kill anything.
void captureAndBroadcastState(const HostedPlugin& h, const char* trigger) {
    // Stage 3f-7 (4b): BEGIN before the first call into the plugin
    // (getStateInformation) and END with the elapsed ms after it — the same
    // receipt shape the editor close got, so a slow/hung capture is located
    // by its last line in engine.log.
    const auto tc0 = std::chrono::steady_clock::now();
    engineLog("[plugin] capture BEGIN instance=" + h.instanceId + " (" + trigger + ")");
    try {
        juce::MemoryBlock mb;
        h.instance->getStateInformation(mb);
        const long long capMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - tc0).count();
        engineLog("[plugin] capture END instance=" + h.instanceId + " " +
                  std::to_string(capMs) + " ms (" + trigger + ")");
        const size_t n = mb.getSize();
        if (n == 0) {
            engineLog(std::string("[plugin] state capture EMPTY (") + trigger + ") — nothing to persist");
            return;
        }
        std::string msg = std::string("{\"type\":\"pluginSavedState\",\"uid\":\"") +
            escape_json(h.uid) + "\",\"path\":\"" + escape_json(h.path) +
            "\",\"instanceId\":\"" + escape_json(h.instanceId) +
            "\",\"name\":\"" + escape_json(h.name) + "\",\"size\":" + std::to_string(n);
        if (n > kMaxPluginStateBytes) {
            // The cap protects project-JSON parseability, NOT a hosting limit:
            // warn (frontend toasts) and ship NO data — the last embedded
            // state (if any) stays authoritative.
            msg += ",\"state\":\"too_large\"}";
            engineLog(std::string("[plugin] state TOO LARGE for project embed: ") +
                      std::to_string(n) + " bytes > " +
                      std::to_string(kMaxPluginStateBytes) + " (" + trigger + ")");
        } else {
            msg += ",\"data\":\"" + juce::Base64::toBase64(mb.getData(), mb.getSize()).toStdString() + "\"}";
            engineLog(std::string("[plugin] state captured ") + std::to_string(n) +
                      " bytes (" + trigger + ")");
        }
        broadcastJson(msg);
    } catch (const std::exception& e) {
        engineLog(std::string("[plugin] state capture FAILED (") + trigger + "): " +
                  (e.what() ? e.what() : "unknown"));
    } catch (...) {
        engineLog(std::string("[plugin] state capture FAILED (") + trigger + "): SEH/unknown");
    }
}

// ─── Stage 3f-6: init-phase watchdog record ─────────────────────────────
// Every phase of the init worker (instantiate / state-restore / prepare /
// publish) calls INTO PLUGIN CODE, and a plugin can hang inside any of them
// (the 3f-6 defect: getStateInformation of a retired instance stalled the
// publish section forever — the worker never spoke again). A hang INSIDE the
// worker is invisible to the worker itself, so the worker writes this record
// at every phase transition and a separate 1 s watchdog thread READS it,
// naming any single phase older than 60 s:
//   "[plugin] init WATCHDOG phase=<name> instance=<id> <ms> ms"
// LOG ONLY — no kill, no skip: the watchdog is forensics, not an executioner
// (killing a thread holding JUCE/plugin locks would wedge the process worse
// than the hang). One WATCHDOG line per phase occurrence (the `named` flag
// resets at every transition); the mutex is held microseconds at transitions
// and by the reader once per second — a worker hung INSIDE plugin code never
// holds it, so the record stays readable exactly when it matters.
struct InitPhaseRecord {
    std::mutex mtx;
    std::string phase;         // "instantiate" | "state-restore" | "prepare" | "publish"
    std::string instanceId;    // "-" for the set-wide publish phase
    std::chrono::steady_clock::time_point startedAt{};
    bool active = false;
    bool named = false;
};
InitPhaseRecord g_initPhase;
class InitPhaseGuard {
public:
    InitPhaseGuard(const char* phase, const std::string& iid) {
        std::lock_guard<std::mutex> lk(g_initPhase.mtx);
        g_initPhase.phase = phase;
        g_initPhase.instanceId = iid;
        g_initPhase.startedAt = std::chrono::steady_clock::now();
        g_initPhase.active = true;
        g_initPhase.named = false;
    }
    ~InitPhaseGuard() {
        std::lock_guard<std::mutex> lk(g_initPhase.mtx);
        g_initPhase.active = false;
    }
    InitPhaseGuard(const InitPhaseGuard&) = delete;
    InitPhaseGuard& operator=(const InitPhaseGuard&) = delete;
};

// ─── Stage 3c-regression: ASYNC plugin init ─────────────────────────────
// loadHostedPlugin (findAllTypesForFile + createPluginInstance +
// prepareToPlay) takes SECONDS for a full orchestra library — the receipts
// caught the user's WS message loop frozen 5.708s behind BBCSO's
// instantiate. The WS thread now only QUEUES the request (loadAck/state are
// never delayed); this single worker instantiates off-thread, latest
// request wins (a newer load supersedes an in-flight instantiate — two
// concurrent orchestra loads must never double-allocate the sample pool).
struct PluginInitEntry {
    std::string instanceId;     // 3d-4: the load's plugins[] entry identity
    int slot = 0;               // 3d-4: wide-channel namespace owner, assigned at parse
    juce::var pluginVar;        // the entry object (uid+path)
    std::string channelsJson;   // THIS instance's hosted wire channels, captured at queue time
    // Stage 3d-3: the project JSON's embedded state (base64), restored after
    // instantiate and BEFORE the real-device prepare. Empty = default state.
    std::string stateB64;
    // Stage 3e-3: the entry's optional outputRouting (immutable on the
    // instance after instantiate).
    std::vector<BusRouting> routing;
};
struct PluginInitRequest {
    // Stage 3d-4: the load's FULL desired instance set (replace-all semantics:
    // instances absent from this list retire when the set publishes).
    std::vector<PluginInitEntry> entries;
    long long seq = 0;
};
std::mutex g_pluginInitMutex;
std::condition_variable g_pluginInitCv;
PluginInitRequest g_pluginInitRequest;   // guarded by g_pluginInitMutex
bool g_pluginInitPending = false;        // guarded by g_pluginInitMutex
uint64_t g_pluginInitGen = 0;            // guarded; bumped per queued request
// Real device config, captured in audioDeviceAboutToStart. A hot-swapped
// instance is prepared with THESE numbers before it becomes visible to the
// audio callback (create-time prepare uses nominal 44100/512 — preparing a
// swapped-in instance only at the next device start was the mis-prepared
// half of the empty-score regression).
std::atomic<int> g_deviceBufferSize{512};

// Dispatch ledger: what the callback ACTUALLY dispatched (post-gating), for
// CI assertions (pre-trigger arithmetic, routing, gating). Single producer
// (audio thread) / single consumer (state thread); drop-oldest ring.
struct DispatchEntry {
    int64_t s;   // absolute sample since play start
    int64_t t;   // tick (rounded)
    uint8_t k, ch, d1, d2;
};
constexpr size_t kLedgerSize = 4096;
DispatchEntry g_ledger[kLedgerSize];
std::atomic<uint64_t> g_ledgerWrite{0};
std::atomic<uint64_t> g_ledgerRead{0};
std::atomic<bool> g_dispatchLog{false};
std::atomic<float> g_lastPeak{0.0f};

// ─── Stage 3e-2 — TRANSPORT INFO (PLAYHEAD) ────────────────────────────────
// The host-side playhead every hosted instance sees via getPlayHead(). Owned
// by the audio callback (one stable address for the process lifetime); the
// audio thread PUBLISHES each buffer's position through relaxed atomics and
// getCurrentPosition (called by plugins, on the audio thread) only READS
// them and fills a stack PositionInfo — no lock, no allocation, on either
// side. bpm/time-signature come from the immutable score snapshot (the
// project data the frontend sends in load.meta; the project model has ONE
// tempo today, so "the tempo active at the current tick" degenerates to it
// — a future tempo map slots in at the per-buffer publish point without a
// protocol change). isLooping is constant false: the engine has no loop
// region (3b contract: stop = position kept, no looping).
class EnginePlayHead : public juce::AudioPlayHead {
public:
    void publish(bool isPlaying, int64_t timeInSamplesVal, double bpmVal,
                 double ppqVal, double ppqBarVal, int tsNum, int tsDen) {
        playing.store(isPlaying, std::memory_order_relaxed);
        timeInSamples.store(timeInSamplesVal, std::memory_order_relaxed);
        bpm.store(bpmVal, std::memory_order_relaxed);
        ppqPosition.store(ppqVal, std::memory_order_relaxed);
        ppqLastBar.store(ppqBarVal, std::memory_order_relaxed);
        tsNumerator.store(tsNum, std::memory_order_relaxed);
        tsDenominator.store(tsDen, std::memory_order_relaxed);
    }

    // The PURE virtual of this JUCE (8.x pinned): getPosition(). Builds a
    // stack PositionInfo from the atomics — no lock, no allocation. Plugins
    // may call this on the audio thread (they already are, in processBlock).
    juce::Optional<PositionInfo> getPosition() const override {
        PositionInfo info;
        info.setTimeInSamples(timeInSamples.load(std::memory_order_relaxed));
        info.setBpm(bpm.load(std::memory_order_relaxed));
        info.setPpqPosition(ppqPosition.load(std::memory_order_relaxed));
        info.setPpqPositionOfLastBarStart(ppqLastBar.load(std::memory_order_relaxed));
        juce::AudioPlayHead::TimeSignature sig{};
        sig.numerator = tsNumerator.load(std::memory_order_relaxed);
        sig.denominator = tsDenominator.load(std::memory_order_relaxed);
        info.setTimeSignature(sig);
        info.setIsPlaying(playing.load(std::memory_order_relaxed));
        info.setIsLooping(false);
        return juce::Optional<PositionInfo>(std::move(info));
    }

private:
    std::atomic<bool> playing{false};
    std::atomic<int64_t> timeInSamples{0};
    std::atomic<double> bpm{120.0};
    std::atomic<double> ppqPosition{0.0};
    std::atomic<double> ppqLastBar{0.0};
    std::atomic<int> tsNumerator{4};
    std::atomic<int> tsDenominator{4};
};

// ─── Audio callback ─────────────────────────────────────────────────────────
class EngineAudioCallback : public juce::AudioIODeviceCallback {
public:
    void audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/,
                                          int /*numInputChannels*/,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& /*context*/) override {
        // ── Stage 3h TEST-ONLY stall hook (see g_testAudioStallFile) ──
        // The FIRST buffer to observe the marker's appear transition freezes
        // HERE for kTestAudioStallMs — before the loads and the seq tick, so
        // a frozen buffer holds NO published pointers and g_audioBufferSeq
        // stops advancing for the whole sleep. This is the controllable
        // stalled-audio-thread regression probe; production engines never
        // see the env var set (the empty-string branch below is the entire
        // steady-state cost).
        if (!g_testAudioStallFile.empty()) {
            bool exists = false;
            if (FILE* f = std::fopen(g_testAudioStallFile.c_str(), "rb")) {
                std::fclose(f);
                exists = true;
            }
            if (!testStallInited) {
                testStallInited = true;          // never stall on the very first buffer
            } else if (exists && !testStallLastSeen) {
                std::this_thread::sleep_for(std::chrono::milliseconds(kTestAudioStallMs));
            }
            testStallLastSeen = exists;
        }
        // Zero the output buffer
        for (int ch = 0; ch < numOutputChannels; ++ch)
            std::memset(outputChannelData[ch], 0, sizeof(float) * numSamples);

        // ── Stage 3c-polish (D2): this function performs NO lock and NO
        // allocation. Voices are audio-thread-owned: kill/release requests
        // are self-serviced HERE at the boundary.

        // ONE atomic load per shared object. Published objects are immutable
        // (score snapshot / prepared instances), so plain pointer loads suffice.
        // Stage 3d-4: the INSTANCE SET (slot-ordered, immutable) replaces the
        // single pointer — every slot with a live instance renders this buffer.
        const auto instances = g_instances.load(std::memory_order_acquire);
        const auto routing = g_routing.load(std::memory_order_acquire);
        const auto mix = g_mix.load(std::memory_order_acquire);
        ScoreSnapshot* score = g_score.load(std::memory_order_acquire);
        // Stage 3h: the retire-proof tick — ONE relaxed increment per buffer,
        // immediately after the published-pointer loads. This is the ONLY
        // audio-thread change proof-based reclamation makes: no lock, no
        // allocation, no blocking call (the test-only stall hook above is
        // compiled-in but inert unless the env var was provided at startup).
        g_audioBufferSeq.fetch_add(1, std::memory_order_relaxed);
        float peak = 0.0f;

        // Stage 3c-polish (D2): kill requests from PANIC and the play-time
        // pre-panic guard — instant (env=0), self-serviced at the boundary.
        if (g_voiceKillPending.exchange(false, std::memory_order_relaxed)) {
            for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
        }

        // Reusable per-buffer MIDI buffers (members, one per slot): clear()
        // keeps the internal capacity — steady-state dispatch allocates nothing.
        for (int i = 0; i < kMaxInstances; ++i) instMidi[i].clear();

        // Stage 3c close-out — MUSICAL RELEASE (stop / seek / end-of-score):
        // (a) synth voices enter the ~15ms release fade (NOT the instant kill)
        // and keep rendering below, so the tail rings out; (b) the plugin gets
        // REAL note-offs for every note the held-note ledger knows about — the
        // library's own release tail plays instead of an amputation. Serviced
        // even when the transport is already stopped (the not-playing branch
        // below still renders, so tails are audible and decay honestly).
        if (g_releasePending.exchange(false, std::memory_order_relaxed)) {
            int synthReleased = 0;
            for (auto& v : g_engine.voices)
                if (v.active) { v.releasing = true; v.active = false; ++synthReleased; }
            int pluginOffs = 0;
            const bool logDispatch = g_dispatchLog.load(std::memory_order_relaxed);
            // Stage 3d-4: walk the WIDE channel space; each held note's note-off
            // lands in its OWNING instance's buffer at the instance's real 1..16
            // channel. Slot 0 wide channels == legacy 1..16 (byte-stable ledger).
            if (instances != nullptr) {
                for (int wide = 1; wide <= kWideChannels; ++wide) {
                    HostedPlugin* h = instances->slots[slotOfWide(wide)];
                    if (h == nullptr || !h->instance) continue;
                    for (int p = 0; p < 128; ++p)
                        if (g_heldPluginNotes[wide - 1][p]) {
                            instMidi[slotOfWide(wide)].addEvent(
                                juce::MidiMessage::noteOff(realChOfWide(wide), p, juce::uint8(0)), 0);
                            g_heldPluginNotes[wide - 1].clearBit(p);
                            ++pluginOffs;
                            if (logDispatch &&
                                g_ledgerWrite.load(std::memory_order_relaxed) -
                                    g_ledgerRead.load(std::memory_order_relaxed) < kLedgerSize) {
                                const uint64_t li = g_ledgerWrite.load(std::memory_order_relaxed);
                                DispatchEntry& e = g_ledger[li % kLedgerSize];
                                e.s = 0;
                                e.t = g_engine.lastTick.load();  // the stopped position
                                e.k = kEvNoteOff; e.ch = static_cast<uint8_t>(wide); e.d1 = static_cast<uint8_t>(p); e.d2 = 0;
                                g_ledgerWrite.store(li + 1, std::memory_order_release);
                            }
                        }
                }
            }
            if ((synthReleased > 0 || pluginOffs > 0) && logDispatch) {
                // Ledger marker: the release batch has CC123 (All Notes Off —
                // MUSICAL) semantics, distinct from the ch=0 CC120 (All Sound
                // Off) markers of panic/mute flushes.
                const uint64_t idx = g_ledgerWrite.load(std::memory_order_relaxed);
                if (idx - g_ledgerRead.load(std::memory_order_relaxed) < kLedgerSize) {
                    DispatchEntry& e = g_ledger[idx % kLedgerSize];
                    e.s = 0;
                    e.t = g_engine.lastTick.load();
                    e.k = kEvCC; e.ch = 0; e.d1 = 123; e.d2 = 0;
                    g_ledgerWrite.store(idx + 1, std::memory_order_release);
                }
            }
        }

        // Stage 3c-2 — panic flush: PANIC (and the play-time pre-panic guard)
        // send CC120 (All Sound Off) on ALL 16 channels of EVERY live instance
        // so hosted voices die instantly (amputation — deliberately NOT the
        // stop semantics any more; the 3c close-out moved stop to musical
        // release). Stage 3d-4: per-instance buffers, real 1..16 channels.
        const bool panicFlush = g_pendingPanic.exchange(false);
        if (panicFlush && instances != nullptr) {
            for (int slot = 0; slot < kMaxInstances; ++slot) {
                HostedPlugin* h = instances->slots[slot];
                if (h == nullptr || !h->instance) continue;
                for (int ch = 1; ch <= 16; ++ch) {
                    instMidi[slot].addEvent(juce::MidiMessage::controllerEvent(ch, 120, 0), 0);
                    g_heldPluginNotes[wideChannelOf(slot, ch) - 1].clear();   // all sound off = nothing held
                }
            }
        }
        // Mute/solo lost-audibility flush: per-WIDE-channel atomic flags — no
        // mutex, no vector (the test-synth voices are killed via the kill
        // flag above; they don't need a MIDI round-trip).
        bool anyMuteFlush = false;
        if (instances != nullptr) {
            for (int wide = 1; wide <= kWideChannels; ++wide) {
                HostedPlugin* h = instances->slots[slotOfWide(wide)];
                if (h == nullptr || !h->instance) continue;
                if (g_muteFlushPending[wide - 1].exchange(false, std::memory_order_relaxed)) {
                    instMidi[slotOfWide(wide)].addEvent(
                        juce::MidiMessage::controllerEvent(realChOfWide(wide), 120, 0), 0);
                    g_heldPluginNotes[wide - 1].clear();
                    anyMuteFlush = true;
                }
            }
        }

        if (!g_engine.playing.load()) {
            // Not playing: the plugin still renders (drains release tails and
            // panic CCs — the MUSICAL stop tail is audible here by design),
            // and the synth voices DRAIN too: the release fade entered at a
            // stop must actually decay while stopped (it used to freeze —
            // voices stuck 'releasing' forever with the count lying).
            ensureScratch(static_cast<size_t>(numSamples));
            std::fill(synthScratch.begin(), synthScratch.begin() + numSamples, 0.0f);
            for (int s = 0; s < numSamples; ++s) {
                double sample = 0;
                for (auto& v : g_engine.voices) {
                    if (!v.active && !v.releasing) continue;
                    sample += std::sin(v.phase) * v.env;
                    v.phase += v.phaseInc;
                    if (v.phase > 2.0 * M_PI) v.phase -= 2.0 * M_PI;
                    if (v.releasing) {
                        double releaseRate = 1000.0 / (kReleaseMs * g_engine.sampleRate.load());
                        v.env -= releaseRate;
                        if (v.env <= 0) { v.env = 0; v.releasing = false; v.active = false; v.pitch = -1; }
                    }
                }
                synthScratch[static_cast<size_t>(s)] = static_cast<float>(sample * 0.2);
            }
            for (int s = 0; s < numSamples; ++s) {
                const float out = synthScratch[static_cast<size_t>(s)];
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    outputChannelData[ch][s] += out;
            }
            // Stage 3d-4: EVERY live instance renders (drains tails); outputs
            // SUM into the device buffer (renderPlugin adds — the buffer was
            // zeroed at callback entry). Side fix: the old single-instance
            // render ASSIGNED, silently overwriting the synth tail above when
            // a plugin was hosted — summing is the honest arithmetic.
            if (instances != nullptr) {
                for (int slot = 0; slot < kMaxInstances; ++slot) {
                    HostedPlugin* h = instances->slots[slot];
                    if (h == nullptr || !h->instance) continue;
                    renderPlugin(*h, instMidi[slot], outputChannelData,
                                 numOutputChannels, numSamples, peak);
                }
            }
            // Summed-buffer peak (see the playing branch — 3d-4 honesty);
            // measured AFTER the instance renders so it sees the full mix.
            for (int s = 0; s < numSamples; ++s) {
                float mx = 0.0f;
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    mx = std::max(mx, std::abs(outputChannelData[ch][s]));
                peak = std::max(peak, mx);
            }
            g_lastPeak.store(peak, std::memory_order_relaxed);
            recountVoices();
            recountHeldNotes();
            // Stage 3e-2: publish the STOPPED position — the playhead stays
            // truthful while the transport is stopped (plugins probing
            // getPlayHead() between takes see the remembered position, not
            // a frozen rolling one). Same lock-free publish as below.
            {
                ScoreSnapshot* sSnap = score;
                const double bpmNow = sSnap ? sSnap->bpm : 120.0;
                const int ppqnNow = sSnap ? sSnap->ppqn : 960;
                const double sptStop =
                    g_engine.sampleRate.load() * 60.0 / (bpmNow * static_cast<double>(ppqnNow));
                const double spqStop =
                    g_engine.sampleRate.load() * 60.0 / bpmNow;   // samples per quarter
                const int64_t tlSample = static_cast<int64_t>(std::llround(
                    static_cast<double>(g_engine.lastTick.load()) * sptStop));
                const double ppqNow = spqStop > 0.0
                    ? static_cast<double>(tlSample) / spqStop : 0.0;
                const int num = sSnap ? sSnap->tsNumerator : 4;
                const int den = sSnap ? sSnap->tsDenominator : 4;
                const double barQ = static_cast<double>(num) * 4.0 / static_cast<double>(den);
                playHead.publish(false, tlSample, bpmNow, ppqNow,
                                 std::floor(ppqNow / barQ) * barQ, num, den);
            }
            return;
        }

        // Capture the transport generation BEFORE the position reads: any
        // play/seek that lands after this point invalidates this buffer's
        // commit (gen mismatch at the end), never half-updated state.
        const uint64_t gen0 = g_engine.transportGen.load(std::memory_order_relaxed);
        // Phase 2: the transport's pre-roll window — fixed at play/seek time,
        // part of the gen-guarded parameter set (a mid-play latency
        // republish never resizes it; the snapshot IS the window).
        const int64_t preRoll = g_engine.preRollSamples.load(std::memory_order_relaxed);
        const double spt = score
            ? g_engine.sampleRate.load() * 60.0 / (score->bpm * score->ppqn)
            : (44100.0 * 60.0 / (120.0 * 960));
        const int64_t endTick = score ? score->endTick : 0;
        const EngineEvent* const events = score ? score->events.data() : nullptr;
        const size_t eventCount = score ? score->events.size() : 0;
        int64_t startSample = g_engine.samplesProcessed.load();
        int64_t playStartTick = g_engine.playStartTick.load();

        // Stage 3e-2: publish THIS buffer's transport position before any
        // plugin runs — bpm/time-signature from the immutable snapshot (the
        // one tempo active today; a future tempo map resolves per buffer
        // here), ppq/bar-start derived from the timeline sample. Pure
        // atomics — no lock, no allocation, realtime-safe.
        {
            const double bpmNow = score ? score->bpm : 120.0;
            const int num = score ? score->tsNumerator : 4;
            const int den = score ? score->tsDenominator : 4;
            const double spq = g_engine.sampleRate.load() * 60.0 / bpmNow;
            const int64_t tlSample = static_cast<int64_t>(std::llround(
                static_cast<double>(playStartTick) * spt)) +
                std::max<int64_t>(0, startSample);   // Phase 2: pinned at the start tick through the pre-roll
            const double ppqNow = static_cast<double>(tlSample) / spq;
            const double barQ = static_cast<double>(num) * 4.0 / static_cast<double>(den);
            playHead.publish(true, tlSample, bpmNow, ppqNow,
                             std::floor(ppqNow / barQ) * barQ, num, den);
        }

        // Routing-only plugin test (shared by the skip and dispatch walks and
        // by dispatchTo). F4: plugin-routed events dispatch EARLIER by the
        // OWNING instance's reported latency (3d-4: per-slot, from the
        // immutable set) so the audible attack lands on the grid.
        auto isPluginRouted = [&](const EngineEvent& ev) -> bool {
            if (instances == nullptr || routing == nullptr || ev.trackRef == 0) return false;
            if (ev.trackRef >= routing->slotChannel.size()) return false;
            if (routing->slotChannel[ev.trackRef] <= 0 ||
                routing->pluginChannels.count(ev.channel) == 0) return false;
            HostedPlugin* h = instances->slots[slotOfWide(ev.channel)];
            return h != nullptr && h->instance != nullptr;
        };
        // F4 shift for a routed event: its instance's latency (0 otherwise).
        auto latencyFor = [&](const EngineEvent& ev) -> int {
            if (instances == nullptr) return 0;
            return instances->slotLatency[slotOfWide(ev.channel)];
        };

        // Pass 1 — dispatch events (plugin → MidiBuffer, synth → voices) and
        // render the synth path into scratch.
        ensureScratch(static_cast<size_t>(numSamples));
        std::fill(synthScratch.begin(), synthScratch.begin() + numSamples, 0.0f);
        // Ledger marker for a flush batch (ch=0 synthetic): the CI test
        // correlates mute-flush position with state peaks by ENGINE TICK, so
        // runner-speed-dependent message latency can never skew the windows.
        if ((panicFlush || anyMuteFlush) && g_dispatchLog.load(std::memory_order_relaxed)) {
            const uint64_t idx = g_ledgerWrite.load(std::memory_order_relaxed);
            if (idx - g_ledgerRead.load(std::memory_order_relaxed) < kLedgerSize) {
                DispatchEntry& e = g_ledger[idx % kLedgerSize];
                e.s = startSample;   // raw: a pre-roll flush marker carries the negative sample truth
                e.t = playStartTick + static_cast<int64_t>(std::llround(
                    static_cast<double>(std::max<int64_t>(0, startSample)) / spt));
                e.k = kEvCC; e.ch = 0; e.d1 = 120; e.d2 = 0;
                g_ledgerWrite.store(idx + 1, std::memory_order_release);
            }
        }
        size_t eventIdx = 0;
        // Skip events before the current position. THE CLAMP RULE (3c
        // close-out receipt — the resume-replay bug), Phase 2 revision: the
        // F4 latency shift may pull an event BEFORE buffer start only when
        // its grid position is at/after the transport start tick — now into
        // the MUTED PRE-ROLL window (floor = -preRoll, not 0): a start-tick
        // event dispatches at -latency during the pre-roll and its audible
        // attack lands exactly on sample 0 = the grid. An event BEFORE the
        // start tick is PAST — it must NEVER resurrect: clamping it used to
        // re-dispatch the ENTIRE pre-resume score on every resume/seek (the
        // pluck + glitch receipt: ~630 stale events into BBCSO, every past
        // CC#32 re-firing = the bow-scrape). The past test is TICK-based
        // (ev.tick < playStartTick continues past), NOT sample-based: with
        // the timeline beginning at -preRoll, a past event's raw sample can
        // sit ABOVE startSample (a synth event one tick before the start is
        // at -spt, inside the window) and would resurrect if only samples
        // were compared.
        for (; eventIdx < eventCount; ++eventIdx) {
            const EngineEvent& ev = events[eventIdx];
            if (ev.tick < playStartTick) continue;   // PAST: never resurrects
            const int64_t raw = static_cast<int64_t>((ev.tick - playStartTick) * spt) -
                (isPluginRouted(ev) ? latencyFor(ev) : 0);
            // At/after the start tick: floor at -preRoll (the play-time max
            // latency snapshot). Events whose raw falls below it — a
            // mid-play latency growth past the snapshot — clamp and land
            // below the read position, i.e. skip as past (the same
            // never-resurrect semantics as the old clamp-to-0, with the
            // boundary moved by the pre-roll width).
            const int64_t eventSample = std::max<int64_t>(-preRoll, raw);
            if (eventSample >= startSample) break;
        }

        for (int s = 0; s < numSamples; ++s) {
            int64_t absSample = startSample + s;

            // Dispatch events at this sample (no lock — immutable snapshot).
            while (eventIdx < eventCount) {
                const EngineEvent& ev = events[eventIdx];
                const bool toPlugin = isPluginRouted(ev);
                // Same clamp rule as the skip walk above (Phase 2 floor: the
                // muted pre-roll window, -preRoll — start-tick events
                // pre-fire into it; past events never reach here, the skip
                // walk consumed them by tick).
                const int64_t eventSample = std::max<int64_t>(-preRoll,
                    static_cast<int64_t>((ev.tick - playStartTick) * spt) -
                    (ev.tick >= playStartTick && toPlugin ? latencyFor(ev) : 0));
                if (eventSample > absSample) break;
                dispatchTo(ev, toPlugin, static_cast<int>(absSample - eventSample),
                           absSample, spt, playStartTick, instances, routing, mix);
                ++eventIdx;
            }

            // Render all active voices (the built-in test synth path)
            double sample = 0;
            for (auto& v : g_engine.voices) {
                if (!v.active && !v.releasing) continue;
                // Sine oscillator
                sample += std::sin(v.phase) * v.env;
                v.phase += v.phaseInc;
                if (v.phase > 2.0 * M_PI) v.phase -= 2.0 * M_PI;

                // Envelope
                if (v.releasing) {
                    double releaseRate = 1000.0 / (kReleaseMs * g_engine.sampleRate.load());
                    v.env -= releaseRate;
                    if (v.env <= 0) { v.env = 0; v.releasing = false; v.active = false; v.pitch = -1; }
                } else {
                    double attackRate = 1000.0 / (kAttackMs * g_engine.sampleRate.load());
                    if (v.env < 1.0) v.env = std::min(1.0, v.env + attackRate);
                }
            }

            // Scratch the synth contribution (mono); written to output below.
            synthScratch[static_cast<size_t>(s)] = static_cast<float>(sample * 0.2); // prevent clipping
        }

        // Resume re-attacks (3c close-out): straddling notes were re-published
        // INTO the snapshot at the start tick (flags bit set) by the play/seek
        // handler — the walk above dispatches them at sample 0 like any other
        // event. Nothing extra to do here; the handler's receipt names them.

        // Pass 2 — output = Σ hosted instances (3d-4) + built-in synth. The
        // buffer was zeroed at callback entry; every path ADDS below (the old
        // single-instance render ASSIGNED — identical result for one instance,
        // and the sum is what multiple instances require).
        {
            if (instances != nullptr) {
                for (int slot = 0; slot < kMaxInstances; ++slot) {
                    HostedPlugin* h = instances->slots[slot];
                    if (h == nullptr || !h->instance) continue;
                    renderPlugin(*h, instMidi[slot], outputChannelData,
                                 numOutputChannels, numSamples, peak);
                }
            }
            const bool noPlugin = instances == nullptr;
            for (int s = 0; s < numSamples; ++s) {
                const float out = synthScratch[static_cast<size_t>(s)];
                if (noPlugin) {
                    for (int ch = 0; ch < numOutputChannels; ++ch)
                        outputChannelData[ch][s] = out;
                } else {
                    for (int ch = 0; ch < numOutputChannels; ++ch)
                        outputChannelData[ch][s] += out;
                }
            }
            // Phase 2 — MUTED PRE-ROLL, sample-accurate: samples before
            // timeline zero rendered the latency-line priming + the
            // pre-fired start-tick events into the buffer; they are
            // discarded here. The audible transport begins at sample 0 =
            // the grid position of playStartTick. The peak truth pass below
            // measures the POST-mute buffer — a muted pre-roll reports
            // peak 0 (honest silence, no phantom pre-roll peak).
            const int64_t muteCount = startSample < 0
                ? std::min<int64_t>(static_cast<int64_t>(numSamples), -startSample) : 0;
            if (muteCount > 0) {
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    std::memset(outputChannelData[ch], 0,
                                sizeof(float) * static_cast<size_t>(muteCount));
                peak = 0.0f;   // the pre-mute loose per-source bounds are discarded with the window
            }
            // Stage 3d-4: the session peak is measured on the SUMMED device
            // buffer (Σ instances + synth), NOT per-source — two 0.79 sources
            // are a 1.57 mix, and the receipt must say so. Single-source peaks
            // above are a loose lower bound only; this pass is the truth.
            for (int s = 0; s < numSamples; ++s) {
                float mx = 0.0f;
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    mx = std::max(mx, std::abs(outputChannelData[ch][s]));
                peak = std::max(peak, mx);
            }
        }
        g_lastPeak.store(peak, std::memory_order_relaxed);
        // Session peak (F3 receipt) + honest active-voice count for handlers.
        {
            const float prev = g_playPeakMax.load(std::memory_order_relaxed);
            if (peak > prev) g_playPeakMax.store(peak, std::memory_order_relaxed);
        }
        recountVoices();
        recountHeldNotes();

        // Commit — but only if no play/seek invalidated this buffer meanwhile.
        if (g_engine.transportGen.load(std::memory_order_relaxed) == gen0) {
            const int64_t committed = startSample + numSamples;
            g_engine.samplesProcessed.store(committed);   // RAW: the dispatch timeline must traverse the pre-roll
            // Phase 2: the reported position clamps the pre-roll window —
            // lastTick stays at the start tick until sample 0.
            g_engine.lastTick.store(playStartTick +
                static_cast<int64_t>(static_cast<double>(std::max<int64_t>(0, committed)) / spt));

            // Stop at endTick — MUSICAL (3c close-out): the synth voices fade
            // (allNotesOff = release), and the plugin path gets real note-offs
            // via the release flag on the next buffer (score-authored offs
            // have normally already fired; this catches anything still held).
            const int64_t nowTick = playStartTick +
                static_cast<int64_t>(static_cast<double>(std::max<int64_t>(0, committed)) / spt);
            if (endTick > 0 && nowTick >= endTick) {
                g_engine.playing.store(false);
                allNotesOff();
                g_releasePending.store(true, std::memory_order_relaxed);
            }
        }
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
        // Adopt the device's actual rate (real device or null device) so the
        // tick→sample scheduling math matches the running callback.
        if (device == nullptr) return;
        g_engine.sampleRate.store(device->getCurrentSampleRate());
        g_deviceBufferSize.store(static_cast<int>(device->getCurrentBufferSizeSamples()));
        // No lock: callbacks are not running during device start, and the
        // published plugin instance is immutable except for this prepare.
        ensureScratch(static_cast<size_t>(device->getCurrentBufferSizeSamples()));
        procBuf.setSize(2, device->getCurrentBufferSizeSamples(), false, true, false);
        // Stage 3c-2/3c-polish (D1) — (re)prepare EVERY hosted instance for
        // the REAL device (create-time used nominal 44100/512) and LOG the
        // actual config pair so a prepare/config mismatch can never hide
        // again. Stage 3d-4: the whole live set re-prepares on device start.
        if (auto set = g_instances.load(std::memory_order_acquire)) {
            int maxLat = 0;
            for (int slot = 0; slot < kMaxInstances; ++slot) {
                HostedPlugin* h = set->slots[slot];
                if (h == nullptr || !h->instance) continue;
                auto* p = h->instance.get();
                // Stage 3e-2: keep the playhead attached across every
                // re-prepare (setPlayHead persists, but re-assert it — cheap
                // and proof against wrapper resets). Member of THIS callback.
                p->setPlayHead(&playHead);
                p->setPlayConfigDetails(0, 2, device->getCurrentSampleRate(),
                                        device->getCurrentBufferSizeSamples());
                // Stage 3e-3: setPlayConfigDetails' next-best-layout
                // negotiation disables non-main output buses — re-enable ALL
                // output buses after it, before the prepare (same ordering
                // as loadHostedPlugin).
                for (int b = 0; b < p->getBusCount(false); ++b)
                    if (auto* bus = p->getBus(false, b)) bus->enable(true);
                p->prepareToPlay(device->getCurrentSampleRate(),
                                 device->getCurrentBufferSizeSamples());
                const int lat = static_cast<int>(p->getLatencySamples());
                h->latencySamples = static_cast<double>(lat);
                if (lat > maxLat) maxLat = lat;
                const double devMs = static_cast<double>(device->getCurrentBufferSizeSamples()) /
                                     device->getCurrentSampleRate() * 1000.0;
                const double plugMs = p->getLatencySamples() / device->getCurrentSampleRate() * 1000.0;
                std::cout << "[engine] latency: device=" << devMs << "ms plugin=" << plugMs
                          << "ms total=" << (devMs + plugMs) << "ms instance=" << h->instanceId << std::endl;
                engineLog("[plugin] prepared rate=" +
                          std::to_string(static_cast<int>(device->getCurrentSampleRate())) +
                          " buffer=" + std::to_string(device->getCurrentBufferSizeSamples()) +
                          " latencySamples=" + std::to_string(lat) +
                          " instance=" + h->instanceId +
                          " (device actual: \"" + device->getName().toStdString() + "\" type=" +
                          device->getTypeName().toStdString() + ")");
            }
            g_pluginLatencySamples.store(maxLat, std::memory_order_release);
            // Stage 3i — THIRD PRODUCER: the re-prepare loop above refreshed
            // h->latencySamples and the max mirror, but the PUBLISHED set's
            // slotLatency (what the F4 dispatch shift actually reads) was
            // never updated. Enqueue the same mini-republish job with the
            // freshly prepared values — device (re)start becomes just another
            // producer of the same corrections.
            for (int slot = 0; slot < kMaxInstances; ++slot) {
                HostedPlugin* h = set->slots[slot];
                if (h == nullptr || !h->instance) continue;
                const int lat = static_cast<int>(h->instance->getLatencySamples());
                if (lat != set->slotLatency[slot])
                    latencyTryEnqueue(h->instanceId, lat);
            }
        }
    }

    void audioDeviceStopped() override {}

private:
    std::vector<float> synthScratch;              // synth contribution per buffer
    juce::AudioBuffer<float> procBuf;             // hosted plugin render target
    juce::MidiBuffer midiBuf;                     // reusable per-buffer MIDI (clear() keeps capacity)
    // Stage 3d-4: ONE reusable MidiBuffer PER SLOT (same steady-state
    // no-alloc contract) — each instance receives only its own events.
    juce::MidiBuffer instMidi[kMaxInstances];

    // Stage 3h test-only stall state (audio-thread-owned; see the hook at the
    // top of audioDeviceIOCallbackWithContext). The first buffer only
    // INITIALIZES the seen-flag so a stale marker at device start cannot
    // freeze the very first buffer.
    bool testStallInited = false;
    bool testStallLastSeen = false;

public:
    // Stage 3e-2: the playhead every hosted instance sees. One stable address
    // (g_audioCallback is a namespace-level global); loadHostedPlugin and the
    // worker prepare paths hand &playHead to every instance. Public — the
    // hosting code lives outside this class.
    EnginePlayHead playHead;

private:

    void ensureScratch(size_t numSamples) {
        if (synthScratch.size() < numSamples) synthScratch.resize(numSamples, 0.0f);
    }

    // Honest active-voice count for handler receipts, recomputed by the
    // audio thread (which owns the voices) at each buffer boundary.
    void recountVoices() {
        int n = 0;
        for (const auto& v : g_engine.voices)
            if (v.active || v.releasing) ++n;
        g_activeVoices.store(n, std::memory_order_relaxed);
    }

    // Honest held-plugin-note count (the release receipt's "m=" figure),
    // recomputed at each buffer boundary from the audio-thread-owned ledger.
    // 3d-4: the ledger spans the whole wide-channel space.
    void recountHeldNotes() {
        int n = 0;
        for (int ch = 0; ch < kWideChannels; ++ch)
            for (int p = 0; p < 128; ++p)
                if (g_heldPluginNotes[ch][p]) ++n;
        g_heldPluginNoteCount.store(n, std::memory_order_relaxed);
    }

    // Render one buffer through the hosted plugin and mix its output buses
    // into the device buffer, tracking the output peak.
    // Stage 3c-polish F3: the hosted OUTPUT GAIN is applied here — plugin
    // path only, after render, before the master bus. NOT a per-track mix
    // recalibration (that is mix-v4); CC7/CC11 remain the per-track levels.
    //
    // Stage 3d-2 (the gauntlet): STEREO-HONEST OUTPUT COPY — L←ch0, R←ch1,
    // mono fold, >2-ch mapped as-is (see the original comment below).
    //
    // Stage 3e-3 — MULTI-OUTPUT BUSES: procBuf is sized to the TOTAL output
    // channel count across all ENABLED buses (the instance's immutable
    // outputBusChannels table), processBlock runs ONCE, then per bus:
    //   bus 0 (main)  → master stereo EXACTLY as always (L←ch0, R←ch1, mono
    //                   duplicated) — for single-bus plugins the arithmetic
    //                   below is BYTE-IDENTICAL to the pre-3e-3 loop;
    //   every other bus → ALSO summed to master stereo by default (nothing
    //                   becomes silent), each fold using the same L/R/mono
    //                   mapping restricted to that bus's channel slice.
    // outputRouting (optional, immutable per instance): {busIndex, gain,
    // mute} — mute skips the bus entirely, gain scales the bus before the
    // master bus (multiplied with the global hosted output gain). Absent
    // entries = gain 1, not muted. Unknown bus indices are ignored.
    void renderPlugin(HostedPlugin& h, juce::MidiBuffer& midi,
                      float* const* outputChannelData, int numOutputChannels,
                      int numSamples, float& peak) {
        const int total = h.totalOutputChannels > 0
            ? h.totalOutputChannels
            : juce::jlimit(1, 8, h.instance->getMainBusNumOutputChannels());   // legacy fallback
        if (procBuf.getNumSamples() != numSamples || procBuf.getNumChannels() != total)
            procBuf.setSize(total, numSamples, false, true, false);
        for (int ch = 0; ch < procBuf.getNumChannels(); ++ch)
            procBuf.clear(ch, 0, numSamples);
        h.instance->processBlock(procBuf, midi);
        const float masterGain = g_hostedOutputGain.load(std::memory_order_relaxed);
        int busStart = 0;
        const int nBuses = static_cast<int>(h.outputBusChannels.size());
        for (int b = 0; b < nBuses; ++b) {
            const int chans = h.outputBusChannels[static_cast<size_t>(b)];
            busStart += chans;
            if (chans <= 0) continue;   // disabled/refused bus — contributes nothing
            const BusRouting* r = nullptr;
            for (const auto& rr : h.outputRouting)
                if (rr.busIndex == b) { r = &rr; break; }   // last entry wins
            if (r != nullptr && r->mute) continue;          // routed mute — bus skipped
            const float busGain = masterGain * (r != nullptr ? std::clamp(r->gain, 0.0f, 8.0f) : 1.0f);
            if (busGain == 0.0f) continue;                  // gain 0 = silence, skip the copy
            for (int s = 0; s < numSamples; ++s) {
                float peakSample = 0.0f;
                for (int ch = 0; ch < numOutputChannels; ++ch) {
                    const int src = chans > 1 ? juce::jmin(ch, 1) : 0;
                    const float out = procBuf.getSample(busStart - chans + src, s) * busGain;
                    // Stage 3d-4: ADD (the device buffer is zeroed at callback
                    // entry and carries the Σ of all instances + the synth path;
                    // the old ASSIGN was only correct for one instance).
                    outputChannelData[ch][s] += out;
                    peakSample = std::max(peakSample, std::abs(out));
                }
                peak = std::max(peak, peakSample);
            }
        }
    }

    // Stage 3c-2 dispatch: mute/solo gate FIRST (before any send — the carried
    // debt, now audible), then plugin channel routing, then the test synth.
    // Stage 3c-polish (F4/D2): the routing decision is computed by the caller
    // (the dispatch walk needs it for the latency shift) and passed in.
    // Stage 3d-4: dispatch is WIDE-CHANNEL aware. ev.channel is the internal
    // wide channel (slot*16 + ch); the MIDI message carries the instance's
    // REAL 1..16 channel into that instance's own MidiBuffer. The ledger
    // (held notes / articulation / CI entries) is indexed by the wide channel
    // — slot 0 wide == legacy 1..16, so single-instance receipts are stable.
    void dispatchTo(const EngineEvent& ev, bool toPlugin, int samplePos, int64_t absSample, double spt,
                    int64_t playStartTick,
                    const std::shared_ptr<const InstanceSet>& instances,
                    const std::shared_ptr<const RoutingTable>& routing,
                    const std::shared_ptr<const MixState>& mix) {
        // Per-track mute/solo gating (trackRef 0 = legacy/ungated events).
        if (ev.trackRef != 0 && mix) {
            const bool audible = mix->anySolo
                ? (ev.trackRef < mix->solo.size() && mix->solo[ev.trackRef] != 0)
                : !(ev.trackRef < mix->muted.size() && mix->muted[ev.trackRef] != 0);
            if (!audible) return;
        }
        // Channel routing: ONLY tracks REGISTERED as plugin-routed (slot →
        // wide-channel map) send into their owning instance — a synth-track
        // event whose midiChannel numerically collides with a hosted channel
        // can never leak into any hosted plugin. Everything else falls to the
        // built-in test synth.
        if (toPlugin && instances != nullptr) {
            const int slot = slotOfWide(ev.channel);
            HostedPlugin* h = instances->slots[slot];
            if (h == nullptr || !h->instance) return;   // set raced a retire: drop, never crash
            juce::MidiBuffer& midi = instMidi[slot];
            const int ch = realChOfWide(ev.channel);
            switch (ev.kind) {
                case kEvNoteOn:
                    midi.addEvent(juce::MidiMessage::noteOn(ch, ev.data1, juce::uint8(ev.data2)), samplePos);
                    g_heldPluginNotes[ev.channel - 1].setBit(ev.data1);   // held-note ledger (wide index)
                    break;
                case kEvNoteOff:
                    midi.addEvent(juce::MidiMessage::noteOff(ch, ev.data1, juce::uint8(0)), samplePos);
                    g_heldPluginNotes[ev.channel - 1].clearBit(ev.data1); // released
                    break;
                case kEvCC:
                    // Stage 3c close-out — EXPRESSION-MAP-AWARE SENDS: UACC
                    // CC#32 is LATCHING inside the library. Re-sending the
                    // value a channel is already in re-articulates the
                    // patch (the audible bow-scrape "pluck" on resume). The
                    // articulation state is seeded from the score's past at
                    // play time and updated here as CC#32s dispatch — a
                    // redundant value is suppressed (ledger kind 6), only
                    // genuine changes are sent. 3d-4: per WIDE channel — two
                    // instances' channel 1 are independent articulation contexts.
                    if (ev.data1 == 32) {
                        const uint8_t cur =
                            g_articulation[ev.channel - 1].load(std::memory_order_relaxed);
                        if (cur == ev.data2) {
                            recordDispatch(ev, absSample, spt, playStartTick, kEvCCSuppressed);
                            return;   // nothing dispatched, nothing held
                        }
                        g_articulation[ev.channel - 1].store(ev.data2, std::memory_order_relaxed);
                    }
                    midi.addEvent(juce::MidiMessage::controllerEvent(ch, ev.data1, ev.data2), samplePos);
                    break;
                case kEvBend:
                    midi.addEvent(juce::MidiMessage::pitchWheel(ch, (static_cast<int>(ev.data2) << 7) | ev.data1), samplePos);
                    break;
                case kEvPC:
                    midi.addEvent(juce::MidiMessage::programChange(ch, ev.data1), samplePos);
                    break;
                default: break;
            }
        } else {
            // Built-in synth: notes only (CC/bend/PC are meaningless here).
            if (ev.kind == kEvNoteOn) noteOn(ev.data1, ev.data2);
            else if (ev.kind == kEvNoteOff) noteOff(ev.data1);
        }
        recordDispatch(ev, absSample, spt, playStartTick);
    }

    // CI ledger: record what was ACTUALLY dispatched (post-gating), with the
    // sample-accurate position. Dropped silently when dispatch_log is off.
    // kindOverride: ledger-only markers (kEvCCSuppressed=6 for redundant UACC
    // sends) — the record shows what the send layer DECIDED, not just what
    // left the engine.
    void recordDispatch(const EngineEvent& ev, int64_t absSample, double spt, int64_t playStartTick,
                        uint8_t kindOverride = 0) {
        if (!g_dispatchLog.load(std::memory_order_relaxed)) return;
        const uint64_t idx = g_ledgerWrite.load(std::memory_order_relaxed);
        if (idx - g_ledgerRead.load(std::memory_order_relaxed) >= kLedgerSize) return; // full — drop
        DispatchEntry& e = g_ledger[idx % kLedgerSize];
        e.s = absSample;   // RAW: a negative sample = a pre-roll pre-fire dispatch (the Phase 2 truth channel)
        e.t = playStartTick + static_cast<int64_t>(std::llround(
            static_cast<double>(std::max<int64_t>(0, absSample)) / spt));   // the position clamps the pre-roll
        e.k = kindOverride != 0 ? kindOverride : ev.kind; e.ch = ev.channel; e.d1 = ev.data1; e.d2 = ev.data2;
        g_ledgerWrite.store(idx + 1, std::memory_order_release);
    }

    void noteOn(int pitch, int velocity) {
        // Find free voice or steal oldest
        int idx = -1;
        int64_t oldestAge = std::numeric_limits<int64_t>::max();
        for (int i = 0; i < kMaxVoices; ++i) {
            if (!g_engine.voices[i].active && !g_engine.voices[i].releasing) {
                idx = i; break;
            }
            if (g_engine.voices[i].age < oldestAge) {
                oldestAge = g_engine.voices[i].age;
                idx = i;
            }
        }
        if (idx < 0) idx = 0;
        auto& v = g_engine.voices[idx];
        v.pitch = pitch;
        v.freq = 440.0 * std::pow(2.0, (pitch - 69) / 12.0);
        v.phaseInc = 2.0 * M_PI * v.freq / g_engine.sampleRate.load();
        v.phase = 0;
        v.env = 0;
        v.active = true;
        v.releasing = false;
        v.age = ++g_engine.voiceAge;
    }

    void noteOff(int pitch) {
        for (auto& v : g_engine.voices) {
            if (v.active && v.pitch == pitch) {
                v.releasing = true;
                v.active = false;
            }
        }
    }

    void allNotesOff() {
        for (auto& v : g_engine.voices) {
            if (v.active || v.releasing) {
                v.releasing = true;
                v.active = false;
            }
        }
    }
};

EngineAudioCallback g_audioCallback;

// ─── Null device (Stage 3b-fix) ─────────────────────────────────────────────
// JUCE 8 no longer ships a NullAudioDevice, so the engine carries its own:
// a minimal AudioIODevice whose callback thread paces the graph in REAL TIME
// with zero hardware. --null-audio opens this instead of scanning for a real
// device — transport play SUCCEEDS and state ticks advance (CI + device-less).
class EngineNullDevice : public juce::AudioIODevice, private juce::Thread {
public:
    EngineNullDevice()
        : juce::AudioIODevice("scorch-null", "Null"), juce::Thread("scorch-null-audio") {}

    juce::StringArray getOutputChannelNames() override { return { "Output 1", "Output 2" }; }
    juce::StringArray getInputChannelNames() override { return {}; }
    juce::Array<double> getAvailableSampleRates() override { return { 44100.0, 48000.0 }; }
    juce::Array<int> getAvailableBufferSizes() override { return { 128, 256, 512, 1024 }; }
    int getDefaultBufferSize() override { return 512; }

    juce::String open(const juce::BigInteger& /*inputChannels*/,
                      const juce::BigInteger& outputChannels,
                      double sampleRateToUse,
                      int bufferSizeToUse) override {
        const juce::ScopedLock sl(stateLock);
        if (openFlag || running) return "null device already open";
        sampleRate = sampleRateToUse > 0 ? sampleRateToUse : 44100.0;
        bufferSize = bufferSizeToUse > 0 ? bufferSizeToUse : 512;
        activeOut = outputChannels;
        if (activeOut.countNumberOfSetBits() == 0) activeOut.setRange(0, 2, true);
        outBuffer.assign(static_cast<size_t>(bufferSize) * 2, 0.0f);
        inBuffer.assign(static_cast<size_t>(bufferSize), 0.0f);
        openFlag = true;
        return {};
    }

    void close() override {
        stop();
        const juce::ScopedLock sl(stateLock);
        openFlag = false;
    }

    bool isOpen() override { const juce::ScopedLock sl(stateLock); return openFlag; }

    void start(juce::AudioIODeviceCallback* newCallback) override {
        if (newCallback == nullptr) return;
        {
            const juce::ScopedLock sl(stateLock);
            if (!openFlag || running) return;
            deviceCallback = newCallback;
            running = true;
        }
        newCallback->audioDeviceAboutToStart(this);
        startThread(juce::Thread::Priority::normal);
    }

    void stop() override {
        juce::AudioIODeviceCallback* old = nullptr;
        {
            const juce::ScopedLock sl(stateLock);
            if (!running) return;
            old = deviceCallback;
            deviceCallback = nullptr;
            running = false;
        }
        stopThread(5000);
        if (old != nullptr) old->audioDeviceStopped();
    }

    bool isPlaying() override { const juce::ScopedLock sl(stateLock); return running; }
    juce::String getLastError() override { return {}; }
    int getCurrentBufferSizeSamples() override { const juce::ScopedLock sl(stateLock); return bufferSize; }
    double getCurrentSampleRate() override { const juce::ScopedLock sl(stateLock); return sampleRate; }
    int getCurrentBitDepth() override { return 32; }
    juce::BigInteger getActiveOutputChannels() const override { const juce::ScopedLock sl(stateLock); return activeOut; }
    juce::BigInteger getActiveInputChannels() const override { return {}; }
    int getOutputLatencyInSamples() override { return 0; }
    int getInputLatencyInSamples() override { return 0; }

private:
    void run() override {
        using Clock = std::chrono::steady_clock;
        const auto period = std::chrono::duration_cast<Clock::duration>(
            std::chrono::duration<double>(static_cast<double>(bufferSize) / sampleRate));
        juce::AudioIODeviceCallbackContext context{};
        auto nextTick = Clock::now();
        while (!threadShouldExit()) {
            std::fill(outBuffer.begin(), outBuffer.end(), 0.0f);
            float* outPtrs[2] = { outBuffer.data(), outBuffer.data() + bufferSize };
            const float* inPtrs[1] = { inBuffer.data() };
            juce::AudioIODeviceCallback* cb = nullptr;
            { const juce::ScopedLock sl(stateLock); cb = deviceCallback; }
            if (cb != nullptr)
                cb->audioDeviceIOCallbackWithContext(inPtrs, 0, outPtrs, 2, bufferSize, context);
            nextTick += period;
            std::this_thread::sleep_until(nextTick);
            if (Clock::now() - nextTick > period * 64) nextTick = Clock::now(); // resync after a stall
        }
    }

    juce::CriticalSection stateLock;  // guards open/running/callback + config
    juce::AudioIODeviceCallback* deviceCallback = nullptr;
    std::vector<float> outBuffer, inBuffer;
    juce::BigInteger activeOut;
    double sampleRate = 44100.0;
    int bufferSize = 512;
    bool openFlag = false;
    bool running = false;
};

// ─── Lazy audio subsystem (Stage 3b-fix) ────────────────────────────────────
// NOTHING here touches hardware at startup. The AudioDeviceManager is heap-
// constructed on the FIRST transport play only; device enumeration (the
// historical 0xC0000005 source on headless runners) runs inside the guarded
// ensureAudioReady() below, on the WS thread, with MSVC /EHa so that even an
// SEH access violation becomes a clean protocol error instead of a crash.
struct AudioSystem {
    std::mutex initMutex;
    std::unique_ptr<juce::AudioDeviceManager> manager;   // real-device path
    std::unique_ptr<EngineNullDevice> nullDevice;        // --null-audio path
    bool ready = false;
};

AudioSystem g_audio;

// Bring up the audio device. Returns "" on success, else a human-readable
// detail string for the no_audio_device error reply. A failed attempt resets
// the subsystem so the NEXT play retries (e.g. a device plugged in later).
std::string ensureAudioReady() {
    std::lock_guard<std::mutex> lock(g_audio.initMutex);
    if (g_audio.ready) return "";
    if (g_forcedNoAudio) return "--no-audio: forced device-less mode";

    try {
        if (g_nullAudio) {
            // CI / device-less: the engine's null device — the graph runs in
            // real time with no hardware. Transport play SUCCEEDS; state
            // ticks advance.
            auto dev = std::make_unique<EngineNullDevice>();
            juce::BigInteger outCh;
            outCh.setBit(0);
            outCh.setBit(1);
            auto err = dev->open(juce::BigInteger(), outCh, 44100.0, g_wantedBufferSize);
            if (err.isNotEmpty())
                return "null audio device open failed: " + err.toStdString();
            g_engine.sampleRate.store(dev->getCurrentSampleRate());
            dev->start(&g_audioCallback);
            g_audio.nullDevice = std::move(dev);
            g_audio.ready = true;
            std::cout << "[engine] audio: null device (no hardware) @ "
                      << g_audio.nullDevice->getCurrentSampleRate() << " Hz" << std::endl;
            // D1 receipt: the ACTUAL opened config, never the assumed one.
            {
                char gainBuf[16];
                std::snprintf(gainBuf, sizeof(gainBuf), "%.2f",
                              static_cast<double>(g_hostedOutputGain.load(std::memory_order_relaxed)));
                engineLog("[audio] opened device=\"scorch-null\" type=Null rate=" +
                          std::to_string(static_cast<int>(g_engine.sampleRate.load())) +
                          " buffer=" + std::to_string(g_audio.nullDevice->getCurrentBufferSizeSamples()) +
                          " (requested buffer=" + std::to_string(g_wantedBufferSize) + ")");
                engineLog(std::string("[audio] hosted output gain x") + gainBuf +
                          " (--plugin-gain) | latency compensation " +
                          std::to_string(g_pluginLatencySamples.load(std::memory_order_relaxed)) +
                          " samples (plugin-reported)");
            }
            return "";
        }

        g_audio.manager = std::make_unique<juce::AudioDeviceManager>();
        auto result = g_audio.manager->initialiseWithDefaultDevices(0, 2);
        if (result.isNotEmpty()) {
            std::string detail = result.toStdString();
            g_audio.manager.reset();  // release; the next play retries
            return detail.empty() ? "no default audio device" : detail;
        }
        // Stage 3c-polish F2 — request the CONSERVATIVE buffer size. The
        // device's driver default is often 128/256 (glitchy with a full
        // orchestra). If the driver refuses, keep its default and SAY SO.
        {
            auto setup = g_audio.manager->getAudioDeviceSetup();
            if (setup.bufferSize != g_wantedBufferSize) {
                setup.bufferSize = g_wantedBufferSize;
                auto setupErr = g_audio.manager->setAudioDeviceSetup(setup, true);
                if (setupErr.isNotEmpty())
                    engineLog("[audio] buffer-size request " + std::to_string(g_wantedBufferSize) +
                              " REJECTED by driver: " + setupErr.toStdString() +
                              " — keeping the device default");
            }
        }
        auto* device = g_audio.manager->getCurrentAudioDevice();
        if (device == nullptr) {
            g_audio.manager.reset();
            return "audio initialised but no current device";
        }
        g_engine.sampleRate.store(device->getCurrentSampleRate());
        g_audio.manager->addAudioCallback(&g_audioCallback);
        g_audio.ready = true;
        std::cout << "[engine] audio: " << device->getName().toStdString()
                  << " @ " << device->getCurrentSampleRate() << " Hz"
                  << " buffer=" << device->getCurrentBufferSizeSamples() << std::endl;
        // D1 receipt: the ACTUAL opened device config (name/type/rate/buffer),
        // never the assumed one — a prepare/config mismatch can now hide NOWHERE.
        {
            char gainBuf[16];
            std::snprintf(gainBuf, sizeof(gainBuf), "%.2f",
                          static_cast<double>(g_hostedOutputGain.load(std::memory_order_relaxed)));
            engineLog("[audio] opened device=\"" + device->getName().toStdString() +
                      "\" type=" + device->getTypeName().toStdString() +
                      " rate=" + std::to_string(static_cast<int>(device->getCurrentSampleRate())) +
                      " buffer=" + std::to_string(device->getCurrentBufferSizeSamples()) +
                      " (requested buffer=" + std::to_string(g_wantedBufferSize) + ")");
            engineLog(std::string("[audio] hosted output gain x") + gainBuf +
                      " (--plugin-gain) | latency compensation " +
                      std::to_string(g_pluginLatencySamples.load(std::memory_order_relaxed)) +
                      " samples (plugin-reported)");
        }
        return "";
    } catch (const std::exception& e) {
        g_audio.manager.reset();
        g_audio.nullDevice.reset();
        return std::string("audio init exception: ") + (e.what() ? e.what() : "unknown");
    } catch (...) {
        g_audio.manager.reset();
        g_audio.nullDevice.reset();
        return "audio init failed (SEH / unknown exception caught)";
    }
}

// Clean shutdown of whichever audio path is active. Never throws.
void shutdownAudio() {
    try {
        if (g_audio.nullDevice) {
            g_audio.nullDevice->close();
            g_audio.nullDevice.reset();
        }
        if (g_audio.manager) {
            g_audio.manager->removeAudioCallback(&g_audioCallback);
            g_audio.manager->closeAudioDevice();
            g_audio.manager.reset();
        }
        g_audio.ready = false;
        // Stage 3c — the hosted plugin is deliberately NOT released or
        // destroyed here. VST3 module teardown inside a dying process is a
        // known hosting-deadlock hazard (module terminate/editor teardown can
        // block forever) and buys nothing: the audio callback above is already
        // stopped, no further processBlock can run, and process exit reclaims
        // every resource. The instance's lifetime IS the process lifetime —
        // the g_instances set pointer and any retired instances are intentionally
        // leaked at exit (Stage 3c-polish: same policy, no lock needed).
    } catch (...) {
        // Swallow — shutdown must be robust.
    }
}

// JUCE 8 doesn't have juce::JSON::escape — manual JSON string escaper.
std::string escape_json(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// ─── VST3 scan (Stage 3c-1; 3f-2 describe/probe split) ──────────────────────
// Default directories per the brief: %COMMONPROGRAMFILES%\VST3 (per-machine),
// %LOCALAPPDATA%\Programs\Common\VST3 (per-user "Programs" location some
// installers write into — 3f-2), and %APPDATA%\VST3 (per-user) on Windows;
// the POSIX conventions elsewhere for dev/CI convenience.
std::vector<std::string> defaultVst3Dirs() {
    std::vector<std::string> dirs;
#ifdef _WIN32
    const char* cf = std::getenv("COMMONPROGRAMFILES");
    const char* lad = std::getenv("LOCALAPPDATA");
    const char* ad = std::getenv("APPDATA");
    if (cf != nullptr) dirs.push_back(std::string(cf) + "\\VST3");
    if (lad != nullptr) dirs.push_back(std::string(lad) + "\\Programs\\Common\\VST3");
    if (ad != nullptr) dirs.push_back(std::string(ad) + "\\VST3");
#else
    dirs.push_back("/usr/lib/vst3");
    const char* home = std::getenv("HOME");
    if (home != nullptr) dirs.push_back(std::string(home) + "/.vst3");
#endif
    return dirs;
}

// 3f-2 — RECURSIVE discovery. Real-world VST3 layouts nest bundles several
// folders deep (vendor/brand/product/Name.vst3), and a flat top-level walk
// loses them. Walk `root` collecting every entry whose name ends in .vst3
// (case-insensitive; a bundle DIRECTORY or a bare file): a hit is collected
// and NEVER descended into (a .vst3 bundle contains the plugin's own tree —
// scanning inside it would find the same classes again). Up to `depth`
// subfolder levels below the root (task contract: max depth 4). Deterministic
// order: entries at each level sorted case-insensitively by path, so
// "first by path order" dedup (below) is reproducible.
void collectVst3Paths(const juce::File& dir, int depth, std::vector<std::string>& out) {
    juce::Array<juce::File> entries;
    dir.findChildFiles(entries, juce::File::findFilesAndDirectories, false, "*");
    std::vector<juce::File> sorted;
    sorted.reserve(static_cast<size_t>(entries.size()));
    for (const auto& e : entries) sorted.push_back(e);
    std::sort(sorted.begin(), sorted.end(), [](const juce::File& a, const juce::File& b) {
        const std::string as = a.getFullPathName().toStdString();
        const std::string bs = b.getFullPathName().toStdString();
        const auto n = std::min(as.size(), bs.size());
        for (size_t i = 0; i < n; ++i) {
            const int ca = std::tolower(static_cast<unsigned char>(as[i]));
            const int cb = std::tolower(static_cast<unsigned char>(bs[i]));
            if (ca != cb) return ca < cb;
        }
        return as.size() < bs.size();
    });
    for (const auto& entry : sorted) {
        const std::string name = entry.getFileName().toStdString();
        const bool isVst3 = name.size() >= 5 &&
            std::equal(name.end() - 5, name.end(), ".vst3",
                       [](char a, char b) { return std::tolower(static_cast<unsigned char>(a)) ==
                                                    std::tolower(static_cast<unsigned char>(b)); });
        if (isVst3) {
            out.push_back(entry.getFullPathName().toStdString());
            continue;   // never look INSIDE a .vst3
        }
        if (depth > 1 && entry.isDirectory())
            collectVst3Paths(entry, depth - 1, out);
    }
}

// Scan ONE path and print its plugin descriptions between markers.
// Runs as a CHILD process (scorch-engine --scan-worker <path>): a plugin whose
// module crashes or hangs during load kills only this child — the parent scan
// records the failure and continues. Deliberately NO catch(...): a crashing
// plugin must actually take this process down (that is the crash-isolation
// contract the CI test proves); graceful load failures return zero types.
// Stage 3f-2 — DESCRIBE ONLY: this worker prints the row identity
// (name, vendor, version, uid, classId, isInstrument, path) from
// findAllTypesForFile alone and NEVER instantiates. Instantiating here was
// the 3e-1 "scanner loses plugins" defect: one library whose cold
// first-instantiate wedged >45 s erased its (already-described) row and every
// row behind it in the same worker. The instantiation work moved to
// runProbeWorker (--probe-worker), a SEPARATE child per row.
// Defined with the hosting code below (Stage 3e-1): the capability-record
// builder both the WS handshake and the probe worker share.
std::string buildCapabilityFields(juce::AudioPluginInstance& inst,
                                  const juce::PluginDescription& desc);

int runScanWorker(const std::string& path) {
    juce::VST3PluginFormat format;
    juce::OwnedArray<juce::PluginDescription> types;
    format.findAllTypesForFile(types, juce::String(path));
    std::cout << "SCORCH_SCAN_BEGIN\n";
    for (const auto* t : types) {
        const juce::String displayName =
            t->descriptiveName.isNotEmpty() ? t->descriptiveName : t->name;
        std::cout << "{\"name\":\"" << escape_json(displayName.toStdString())
                  << "\",\"vendor\":\"" << escape_json(t->manufacturerName.toStdString())
                  << "\",\"version\":\"" << escape_json(t->version.toStdString())
                  << "\",\"uid\":\"" << escape_json(juce::String(t->uniqueId).toStdString())
                  << "\",\"isInstrument\":" << (t->isInstrument ? "true" : "false")
                  // The full VST3 class identifier string (3e-1) — the
                  // rebind key the host prefers when loading by this row,
                  // and (3f-2) the key the scan_probe result merges by.
                  << ",\"classId\":\"" << escape_json(t->createIdentifierString().toStdString())
                  << "\",\"path\":\"" << escape_json(path) << "\""
                  << "}\n";
    }
    std::cout << "SCORCH_SCAN_END" << std::endl;
    return 0;
}

// Stage 3f-2 — PROBE one row. Runs as a CHILD process (scorch-engine
// --probe-worker <path> <classId>): the createPluginInstance +
// prepareToPlay + buildCapabilityFields work the scan worker used to do
// inline (3e-1), isolated so a wedged/crashing INSTANTIATE can no longer
// erase the scan row it belongs to. Prints EXACTLY ONE JSON object between
// the SCORCH_PROBE_BEGIN/END markers:
//   success            {"classId":"…","capabilities":{…}}
//   graceful failure   {"classId":"…","capabilitiesError":"…"}
// A hard crash or a hang prints nothing — the PARENT classifies both (exit
// code / 90 s timeout) and reports capabilitiesError itself.
// The ScopedJuceInitialiser_GUI: a probe child is a fresh process that does
// no other JUCE GUI work; if no initialiser is alive (the normal case here),
// create one as the FIRST statement — deliberately LEAKED (never destroyed).
// Why leaked: the initialiser's static destruction at process exit races the
// VST3 module-handle cache (which FreeLibrary()s the plugin DLL from its own
// atexit statics) — Windows CI measured exactly that death (exit 0xC0000374
// heap corruption on the synth probe's SUCCESS path, ~477 ms in, while the
// engine process — whose initialiser stays alive at exit — shuts down clean).
// A short-lived child gains nothing from an ordered teardown; the OS reaps
// the address space. The function-local static keeps the "create only if
// none is alive" contract idempotent without a SharedResourcePointer (whose
// static destruction was precisely the crashing step).
int runProbeWorker(const std::string& path, const std::string& classId) {
    static juce::ScopedJuceInitialiser_GUI* const juceInit = new juce::ScopedJuceInitialiser_GUI();
    (void) juceInit;
    juce::VST3PluginFormat format;
    juce::OwnedArray<juce::PluginDescription> types;
    format.findAllTypesForFile(types, juce::String(path));
    const juce::PluginDescription* chosen = nullptr;
    for (const auto* t : types)
        if (t->createIdentifierString() == juce::String(classId)) { chosen = t; break; }
    if (chosen == nullptr) {
        std::cout << "SCORCH_PROBE_BEGIN\n{\"classId\":\"" << escape_json(classId)
                  << "\",\"capabilitiesError\":\"classId not found at " << escape_json(path)
                  << "\"}\nSCORCH_PROBE_END" << std::endl;
        return 0;
    }
    juce::AudioPluginFormatManager mgr;
    mgr.addDefaultFormats();
    juce::String instErr;
    auto inst = mgr.createPluginInstance(*chosen, 44100.0, 512, instErr);
    if (inst == nullptr) {
        std::cout << "SCORCH_PROBE_BEGIN\n{\"classId\":\"" << escape_json(classId)
                  << "\",\"capabilitiesError\":\"" << escape_json(instErr.toStdString())
                  << "\"}\nSCORCH_PROBE_END" << std::endl;
        return 0;
    }
    // Same capture ordering as loadHostedPlugin (3e-1): the module reports
    // its real latency only after a prepare.
    inst->prepareToPlay(44100.0, 512);
    std::cout << "SCORCH_PROBE_BEGIN\n{\"classId\":\"" << escape_json(classId)
              << "\",\"capabilities\":{" << buildCapabilityFields(*inst, *chosen)
              << "}}\nSCORCH_PROBE_END" << std::endl;
    return 0;
}

// ─── Stage 3f-2 — background scan probes ────────────────────────────────────
// After scan_result goes out, each row is probed SEQUENTIALLY by the
// dedicated probe thread in main(): one --probe-worker child per row (90 s
// cap). The queue lives here; a fresher scan REPLACES pending jobs (its
// rows already supersede), while a probe in flight still completes.
struct ScanProbeJob { std::string path; std::string classId; };
std::mutex g_scanProbeMutex;
std::vector<ScanProbeJob> g_scanProbeQueue;
std::condition_variable g_scanProbeCv;
// Stage 3f-7 — LAZY probing: the scan RECORDS its rows (classId → path)
// instead of auto-probing every one (probing competed with the user — a 90 s
// hung probe child and a library-full of instantiates ran uninvited). Probes
// now run when (a) the frontend asks for a visible row ({"type":"probe"}),
// (b) the frontend asks for all rows ({"type":"probeAll"} — the scan
// dialog's "Probe all" button), or (c) a plugin is actually LOADED
// (probe-on-load, deduped per session until it succeeds). The pause gate in
// the probe thread keeps even requested probes from competing with a load,
// an open editor, or a rolling transport.
std::unordered_map<std::string, std::string> g_scanRowPaths;
// Probe-on-load dedupe: classId → 0 never probed / 1 probe IN FLIGHT (queued
// or child running) / 2 probe SUCCEEDED this session. Probe-on-load skips
// in-flight and succeeded probes (one load entry per class — a two-instance
// load must not queue two children) and RETRIES a failed one (the plugin
// loaded, so its earlier failure is stale). Explicit probe/probeAll requests
// bypass this map entirely (user intent) — its value is patched by the probe
// thread's outcome receipt.
std::unordered_map<std::string, int> g_probeOutcomeByClassId;
// Stage 3f-7: a load is in progress (queued or being instantiated/published
// by the init worker) — the probe thread pauses for its whole duration.
std::atomic<bool> g_pluginLoadActive{false};

// Queue ONE probe (shared by the probe message and probe-on-load). The
// registry is the path source of truth; unknown classIds answer a
// capabilitiesError scan_probe so the frontend row (if any) is annotated.
void queueProbeForClassId(const std::string& classId, ix::WebSocket* replyTo) {
    std::string path;
    {
        std::lock_guard<std::mutex> lock(g_scanProbeMutex);
        auto it = g_scanRowPaths.find(classId);
        if (it != g_scanRowPaths.end()) path = it->second;
    }
    if (path.empty()) {
        if (replyTo != nullptr)
            replyTo->send(std::string("{\"type\":\"scan_probe\",\"classId\":\"") +
                          escape_json(classId) +
                          "\",\"capabilitiesError\":\"unknown classId — no such scan row (scan first)\"}");
        return;
    }
    {
        std::lock_guard<std::mutex> lock(g_scanProbeMutex);
        g_scanProbeQueue.push_back(ScanProbeJob{path, classId});
    }
    g_scanProbeCv.notify_one();
    engineLog("[probe] requested classId=\"" + classId + "\" path=" + path);
}

// Out-of-process directory scan (3f-2 DESCRIBE stage). Each *.vst3 entry
// (bundle dir or file, found RECURSIVELY up to 4 subfolder levels) is
// described by a child copy of this exe with a hard 20 s timeout — describe
// is findAllTypesForFile ONLY (the instantiate work moved to --probe-worker).
// Crashes and hangs become per-file "failed" entries that now CARRY THE
// DIAGNOSTICS (exit code, wall-clock elapsedMs, last 2000 chars of the
// worker's stderr) — the engine and the scan survive. Duplicate classIds are
// deduped, first by scan order. Since 3f-7 the rows are RECORDED for lazy
// probing — the frontend requests probes for the rows it shows (probe /
// probeAll) and loaded plugins are probed automatically.
void handle_scan(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    std::vector<std::string> dirs;
    if (obj != nullptr) {
        const auto& dirsVar = obj->getProperty("dirs");
        if (dirsVar.isArray()) {
            for (auto& d : *dirsVar.getArray()) {
                std::string s = d.toString().toStdString();
                if (!s.empty()) dirs.push_back(s);
            }
        }
    }
    if (dirs.empty()) dirs = defaultVst3Dirs();

    const juce::String exePath =
        juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName();

    std::string pluginsJson, failedJson, scannedJson;
    std::unordered_map<std::string, std::string> rowPaths;   // 3f-7: classId → path (lazy probing)
    std::unordered_set<std::string> seenClassIds;
    int pluginCount = 0, failedCount = 0;

    // 3f-2 — one failed entry WITH DIAGNOSTICS: path, error, exitCode,
    // elapsedMs and the last 2000 chars of the worker's output. JUCE's
    // ChildProcess merges the child's stdout AND stderr into a single pipe
    // on every platform (both dup2'd / STARTF_USESTDHANDLES onto one handle
    // when both stream flags are set), so for a crashed or killed worker
    // that tail IS the worker's stderr — the class of evidence the old
    // "scanner worker crashed (exit N)" one-liner threw away.
    auto addFailed = [&](const std::string& path, const std::string& error,
                         int code, long long ms, const std::string& out) {
        std::string tail = out.size() > 2000 ? out.substr(out.size() - 2000) : out;
        if (!failedJson.empty()) failedJson += ",";
        failedJson += std::string("{\"path\":\"") + escape_json(path) +
                      "\",\"error\":\"" + escape_json(error) +
                      "\",\"exitCode\":" + std::to_string(code) +
                      ",\"elapsedMs\":" + std::to_string(ms) +
                      ",\"stderrTail\":\"" + escape_json(tail) + "\"}";
        ++failedCount;
    };

    for (const auto& dir : dirs) {
        const juce::File dirFile(dir);
        if (!scannedJson.empty()) scannedJson += ",";
        if (!dirFile.isDirectory()) {
            scannedJson += std::string("{\"dir\":\"") + escape_json(dir) + "\",\"status\":\"missing\"}";
            continue;
        }
        scannedJson += std::string("{\"dir\":\"") + escape_json(dir) + "\",\"status\":\"scanned\"}";

        // 3f-2: RECURSIVE walk — vendor/product nests real libraries deep;
        // max 4 subfolder levels below the root; a .vst3 hit is never
        // descended into. Deterministic order (case-insensitive path sort at
        // every level) → "keep the FIRST by path order" dedup is stable.
        std::vector<std::string> paths;
        collectVst3Paths(dirFile, 4, paths);

        for (const auto& path : paths) {
            const auto t0 = std::chrono::steady_clock::now();
            const auto elapsedMs = [&t0]() {
                return std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - t0).count();
            };
            juce::ChildProcess child;
            // Both stream flags EXPLICIT: the child's stdout+stderr arrive
            // merged (see addFailed) — stderr is what a crash diagnosis
            // reads.
            const bool started = child.start(
                juce::StringArray{ exePath, "--scan-worker", juce::String(path) },
                juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr);
            std::string out;
            int exitCode = -1;
            if (!started) {
                addFailed(path, "scanner child failed to start", -1, elapsedMs(), out);
                engineLog(std::string("[scan] path=") + path + " outcome=start-failed elapsedMs=" +
                          std::to_string(elapsedMs()));
                continue;
            }
            // 3f-2: 20 s describe timeout (was 45 s) — the worker no longer
            // instantiates; describing a real library (module load +
            // GetPluginFactory enumeration) is a seconds-scale job.
            if (!child.waitForProcessToFinish(20000)) {
                child.kill();
                out = child.readAllProcessOutput().toStdString();
                addFailed(path, "scanner timeout after 20s", -1, elapsedMs(), out);
                engineLog(std::string("[scan] path=") + path + " outcome=timeout elapsedMs=" +
                          std::to_string(elapsedMs()));
                continue;
            }
            exitCode = child.getExitCode();
            out = child.readAllProcessOutput().toStdString();
            if (exitCode != 0) {
                addFailed(path, "scanner worker crashed (exit " + std::to_string(exitCode) + ")",
                          exitCode, elapsedMs(), out);
                engineLog(std::string("[scan] path=") + path + " outcome=crashed elapsedMs=" +
                          std::to_string(elapsedMs()) + " exitCode=" + std::to_string(exitCode));
                continue;
            }
            const std::string begin = "SCORCH_SCAN_BEGIN";
            const std::string end = "SCORCH_SCAN_END";
            const auto b = out.find(begin);
            const auto e = out.find(end);
            if (b == std::string::npos || e == std::string::npos || e < b) {
                // Exit 0 but NO markers = the worker died mid-scan (SIGABRT /
                // hard kill before printing — JUCE reports signal death as
                // exit 0 on POSIX). Windows abort() surfaces as a real exit
                // code above; here we still classify it as a crash.
                addFailed(path, "scanner produced no result (worker crashed or was killed)",
                          0, elapsedMs(), out);
                engineLog(std::string("[scan] path=") + path + " outcome=crashed elapsedMs=" +
                          std::to_string(elapsedMs()) + " (no markers, exit 0)");
                continue;
            }
            // One compact JSON object per line between the markers.
            const std::string body = out.substr(b + begin.size(), e - (b + begin.size()));
            size_t pos = 0;
            while (pos < body.size()) {
                size_t nl = body.find('\n', pos);
                if (nl == std::string::npos) nl = body.size();
                std::string line = body.substr(pos, nl - pos);
                pos = nl + 1;
                // trim
                const auto first = line.find_first_not_of(" \t\r\n");
                if (first == std::string::npos) continue;
                line = line.substr(first, line.find_last_not_of(" \t\r\n") - first + 1);
                if (line.empty()) continue;
                auto parsed = juce::JSON::parse(juce::String(line));
                if (parsed.getDynamicObject() == nullptr) continue;
                // 3f-2: the SAME classId found twice (nested layouts, copied
                // bundles, overlapping dirs) keeps the FIRST row by scan
                // order; the duplicate is dropped entirely — never a second
                // row, never a second probe.
                const std::string cid =
                    parsed.getProperty("classId", juce::var("")).toString().toStdString();
                if (!cid.empty() && !seenClassIds.insert(cid).second) continue;
                if (!pluginsJson.empty()) pluginsJson += ",";
                pluginsJson += line;
                ++pluginCount;
                if (!cid.empty()) rowPaths[cid] = path;   // 3f-7: record for lazy probing (no auto-probe)
            }
            engineLog(std::string("[scan] path=") + path + " outcome=ok elapsedMs=" +
                      std::to_string(elapsedMs()));
        }
    }

    std::cout << "[engine] scan: " << pluginCount << " plugin(s), " << failedCount
              << " failed, dirs=" << dirs.size() << std::endl;
    engineLog("[scan] summary: " + std::to_string(pluginCount) + " row(s), " +
              std::to_string(failedCount) + " failed, dirs=" + std::to_string(dirs.size()) +
              " — probing is LAZY (3f-7): rows are probed on request (probe/probeAll) or when loaded");
    ws.send(std::string("{\"type\":\"scan_result\",\"plugins\":[") + pluginsJson +
            "],\"failed\":[" + failedJson + "],\"scannedDirs\":[" + scannedJson + "]}");

    // Stage 3f-7 — LAZY probing: record the rows for on-demand probes; do
    // NOT auto-probe. The frontend asks for the rows it actually shows
    // (probe / probeAll); loaded plugins are probed by probe-on-load.
    {
        std::lock_guard<std::mutex> lock(g_scanProbeMutex);
        g_scanRowPaths = std::move(rowPaths);
    }
}

// Stage 3f-7 — ON-DEMAND probes. {"type":"probe","classId":"…"} probes ONE
// row; {"type":"probeAll"} probes EVERY row of the last scan (the scan
// dialog's "Probe all" button). Both run through the same sequential probe
// thread (one --probe-worker child per row, 90 s cap) and its pause gate —
// a user-triggered probe still never competes with a load, an open editor,
// or a rolling transport.
void handle_probe(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    const std::string classId = obj != nullptr
        ? obj->getProperty("classId").toString().toStdString() : "";
    if (classId.empty()) {
        ws.send("{\"type\":\"error\",\"code\":\"bad_probe\",\"detail\":\"probe requires classId\"}");
        return;
    }
    queueProbeForClassId(classId, &ws);
}

void handle_probe_all(const juce::var& /*json*/, ix::WebSocket& ws) {
    std::vector<std::string> ids;
    {
        std::lock_guard<std::mutex> lock(g_scanProbeMutex);
        ids.reserve(g_scanRowPaths.size());
        for (const auto& kv : g_scanRowPaths) ids.push_back(kv.first);
    }
    if (ids.empty()) {
        engineLog("[probe] probeAll with no scan rows — nothing to probe (scan first)");
        return;
    }
    // Deterministic order (the map is keyed, not ordered) — sort so the
    // receipts are reproducible.
    std::sort(ids.begin(), ids.end());
    {
        std::lock_guard<std::mutex> lock(g_scanProbeMutex);
        for (const auto& cid : ids) {
            auto it = g_scanRowPaths.find(cid);
            g_scanProbeQueue.push_back(ScanProbeJob{it->second, cid});
        }
    }
    g_scanProbeCv.notify_one();
    engineLog("[probe] probeAll requested — " + std::to_string(ids.size()) + " row(s) queued");
}

// ─── Message handlers ───────────────────────────────────────────────────────
// Protocol v1 EXTENSION (additive, Stage 3b polish + 3c-1 scan + 3c-2 hosting):
//   transport play MAY carry "tick": <n>. Without it, play RESUMES from the
//   engine's lastTick (position at stop) — it never auto-resets to 0.
//   transport stop is PANIC: all voices die immediately (hosted plugin gets
//   a CC120 All-Sound-Off flush on all 16 channels).

// ─── Stage 3e-1 — CAPABILITY HANDSHAKE ──────────────────────────────────────
// Build the capability record from a LIVE instance + its description. Called
// right after createPluginInstance succeeds, BEFORE any host negotiation
// (setPlayConfigDetails / bus enabling) — the record documents the plugin's
// OWN defaults, which is exactly what "enabledByDefault" means. Returns the
// JSON fields WITHOUT the {"type":…,"instanceId":…} wrapper (both the WS
// message and the scan-row "capabilities" object wrap it differently).
// layoutChangeable is probed honestly: the bus can change layout iff some
// OTHER channel count is supported (bounded probe — load-time only, never
// on the audio thread).
std::string buildCapabilityFields(juce::AudioPluginInstance& inst,
                                  const juce::PluginDescription& desc) {
    auto boolStr = [](bool b) { return b ? "true" : "false"; };
    std::string buses;
    int inputBuses = 0, outputBuses = 0;
    // Stage 3f-7: the ONLY plugin-reported double in the record. A synth may
    // honestly report an infinite tail — serialize non-finite as null (the
    // frontend renders ∞; null tailSeconds means "infinite"). Bare inf/nan
    // would make the whole capability JSON unparseable.
    const std::string tailJson = jsonNumberOrNul(inst.getTailLengthSeconds());
    for (int dir = 0; dir < 2; ++dir) {
        const bool isInput = dir == 0;
        const int n = inst.getBusCount(isInput);
        if (isInput) inputBuses = n; else outputBuses = n;
        for (int i = 0; i < n; ++i) {
            const auto* bus = inst.getBus(isInput, i);
            if (bus == nullptr) continue;
            bool layoutChangeable = false;
            for (int ch = 1; ch <= 16 && !layoutChangeable; ++ch)
                if (ch != bus->getNumberOfChannels() && bus->isNumberOfChannelsSupported(ch))
                    layoutChangeable = true;
            if (!buses.empty()) buses += ",";
            buses += std::string("{\"input\":") + boolStr(isInput) +
                     ",\"index\":" + std::to_string(i) +
                     ",\"name\":\"" + escape_json(bus->getName().toStdString()) + "\"" +
                     ",\"channels\":" + std::to_string(bus->getNumberOfChannels()) +
                     ",\"isMain\":" + boolStr(bus->isMain()) +
                     ",\"enabledByDefault\":" + boolStr(bus->isEnabledByDefault()) +
                     ",\"layoutChangeable\":" + boolStr(layoutChangeable) + "}";
        }
    }
    std::string s;
    s += "\"name\":\"" + escape_json(desc.name.toStdString()) + "\"";
    s += ",\"vendor\":\"" + escape_json(desc.manufacturerName.toStdString()) + "\"";
    s += ",\"version\":\"" + escape_json(desc.version.toStdString()) + "\"";
    s += ",\"isInstrument\":" + std::string(boolStr(desc.isInstrument));
    s += ",\"acceptsMidi\":" + std::string(boolStr(inst.acceptsMidi()));
    s += ",\"producesMidi\":" + std::string(boolStr(inst.producesMidi()));
    s += ",\"isMidiEffect\":" + std::string(boolStr(inst.isMidiEffect()));
    s += ",\"hasEditor\":" + std::string(boolStr(inst.hasEditor()));
    s += ",\"numPrograms\":" + std::to_string(inst.getNumPrograms());
    s += ",\"latencySamples\":" + std::to_string(inst.getLatencySamples());
    s += ",\"tailSeconds\":" + tailJson;
    s += ",\"supportsDoublePrecision\":" + std::string(boolStr(inst.supportsDoublePrecisionProcessing()));
    s += ",\"inputBuses\":" + std::to_string(inputBuses);
    s += ",\"outputBuses\":" + std::to_string(outputBuses);
    s += ",\"classId\":\"" + escape_json(desc.createIdentifierString().toStdString()) + "\"";
    s += ",\"buses\":[" + buses + "]";
    return s;
}

// Host a VST3 by id/path (Stage 3c-2; 3d-4: one INSTANCE of possibly many —
// identity = the frontend's libraryGroup id, "hosted" for the legacy field).
// Stage 3e-3: routing (optional per-load outputRouting) rides in and lands
// on the immutable instance before publish. Returns "" on success, else a
// human-readable detail.
std::string loadHostedPlugin(const juce::var& pluginVar, const std::string& instanceId,
                             std::unique_ptr<HostedPlugin>& out,
                             std::vector<BusRouting> routing = {}) {
    juce::DynamicObject* pobj = pluginVar.getDynamicObject();
    if (pobj == nullptr) return "plugin field must be an object";
    const std::string path = pobj->getProperty("path").toString().toStdString();
    const std::string uid = pobj->getProperty("uid").toString().toStdString();
    if (path.empty()) return "plugin.path is required";
    if (instanceId.empty()) return "plugin.instanceId is required (multi-instance hosting)";
    try {
        juce::AudioPluginFormatManager mgr;
        mgr.addDefaultFormats();  // VST3 registered when JUCE_PLUGINHOST_VST3=1
        juce::VST3PluginFormat vst3;
        juce::OwnedArray<juce::PluginDescription> types;
        vst3.findAllTypesForFile(types, juce::String(path));
        if (types.isEmpty()) return "no plugin types found at " + path;
        // Stage 3e-1 — plugin matching PREFERS the full VST3 class identifier
        // string (PluginDescription::createIdentifierString()): stable per
        // class, carries name+format+uid, and survives uid renumbering. The
        // legacy numeric uid stays the fallback so saved projects (and scan
        // results, which still carry the numeric uid) keep loading.
        const juce::PluginDescription* chosen = nullptr;
        if (!uid.empty()) {
            for (const auto* t : types)
                if (t->createIdentifierString() == juce::String(uid)) { chosen = t; break; }
            if (chosen == nullptr) {
                const long long wantUid = std::atoll(uid.c_str());
                for (const auto* t : types)
                    if (static_cast<long long>(t->uniqueId) == wantUid) { chosen = t; break; }
            }
            if (chosen == nullptr) return "uid " + uid + " not found at " + path;
        } else {
            chosen = types[0];
            for (const auto* t : types)  // prefer an instrument when unspecified
                if (t->isInstrument) { chosen = t; break; }
        }
        juce::String err;
        auto inst = mgr.createPluginInstance(*chosen, 44100.0, 512, err);
        if (inst == nullptr) return "createPluginInstance failed: " + err.toStdString();
        // Stage 3e-2 — the instance gets the engine's playhead BEFORE any
        // prepare (plugins cache the pointer; the audio callback publishes
        // positions through it every buffer). One stable address: the
        // namespace-level g_audioCallback's member.
        inst->setPlayHead(&g_audioCallback.playHead);
        // Activate the stereo output bus into the graph (nominal rate/size;
        // audioDeviceAboutToStart re-prepares for the REAL device). Only the
        // MAIN bus is negotiated to 2 — the aux buses keep their layouts.
        // EMPIRICAL (3e-3): this call's next-best-layout negotiation DISABLES
        // non-main output buses (it asks the module for a 2-out arrangement
        // and the wrapper answers with aux disabled) — the enable-all below
        // therefore runs AFTER it, never before.
        inst->setPlayConfigDetails(0, 2, 44100.0, 512);
        if (inst->getMainBusNumOutputChannels() <= 0)
            return "plugin exposes no output bus: " + chosen->name.toStdString();
        // Stage 3d-2 (the gauntlet): bus-negotiation receipt — the plugin's
        // ACTUAL answer to the 0-in/2-out request, so a mono or surround
        // main bus is VISIBLE per plugin (renderPlugin maps whatever the
        // plugin really exposes; nothing is assumed).
        engineLog("[plugin] bus negotiation: requested 0-in/2-out, plugin answers " +
                  std::to_string(inst->getMainBusNumOutputChannels()) + "-out (\"" +
                  chosen->name.toStdString() + "\")");
        // Stage 3e-3 — ENABLE ALL OUTPUT BUSES the plugin allows (main +
        // aux), AFTER the main-bus negotiation that would otherwise have
        // disabled them. Input buses stay DISABLED — no sidechain in this
        // stage. A refused enable (plugins may forbid it) is receipt-visible
        // and that bus simply contributes nothing.
        {
            std::string busReceipt;
            for (int i = 0; i < inst->getBusCount(false); ++i) {
                auto* bus = inst->getBus(false, i);
                if (bus == nullptr) continue;
                const bool wasEnabled = bus->isEnabled();
                const bool ok = bus->enable(true);
                if (!busReceipt.empty()) busReceipt += " | ";
                busReceipt += "bus" + std::to_string(i) + " \"" + bus->getName().toStdString() + "\"";
                if (!ok && !wasEnabled) busReceipt += " ENABLE-REFUSED";
            }
            engineLog("[plugin] output buses ENABLED (all the plugin allows, inputs untouched): " + busReceipt);
        }
        inst->prepareToPlay(44100.0, 512);
        inst->setNonRealtime(false);
        // Stage 3e-1 — capture the capability record after the create-time
        // prepare: a VST3 module reports its REAL latency only once its
        // wrapper has prepared (empirical: right after createPluginInstance
        // the same fixture read 0). enabledByDefault/isMain are
        // construction-time flags no host call touches (enable() changes the
        // CURRENT layout, never the construction flag), so the 3e-3
        // enable-all above does not contaminate the record.
        const std::string capsFields = buildCapabilityFields(*inst, *chosen);
        auto hosted = std::make_unique<HostedPlugin>();
        hosted->instance = std::move(inst);
        hosted->name = chosen->name.toStdString();
        hosted->vendor = chosen->manufacturerName.toStdString();
        hosted->latencySamples = hosted->instance->getLatencySamples();
        // Stage 3i: attach the runtime-latency listener (see the block above
        // HostedPlugin). The callback stores one atomic flag — realtime-safe
        // no matter which thread the plugin notifies from. Detached in
        // ~HostedPlugin so the wrapper can never fire into a dying listener.
        hosted->latencyListener = std::make_unique<LatencyListener>(&hosted->latencyNotified);
        hosted->instance->addListener(hosted->latencyListener.get());
        hosted->uid = uid;
        hosted->path = path;
        hosted->instanceId = instanceId;
        hosted->classId = chosen->createIdentifierString().toStdString();
        hosted->capabilitiesFields = capsFields;
        // Stage 3f-7 — PROBE-ON-LOAD: a plugin that gets loaded is probed
        // (once per session while in flight or succeeded; retried after a
        // FAILED probe — the successful load makes the earlier failure
        // stale). The job queues behind the pause gate: the load is still in
        // progress right now, so the probe child only runs after the publish
        // (and the 2 s resume delay).
        {
            const std::string loadedClassId = chosen->createIdentifierString().toStdString();
            bool needProbe = false;
            {
                std::lock_guard<std::mutex> lock(g_scanProbeMutex);
                auto it = g_probeOutcomeByClassId.find(loadedClassId);
                if (it == g_probeOutcomeByClassId.end() || it->second == 0) {
                    g_probeOutcomeByClassId[loadedClassId] = 1;   // in flight
                    needProbe = true;
                }
            }
            if (needProbe) queueProbeForClassId(loadedClassId, nullptr);
        }
        // Stage 3e-3 — the bus→procBuffer channel table: per output bus, the
        // ENABLED channel count (disabled buses report 0). This table is the
        // offset map renderPlugin walks (lock-free, immutable from here).
        {
            int totalOut = 0;
            std::string chanReceipt;
            for (int i = 0; i < hosted->instance->getBusCount(false); ++i) {
                const auto* bus = hosted->instance->getBus(false, i);
                const int n = bus != nullptr ? bus->getNumberOfChannels() : 0;
                hosted->outputBusChannels.push_back(n);
                totalOut += n;
                if (!chanReceipt.empty()) chanReceipt += " | ";
                chanReceipt += "bus" + std::to_string(i) + " \"" +
                               (bus != nullptr ? bus->getName().toStdString() : "?") + "\" " +
                               std::to_string(n) + "ch" +
                               (bus != nullptr && bus->isMain() ? " (main)" : "");
            }
            hosted->totalOutputChannels = totalOut;
            engineLog("[plugin] output buses: instance=" + instanceId + " " + chanReceipt +
                      " — total " + std::to_string(totalOut) + "-out (renderPlugin mixes bus 0 to"+
                      " master as always; every other bus ALSO sums to master unless outputRouting says otherwise)");
        }
        hosted->outputRouting = std::move(routing);
        out = std::move(hosted);
        return "";
    } catch (const std::exception& e) {
        return std::string("plugin load exception: ") + (e.what() ? e.what() : "unknown");
    } catch (...) {
        return "plugin load failed (SEH / unknown exception caught)";
    }
}

void sendPluginState(ix::WebSocket& ws, const char* state, const std::string& name,
                     const std::string& vendor, double latencyMs, const std::string& detail,
                     const std::string& channelsJson, const std::string& instanceId = "",
                     const std::string& classId = "") {
    std::string msg = std::string("{\"type\":\"plugin_state\",\"state\":\"") + state + "\"";
    if (!instanceId.empty()) msg += ",\"instanceId\":\"" + escape_json(instanceId) + "\"";
    if (!name.empty()) msg += ",\"name\":\"" + escape_json(name) + "\"";
    if (!vendor.empty()) msg += ",\"vendor\":\"" + escape_json(vendor) + "\"";
    // Stage 3e-1: the full VST3 class identifier string rides every "loaded"
    // receipt (the rebind key that prefers identifier matching on reload).
    if (!classId.empty()) msg += ",\"classId\":\"" + escape_json(classId) + "\"";
    if (latencyMs >= 0) {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.2f", latencyMs);
        msg += std::string(",\"latencyMs\":") + buf;
    }
    if (!channelsJson.empty()) msg += ",\"channels\":[" + channelsJson + "]";
    if (!detail.empty()) msg += ",\"detail\":\"" + escape_json(detail) + "\"";
    msg += "}";
    ws.send(msg);
}

// Stage 3e-3 — parse the optional per-instance "outputRouting" field:
// a JSON array of {busIndex, gain, mute}. Malformed entries are SKIPPED but
// NAMED in the receipt (the load's named-skip discipline); the field is
// optional and additive — absent = default routing (all buses sum at gain 1).
void parseOutputRouting(const juce::var& v, std::vector<BusRouting>& out) {
    if (v.isVoid()) return;
    const auto* arr = v.getArray();
    if (arr == nullptr) {
        engineLog("[load] outputRouting is not an array — IGNORED (default routing: all buses sum at gain 1)");
        return;
    }
    int idx = -1;
    for (const auto& e : *arr) {
        ++idx;
        juce::DynamicObject* eo = e.getDynamicObject();
        if (eo == nullptr) {
            engineLog("[load] outputRouting[" + std::to_string(idx) + "] is not an object — SKIPPED");
            continue;
        }
        BusRouting r;
        r.busIndex = static_cast<int>(static_cast<double>(eo->getProperty("busIndex")));
        const juce::var& gainVar = eo->getProperty("gain");
        if (!gainVar.isVoid()) {
            const double g = static_cast<double>(gainVar);
            if (!std::isfinite(g)) {
                engineLog("[load] outputRouting[" + std::to_string(idx) + "] gain not finite — entry SKIPPED");
                continue;
            }
            r.gain = static_cast<float>(std::clamp(g, 0.0, 8.0));
        }
        r.mute = static_cast<bool>(eo->getProperty("mute"));
        if (r.busIndex < 0) {
            engineLog("[load] outputRouting[" + std::to_string(idx) + "] busIndex " +
                      std::to_string(r.busIndex) + " < 0 — entry SKIPPED");
            continue;
        }
        out.push_back(r);
    }
}

// Re-resolve the last mix request (trackId lists) against a routing table.
std::shared_ptr<const MixState> buildMixState(const RoutingTable& table,
                                              const LastMix& lastMix) {
    auto ms = std::make_shared<MixState>();
    ms->muted.assign(table.trackNames.size() + 1, 0);
    ms->solo.assign(table.trackNames.size() + 1, 0);
    for (const auto& id : lastMix.muted) {
        auto it = table.slotOf.find(id);
        if (it != table.slotOf.end()) ms->muted[it->second] = 1;
    }
    for (const auto& id : lastMix.solo) {
        auto it = table.slotOf.find(id);
        if (it != table.slotOf.end()) ms->solo[it->second] = 1;
    }
    ms->anySolo = !lastMix.solo.empty();
    return ms;
}

// Stage 3c close-out — forward declaration (defined with the transport
// helpers below; handle_load resets articulation context at publish time).
void resetArticulations();

void handle_load(const juce::var& json, ix::WebSocket& ws, size_t byteSize) {
    juce::DynamicObject* obj = json.getDynamicObject();
    if (!obj) { ws.send("{\"type\":\"error\",\"code\":\"bad_load\",\"echo\":\"load\"}"); return; }

    const auto& eventsVar = obj->getProperty("events");
    const auto& metaVar = obj->getProperty("meta");

    // Track table (slots) + channel assignments.
    RoutingTable table;
    std::unordered_map<std::string, int> channelOfTrack;   // trackId → WIDE channel (slot*16+ch)
    bool channelsBad = false;
    std::string channelsBadDetail;

    // ─── Stage 3d-4: MULTI-INSTANCE parse (additive over the legacy shape) ──
    // NEW:  plugins = [{instanceId, uid, path, name?, state?}],
    //       routing = {trackId: {inst, ch}}.
    // LEGACY (still accepted, byte-compatible): plugin = {uid, path, ...}
    // (ONE instance, reserved id "hosted", slot 0 — wide channels == 1..16),
    // channels = {trackId: ch}.
    struct ReqInstance { std::string instanceId; int slot = 0; juce::var pluginVar; std::string stateB64;
                         std::vector<BusRouting> routing; };   // 3e-3: optional outputRouting
    std::vector<ReqInstance> reqInstances;
    std::unordered_map<std::string, std::string> instanceOfTrack;   // trackId → instanceId
    if (const auto* pluginsArr = obj->getProperty("plugins").getArray()) {
        int pidx = -1;
        for (auto& pv : *pluginsArr) {
            ++pidx;
            juce::DynamicObject* po = pv.getDynamicObject();
            if (po == nullptr) {
                channelsBad = true;
                channelsBadDetail = "plugins[" + std::to_string(pidx) + "] is not an object";
                continue;
            }
            const std::string iid = po->getProperty("instanceId").toString().toStdString();
            if (iid.empty()) {
                channelsBad = true;
                channelsBadDetail = "plugins[" + std::to_string(pidx) + "].instanceId is required";
                continue;
            }
            if (iid == "hosted") {
                channelsBad = true;
                channelsBadDetail = "instanceId \"hosted\" is reserved for the legacy plugin field";
                continue;
            }
            bool dup = false;
            for (const auto& r : reqInstances) if (r.instanceId == iid) { dup = true; break; }
            if (dup) {
                channelsBad = true;
                channelsBadDetail = "duplicate instanceId \"" + iid + "\" in plugins[]";
                continue;
            }
            if (static_cast<int>(reqInstances.size()) >= kMaxInstances) {
                channelsBad = true;
                channelsBadDetail = "too many plugin instances (max " + std::to_string(kMaxInstances) + ")";
                continue;
            }
            ReqInstance r;
            r.instanceId = iid;
            r.slot = static_cast<int>(reqInstances.size());   // slot = declaration order (deterministic)
            r.pluginVar = pv;
            r.stateB64 = po->getProperty("state").toString().toStdString();
            parseOutputRouting(po->getProperty("outputRouting"), r.routing);
            reqInstances.push_back(std::move(r));
        }
    }
    const bool pluginsArraySent = !reqInstances.empty();
    const auto& pluginVar = obj->getProperty("plugin");
    if (!pluginsArraySent && pluginVar.getDynamicObject() != nullptr) {
        // Legacy single-plugin load → the reserved "hosted" instance, slot 0.
        ReqInstance r;
        r.instanceId = "hosted";
        r.slot = 0;
        r.pluginVar = pluginVar;
        r.stateB64 = pluginVar.getDynamicObject()->getProperty("state").toString().toStdString();
        parseOutputRouting(pluginVar.getDynamicObject()->getProperty("outputRouting"), r.routing);
        reqInstances.push_back(std::move(r));
    }
    const bool pluginRequested = !reqInstances.empty();

    // Routing: NEW routing map first; legacy flat channels map otherwise.
    // Both normalize into channelOfTrack (WIDE channels) + instanceOfTrack.
    if (auto* routingObj = obj->getProperty("routing").getDynamicObject()) {
        auto& props = routingObj->getProperties();
        std::map<std::pair<std::string, int>, bool> seenPerInstance;   // (inst, ch) collision scope
        for (int i = 0; i < props.size(); ++i) {
            const std::string trackId = props.getName(i).toString().toStdString();
            juce::DynamicObject* ro = props.getValueAt(i).getDynamicObject();
            if (trackId.empty() || ro == nullptr) {
                channelsBad = true;
                channelsBadDetail = "routing entries must be {inst, ch} objects";
                continue;
            }
            const std::string inst = ro->getProperty("inst").toString().toStdString();
            const int ch = static_cast<int>(static_cast<double>(ro->getProperty("ch")));
            if (ch < 1 || ch > 16) {
                channelsBad = true;
                channelsBadDetail = "engine channel must be an integer 1–16 (track " + trackId + ")";
                continue;
            }
            int slot = -1;
            for (const auto& r : reqInstances)
                if (r.instanceId == inst) { slot = r.slot; break; }
            if (slot < 0) {
                channelsBad = true;
                channelsBadDetail = "routing references unknown instanceId \"" + inst + "\" (track " + trackId + ")";
                continue;
            }
            if (!seenPerInstance.emplace(std::make_pair(inst, ch), true).second) {
                channelsBad = true;
                channelsBadDetail = "instance \"" + inst + "\" channel " + std::to_string(ch) +
                                    " assigned to more than one track (per-instance channel collision)";
                continue;
            }
            channelOfTrack[trackId] = wideChannelOf(slot, ch);
            instanceOfTrack[trackId] = inst;
        }
    } else if (auto* channelsObj = obj->getProperty("channels").getDynamicObject()) {
        auto& props = channelsObj->getProperties();
        std::unordered_set<int> seen;
        for (int i = 0; i < props.size(); ++i) {
            const std::string trackId = props.getName(i).toString().toStdString();
            const int ch = static_cast<int>(static_cast<double>(props.getValueAt(i)));
            if (trackId.empty() || ch < 1 || ch > 16) {
                channelsBad = true;
                channelsBadDetail = "engine channel must be an integer 1–16";
                continue;
            }
            if (!seen.insert(ch).second) {
                channelsBad = true;
                channelsBadDetail = "engine channel " + std::to_string(ch) +
                                    " assigned to more than one track (engine channel collision)";
                continue;
            }
            // Legacy: slot 0 ("hosted") — wide == wire channel, byte-stable.
            channelOfTrack[trackId] = wideChannelOf(0, ch);
            if (pluginRequested) instanceOfTrack[trackId] = "hosted";
        }
    }

    std::vector<EngineEvent> newEvents;
    // Stage 3c-hotfix receipt counters: malformed events are SKIPPED but
    // NAMED (the old loop `continue`d silently — one unserializable event
    // vanished without a trace, and a non-array events payload silently
    // EMPTIED the score while the transport kept "playing" bar after bar).
    int receivedCount = 0;
    int skipped = 0;
    int firstErrorIndex = -1;
    std::string firstErrorReason;
    std::string loadFail;   // non-empty = hard failure (score NOT replaced)
    std::map<int, int> perChannel;
    std::map<uint32_t, int> perTrack;   // slot → count (0 = no trackId)

    // Echo the frontend's load sequence number (additive; 0 if absent).
    long long seq = 0;
    {
        juce::var seqVar = obj->getProperty("seq");
        if (!seqVar.isVoid() && std::isfinite(static_cast<double>(seqVar)))
            seq = static_cast<long long>(static_cast<double>(seqVar));
    }

    auto skipEvent = [&](int idx, const std::string& why) {
        ++skipped;
        if (firstErrorIndex < 0) {
            firstErrorIndex = idx;
            firstErrorReason = why;
        }
    };

    if (!eventsVar.isArray()) {
        loadFail = "events is not an array";
    } else {
        int idx = -1;
        for (auto& ev : *eventsVar.getArray()) {
            ++idx;
            juce::DynamicObject* eobj = ev.getDynamicObject();
            if (!eobj) { skipEvent(idx, "event is not an object"); continue; }
            // Numeric fields must be present and FINITE before the int casts
            // below — static_cast<int>(NaN) is undefined behavior, and a
            // JSON null (e.g. a NaN serialized by the sender) used to become
            // a silent 0 instead of being named.
            auto numProp = [&](const char* name, double& out) -> bool {
                juce::var v = eobj->getProperty(name);
                if (v.isVoid()) return false;
                out = static_cast<double>(v);
                return std::isfinite(out);
            };
            double dCh = 0, d1 = 0, d2 = 0, dTick = 0;
            if (!numProp("channel", dCh) || !numProp("data1", d1) ||
                !numProp("data2", d2) || !numProp("timestampTicks", dTick)) {
                skipEvent(idx, "missing or non-finite numeric field (channel/data1/data2/timestampTicks)");
                continue;
            }
            EngineEvent ee;
            const juce::String et = eobj->getProperty("eventType").toString();
            if (et == "NOTE_ON") ee.kind = kEvNoteOn;
            else if (et == "CONTROL_CHANGE") ee.kind = kEvCC;
            else if (et == "PITCH_BEND") ee.kind = kEvBend;
            else if (et == "PROGRAM_CHANGE") ee.kind = kEvPC;
            else ee.kind = kEvNoteOff;
            int ch = static_cast<int>(dCh);
            if (ch < 1 || ch > 16) ch = 1;
            ee.channel = static_cast<uint8_t>(ch);
            ee.data1 = static_cast<uint8_t>(static_cast<int>(d1) & 0x7f);
            ee.data2 = static_cast<uint8_t>(static_cast<int>(d2) & 0x7f);
            ee.tick = static_cast<int64_t>(dTick);
            perChannel[ee.channel]++;
            // trackId → slot; a plugin-routed channel overrides the event's own.
            const juce::String trackIdVar = eobj->getProperty("trackId").toString();
            if (trackIdVar.isNotEmpty()) {
                const std::string trackId = trackIdVar.toStdString();
                auto it = table.slotOf.find(trackId);
                if (it == table.slotOf.end()) {
                    table.slotOf.emplace(trackId, table.trackNames.size() + 1);
                    table.trackNames.push_back(trackId);
                    it = table.slotOf.find(trackId);
                }
                ee.trackRef = it->second;
                perTrack[ee.trackRef]++;
                auto cit = channelOfTrack.find(trackId);
                if (cit != channelOfTrack.end()) ee.channel = static_cast<uint8_t>(cit->second);
            }
            newEvents.push_back(ee);
        }
        receivedCount = idx + 1;
    }

    double bpm = 120.0;
    int ppqn = 960;
    int64_t endTick = 0;
    // Stage 3e-2: the project's time signature (the frontend already sends it
    // in load.meta) — sanitized, and the playhead publishes it. A malformed
    // signature is NOT a load failure (it cannot break scheduling); the
    // default 4/4 stands and the receipt names the substitution.
    int tsNum = 4, tsDen = 4;
    bool tsProvidedBad = false;
    if (metaVar.getDynamicObject()) {
        bpm = metaVar.getDynamicObject()->getProperty("bpm");
        ppqn = metaVar.getDynamicObject()->getProperty("ppqn");
        endTick = static_cast<int64_t>(static_cast<double>(metaVar.getDynamicObject()->getProperty("endTick")));
        juce::DynamicObject* tsObj = metaVar.getDynamicObject()->getProperty("timeSignature").getDynamicObject();
        if (tsObj != nullptr) {
            const int n = static_cast<int>(static_cast<double>(tsObj->getProperty("numerator")));
            const int d = static_cast<int>(static_cast<double>(tsObj->getProperty("denominator")));
            static constexpr int kAllowedDen[] = { 1, 2, 4, 8, 16, 32, 64 };
            const bool denOk = std::find(std::begin(kAllowedDen), std::end(kAllowedDen), d) != std::end(kAllowedDen);
            if (n >= 1 && n <= 99 && denOk) { tsNum = n; tsDen = d; }
            else tsProvidedBad = true;
        }
    }
    // Stage 3c-hotfix: non-finite / non-positive tempo degenerates
    // samplesPerTick() (inf / zero) — events would load but NEVER dispatch:
    // the other silent-empty-score path. Same treatment: hard fail, name it.
    if (!std::isfinite(bpm) || bpm <= 0.0) loadFail = loadFail.empty() ? "meta.bpm is not finite/positive" : loadFail;
    if (ppqn <= 0) loadFail = loadFail.empty() ? "meta.ppqn is not positive" : loadFail;
    if (tsProvidedBad) {
        engineLog("[load] meta.timeSignature malformed — the playhead publishes 4/4 (non-fatal; scheduling unaffected)");
        std::cout << "[engine] load: timeSignature malformed, playhead publishes 4/4" << std::endl;
    }

    if (!loadFail.empty()) {
        engineLog("[load-fail] " + loadFail + " | received " + std::to_string(byteSize) +
                  " bytes | seq " + std::to_string(seq) + " | skipped " +
                  std::to_string(skipped) +
                  (firstErrorIndex >= 0 ? " | firstError " + std::to_string(firstErrorIndex) +
                    " (" + firstErrorReason + ")" : "") +
                  " — previous score state RETAINED");
        std::cout << "[engine] load FAILED: " << loadFail << " (seq " << seq << ")" << std::endl;
        ws.send(std::string("{\"type\":\"error\",\"code\":\"bad_load\",\"echo\":\"load\",\"detail\":\"") +
                escape_json(loadFail) + "\"}");
        return;
    }

    // ─── Stage 3c-regression — ROLLING-TRANSPORT LOAD GUARD (3d-4 set form) ──
    // On a rolling transport a load whose plugin SET differs from the live
    // set is REJECTED wholesale — score, routing, plugins and transport are
    // all left untouched. "Differs" = any requested (instanceId → uid+path)
    // not exactly matching a live slot, or any live slot absent from the
    // request (retire-while-playing is the empty-score class). A load whose
    // set EXACTLY matches (the live-edit reload) stays allowed and takes the
    // routing-only fast path below. Non-plugin loads stay allowed.
    bool midPlayReuse = false;
    if (pluginRequested && !channelsBad && g_engine.playing.load()) {
        const auto live = g_instances.load(std::memory_order_acquire);
        bool exact = live != nullptr;
        std::string mismatch;
        if (exact) {
            for (const auto& r : reqInstances) {
                HostedPlugin* h = live->byId(r.instanceId);
                juce::DynamicObject* po = r.pluginVar.getDynamicObject();
                const std::string reqUid = po ? po->getProperty("uid").toString().toStdString() : "";
                const std::string reqPath = po ? po->getProperty("path").toString().toStdString() : "";
                if (h == nullptr) { exact = false; mismatch = "instance \"" + r.instanceId + "\" is not hosted"; break; }
                if (h->uid != reqUid || h->path != reqPath) {
                    exact = false; mismatch = "instance \"" + r.instanceId + "\" changed binary"; break;
                }
            }
        }
        if (exact) {
            for (int i = 0; i < kMaxInstances && exact; ++i) {
                HostedPlugin* h = live->slots[i];
                if (h == nullptr) continue;
                bool requested = false;
                for (const auto& r : reqInstances) if (r.instanceId == h->instanceId) { requested = true; break; }
                if (!requested) { exact = false; mismatch = "hosted instance \"" + h->instanceId + "\" absent from load"; }
            }
        }
        if (exact) {
            midPlayReuse = true;
        } else {
            engineLog("[load] REJECTED while playing — plugin set change requires stop (" + mismatch + ")" +
                      " | seq " + std::to_string(seq) + " | received " +
                      std::to_string(byteSize) + " bytes — score, routing and transport UNTOUCHED");
            std::cout << "[engine] load rejected while playing (seq " << seq << ")" << std::endl;
            ws.send(std::string("{\"type\":\"error\",\"code\":\"load_rejected\",\"echo\":\"load\",\"detail\":\"") +
                    "transport is playing — stop before changing the plugin set (" + escape_json(mismatch) + ")" + "\"}");
            return;
        }
    }

    // ─── Stage 3c-polish (D2): publish the score as an immutable snapshot ───
    // The dispatch walk is sequential in tick order (3b contract: the
    // frontend sorts). Sort here anyway — stable — so an unsorted client
    // can never silently drop out-of-order events. The OLD snapshot is
    // retired (freed by the init worker after a grace period — never on
    // the audio thread, which may still be reading it this buffer).
    {
        ScoreSnapshot* snap = new ScoreSnapshot();
        snap->events = std::move(newEvents);
        std::stable_sort(snap->events.begin(), snap->events.end(),
                         [](const EngineEvent& a, const EngineEvent& b) { return a.tick < b.tick; });
        snap->bpm = bpm;
        snap->ppqn = ppqn;
        snap->endTick = endTick;
        snap->tsNumerator = tsNum;
        snap->tsDenominator = tsDen;
        ScoreSnapshot* old = g_score.exchange(snap, std::memory_order_acq_rel);
        if (old) {
            // Stage 3h: the proof value is captured AFTER the store — a
            // capture taken before it could go stale if this thread were
            // preempted between the two statements (see the retirement-queue
            // block for the full proof).
            const uint64_t swapSeq = g_audioBufferSeq.load(std::memory_order_relaxed);
            std::lock_guard<std::mutex> rlock(g_retireMutex);
            g_retiredScores.push_back({old, swapSeq, false});
        }
        // Stage 3c close-out — a new score is a new articulation context: the
        // per-channel knowledge resets to UNKNOWN so the first CC#32 always
        // sends (play/seek then re-seed from the new score's past).
        resetArticulations();
    }

    // Stage 3c-hotfix — LOAD RECEIPT (the black box opened): what the engine
    // actually holds after this load, with the exact byte size received.
    std::string chStr;
    for (const auto& [channel, count] : perChannel)
        chStr += " ch" + std::to_string(channel) + "=" + std::to_string(count);
    std::string trStr;
    for (const auto& [slot, count] : perTrack) {
        if (!trStr.empty()) trStr += " ";
        const std::string& id = (slot >= 1 && slot <= table.trackNames.size())
                                    ? table.trackNames[slot - 1] : ("slot" + std::to_string(slot));
        // Routing disposition per track — the receipt must answer "did this
        // track reach the plugin or the test synth" without guesswork: a
        // track absent from the channels map rides the test synth EVEN IF
        // its project midiChannel numerically matches a hosted channel.
        std::string disp = "[synth]";
        auto cit = channelOfTrack.find(id);
        if (cit != channelOfTrack.end())
            disp = "[ch" + std::to_string(cit->second) + "]";
        trStr += id + "=" + std::to_string(count) + disp;
    }
    char bpmBuf[32];
    std::snprintf(bpmBuf, sizeof(bpmBuf), "%g", bpm);
    const size_t publishedCount = [&] {
        ScoreSnapshot* s = g_score.load(std::memory_order_acquire);
        return s ? s->events.size() : size_t(0);
    }();
    engineLog("[load] received " + std::to_string(byteSize) + " bytes | loaded " +
              withCommas(static_cast<uint64_t>(publishedCount)) + " events (array had " +
              withCommas(static_cast<uint64_t>(receivedCount)) + ", skipped " +
              std::to_string(skipped) + ")" +
              (firstErrorIndex >= 0 ? " | firstError " + std::to_string(firstErrorIndex) +
                " (" + firstErrorReason + ")" : "") +
              " | perChannel" + (chStr.empty() ? " none" : chStr) +
              " | perTrack" + (trStr.empty() ? " none" : " " + trStr) +
              " | bpm=" + bpmBuf + " ppqn=" + std::to_string(ppqn) +
              " endTick=" + std::to_string(endTick) + " | seq " + std::to_string(seq) +
              (pluginRequested ? " | plugin requested" : ""));
    std::cout << "[engine] loaded " << publishedCount << " events (bpm=" << bpm
              << " ppqn=" << ppqn << " endTick=" << endTick << ")" << std::endl;

    // Stage 3c-hotfix — loadAck (ADDITIVE): the receipt the frontend's source
    // switch gates on. Fields: seq echo, entries in the events array,
    // validated count, skipped count, first offending index + reason, and the
    // exact byte size received. The legacy `state` reply below still follows.
    ws.send(std::string("{\"type\":\"loadAck\",\"seq\":") + std::to_string(seq) +
            ",\"received\":" + std::to_string(receivedCount) +
            ",\"loaded\":" + std::to_string(publishedCount) +
            ",\"skipped\":" + std::to_string(skipped) +
            ",\"firstErrorIndex\":" + std::to_string(firstErrorIndex) +
            ",\"firstErrorReason\":\"" + escape_json(firstErrorReason) + "\"" +
            ",\"byteSize\":" + std::to_string(byteSize) + "}");

    // Stage 3b polish — the load ack reports the CURRENT transport truth
    // (playing + current position), not a hardcoded {playing:false,tick:0}:
    // a reload during playback used to poison the UI playhead to 0 while the
    // engine kept playing (source-switch audit finding).
    ws.send(std::string("{\"type\":\"state\",\"playing\":") +
            (g_engine.playing.load() ? "true" : "false") +
            ",\"tick\":" + std::to_string(g_engine.currentTick()) + "}");

    // Stage 3c-2 + 3d-4 — hosting: the load's plugin SET (one instance per
    // plugin-bearing library group). On ANY parse failure the routing table
    // ships with EMPTY plugin channels → every event renders through the
    // built-in test synth (the app never dead-ends).
    if (pluginRequested && channelsBad) {
        sendPluginState(ws, "error", "", "", -1.0,
                        channelsBadDetail + " — falling back to test synth", "");
        std::cout << "[engine] plugin hosting refused: " << channelsBadDetail << std::endl;
    } else if (pluginRequested) {
        // Hosted channels flow from the load's routing/channels map in ALL
        // accepted plugin paths (reuse fast path AND async init): the routing
        // table must carry them (as WIDE channels) even before the worker
        // lands the instances (the callback's toPlugin check additionally
        // requires a live instance, so the map alone can never route into a
        // dead plugin).
        std::map<std::string, std::vector<int>> chansPerInst;   // instanceId → wire channels
        for (const auto& [trackId, wide] : channelOfTrack) {
            auto iit = instanceOfTrack.find(trackId);
            if (iit == instanceOfTrack.end()) continue;   // legacy channels without a plugin request
            table.pluginChannels.insert(wide);
            table.channelOfTrack[trackId] = wide;
            chansPerInst[iit->second].push_back(realChOfWide(wide));
        }
        std::map<std::string, std::string> chansJsonPerInst;
        for (auto& [iid, chans] : chansPerInst) {
            std::sort(chans.begin(), chans.end());
            std::string cj;
            for (const int ch : chans) { if (!cj.empty()) cj += ","; cj += std::to_string(ch); }
            chansJsonPerInst[iid] = cj;
        }

        if (midPlayReuse) {
            // ── Fast path: SAME instance set on a rolling transport. Every
            // live instance is kept untouched (no re-instantiate, no swap, no
            // release) — only events + routing swapped above. This is the
            // mid-play live-edit reload, and it costs milliseconds.
            const auto live = g_instances.load(std::memory_order_acquire);
            if (live != nullptr) {
                for (const auto& r : reqInstances) {
                    HostedPlugin* h = live->byId(r.instanceId);
                    if (h == nullptr) continue;
                    const double latMs = (h->latencySamples + 512.0) / 44100.0 * 1000.0;
                    sendPluginState(ws, "loaded", h->name, h->vendor, latMs, "",
                                    chansJsonPerInst[r.instanceId], r.instanceId, h->classId);
                    // Stage 3e-1: capabilities ride the reuse receipt too —
                    // the record is immutable on the instance, so the
                    // pre-serialized fields are re-wrapped (no plugin calls).
                    if (!h->capabilitiesFields.empty()) {
                        ws.send(std::string("{\"type\":\"plugin_capabilities\",\"instanceId\":\"") +
                                escape_json(h->instanceId) + "\"," + h->capabilitiesFields + "}");
                    }
                    engineLog("[plugin] reuse while playing — no re-instantiate | seq " +
                              std::to_string(seq) + " instance=" + r.instanceId +
                              " latencySamples=" + std::to_string(static_cast<int>(h->latencySamples)) +
                              " channels=[" + chansJsonPerInst[r.instanceId] + "]");
                }
                std::cout << "[engine] plugin set reused (mid-play, seq " << seq
                          << ", " << reqInstances.size() << " instance(s))" << std::endl;
            }
        } else {
            // ── Async init: queue the FULL desired set for the worker. Each
            // instantiate takes seconds for a real orchestra library — it must
            // NEVER run on the WS thread. loadAck/state above already went out
            // in milliseconds; plugin_state arrives per instance on completion.
            std::vector<PluginInitEntry> entries;
            entries.reserve(reqInstances.size());
            for (const auto& r : reqInstances) {
                PluginInitEntry e;
                e.instanceId = r.instanceId;
                e.slot = r.slot;
                e.pluginVar = r.pluginVar;
                e.stateB64 = r.stateB64;
                e.routing = r.routing;
                auto cit = chansJsonPerInst.find(r.instanceId);
                if (cit != chansJsonPerInst.end()) e.channelsJson = cit->second;
                entries.push_back(std::move(e));
            }
            const size_t n = entries.size();
            {
                std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                g_pluginInitRequest = PluginInitRequest{std::move(entries), seq};
                g_pluginInitPending = true;
                ++g_pluginInitGen;
            }
            // Stage 3f-7: the probe thread pauses for the WHOLE load — from
            // queue time (this line, before the worker can even see it) to
            // the init worker's iteration end.
            g_pluginLoadActive.store(true, std::memory_order_release);
            g_pluginInitCv.notify_one();
            engineLog("[plugin] init started (async) instances=" + std::to_string(n) +
                      " | seq " + std::to_string(seq) +
                      " — loadAck not delayed, plugin_state follows per instance on completion");
            std::cout << "[engine] plugin init queued (async, " << n << " instance(s), seq " << seq << ")" << std::endl;
        }
    }

    // Swap the routing table (pluginChannels empty unless hosted) and rebuild
    // the mix snapshot for the new slots.
    {
        // slot → channel for precise routing (0 = not plugin-routed).
        table.slotChannel.assign(table.trackNames.size() + 1, 0);
        for (size_t i = 0; i < table.trackNames.size(); ++i) {
            auto it = table.channelOfTrack.find(table.trackNames[i]);
            if (it != table.channelOfTrack.end()) table.slotChannel[i + 1] = it->second;
        }
        g_routing.store(std::make_shared<const RoutingTable>(std::move(table)), std::memory_order_release);
        std::lock_guard<std::mutex> mlock(g_lastMixMutex);
        g_mix.store(buildMixState(*g_routing.load(std::memory_order_acquire), g_lastMix), std::memory_order_release);
    }
}

// {"type":"mix","mutedTracks":[...],"soloTracks":[...]} — per-TRACK mute/solo
// (gated at dispatch, BEFORE any channel send). Unknown trackIds ignored.
// Tracks that LOSE audibility get their hosted channels CC120-flushed so the
// change is immediately audible (already-sounding notes die).
void handle_mix(const juce::var& json) {
    juce::DynamicObject* obj = json.getDynamicObject();
    if (!obj) return;
    LastMix next;
    for (const char* field : {"mutedTracks", "muted", "solos", "soloTracks"}) {
        const auto& arr = obj->getProperty(field);
        if (!arr.isArray()) continue;
        const bool isMute = std::string(field) == "mutedTracks" || std::string(field) == "muted";
        for (auto& v : *arr.getArray()) {
            std::string id = v.toString().toStdString();
            if (id.empty()) continue;
            auto& list = isMute ? next.muted : next.solo;
            if (std::find(list.begin(), list.end(), id) == list.end()) list.push_back(id);
        }
    }
    std::lock_guard<std::mutex> lock(g_lastMixMutex);
    const auto table = g_routing.load(std::memory_order_acquire);
    if (table) {
        const auto oldMix = buildMixState(*table, g_lastMix);
        const auto newMix = buildMixState(*table, next);
        // audibility(slot) under a mix snapshot
        auto audible = [&oldMix, &newMix](size_t slot, bool useOld) {
            const MixState& m = useOld ? *oldMix : *newMix;
            return m.anySolo
                ? (slot < m.solo.size() && m.solo[slot] != 0)
                : !(slot < m.muted.size() && m.muted[slot] != 0);
        };
        for (uint32_t slot = 1; slot <= table->trackNames.size(); ++slot) {
            if (audible(slot, true) && !audible(slot, false)) {
                auto it = table->channelOfTrack.find(table->trackNames[slot - 1]);
                if (it != table->channelOfTrack.end() && table->pluginChannels.count(it->second))
                    g_muteFlushPending[it->second - 1].store(true, std::memory_order_relaxed);
            }
        }
        g_mix.store(std::move(newMix), std::memory_order_release);
    }
    g_lastMix = std::move(next);
}

// {"type":"dispatch_log","enable":bool} — CI observability: stream what was
// actually dispatched (post-gating), sample-accurate.
void handle_dispatch_log(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    const bool enable = obj != nullptr && static_cast<bool>(static_cast<double>(obj->getProperty("enable")));
    g_dispatchLog.store(enable, std::memory_order_relaxed);
    if (enable) g_ledgerRead.store(g_ledgerWrite.load(std::memory_order_acquire), std::memory_order_relaxed);
    ws.send(std::string("{\"type\":\"dispatch_log\",\"enabled\":") + (enable ? "true" : "false") + "}");
    std::cout << "[engine] dispatch_log " << (enable ? "on" : "off") << std::endl;
}

// ─── Stage 3c close-out — musical transport transitions (helpers) ───────────
// Reset the per-channel articulation knowledge to UNKNOWN (0xFF): used at
// load (new score context — the first CC#32 always sends) before play/seek
// re-seed it from the score's past.
void resetArticulations() {
    for (int i = 0; i < kWideChannels; ++i)
        g_articulation[i].store(kArticulationUnknown, std::memory_order_relaxed);
}

// Seed the per-channel articulation knowledge from the score's PAST: the
// plugin retains its UACC state across stops, so on a resume at startTick the
// engine must know which articulation each channel is ALREADY in (the last
// CC#32 before startTick) — otherwise the first same-value CC#32 of the
// resumed transport re-articulates (the bow-scrape pluck). Tick-sorted scan;
// synthetic re-attack notes carry no CCs.
void seedArticulationsFromPast(int64_t startTick) {
    resetArticulations();
    if (ScoreSnapshot* s = g_score.load(std::memory_order_acquire)) {
        for (const auto& ev : s->events) {
            if (ev.tick >= startTick) break;
            if (ev.kind == kEvCC && ev.data1 == 32)
                g_articulation[ev.channel - 1].store(ev.data2, std::memory_order_relaxed);
        }
    }
}

// Notes STRADDLING the start tick (note-on before it, note-off strictly after
// it): their note-ons are in the skipped past, so a resumed transport would
// silently MISS every sustained note. The close-out answer is a GENTLE
// RE-ATTACK: each straddling note re-attacks AT the start tick with velocity
// min(original, kReattackVelCap). Pairing is per (channel, pitch); a straddle
// is only re-attacked when the score also carries a FUTURE note-off for that
// (channel, pitch) — min(onCount, offCount) — so a re-attack always has a
// release waiting. Pure function of the snapshot + startTick (no RNG).
std::vector<EngineEvent> resumeReattacksFor(const ScoreSnapshot& s, int64_t startTick) {
    struct PairState { int on = 0; int off = 0; int vel = 0; uint32_t ref = 0; };
    std::vector<PairState> st(kWideChannels * 128);
    auto idx = [](int ch, int p) { return (ch - 1) * 128 + p; };
    for (const auto& ev : s.events) {
        if (ev.flags & kEvFlagResumeReattack) continue;   // synthetic — never pairs
        if (ev.tick < startTick) {
            if (ev.kind == kEvNoteOn) {
                auto& p = st[idx(ev.channel, ev.data1)];
                ++p.on; p.vel = ev.data2; p.ref = ev.trackRef;
            } else if (ev.kind == kEvNoteOff) {
                if (st[idx(ev.channel, ev.data1)].on > 0) --st[idx(ev.channel, ev.data1)].on;
            }
        } else if (ev.kind == kEvNoteOff && ev.tick > startTick) {
            ++st[idx(ev.channel, ev.data1)].off;
        }
    }
    std::vector<EngineEvent> tails;
    for (int ch = 1; ch <= kWideChannels; ++ch)
        for (int p = 0; p < 128; ++p) {
            const PairState& ps = st[idx(ch, p)];
            const int n = std::min(ps.on, ps.off);
            for (int i = 0; i < n; ++i)
                tails.push_back(EngineEvent{kEvNoteOn, static_cast<uint8_t>(ch),
                    static_cast<uint8_t>(p),
                    static_cast<uint8_t>(std::min<int>(ps.vel, kReattackVelCap)),
                    startTick, ps.ref, kEvFlagResumeReattack});
        }
    return tails;
}

// Publish the score for a NEW transport position: clone the current snapshot
// with the straddling-note re-attacks (tick = startTick) inserted in tick
// order. Old synthetic tails are stripped (a fresh scan must pair against the
// authored score only). No straddles ⇒ the current snapshot is kept as-is
// (zero-copy fast path). Returns the re-attack count. The OLD snapshot is
// retired to the worker queue (never freed on the audio thread).
size_t publishScoreWithReattacks(int64_t startTick) {
    ScoreSnapshot* cur = g_score.load(std::memory_order_acquire);
    if (!cur) return 0;
    std::vector<EngineEvent> tails = resumeReattacksFor(*cur, startTick);
    if (tails.empty()) return 0;
    ScoreSnapshot* snap = new ScoreSnapshot();
    snap->events.reserve(cur->events.size() + tails.size());
    // Authored events (old synthetic tails dropped), then the tails inserted
    // before the first strictly-later tick (same-sample order is irrelevant —
    // everything at startTick dispatches at sample 0 of the first buffer).
    bool tailsInserted = false;
    for (const auto& ev : cur->events) {
        if (ev.flags & kEvFlagResumeReattack) continue;
        if (!tailsInserted && ev.tick > startTick) {
            snap->events.insert(snap->events.end(), tails.begin(), tails.end());
            tailsInserted = true;
        }
        snap->events.push_back(ev);
    }
    if (!tailsInserted) snap->events.insert(snap->events.end(), tails.begin(), tails.end());
    snap->bpm = cur->bpm;
    snap->ppqn = cur->ppqn;
    snap->endTick = cur->endTick;
    snap->tsNumerator = cur->tsNumerator;
    snap->tsDenominator = cur->tsDenominator;
    ScoreSnapshot* old = g_score.exchange(snap, std::memory_order_acq_rel);
    if (old) {
        // Stage 3h: proof value captured AFTER the store (retirement-queue block).
        const uint64_t swapSeq = g_audioBufferSeq.load(std::memory_order_relaxed);
        std::lock_guard<std::mutex> rlock(g_retireMutex);
        g_retiredScores.push_back({old, swapSeq, false});
    }
    return tails.size();
}

void handle_transport(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    if (!obj) return;
    juce::String cmd = obj->getProperty("command").toString();

    if (cmd == "play") {
        // LAZY audio init — the first transport play brings the device up
        // (Stage 3b-fix policy). Failure → clean no_audio_device error reply,
        // engine stays protocol-functional; success → normal rendering.
        std::string audioErr = ensureAudioReady();
        if (!audioErr.empty()) {
            ws.send(std::string("{\"type\":\"error\",\"code\":\"no_audio_device\",\"detail\":\"")
                    + escape_json(audioErr) + "\"}");
            std::cout << "[engine] play rejected — no audio device: " << audioErr << std::endl;
            return;
        }
        // Stage 3b polish — OPTIONAL start tick (v1-extension, backward
        // compatible): explicit tick → start there; absent → RESUME from
        // lastTick (the remembered stopped position). The engine NEVER
        // auto-resets to 0 on play without an explicit tick.
        const auto& tickVar = obj->getProperty("tick");
        const bool hasTick = !tickVar.isVoid();
        int64_t startTick = hasTick
            ? static_cast<int64_t>(static_cast<double>(tickVar))
            : g_engine.lastTick.load();
        if (startTick < 0) startTick = 0;
        // Stage 3c close-out — RESUME CONTEXT: (a) the per-channel articulation
        // knowledge is seeded from the score's past (the plugin retained its
        // UACC state across the stop — redundant CC#32s on resume must be
        // suppressed, not re-sent); (b) straddling notes (on before startTick,
        // off after) are published back as GENTLE re-attacks at startTick —
        // without them every sustained note would be MISSING on resume (their
        // note-ons are in the skipped past). Both scan the immutable snapshot
        // on this (WS) thread — the audio thread only sees the new snapshot.
        seedArticulationsFromPast(startTick);
        const size_t reattacks = publishScoreWithReattacks(startTick);
        // Panic-before-play: a fresh play must never overlap a previous
        // transport's ringing voices (the doubled-audio finding). The kill is
        // SELF-SERVICED by the next audio buffer (Stage 3c-polish D2: no
        // cross-thread voice access anymore). NOTE (3c close-out): this is
        // the ONE remaining transport amputation besides panic — a new
        // transport beginning while the previous one's tails still ring would
        // double the audio; instant kill of STALE tails at play time is the
        // standard DAW contract and stays.
        g_voiceKillPending.store(true, std::memory_order_relaxed);
        g_pendingPanic.store(true);  // hosted plugin gets the CC120 flush too
        // Phase 2 — DOWNBEAT-LATE PRE-ROLL: a start-tick event's F4 shift
        // (dispatch minus slotLatency) used to clamp at sample 0, so the
        // downbeat's audible attack landed `latency` samples late (the
        // plugin needs that many input samples before its first output
        // emerges). The transport timeline now BEGINS at -preRoll: the
        // window primes the latency lines with silence and pre-fires the
        // start-tick events muted, so dispatch + latency = 0 = the grid
        // position of startTick. playing goes true immediately; the POSITION
        // stays pinned at startTick until sample 0 (currentTick / lastTick /
        // playhead / ledger-t clamp the negative window).
        const int64_t preRoll = static_cast<int64_t>(
            g_pluginLatencySamples.load(std::memory_order_acquire));
        g_engine.samplesProcessed.store(-preRoll);
        g_engine.preRollSamples.store(preRoll, std::memory_order_release);
        g_engine.playStartTick.store(startTick);
        g_engine.transportGen.fetch_add(1);  // invalidate pre-play buffer commits
        g_playPeakMax.store(0.0f, std::memory_order_relaxed);  // fresh session peak
        g_engine.playing.store(true);
        if (preRoll > 0)
            engineLog("[transport] pre-roll " + std::to_string(preRoll) +
                      " samples (max plugin latency) — start-tick events pre-fire muted, audible downbeat lands on the grid");
        std::cout << "[engine] transport play from tick " << startTick
                  << (hasTick ? " (explicit" : " (resume")
                  << (reattacks > 0 ? ", " + std::to_string(reattacks) + " re-attacks)" : ")")
                  << std::endl;
        // Stage 3c-hotfix — PLAY RECEIPT: "rendering from tick X, N voices
        // scheduled". N counts NOTE_ON events from the start tick — the
        // engine's honest answer to "will this play make sound?". A play
        // against an empty/unloaded score now reads 0 scheduled in the log.
        {
            uint64_t scheduled = 0;
            size_t total = 0;
            if (ScoreSnapshot* s = g_score.load(std::memory_order_acquire)) {
                total = s->events.size();
                for (const auto& ev : s->events)
                    if (ev.kind == kEvNoteOn && ev.tick >= startTick) ++scheduled;
            }
            engineLog("[play] rendering from tick " + std::to_string(startTick) + ", " +
                      withCommas(scheduled) + " voices scheduled (of " +
                      withCommas(static_cast<uint64_t>(total)) + " events)" +
                      (hasTick ? " (explicit tick)" : " (resume)") +
                      " | resume re-attacks: " + std::to_string(reattacks));
        }
    } else if (cmd == "stop") {
        // Stage 3c close-out — STOP IS MUSICAL RELEASE, not amputation: the
        // transport halts at the stopped position (lastTick keeps it for the
        // next play-without-tick), synth voices fade over ~15ms and the hosted
        // plugin receives REAL note-offs for every held note — the library's
        // own release tail rings out. Instant kill (env=0 + CC120 All Sound
        // Off) is reserved for panic and the play-time pre-panic guard.
        g_engine.playing.store(false);
        // Invalidate any in-flight buffer: without this, a buffer that started
        // before the stop would still COMMIT samplesProcessed/lastTick after
        // the stop — the stopped position (and every release receipt) would
        // drift by up to one buffer past the stop point. Freezing at the last
        // committed boundary keeps the state tick, the release-marker tick and
        // the resume start tick EXACTLY equal.
        g_engine.transportGen.fetch_add(1);
        g_releasePending.store(true, std::memory_order_relaxed);
        const int releasing = g_activeVoices.load(std::memory_order_relaxed);
        const int held = g_heldPluginNoteCount.load(std::memory_order_relaxed);
        const float sessionPeak = g_playPeakMax.load(std::memory_order_relaxed);
        char peakBuf[16];
        std::snprintf(peakBuf, sizeof(peakBuf), "%.3f", static_cast<double>(sessionPeak));
        std::cout << "[engine] transport stop: musical release (voices releasing n=" << releasing
                  << ", plugin note-offs m=" << held
                  << ", tick=" << g_engine.lastTick.load() << ")" << std::endl;
        engineLog("[stop] transport stop — musical release: voices releasing n=" +
                  std::to_string(releasing) + ", plugin note-offs m=" + std::to_string(held) +
                  ", lastTick " + std::to_string(g_engine.lastTick.load()) +
                  " | session peak " + peakBuf);
    } else if (cmd == "seek") {
        int64_t tick = static_cast<int64_t>(static_cast<double>(obj->getProperty("tick")));
        if (tick < 0) tick = 0;
        // Stage 3c close-out — a seek is a resume transition too: while the
        // transport ROLLS across the jump, held notes are released MUSically
        // (real note-offs — the tail rings into the new position, like a live
        // player moving on) and notes straddling the NEW position re-attack
        // gently. While STOPPED there is nothing sounding: skip the snapshot
        // republish (the next play re-scans straddles for its own start tick;
        // dormant synthetic tails would be dead weight).
        const bool wasPlaying = g_engine.playing.load();
        // Phase 2: a ROLLING seek is a transport re-start — the seek
        // target's downbeat gets the same muted pre-roll (its re-attacks
        // pre-fire into the window and land on the grid). A stopped seek
        // defers to the next play, which pre-rolls for its own start tick.
        const int64_t preRoll = wasPlaying ? static_cast<int64_t>(
            g_pluginLatencySamples.load(std::memory_order_acquire)) : 0;
        g_engine.samplesProcessed.store(-preRoll);
        g_engine.preRollSamples.store(preRoll, std::memory_order_release);
        g_engine.playStartTick.store(tick);
        g_engine.lastTick.store(tick);
        g_engine.transportGen.fetch_add(1);  // pre-seek buffers must not commit
        if (wasPlaying) {
            seedArticulationsFromPast(tick);
            publishScoreWithReattacks(tick);
            g_releasePending.store(true, std::memory_order_relaxed);  // musical, not amputation
        }
        std::cout << "[engine] transport seek to tick " << tick
                  << (wasPlaying ? " (rolling — musical release + re-attacks)" : " (stopped)") << std::endl;
        engineLog("[seek] to tick " + std::to_string(tick) +
                  (wasPlaying ? " (rolling — musical release + resume re-attacks)" : " (stopped)") +
                  (wasPlaying && preRoll > 0
                       ? " | pre-roll " + std::to_string(preRoll) + " samples (downbeat pre-fire)"
                       : ""));
    }
}

void handle_panic() {
    g_engine.playing.store(false);
    // Stage 3c-polish (D2): the kill is self-serviced by the next audio
    // buffer; n = honest active count at request time.
    const int killed = g_activeVoices.load(std::memory_order_relaxed);
    g_voiceKillPending.store(true, std::memory_order_relaxed);
    g_engine.transportGen.fetch_add(1);
    g_pendingPanic.store(true);
    std::cout << "[engine] panic — all notes off (n=" << killed << ")" << std::endl;
}

// ─── Stage 3d-1: editor window protocol handlers ───────────────────────────
// {"type":"openEditor","instanceId"?} — validate on the WS thread, create on
// the message thread (window work is illegal anywhere else). No live
// instance is the editor_unavailable negative path (CI asserts it).

// {"type":"setHostWindow","hwnd":<number>} — Stage 3f-3a. The shell frontend
// sends its main window's HWND on connect (Tauri command main_window_hwnd());
// the engine stores it and every SUBSEQUENTLY opened PluginEditorWindow on
// Windows becomes OWNED by that window (applyHostWindowOwner above). The
// reply echoes the accepted hwnd so thin clients (and the CI runner) can
// assert the parse+store round-trip; the owner application itself is proven
// by the engine.log receipt (desktop.yml grep). A malformed message is a
// NAMED error, never a crash — and no other behaviour depends on this
// message arriving (missing/invalid = today's floating-window behaviour).
void handle_set_host_window(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    const double h = obj ? static_cast<double>(obj->getProperty("hwnd")) : 0.0;
    // Windows HWNDs are pointer-sized; a frontend number must be a positive
    // integer within double's exact-integer range (the shell resolves the
    // real handle; 0/"undefined"/fractions are all malformed).
    if (!(h >= 1.0) || h > 9.007199254740992e15 || h != std::floor(h)) {
        ws.send(std::string("{\"type\":\"error\",\"code\":\"bad_request\",\"echo\":\"setHostWindow\","
                            "\"detail\":\"hwnd must be a positive integer number\"}"));
        engineLog("[editor] host window REJECTED (hwnd missing or not a positive integer)");
        return;
    }
    g_hostHwnd.store(static_cast<uintptr_t>(h), std::memory_order_release);
    char hex[32];
    std::snprintf(hex, sizeof(hex), "0x%llx", static_cast<unsigned long long>(h));
    engineLog(std::string("[editor] host window set hwnd=") + hex);
    ws.send(std::string("{\"type\":\"hostWindowSet\",\"hwnd\":") + std::to_string(static_cast<long long>(h)) + "}");
}

void handle_open_editor(const juce::var& json, ix::WebSocket& ws) {
    // Stage 3d-4: instanceId now ADDRESSES a specific hosted instance (the
    // frontend sends the track's libraryGroup id); an empty/"hosted" id
    // resolves to the legacy first instance so old callers keep working.
    const auto set = g_instances.load(std::memory_order_acquire);
    HostedPlugin* live = nullptr;
    juce::DynamicObject* obj = json.getDynamicObject();
    std::string iid = obj ? obj->getProperty("instanceId").toString().toStdString() : "";
    if (set != nullptr) {
        if (!iid.empty()) live = set->byId(iid);
        if (live == nullptr) live = set->first();   // legacy/unknown id → first live instance
    }
    if (live == nullptr || !live->instance) {
        ws.send(std::string("{\"type\":\"error\",\"code\":\"editor_unavailable\",\"echo\":\"openEditor\",\"detail\":\"no hosted plugin instance\"}"));
        engineLog("[editor] open refused — no live instance" +
                  (iid.empty() ? std::string() : " (requested id \"" + iid + "\")"));
        return;
    }
    if (iid.empty()) iid = live->instanceId;   // resolve to the REAL registry id
    bool alreadyOpen = false;
    {
        std::lock_guard<std::mutex> lock(g_editorMutex);
        alreadyOpen = g_editors.count(iid) != 0;
    }
    if (alreadyOpen) {
        // One editor per instance: a repeat request RAISES the existing
        // window and re-echoes editorOpened (focused) — never a second one.
        juce::MessageManager::callAsync([iid] {
            PluginEditorWindow* win = nullptr;
            {
                std::lock_guard<std::mutex> lock(g_editorMutex);
                auto it = g_editors.find(iid);
                if (it != g_editors.end()) win = it->second;
            }
            if (win != nullptr) win->toFront(true);
        });
        ws.send(std::string("{\"type\":\"editorOpened\",\"instanceId\":\"") + escape_json(iid) +
                "\",\"name\":\"" + escape_json(live->name) + "\",\"focused\":true}");
        engineLog("[editor] focus existing instance=" + iid);
        return;
    }
    // Stage 3d-4 hotfix: the lambda NO LONGER captures the raw `live`
    // pointer. HostedPlugin objects live inside raw-pointer-slotted
    // InstanceSets and are freed by the worker's retire path once the audio
    // proof passes (Stage 3h: two buffer-start ticks past the swap — the
    // audio thread runs buffers sequentially, so the old set is provably
    // unreferenced by then; with no audio running the free is deferred
    // indefinitely) — a set replacement in the request→run window could
    // dangle the capture (the silent-death family the user hit). The job
    // instead re-resolves by id from the CURRENT set at message-thread run
    // time — this codebase's standard resolve-from-current-load pattern — and
    // the abandon receipt in openEditorWindow names any retirement.
    {
        std::lock_guard<std::mutex> pl(g_pendingEditorMutex);
        g_pendingEditorOpen = PendingEditorOpen{ iid, std::chrono::steady_clock::now(), {} };
        g_pendingEditorActive = true;
        g_pendingEditorNamed = false;
    }
    juce::MessageManager::callAsync([iid] {
        std::shared_ptr<const InstanceSet> cur = g_instances.load(std::memory_order_acquire);
        HostedPlugin* h = cur ? cur->byId(iid) : nullptr;
        openEditorWindow(iid, h);
    });
    engineLog("[editor] open requested instance=" + iid + " plugin=" + live->name);
}

// {"type":"closeEditor","instanceId"?} — idempotent (unknown id = no-op).
void handle_close_editor(const juce::var& json) {
    juce::DynamicObject* obj = json.getDynamicObject();
    std::string iid = obj ? obj->getProperty("instanceId").toString().toStdString() : "";
    if (iid.empty()) iid = "hosted";
    // Stage 3f-7 (4c): the protocol close is a close REQUEST like the window
    // button — the same receipt, the moment the request arrives, before any
    // work (the button path logs the identical line without the suffix).
    engineLog("[editor] closing requested instance=" + iid + " (closeEditor message)");
    closeEditorAsync(iid);
}

// {"type":"captureState"} — Stage 3d-3: capture the live instance's state
// NOW (the frontend sends this on app close; best-effort). The capture runs
// on the message thread via callAsync and reads the LIVE SET at execution
// time (a set swap may land between request and execution). Stage 3d-4:
// captures EVERY live instance — one pluginSavedState per instance, each
// carrying its instanceId so the app embeds it in the right LibraryGroup.
void handle_capture_state() {
    juce::MessageManager::callAsync([] {
        if (auto set = g_instances.load(std::memory_order_acquire)) {
            for (int slot = 0; slot < kMaxInstances; ++slot) {
                HostedPlugin* h = set->slots[slot];
                if (h != nullptr && h->instance)
                    captureAndBroadcastState(*h, "request");
            }
        }
    });
}

// ─── Main ───────────────────────────────────────────────────────────────────
} // namespace

int main(int argc, char** argv) {
    // --scan-worker mode (Stage 3c-1, 3f-2: DESCRIBE only): scan ONE .vst3
    // path, print JSON rows between markers, exit. Spawned by handle_scan()
    // for crash isolation — never used by the app itself.
    // --probe-worker mode (Stage 3f-2): instantiate ONE class (path + classId)
    // and print its capability record between markers, exit. A crash or a
    // hang here costs that row's probe only — the row itself is already safe
    // in the frontend list.
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--scan-worker" && i + 1 < argc) {
            return runScanWorker(argv[i + 1]);
        }
        if (std::string(argv[i]) == "--probe-worker" && i + 2 < argc) {
            return runProbeWorker(argv[i + 1], argv[i + 2]);
        }
    }

    int port = kDefaultPort;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--version") {
            // "audio: built-in" is the compile-gate-absence proof: a gated
            // (mute) build would not report audio support here.
            std::cout << "scorch-engine " << kEngineVersion
                      << " (protocol " << kProtocolVersion
                      << ", audio: built-in)" << std::endl;
            return 0;
        }
        if (arg == "--null-audio") {
            g_nullAudio = true;
        }
        if (arg == "--no-audio") {
            g_forcedNoAudio = true;
        }
        // Stage 3c-polish F2 — conservative buffer size override (default 512).
        if (arg == "--buffer-size" && i + 1 < argc) {
            g_wantedBufferSize = std::atoi(argv[++i]);
            if (g_wantedBufferSize < 64) g_wantedBufferSize = 64;
            if (g_wantedBufferSize > 4096) g_wantedBufferSize = 4096;
        }
        // Stage 3c-polish F3 — hosted output gain override (default 2.0).
        if (arg == "--plugin-gain" && i + 1 < argc) {
            const float g = static_cast<float>(std::atof(argv[++i]));
            g_hostedOutputGain.store(std::clamp(g, 0.25f, 8.0f), std::memory_order_relaxed);
        }
        if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
            if (port <= 0 || port > 65535) {
                std::cerr << "[engine] invalid port: " << argv[i] << std::endl;
                return 1;
            }
        }
    }

    // Stage 3h TEST-ONLY: the null-audio regression probe arms its controlled
    // audio-thread stall through this env-named marker file (desktop.yml sets
    // it for the D2 engine process). Read ONCE here, before any thread exists,
    // so the audio thread's per-buffer check is a plain string compare.
    if (const char* stallFile = std::getenv("SCORCH_TEST_AUDIO_STALL_FILE"))
        g_testAudioStallFile = stallFile;

    ix::initNetSystem();

    // Stage 3c-regression — JUCE MessageManager pump thread.
    // The VST3 wrapper touches the MessageManager (lazy singleton) during
    // instantiate/prepare. With async init, the FIRST touch used to happen on
    // the init worker — making the WORKER the message thread — and the worker
    // never pumps messages, so any other thread that then needed the
    // MessageManagerLock (audioDeviceAboutToStart's prepareToPlay inside the
    // first transport play) blocked FOREVER. The old synchronous code worked
    // only because load and AboutToStart ran on the same thread.
    // The pump owns the MessageManager for the process lifetime: the worker,
    // the WS threads and the audio path all just post to it.
    std::thread mm_pump_thread([]() {
        juce::MessageManager::getInstance();   // created ON this thread
        // Stage 3i: the latency watchdog timer lives on the message thread —
        // started HERE so the Timer is created on the same thread that pumps
        // it (JUCE requirement), for the process lifetime. Every 2000 ms it
        // drains the plugin-notification flags (immediate path, no debounce)
        // and walks every live instance as the safety net for plugins that
        // change WITHOUT notifying (2-identical-reads debounce there).
        g_latencyWatch = new LatencyWatchTimer();
        g_latencyWatch->startTimer(2000);
        // Blocks until main() calls stopDispatchLoop() at shutdown. The loop
        // is event-driven (no polling, no keep-alive): it wakes for every
        // posted JUCE message and sleeps otherwise.
        juce::MessageManager::getInstance()->runDispatchLoop();
    });

    // ─── Stage 3f-7 (4a) — message-thread heartbeat ────────────────────────
    // DIAGNOSTIC ONLY. A watcher thread posts a callAsync every 1 s that
    // stamps the current time into an atomic; if the stamp is older than 3 s,
    // NO callAsync has executed for that long — the message thread is not
    // running posted work (a plugin wedged inside getStateInformation or an
    // editor destructor is the classic shape, but the heartbeat does NOT
    // claim a cause — it measures responsiveness and nothing else). One
    // "[mm] message thread unresponsive for <n> s" line when the staleness
    // first crosses 3 s, one "[mm] message thread recovered after <n> s"
    // line when fresh stamps flow again; the same transitions broadcast an
    // additive engineDiagnostic message so the frontend can name the
    // condition in a late-loadAck toast (item 5) without reading engine.log.
    std::atomic<long long> g_mmHeartbeatMs{0};
    std::thread mm_heartbeat_thread([&g_mmHeartbeatMs]() {
        auto nowMs = []() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
        };
        g_mmHeartbeatMs.store(nowMs(), std::memory_order_release);
        bool unresponsiveNamed = false;
        long long stallStartMs = 0;
        while (!g_should_exit.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            if (g_should_exit.load()) break;
            juce::MessageManager::callAsync([&g_mmHeartbeatMs, nowMs] {
                g_mmHeartbeatMs.store(nowMs(), std::memory_order_release);
            });
            const long long now = nowMs();
            const long long last = g_mmHeartbeatMs.load(std::memory_order_acquire);
            const long long staleMs = now - last;
            const bool fresh = staleMs < 3000;
            if (!fresh && !unresponsiveNamed) {
                unresponsiveNamed = true;
                stallStartMs = last;
                const long long s = (now - stallStartMs) / 1000;
                engineLog("[mm] message thread unresponsive for " + std::to_string(s) + " s");
                broadcastJson(std::string("{\"type\":\"engineDiagnostic\",\"mm\":\"unresponsive\",\"seconds\":") +
                              std::to_string(s) + "}");
            } else if (fresh && unresponsiveNamed) {
                unresponsiveNamed = false;
                const long long s = (now - stallStartMs) / 1000;
                engineLog("[mm] message thread recovered after " + std::to_string(s) + " s");
                broadcastJson(std::string("{\"type\":\"engineDiagnostic\",\"mm\":\"recovered\",\"seconds\":") +
                              std::to_string(s) + "}");
            }
        }
    });

    // Stage 3b-fix: NO audio initialization at startup. Audio is brought up
    // lazily on the first transport play (or simulated via --null-audio), so
    // a headless machine boots cleanly and the protocol test does not depend
    // on audio hardware.
    std::cout << "[engine] audio policy: lazy init on first transport play";
    if (g_nullAudio) std::cout << " (--null-audio)";
    else if (g_forcedNoAudio) std::cout << " (--no-audio: forced device-less)";
    std::cout << std::endl;
    engineLog(std::string("[engine] start v") + kEngineVersion + " port " +
              std::to_string(port) + (g_nullAudio ? " --null-audio" : "") +
              (g_forcedNoAudio ? " --no-audio" : ""));

    ix::WebSocketServer server(port, "127.0.0.1");
    // Stage 3d-1: message-thread-initiated editor events broadcast through
    // the server; it outlives every thread that can schedule an editor op.
    g_wsServer = &server;

    server.setOnClientMessageCallback(
        [](std::shared_ptr<ix::ConnectionState> /*state*/,
           ix::WebSocket& ws,
           const ix::WebSocketMessagePtr& msg) {
            if (msg->type == ix::WebSocketMessageType::Open) {
                // Size-limit audit (Stage 3c-hotfix): verified against the
                // fetched IXWebSocket v11.4.5 source — there is NO incoming
                // message size cap in the engine's WS stack (no
                // maxMessageSize API, no 1009 logic). A large load is
                // delivered whole or fails juce::JSON::parse with a receipt —
                // it cannot vanish at a size threshold.
                engineLog("[ws] client connected (no message-size cap in IXWebSocket v11.4.5 — verified in source)");
                std::cout << "[engine] client connected" << std::endl;
                std::string hello = "{\"type\":\"hello\",\"engineVersion\":\"" +
                                    std::string(kEngineVersion) +
                                    "\",\"protocol\":" + std::to_string(kProtocolVersion) + "}";
                ws.send(hello);
            } else if (msg->type == ix::WebSocketMessageType::Error) {
                // Socket-level failures (handshake, TCP, send errors) land
                // here — receipt-logged so the transport can never fail
                // silently.
                engineLog("[ws-error] " + msg->errorInfo.reason +
                          " (http " + std::to_string(msg->errorInfo.http_status) +
                          ", retries " + std::to_string(msg->errorInfo.retries) + ")");
            } else if (msg->type == ix::WebSocketMessageType::Message) {
                std::string message = msg->str;
                // Stage 3f-7 (4d): ONE arrival line per incoming message,
                // BEFORE any parsing. The type is sniffed cheaply from the
                // first 64 bytes (or "unknown"); the CONTENTS are never
                // logged (the pre-existing parse-failure receipt already
                // bounds its prefix at 80 chars for the error path only).
                engineLog("[ws] message type=" + wsPeekType(message) +
                          " bytes=" + std::to_string(message.size()));
                auto parsed = juce::JSON::parse(juce::String(message));
                juce::DynamicObject* obj = parsed.getDynamicObject();
                if (!obj) {
                    // Stage 3c-hotfix: a top-level parse failure is a load
                    // receipt too (juce::JSON exposes no error position, so
                    // the receipt carries byte size + a sanitized prefix).
                    engineLog("[ws] JSON parse FAILED | received " +
                              std::to_string(message.size()) + " bytes | prefix \"" +
                              escape_json(message.substr(0, 80)) + "\"");
                    ws.send("{\"type\":\"error\",\"code\":\"bad_json\",\"echo\":\"" + escape_json(message) + "\"}");
                    return;
                }
                juce::String type = obj->getProperty("type").toString();

                if (type == "ping") {
                    int64_t t = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now().time_since_epoch()).count();
                    ws.send("{\"type\":\"pong\",\"t\":" + std::to_string(t) + "}");
                } else if (type == "shutdown") {
                    std::cout << "[engine] shutdown received" << std::endl;
                    g_should_exit.store(true);
                    ws.close();
                } else if (type == "load") {
                    handle_load(parsed, ws, message.size());
                } else if (type == "transport") {
                    handle_transport(parsed, ws);
                } else if (type == "panic") {
                    handle_panic();
                } else if (type == "scan") {
                    handle_scan(parsed, ws);
                } else if (type == "probe") {
                    handle_probe(parsed, ws);   // 3f-7: lazy probing — one visible row
                } else if (type == "probeAll") {
                    handle_probe_all(parsed, ws);   // 3f-7: the scan dialog's "Probe all"
                } else if (type == "engineDiagnostic") {
                    // Reserved SERVER → CLIENT name (the 3f-7 stall
                    // diagnostics). A client sending it is ignored silently.
                } else if (type == "mix") {
                    handle_mix(parsed);
                } else if (type == "dispatch_log") {
                    handle_dispatch_log(parsed, ws);
                } else if (type == "setHostWindow") {
                    handle_set_host_window(parsed, ws);
                } else if (type == "openEditor") {
                    handle_open_editor(parsed, ws);
                } else if (type == "closeEditor") {
                    handle_close_editor(parsed);
                } else if (type == "captureState") {
                    handle_capture_state();
                } else {
                    ws.send("{\"type\":\"error\",\"code\":\"unknown\",\"echo\":\"" + escape_json(message) + "\"}");
                }
            } else if (msg->type == ix::WebSocketMessageType::Close) {
                // Panic on disconnect — no stuck notes (self-serviced kill,
                // Stage 3c-polish D2: no cross-thread voice access).
                g_engine.playing.store(false);
                g_voiceKillPending.store(true, std::memory_order_relaxed);
                g_pendingPanic.store(true);
                std::cout << "[engine] client disconnected (panic)" << std::endl;
                engineLog("[ws] client disconnected (panic)");
            }
        });

    // State broadcast thread (~30Hz)
    std::thread state_thread([&server]() {
        while (!g_should_exit.load()) {
            {
                int64_t tick = g_engine.currentTick();
                char peakBuf[24];
                std::snprintf(peakBuf, sizeof(peakBuf), "%.4f",
                              static_cast<double>(g_lastPeak.load(std::memory_order_relaxed)));
                std::string state = std::string("{\"type\":\"state\",\"playing\":") +
                    std::string(g_engine.playing.load() ? "true" : "false") +
                    ",\"tick\":" + std::to_string(tick) +
                    std::string(",\"peak\":") + peakBuf + "}";
                // Broadcast to all clients (frontend is the only client)
                auto clients = server.getClients();
                for (auto& client : clients) {
                    if (client) client->send(state);
                }
            }
            // Stage 3c-2 — dispatch ledger drain (when enabled): batch the
            // sample-accurate dispatch record to the client for CI assertions.
            if (g_dispatchLog.load(std::memory_order_relaxed)) {
                const uint64_t w = g_ledgerWrite.load(std::memory_order_acquire);
                uint64_t r = g_ledgerRead.load(std::memory_order_relaxed);
                if (w > r) {
                    if (w - r > kLedgerSize) r = w - kLedgerSize;  // drop-oldest
                    std::string entries;
                    for (uint64_t i = r; i < w; ++i) {
                        const DispatchEntry& e = g_ledger[i % kLedgerSize];
                        char buf[112];
                        std::snprintf(buf, sizeof(buf),
                                      "{\"s\":%lld,\"t\":%lld,\"c\":%d,\"k\":%d,\"a\":%d,\"b\":%d}",
                                      static_cast<long long>(e.s), static_cast<long long>(e.t),
                                      static_cast<int>(e.ch), static_cast<int>(e.k),
                                      static_cast<int>(e.d1), static_cast<int>(e.d2));
                        if (!entries.empty()) entries += ",";
                        entries += buf;
                    }
                    g_ledgerRead.store(w, std::memory_order_relaxed);
                    const std::string msg = "{\"type\":\"dispatch\",\"entries\":[" + entries + "]}";
                    auto clients = server.getClients();
                    for (auto& client : clients) {
                        if (client) client->send(msg);
                    }
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(33));
        }
    });

    // Stage 3c-regression — plugin init worker: instantiates VST3s OFF the WS
    // thread (BBCSO took 5.7s and froze the loop behind it). Single worker,
    // latest request wins; the instance is prepared for the REAL device
    // config BEFORE it becomes visible to the audio callback; plugin_state +
    // engine.log receipts are emitted on completion. Joined after
    // server.stop() like the state broadcaster, so sends stay valid.
    std::thread plugin_init_thread([&server]() {
        uint64_t seenGen = 0;
        while (!g_should_exit.load()) {
            // Stage 3c-polish (D2): retire aged publications FIRST — Stage 3h
            // replaced the fixed 250 ms grace with a PROOF: the audio
            // callback's buffer-sequence counter (see the retirement-queue
            // block). seq >= swapSeq + 2 proves every buffer that began
            // before the swap has FINISHED (buffers run sequentially on the
            // one audio thread), so the free can never race an in-flight
            // buffer — a stalled audio thread (driver DPC spike, antivirus,
            // plugin I/O in processCall) now DEFERS the free instead of
            // losing the race. With no audio running the counter freezes and
            // entries stay queued (named once each); process exit reclaims,
            // as before. Receipts are collected and emitted after the lock
            // (the standing log discipline).
            {
                std::vector<std::string> receipts;
                {
                    std::lock_guard<std::mutex> rlock(g_retireMutex);
                    const uint64_t nowSeq = g_audioBufferSeq.load(std::memory_order_relaxed);
                    for (auto it = g_retiredScores.begin(); it != g_retiredScores.end();) {
                        if (nowSeq >= it->swapSeq + 2) {
                            receipts.push_back("[audio] score snapshot freed swapSeq=" +
                                               std::to_string(it->swapSeq) + " seq=" +
                                               std::to_string(nowSeq) +
                                               " — audio proof: two buffer-start ticks past the swap");
                            delete it->snapshot;
                            it = g_retiredScores.erase(it);
                        } else {
                            if (!it->deferNamed) {
                                it->deferNamed = true;   // rate limit: one line per deferred entry
                                receipts.push_back("[audio] retire deferred — audio proof pending (score snapshot swapSeq=" +
                                                   std::to_string(it->swapSeq) + " seq=" + std::to_string(nowSeq) +
                                                   ") — the audio thread has not advanced two buffers past the swap");
                            }
                            ++it;
                        }
                    }
                    // Stage 3f-6: a plugin whose retire capture is STILL pending on
                    // the message thread (queued, or mid-sleep inside a slow
                    // getStateInformation) must not be freed — the capture job
                    // dereferences it after the init worker's 3000 ms budget has
                    // already expired. Stage 3h: the free now needs BOTH proofs
                    // composed — the buffer-seq proof AND the job's done flag.
                    // Named ONCE per record, as before.
                    std::vector<std::string> retireDeferredIds;
                    for (auto it = g_retiredPlugins.begin(); it != g_retiredPlugins.end();) {
                        if (nowSeq >= it->swapSeq + 2) {
                            bool capturePending = false;
                            {
                                std::lock_guard<std::mutex> clk(g_retireCaptureMutex);
                                for (auto rcit = g_retireCaptures.begin(); rcit != g_retireCaptures.end();) {
                                    if (rcit->plugin != it->plugin) { ++rcit; continue; }
                                    if (rcit->done->load(std::memory_order_acquire)) {
                                        rcit = g_retireCaptures.erase(rcit);   // job finished touching it
                                        continue;
                                    }
                                    capturePending = true;
                                    if (!rcit->named) {
                                        rcit->named = true;
                                        retireDeferredIds.push_back(it->plugin->instanceId);
                                    }
                                    ++rcit;
                                }
                            }
                            if (capturePending) { ++it; continue; }
                            if (it->plugin->instance) it->plugin->instance->releaseResources();
                            receipts.push_back("[plugin] retire freed instance=" + it->plugin->instanceId +
                                               " swapSeq=" + std::to_string(it->swapSeq) + " seq=" +
                                               std::to_string(nowSeq) +
                                               " — audio proof: two buffer-start ticks past the swap");
                            delete it->plugin;
                            it = g_retiredPlugins.erase(it);
                        } else {
                            if (!it->deferNamed) {
                                it->deferNamed = true;   // rate limit: one line per deferred entry
                                receipts.push_back("[plugin] retire deferred — audio proof pending instance=" +
                                                   it->plugin->instanceId + " swapSeq=" +
                                                   std::to_string(it->swapSeq) + " seq=" + std::to_string(nowSeq) +
                                                   " — the audio thread has not advanced two buffers past the swap");
                            }
                            ++it;
                        }
                    }
                    for (const auto& iid : retireDeferredIds)
                        receipts.push_back("[plugin] retire deferred — capture job still pending on the message thread instance=" + iid);
                }
                for (const auto& r : receipts) engineLog(r);
            }
            // ── Stage 3i: latency flag drain + mini-republish jobs ──
            // The init worker is a PRODUCER-side drainer too: a plugin may
            // notify (latencyChanged) from any thread — including its own
            // realtime context — so the listener callback only stores an
            // atomic flag; scheduling the read via MessageManager::callAsync
            // would allocate on the notifying thread (audio-thread allocation
            // ban), so THIS 100 ms loop drains the flags instead. It is the
            // engine's existing plugin-facing worker (releaseResources already
            // runs here), the reads stay off the audio thread, and the fast
            // drain is also what makes the one-per-second rate limit real:
            // rapid notifications now CLUSTER into rate-limited enqueues
            // instead of collapsing into one flag per 2 s timer tick.
            latencyDrain(false);
            {
                std::vector<std::vector<LatencyCorrection>> jobs;
                {
                    std::lock_guard<std::mutex> lock(g_latencyJobMutex);
                    jobs.swap(g_latencyJobs);
                }
                for (auto& job : jobs) latencyRepublishJob(std::move(job));
            }
            // Stage 3d-4 hotfix — pending-open watchdog (this janitor loop is
            // the only off-MM heartbeat the engine owns; zero new threads).
            // An accepted openEditor that stays pending >10s is NAMED once:
            // either its message-thread job never started (MM wedged
            // elsewhere) or createEditor() has not returned (plugin UI
            // wedge — the only editor step a plugin can hang). Without this
            // the log shows "open requested" followed by eternal silence —
            // exactly the user's v0.7.0 evidence.
            {
                std::lock_guard<std::mutex> pl(g_pendingEditorMutex);
                if (g_pendingEditorActive && !g_pendingEditorNamed) {
                    const auto since = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - g_pendingEditorOpen.queuedAt).count();
                    if (since >= 10000) {
                        g_pendingEditorNamed = true;
                        const bool started = g_pendingEditorOpen.startedAt.time_since_epoch().count() != 0;
                        engineLog(std::string("[editor] open pending >10s instance=") +
                                  g_pendingEditorOpen.iid +
                                  (started
                                       ? " — createEditor() has not returned; message thread blocked inside plugin editor creation"
                                       : " — message-thread job has not started; message thread appears wedged"));
                    }
                }
            }
            PluginInitRequest req;
            {
                std::unique_lock<std::mutex> lock(g_pluginInitMutex);
                g_pluginInitCv.wait_for(lock, std::chrono::milliseconds(100), [] {
                    return g_pluginInitPending || g_should_exit.load();
                });
                if (!g_pluginInitPending) continue;   // spurious wake or shutdown
                req = std::move(g_pluginInitRequest);
                g_pluginInitRequest = PluginInitRequest{};
                g_pluginInitPending = false;
                seenGen = g_pluginInitGen;
            }
            // Stage 3f-7: the load is in progress until this iteration ends —
            // the probe thread pauses for all of it (queue time already set
            // the flag on the WS thread; this re-assert covers superseding
            // requests that were queued while a previous iteration ran).
            g_pluginLoadActive.store(true, std::memory_order_release);
            const auto t0 = std::chrono::steady_clock::now();
            // ─── Stage 3d-4: instantiate the requested set, entry by entry ───
            // Per-entry independence: one broken binary must not kill the
            // other instances of the set (its id RETAINS the previous instance;
            // the error receipt names it). A newer load supersedes the whole
            // request (checked after each entry — the set is discarded whole).
            struct EntryOutcome {
                std::unique_ptr<HostedPlugin> hosted;
                std::string err;
                long long initMs = 0;
                // 3e-3 FIX (3d-4 bug): success is tracked EXPLICITLY — the
                // publish path release()s `hosted` into the set, which NULLS
                // it, so `hosted == nullptr` cannot mean "failed" downstream.
                // Before this flag, EVERY successful replace was misread as a
                // failure and the OLD instance was retained at the requested
                // slot (the fresh instance leaked) — masked until now because
                // the old instance usually carried equivalent state; the 3e-3
                // outputRouting was the first observable old-vs-new difference.
                bool succeeded = false;
            };
            std::vector<EntryOutcome> outcomes(req.entries.size());
            bool superseded = false;
            for (size_t i = 0; i < req.entries.size(); ++i) {
                const PluginInitEntry& e = req.entries[i];
                const auto te0 = std::chrono::steady_clock::now();
                std::unique_ptr<HostedPlugin> h;
                // Stage 3f-6: phase watchdog record — a plugin hanging inside
                // createPluginInstance is named after 60 s by the watchdog
                // thread (log only).
                std::string hostErr;
                {
                    InitPhaseGuard pg("instantiate", e.instanceId);
                    hostErr = loadHostedPlugin(e.pluginVar, e.instanceId, h, e.routing);
                }
                outcomes[i].initMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - te0).count();
                {
                    std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                    superseded = seenGen != g_pluginInitGen;
                }
                if (g_should_exit.load() || superseded) break;
                if (!hostErr.empty()) {
                    outcomes[i].err = hostErr;
                    engineLog("[plugin] FAILED after " + std::to_string(outcomes[i].initMs) + "ms: " + hostErr +
                              " — instance \"" + e.instanceId + "\" retains its previous instance | seq " +
                              std::to_string(req.seq));
                    std::cout << "[engine] plugin load FAILED (" << e.instanceId << "): " << hostErr << std::endl;
                    const std::string ps = std::string("{\"type\":\"plugin_state\",\"state\":\"error\",\"instanceId\":\"") +
                        escape_json(e.instanceId) + "\",\"detail\":\"" +
                        escape_json(hostErr) + " — previous instance retained\"}";
                    for (auto& client : server.getClients())
                        if (client) client->send(ps);
                    continue;
                }
                // Stage 3d-3 — restore the project's embedded state BEFORE the
                // real-device prepare (documented order: instantiate → state →
                // prepare). A restore failure NEVER kills hosting: the receipt
                // names it and the plugin runs on its default state.
                if (!e.stateB64.empty() && h->instance) {
                    // Decode via MemoryOutputStream backed by mb — and read the
                    // TRUE decoded size from the STREAM (mos.getDataSize()), not
                    // mb.getSize(): the stream commits its final size on flush,
                    // and reading the block early yields the PREALLOCATED
                    // capacity (empirically 224 vs the real 197 — the container
                    // format happened to be self-delimiting, but passing a
                    // capacity-garbage size to a plugin is a bug, not a
                    // contract).
                    juce::MemoryBlock mb;
                    juce::MemoryOutputStream mos(mb, false);
                    const bool decoded = juce::Base64::convertFromBase64(mos, juce::String(e.stateB64));
                    mos.flush();
                    const size_t restoredBytes = mos.getDataSize();
                    if (decoded && restoredBytes > 0 && restoredBytes <= kMaxPluginStateBytes * 2) {
                        try {
                            InitPhaseGuard pg("state-restore", e.instanceId);   // 3f-6 watchdog phase
                            h->instance->setStateInformation(mos.getData(), static_cast<int>(restoredBytes));
                            engineLog("[plugin] state restored " + std::to_string(restoredBytes) +
                                      " bytes (project embed) instance=" + e.instanceId);
                        } catch (const std::exception& ex) {
                            engineLog(std::string("[plugin] state restore FAILED: ") +
                                      (ex.what() ? ex.what() : "unknown") + " — running on default state");
                        } catch (...) {
                            engineLog("[plugin] state restore FAILED: SEH/unknown — running on default state");
                        }
                    } else {
                        engineLog("[plugin] state restore SKIPPED — empty/oversized blob (" +
                                  std::to_string(e.stateB64.size()) + " b64 chars, decoded " +
                                  std::to_string(decoded ? restoredBytes : 0) + " bytes)");
                    }
                }
                // Prepare for the REAL device (create-time used nominal
                // 44100/512) BEFORE the swap — a mis-prepared instance under a
                // running callback was the other half of the empty-score
                // regression. D1: log the ACTUAL prepared config.
                const double devRate = g_engine.sampleRate.load();
                const int devBuf = g_deviceBufferSize.load();
                if (devRate > 0.0 && h->instance) {
                    InitPhaseGuard pg("prepare", e.instanceId);   // 3f-6 watchdog phase
                    // Stage 3e-2: playhead re-asserted before the real-device
                    // prepare (see loadHostedPlugin).
                    h->instance->setPlayHead(&g_audioCallback.playHead);
                    h->instance->setPlayConfigDetails(0, 2, devRate, devBuf);
                    // Stage 3e-3: re-enable all output buses AFTER the
                    // negotiation (it disables non-main buses — same
                    // ordering as loadHostedPlugin).
                    for (int b = 0; b < h->instance->getBusCount(false); ++b)
                        if (auto* bus = h->instance->getBus(false, b)) bus->enable(true);
                    h->instance->prepareToPlay(devRate, devBuf);
                }
                int preparedLat = 0;
                if (h->instance) {
                    preparedLat = static_cast<int>(h->instance->getLatencySamples());
                    h->latencySamples = static_cast<double>(preparedLat);
                }
                engineLog("[plugin] prepared (async) rate=" +
                          std::to_string(static_cast<int>(devRate > 0.0 ? devRate : 44100.0)) +
                          " buffer=" + std::to_string(devRate > 0.0 ? devBuf : 512) +
                          " latencySamples=" + std::to_string(preparedLat) +
                          " instance=" + e.instanceId +
                          (devRate > 0.0 ? " (real device)" : " (nominal — device not started yet; AboutToStart re-prepares)"));
                if (!e.routing.empty()) {
                    std::string rStr;
                    for (const auto& rr : e.routing) {
                        if (!rStr.empty()) rStr += ", ";
                        rStr += "bus" + std::to_string(rr.busIndex) +
                                (rr.mute ? " MUTE" : " gain=" + std::to_string(rr.gain));
                    }
                    engineLog("[plugin] outputRouting instance=" + e.instanceId + ": " + rStr);
                }
                outcomes[i].hosted = std::move(h);
            }
            if (g_should_exit.load()) continue;   // unique_ptrs free the set
            if (superseded) {
                // A newer load queued behind this instantiate — discard the
                // whole set; the loop picks up the newest request next pass.
                long long totalMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - t0).count();
                engineLog("[plugin] init superseded after " + std::to_string(totalMs) +
                          "ms — instance set discarded | seq " + std::to_string(req.seq));
                continue;
            }
            // ─── Publish the new SET (Stage 3d-4; publish-safe since 3f-6) ───
            // Successful entries take their parse-assigned slots; a requested
            // id whose instantiate FAILED RETAINS its previous instance (moved
            // into the new set at the requested slot — slots always mirror the
            // request, so the just-published routing table stays truthful);
            // ids absent from the request retire (the group vanished from the
            // project). Replaced/retired instances: editors close BEFORE the
            // swap; the NEW set's loaded receipts go out IMMEDIATELY after the
            // swap (3f-6 reorder — receipts must never wait behind the retired
            // instances' state captures); the captures then run on the MESSAGE
            // thread with a 3000 ms init-thread budget (the 3f-6 defect: a
            // slow plugin getStateInformation on THIS thread stalled the
            // publish section forever — no receipts, and every later load
            // wedged behind "init started (async)").
            InitPhaseGuard publishGuard("publish", "-");   // 3f-6 watchdog phase (set-wide)
            auto nextSet = std::make_shared<InstanceSet>();
            std::unordered_map<std::string, size_t> entryIdxById;
            for (size_t i = 0; i < req.entries.size(); ++i)
                entryIdxById[req.entries[i].instanceId] = i;
            int maxLat = 0;
            for (size_t i = 0; i < req.entries.size(); ++i) {
                if (!outcomes[i].hosted) continue;
                HostedPlugin* raw = outcomes[i].hosted.release();   // the set owns it from here
                outcomes[i].succeeded = true;   // release() nulls `hosted` — record success EXPLICITLY
                raw->slot = req.entries[i].slot;
                nextSet->slots[raw->slot] = raw;
                nextSet->slotLatency[raw->slot] = static_cast<int>(raw->latencySamples);
                if (nextSet->slotLatency[raw->slot] > maxLat) maxLat = nextSet->slotLatency[raw->slot];
            }
            const auto oldSet = g_instances.load(std::memory_order_acquire);
            std::vector<HostedPlugin*> retiredNow;
            if (oldSet != nullptr) {
                for (int s = 0; s < kMaxInstances; ++s) {
                    HostedPlugin* old = oldSet->slots[s];
                    if (old == nullptr) continue;
                    auto eit = entryIdxById.find(old->instanceId);
                    if (eit == entryIdxById.end()) {
                        retiredNow.push_back(old);   // group vanished from the project
                        continue;
                    }
                    if (!outcomes[eit->second].succeeded) {
                        // FAILED entry → retain the previous instance at the
                        // REQUESTED slot (routing truth = request order).
                        old->slot = req.entries[eit->second].slot;
                        nextSet->slots[old->slot] = old;
                        nextSet->slotLatency[old->slot] = static_cast<int>(old->latencySamples);
                        if (nextSet->slotLatency[old->slot] > maxLat) maxLat = nextSet->slotLatency[old->slot];
                    } else {
                        retiredNow.push_back(old);   // replaced by the fresh instance
                    }
                }
            }
            g_pluginLatencySamples.store(maxLat, std::memory_order_release);
            const auto tPub = std::chrono::steady_clock::now();
            const auto pubMs = [&tPub]() {
                return std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - tPub).count();
            };
            // Stage 3f-6 receipt: the publish section now SPEAKS — every step
            // is preceded by a named, elapsed-stamped line, so a wedged
            // publish is locatable in engine.log by its last receipt.
            engineLog("[plugin] publish: swapping set | seq " + std::to_string(req.seq) +
                      " retired=" + std::to_string(retiredNow.size()) +
                      " elapsed=" + std::to_string(pubMs()) + "ms");
            // Stage 3d-1: the outgoing instances' editors must not outlive
            // them — close by id BEFORE the swap (scheduled on the pump thread,
            // well inside the retire grace; the audio callback never touches
            // editors).
            for (HostedPlugin* old : retiredNow) closeEditorAsync(old->instanceId);
            g_instances.store(std::move(nextSet), std::memory_order_acq_rel);
            // Stage 3h: the proof value is captured AFTER the store — a capture
            // taken before it could go stale if this thread were preempted
            // between the two statements (the retirement-queue block carries
            // the full proof). EVERY retired entry of this swap carries the
            // same swapSeq; rapid successive swaps each keep their own, and
            // one post-swap buffer tick can satisfy several entries at once.
            const uint64_t swapSeq = g_audioBufferSeq.load(std::memory_order_relaxed);

            // Stage 3f-6 REORDER: the NEW set's receipts go out FIRST —
            // per-instance loaded receipts (log + plugin_state, additive
            // instanceId field) and the 3e-1 capability handshake, all
            // IMMEDIATELY after the swap and BEFORE any state capture of the
            // retired instances. The frontend unblocks the moment the set is
            // live; a 10-second capture can no longer starve them. Retained-
            // on-failure instances re-report too — the frontend's editor gate
            // keys on plugin_state per instance.
            const auto liveSet = g_instances.load(std::memory_order_acquire);
            for (const auto& e : req.entries) {
                HostedPlugin* h = liveSet ? liveSet->byId(e.instanceId) : nullptr;
                if (h == nullptr) continue;
                engineLog("[plugin] loaded name=" + h->name + " vendor=" + h->vendor +
                          " instance=" + h->instanceId + " slot=" + std::to_string(h->slot) +
                          " | seq " + std::to_string(req.seq) +
                          " channels=[" + e.channelsJson + "]");
                std::cout << "[engine] plugin loaded: name=" << h->name
                          << " instance=" << h->instanceId
                          << " init=" << (outcomes[entryIdxById[e.instanceId]].initMs) << "ms"
                          << " channels=[" << e.channelsJson << "]" << std::endl;
                const double latencyMs = (h->latencySamples + 512.0) / 44100.0 * 1000.0;
                char latBuf[32];
                std::snprintf(latBuf, sizeof(latBuf), "%.2f", latencyMs);
                const std::string ps = std::string("{\"type\":\"plugin_state\",\"state\":\"loaded\",\"instanceId\":\"") +
                    escape_json(h->instanceId) + "\",\"name\":\"" + escape_json(h->name) +
                    "\",\"vendor\":\"" + escape_json(h->vendor) +
                    "\",\"classId\":\"" + escape_json(h->classId) +
                    "\",\"latencyMs\":" + latBuf + ",\"channels\":[" + e.channelsJson + "]}";
                for (auto& client : server.getClients())
                    if (client) client->send(ps);
                // Stage 3e-1 — CAPABILITY HANDSHAKE: exactly one
                // plugin_capabilities per instance, IMMEDIATELY after its
                // plugin_state "loaded". The fields were captured at
                // instantiate time (pre-serialized on the instance).
                if (!h->capabilitiesFields.empty()) {
                    const std::string caps = std::string("{\"type\":\"plugin_capabilities\",\"instanceId\":\"") +
                        escape_json(h->instanceId) + "\"," + h->capabilitiesFields + "}";
                    for (auto& client : server.getClients())
                        if (client) client->send(caps);
                    engineLog("[plugin] capabilities sent instance=" + h->instanceId +
                              " classId=\"" + h->classId + "\"");
                }
            }

            // Stage 3f-6: capture the OUTGOING instances' states (the user's
            // patches — a reload must not lose them) OFF the init thread.
            // getStateInformation runs on the MESSAGE thread via callAsync
            // (the same scheduling closeEditorAsync uses) while the init
            // thread waits on the job's done flag with a 3000 ms budget — the
            // init thread NEVER waits longer than that per retired instance.
            // On budget expiry the capture is abandoned (the message-thread
            // job may still complete later and broadcast its blob — harmless;
            // the instance is only freed after the job's done flag lands, see
            // g_retireCaptures), the TIMEOUT receipt names the instance, and
            // the LAST EMBEDDED STATE stays authoritative (the frontend keeps
            // its project blob). The instance then joins g_retiredPlugins
            // exactly as before.
            for (HostedPlugin* old : retiredNow) {
                engineLog("[plugin] retire capture BEGIN instance=" + old->instanceId +
                          " elapsed=" + std::to_string(pubMs()) + "ms");
                if (old->instance != nullptr) {
                    auto done = std::make_shared<std::atomic<bool>>(false);
                    {
                        std::lock_guard<std::mutex> clk(g_retireCaptureMutex);
                        g_retireCaptures.push_back({old, done, false});
                    }
                    HostedPlugin* captured = old;   // lifetime guarded by the janitor's g_retireCaptures defer
                    juce::MessageManager::callAsync([captured, done] {
                        captureAndBroadcastState(*captured, "replace");
                        done->store(true, std::memory_order_release);
                    });
                    const auto tc0 = std::chrono::steady_clock::now();
                    bool finished = false;
                    // The DONE check leads every iteration: a capture that
                    // completed before shutdown must be reported as END, never
                    // as "engine exiting" (the flag can land while this wait
                    // is pending — node sends shutdown right after the loaded
                    // receipts). g_should_exit only bounds the wait when the
                    // job genuinely has not finished; the 3000 ms budget
                    // remains the hard ceiling either way.
                    while (true) {
                        if (done->load(std::memory_order_acquire)) { finished = true; break; }
                        if (g_should_exit.load()) break;
                        const auto waitedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - tc0).count();
                        if (waitedMs >= 3000) break;
                        std::this_thread::sleep_for(std::chrono::milliseconds(10));
                    }
                    const long long capMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - tc0).count();
                    if (finished) {
                        // The job finished touching the instance — drop its
                        // record so the janitor's audio-proof condition governs
                        // the free exactly as before (Stage 3h: seq >= swapSeq + 2).
                        std::lock_guard<std::mutex> clk(g_retireCaptureMutex);
                        g_retireCaptures.erase(
                            std::remove_if(g_retireCaptures.begin(), g_retireCaptures.end(),
                                           [old](const PendingRetireCapture& rc) { return rc.plugin == old; }),
                            g_retireCaptures.end());
                        engineLog("[plugin] retire capture END instance=" + old->instanceId +
                                  " " + std::to_string(capMs) + " ms");
                    } else {
                        engineLog("[plugin] retire capture TIMEOUT instance=" + old->instanceId +
                                  " " + std::to_string(capMs) + " ms (3000 ms budget)"
                                  + std::string(g_should_exit.load() ? " — engine exiting" : "") +
                                  " — last embedded state stays authoritative");
                    }
                }
                std::lock_guard<std::mutex> rlock(g_retireMutex);
                g_retiredPlugins.push_back({old, swapSeq, false});
            }
            engineLog("[plugin] publish: done | seq " + std::to_string(req.seq) +
                      " retired=" + std::to_string(retiredNow.size()) +
                      " elapsed=" + std::to_string(pubMs()) + "ms");
            // Stage 3f-7: the load iteration is over — clear the probe pause
            // unless ANOTHER request is already queued behind it.
            {
                std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                g_pluginLoadActive.store(g_pluginInitPending, std::memory_order_release);
            }
        }
    });

    // ─── Stage 3f-6 — init-phase watchdog thread ────────────────────────────
    // A hang INSIDE the init worker (plugin code: instantiate, state restore,
    // prepare, or the publish section) is invisible to the worker itself —
    // the worker IS the hang. This 1 s observer reads the g_initPhase record
    // the worker writes at every phase transition and NAMES any single phase
    // older than 60 s (log only — no kill, no skip: killing a thread that
    // holds plugin/JUCE locks wedges the process harder than the hang). The
    // receipt turns the user's symptom ("loaded never appears, later loads
    // log init started and nothing more") into a located phase + instance.
    std::thread plugin_init_watchdog([]() {
        while (!g_should_exit.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            if (g_should_exit.load()) break;
            std::string phase, iid;
            std::chrono::steady_clock::time_point startedAt{};
            bool active = false, named = false;
            {
                std::lock_guard<std::mutex> lk(g_initPhase.mtx);
                phase = g_initPhase.phase;
                iid = g_initPhase.instanceId;
                startedAt = g_initPhase.startedAt;
                active = g_initPhase.active;
                named = g_initPhase.named;
            }
            if (!active || named || phase.empty()) continue;
            const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - startedAt).count();
            if (ms < 60000) continue;
            engineLog("[plugin] init WATCHDOG phase=" + phase + " instance=" + iid + " " +
                      std::to_string(ms) + " ms");
            std::lock_guard<std::mutex> lk(g_initPhase.mtx);
            g_initPhase.named = true;   // one WATCHDOG line per phase occurrence
        }
    });

    // ─── Stage 3f-2 — background scan-probe thread ─────────────────────────
    // Probes each queued scan row SEQUENTIALLY: one --probe-worker child per
    // row (90 s cap, waited in 250 ms slices so shutdown never stalls). A
    // probe failure, timeout or crash sends a capabilitiesError scan_probe —
    // it can NEVER remove or change a row (rows were already sent with
    // scan_result; the frontend merges by classId).
    // Stage 3f-7: probing must not compete with the user — the pause gate is
    // evaluated CONTINUOUSLY (every loop pass AND during a running child's
    // 250 ms wait slices): a load in progress, ANY open editor window, or a
    // rolling transport holds the gate; dequeueing stays blocked and "[probe]
    // paused (reason=…)" / "[probe] resumed" are logged ONCE per state change
    // while there is probe activity to gate. A probe already RUNNING finishes
    // normally (the gate never touches a running child — it only blocks the
    // next dequeue); resume waits 2 s after every condition has cleared.
    std::thread scan_probe_thread([&server]() {
        const juce::String exePath =
            juce::File::getSpecialLocation(juce::File::currentExecutableFile).getFullPathName();
        bool pausedLogged = false;
        std::chrono::steady_clock::time_point allClearAt{};
        auto pauseReason = []() -> std::string {
            std::string reason;
            if (g_pluginLoadActive.load(std::memory_order_acquire)) reason = "load in progress";
            {
                std::lock_guard<std::mutex> lk(g_editorMutex);
                if (!g_editors.empty()) reason += reason.empty() ? "editor window open" : " + editor window open";
            }
            if (g_engine.playing.load(std::memory_order_relaxed))
                reason += reason.empty() ? "transport playing" : " + transport playing";
            return reason;
        };
        // One gate evaluation. Returns true when the gate is HOLDING (paused).
        auto pauseUpdate = [&pausedLogged, &allClearAt, &pauseReason]() -> bool {
            const std::string reason = pauseReason();
            if (!reason.empty()) {
                if (!pausedLogged) {
                    engineLog("[probe] paused (reason=" + reason + ")");
                    pausedLogged = true;
                }
                allClearAt = {};
                return true;
            }
            if (pausedLogged) {
                const auto now = std::chrono::steady_clock::now();
                if (allClearAt.time_since_epoch().count() == 0) allClearAt = now;
                if (std::chrono::duration_cast<std::chrono::milliseconds>(now - allClearAt).count() < 2000) {
                    return true;   // 2 s all-clear delay before resuming
                }
                engineLog("[probe] resumed");
                pausedLogged = false;
                allClearAt = {};
            }
            return false;
        };
        while (!g_should_exit.load()) {
            ScanProbeJob job;
            bool haveJob = false;
            {
                std::unique_lock<std::mutex> lock(g_scanProbeMutex);
                g_scanProbeCv.wait_for(lock, std::chrono::milliseconds(200), [] {
                    return !g_scanProbeQueue.empty() || g_should_exit.load();
                });
                if (g_should_exit.load()) break;
                if (!g_scanProbeQueue.empty()) {
                    // Dequeue gate: a holding gate keeps the job QUEUED (a
                    // probe already running finishes normally).
                    if (!pauseUpdate()) {
                        job = g_scanProbeQueue.front();
                        g_scanProbeQueue.erase(g_scanProbeQueue.begin());
                        haveJob = true;
                    }
                }
            }
            if (!haveJob) continue;
            const auto t0 = std::chrono::steady_clock::now();
            const auto elapsedMs = [&t0]() {
                return std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - t0).count();
            };
            std::string resultInner;   // the fields after {"type":"scan_probe",
            std::string tailForLog;    // stderr evidence for the failure classes
            const char* outcome = "error";
            juce::ChildProcess child;
            const bool started = child.start(
                juce::StringArray{ exePath, "--probe-worker",
                                   juce::String(job.path), juce::String(job.classId) },
                juce::ChildProcess::wantStdOut | juce::ChildProcess::wantStdErr);
            if (!started) {
                // 3f-2: EVERY scan_probe names its row — the classId is how
                // the frontend merges (and a failure must still be able to
                // annotate its row; a probe never removes one).
                resultInner = "\"classId\":\"" + escape_json(job.classId) +
                              "\",\"capabilitiesError\":\"probe worker failed to start\"";
                outcome = "start-failed";
            } else {
                // 90 s cap — 360 × 250 ms slices; g_should_exit checked between
                // slices so engine shutdown never waits behind a hung probe.
                // Stage 3f-7: the pause gate is re-evaluated on EVERY slice —
                // a load/editor/transport starting MID-PROBE still logs its
                // transition (the child itself finishes normally either way).
                bool finished = false;
                for (int i = 0; i < 360 && !finished; ++i) {
                    finished = child.waitForProcessToFinish(250);
                    if (g_should_exit.load()) break;
                    pauseUpdate();
                }
                if (!finished) {
                    child.kill();
                    tailForLog = child.readAllProcessOutput().toStdString();
                    resultInner = "\"classId\":\"" + escape_json(job.classId) +
                                  "\",\"capabilitiesError\":\"probe timeout after 90s\"";
                    outcome = "timeout";
                } else {
                    const int exitCode = child.getExitCode();
                    const std::string out = child.readAllProcessOutput().toStdString();
                    if (exitCode != 0) {
                        resultInner = "\"classId\":\"" + escape_json(job.classId) +
                                      "\",\"capabilitiesError\":\"probe worker crashed (exit " +
                                      std::to_string(exitCode) + ")\"";
                        outcome = "crashed";
                        tailForLog = out;
                    } else {
                        const std::string pb = "SCORCH_PROBE_BEGIN";
                        const std::string pe = "SCORCH_PROBE_END";
                        const auto b = out.find(pb);
                        const auto e = out.find(pe);
                        if (b == std::string::npos || e == std::string::npos || e < b) {
                            // Exit 0 but no markers — the JUCE POSIX wrapper
                            // reports signal death as exit 0; still a crash.
                            resultInner = "\"classId\":\"" + escape_json(job.classId) +
                                          "\",\"capabilitiesError\":\"probe worker produced no result (crashed or killed)\"";
                            outcome = "crashed";
                            tailForLog = out;
                        } else {
                            std::string body = out.substr(b + pb.size(), e - (b + pb.size()));
                            const auto f = body.find_first_not_of(" \t\r\n");
                            if (f == std::string::npos) {
                                resultInner = "\"classId\":\"" + escape_json(job.classId) +
                                              "\",\"capabilitiesError\":\"probe worker produced empty output\"";
                                tailForLog = out;
                            } else {
                                body = body.substr(f, body.find_last_not_of(" \t\r\n") - f + 1);
                                auto parsed = juce::JSON::parse(juce::String(body));
                                if (parsed.getDynamicObject() == nullptr) {
                                    resultInner = "\"classId\":\"" + escape_json(job.classId) +
                                                  "\",\"capabilitiesError\":\"probe worker produced unparsable output\"";
                                    tailForLog = out;
                                } else {
                                    // The worker already wrapped classId +
                                    // capabilities/capabilitiesError in a
                                    // JSON object — forward its FIELDS
                                    // verbatim (the send site below wraps
                                    // them as {"type":"scan_probe", …}).
                                    resultInner = body.substr(1, body.size() - 2);
                                    outcome = parsed.getProperty("capabilities", juce::var())
                                                  .getDynamicObject() != nullptr ? "ok" : "error";
                                }
                            }
                        }
                    }
                }
            }
            if (!g_should_exit.load() && !resultInner.empty()) {
                const std::string msg = "{\"type\":\"scan_probe\"," + resultInner + "}";
                for (auto& client : server.getClients())
                    if (client) client->send(msg);
            }
            std::string logLine = std::string("[probe] path=") + job.path +
                                  " outcome=" + outcome +
                                  " elapsedMs=" + std::to_string(elapsedMs());
            if (!tailForLog.empty()) {
                const std::string tail =
                    tailForLog.size() > 2000 ? tailForLog.substr(tailForLog.size() - 2000) : tailForLog;
                logLine += " stderrTail=" + tail;
            }
            engineLog(logLine);
            // Stage 3f-7: record the outcome for probe-on-load's dedupe — a
            // SUCCEEDED probe (2) is never repeated by a load; a FAILED one
            // (0) is retried the next time the plugin loads (its earlier
            // failure is stale once the plugin actually hosts).
            {
                std::lock_guard<std::mutex> lock(g_scanProbeMutex);
                g_probeOutcomeByClassId[job.classId] = (std::string(outcome) == "ok") ? 2 : 0;
            }
            std::cout << "[engine] scan_probe " << outcome
                      << " (" << elapsedMs() << "ms)" << std::endl;
        }
    });

    std::cout << "[engine] scorch-engine " << kEngineVersion
              << " listening on 127.0.0.1:" << port << std::endl;

    auto res = server.listen();
    if (!res.first) {
        std::cerr << "[engine] failed to bind 127.0.0.1:" << port
                  << " — " << res.second << std::endl;
        return 1;
    }

    server.start();
    while (!g_should_exit.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    server.stop();
    state_thread.join();
    plugin_init_thread.join();
    // Stage 3f-6: the watchdog sleeps in 1 s slices and re-checks
    // g_should_exit — join is bounded.
    plugin_init_watchdog.join();
    // Stage 3f-7 (4a): the heartbeat sleeps in 1 s slices — join is bounded.
    mm_heartbeat_thread.join();
    // Stage 3f-2: the probe thread checks g_should_exit between its 250 ms
    // wait slices and kills any in-flight probe child — join is bounded.
    scan_probe_thread.join();
    // Stage 3d-1: graceful exit closes editor windows FIRST (bounded wait —
    // the pump is still running). A hard kill needs nothing: the OS reaps
    // the process's windows, so orphans are impossible either way.
    closeAllEditorsAtShutdown();
    // Wake the MM pump (join would otherwise block forever) and let it die.
    juce::MessageManager::getInstance()->stopDispatchLoop();
    mm_pump_thread.join();
    shutdownAudio();
    ix::uninitNetSystem();
    engineLog("[engine] clean exit 0");
    std::cout << "[engine] clean exit 0" << std::endl;
    return 0;
}
