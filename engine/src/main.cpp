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
//                     default: %COMMONPROGRAMFILES%\VST3 + %APPDATA%\VST3 on
//                     Windows, /usr/lib/vst3 + ~/.vst3 elsewhere)
//   server -> client: {"type":"scan_result","plugins":[{name,vendor,version,
//                     uid,isInstrument,path}],"failed":[{path,error}],
//                     "scannedDirs":[{dir,status}]}
//                     Crash isolation: each .vst3 is scanned by a CHILD copy
//                     of this exe (--scan-worker); a plugin that crashes or
//                     hangs kills only its worker — the scan survives.
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

constexpr const char* kEngineVersion = "0.7.0";
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
};
std::atomic<ScoreSnapshot*> g_score{nullptr};

// Retirement queue (worker-thread-only): published objects that may still be
// referenced by one in-flight audio buffer. Drained after a grace period far
// exceeding any buffer duration (250ms >> 1024 samples @ 44.1kHz = 23ms), so
// the audio thread NEVER frees anything. Deliberately NOT drained at exit
// (process exit reclaims — same policy as the hosted plugin teardown).
struct HostedPlugin;   // defined below (lock-free published instance)
std::mutex g_retireMutex;
std::vector<std::pair<ScoreSnapshot*, std::chrono::steady_clock::time_point>> g_retiredScores;
std::vector<std::pair<HostedPlugin*, std::chrono::steady_clock::time_point>> g_retiredPlugins;

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

    // Audio-thread-owned. External code NEVER touches these: stop/seek/panic
    // set g_voiceKillPending and the next buffer performs the kill.
    Voice voices[kMaxVoices];
    int64_t voiceAge = 0;

    int64_t currentTick() const {
        if (!playing.load()) return lastTick.load();
        ScoreSnapshot* s = g_score.load(std::memory_order_acquire);
        const double b = s ? s->bpm : 120.0;
        const int q = s ? s->ppqn : 960;
        return playStartTick.load() +
               static_cast<int64_t>(samplesProcessed.load() /
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

class PluginEditorWindow : public juce::DocumentWindow {
public:
    PluginEditorWindow(std::string instanceId, const juce::String& title)
        : juce::DocumentWindow(title, juce::Colour(0xff14161f),
                               juce::DocumentWindow::closeButton, true),
          iid(std::move(instanceId)) {}

    void closeButtonPressed() override {
        // Runs on the message thread. Destroying self synchronously inside
        // the window's own callback is unsafe — schedule the deletion.
        // USER-initiated close → the state capture fires (3d-3).
        juce::MessageManager::callAsync([iid = this->iid] { destroyEditorWindow(iid, true); });
    }

    std::string iid;
};

// Message-thread side of open. A plugin may ship no editor — createEditor()
// returning null is the editor_unavailable path, a NORMAL reply.
void openEditorWindow(const std::string& iid, HostedPlugin* owner) {
    if (owner == nullptr || !owner->instance) return;
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
            return;
        }
    }
    auto* ed = owner->instance->createEditor();
    if (ed == nullptr) {
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
        win->setVisible(false);
        delete win;   // setContentOwned(ed, true) frees the editor with the window
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
    try {
        juce::MemoryBlock mb;
        h.instance->getStateInformation(mb);
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

// ─── Audio callback ─────────────────────────────────────────────────────────
class EngineAudioCallback : public juce::AudioIODeviceCallback {
public:
    void audioDeviceIOCallbackWithContext(const float* const* /*inputChannelData*/,
                                          int /*numInputChannels*/,
                                          float* const* outputChannelData,
                                          int numOutputChannels,
                                          int numSamples,
                                          const juce::AudioIODeviceCallbackContext& /*context*/) override {
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
                    renderPlugin(h->instance.get(), instMidi[slot], outputChannelData,
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
            return;
        }

        // Capture the transport generation BEFORE the position reads: any
        // play/seek that lands after this point invalidates this buffer's
        // commit (gen mismatch at the end), never half-updated state.
        const uint64_t gen0 = g_engine.transportGen.load(std::memory_order_relaxed);
        const double spt = score
            ? g_engine.sampleRate.load() * 60.0 / (score->bpm * score->ppqn)
            : (44100.0 * 60.0 / (120.0 * 960));
        const int64_t endTick = score ? score->endTick : 0;
        const EngineEvent* const events = score ? score->events.data() : nullptr;
        const size_t eventCount = score ? score->events.size() : 0;
        int64_t startSample = g_engine.samplesProcessed.load();
        int64_t playStartTick = g_engine.playStartTick.load();

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
                e.s = startSample;
                e.t = playStartTick + static_cast<int64_t>(std::llround(static_cast<double>(startSample) / spt));
                e.k = kEvCC; e.ch = 0; e.d1 = 120; e.d2 = 0;
                g_ledgerWrite.store(idx + 1, std::memory_order_release);
            }
        }
        size_t eventIdx = 0;
        // Skip events before the current position. THE CLAMP RULE (3c
        // close-out receipt — the resume-replay bug): the F4 latency shift
        // may pull an event BEFORE buffer start only when its grid position
        // is at/after the transport start tick (those have not fired yet —
        // the just-in-time pre-trigger case; clamp to 0 and fire now). An
        // event BEFORE the start tick is PAST — it must NEVER resurrect:
        // clamping it to 0 used to re-dispatch the ENTIRE pre-resume score
        // at sample 0 on every resume/seek (the pluck + glitch receipt:
        // ~630 stale events into BBCSO, every past CC#32 re-firing = the
        // bow-scrape). Past events keep their negative sample and skip.
        for (; eventIdx < eventCount; ++eventIdx) {
            const EngineEvent& ev = events[eventIdx];
            const int64_t raw = static_cast<int64_t>((ev.tick - playStartTick) * spt) -
                (ev.tick >= playStartTick && isPluginRouted(ev) ? latencyFor(ev) : 0);
            // Events AT/AFTER the start tick may be pulled before buffer start
            // by the latency shift — they have NOT fired yet (the tick-0
            // pre-set / just-in-time pre-trigger case): clamp to 0, fire now.
            // Events BEFORE the start tick are PAST: keep the negative sample
            // and skip — they must never resurrect.
            const int64_t eventSample = ev.tick >= playStartTick
                ? std::max<int64_t>(0, raw) : raw;
            if (eventSample >= startSample) break;
        }

        for (int s = 0; s < numSamples; ++s) {
            int64_t absSample = startSample + s;

            // Dispatch events at this sample (no lock — immutable snapshot).
            while (eventIdx < eventCount) {
                const EngineEvent& ev = events[eventIdx];
                const bool toPlugin = isPluginRouted(ev);
                // Same clamp rule as the skip walk above: only events AT/AFTER
                // the transport start tick get the latency shift + clamp —
                // past events never reach here (the skip walk consumed them).
                const int64_t eventSample = std::max<int64_t>(0,
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
                    renderPlugin(h->instance.get(), instMidi[slot], outputChannelData,
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
            g_engine.samplesProcessed.store(committed);
            g_engine.lastTick.store(playStartTick +
                static_cast<int64_t>(static_cast<double>(committed) / spt));

            // Stop at endTick — MUSICAL (3c close-out): the synth voices fade
            // (allNotesOff = release), and the plugin path gets real note-offs
            // via the release flag on the next buffer (score-authored offs
            // have normally already fired; this catches anything still held).
            const int64_t nowTick = playStartTick +
                static_cast<int64_t>(static_cast<double>(committed) / spt);
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
                p->setPlayConfigDetails(0, 2, device->getCurrentSampleRate(),
                                        device->getCurrentBufferSizeSamples());
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

    // Render one buffer through the hosted plugin and copy its output
    // channels into the device buffer, tracking the output peak.
    // Stage 3c-polish F3: the hosted OUTPUT GAIN is applied here — plugin
    // path only, after render, before the master bus. NOT a per-track mix
    // recalibration (that is mix-v4); CC7/CC11 remain the per-track levels.
    //
    // Stage 3d-2 (the gauntlet): STEREO-HONEST OUTPUT COPY. The old loop read
    // ONLY channel 0 and copied it to EVERY device channel — a stereo
    // instrument's right channel was silently dropped (panned patches,
    // stereo pianos, chorused synths all rendered mono-left). Universal
    // channel mapping (no plugin-name logic):
    //   plugin mono   → mono fold to every device channel (unchanged)
    //   plugin stereo → device L←ch0, device R←ch1  (THE fix)
    //   plugin >2     → L←ch0, R←ch1, extra device channels take ch1;
    //                   ch2+ of the plugin are NOT mixed down (documented:
    //                   Scorch returns stereo; a surround main bus that
    //                   refused the stereo request is accepted as-is).
    // The fixture renders identical L/R, so the CI peak arithmetic is
    // byte-identical pre/post (asserted: phases A/C peaks unchanged).
    void renderPlugin(juce::AudioPluginInstance* plugin, juce::MidiBuffer& midi,
                      float* const* outputChannelData, int numOutputChannels,
                      int numSamples, float& peak) {
        const int wantChans = juce::jlimit(1, 8, plugin->getMainBusNumOutputChannels());
        if (procBuf.getNumSamples() != numSamples || procBuf.getNumChannels() != wantChans)
            procBuf.setSize(wantChans, numSamples, false, true, false);
        for (int ch = 0; ch < procBuf.getNumChannels(); ++ch)
            procBuf.clear(ch, 0, numSamples);
        plugin->processBlock(procBuf, midi);
        const float gain = g_hostedOutputGain.load(std::memory_order_relaxed);
        const int procChans = procBuf.getNumChannels();
        for (int s = 0; s < numSamples; ++s) {
            float peakSample = 0.0f;
            for (int ch = 0; ch < numOutputChannels; ++ch) {
                const int src = procChans > 1 ? juce::jmin(ch, 1) : 0;
                const float out = procChans > 0 ? procBuf.getSample(src, s) * gain : 0.0f;
                // Stage 3d-4: ADD (the device buffer is zeroed at callback
                // entry and carries the Σ of all instances + the synth path;
                // the old ASSIGN was only correct for one instance).
                outputChannelData[ch][s] += out;
                peakSample = std::max(peakSample, std::abs(out));
            }
            peak = std::max(peak, peakSample);
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
        e.s = absSample;
        e.t = playStartTick + static_cast<int64_t>(std::llround(static_cast<double>(absSample) / spt));
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

// ─── VST3 scan (Stage 3c-1) ─────────────────────────────────────────────────
// Default directories per the brief: %COMMONPROGRAMFILES%\VST3 and
// %APPDATA%\VST3 on Windows (the two standard per-machine / per-user VST3
// locations); the POSIX conventions elsewhere for dev/CI convenience.
std::vector<std::string> defaultVst3Dirs() {
    std::vector<std::string> dirs;
#ifdef _WIN32
    const char* cf = std::getenv("COMMONPROGRAMFILES");
    const char* ad = std::getenv("APPDATA");
    if (cf != nullptr) dirs.push_back(std::string(cf) + "\\VST3");
    if (ad != nullptr) dirs.push_back(std::string(ad) + "\\VST3");
#else
    dirs.push_back("/usr/lib/vst3");
    const char* home = std::getenv("HOME");
    if (home != nullptr) dirs.push_back(std::string(home) + "/.vst3");
#endif
    return dirs;
}

// Scan ONE path and print its plugin descriptions between markers.
// Runs as a CHILD process (scorch-engine --scan-worker <path>): a plugin whose
// module crashes or hangs during load kills only this child — the parent scan
// records the failure and continues. Deliberately NO catch(...): a crashing
// plugin must actually take this process down (that is the crash-isolation
// contract the CI test proves); graceful load failures return zero types.
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
                  << ",\"path\":\"" << escape_json(path) << "\"}\n";
    }
    std::cout << "SCORCH_SCAN_END" << std::endl;
    return 0;
}

// Out-of-process directory scan. Each *.vst3 entry (bundle dir or file) is
// scanned by a child copy of this exe with a hard 15s timeout; crashes and
// hangs become per-file "failed" entries — the engine and the scan survive.
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
    int pluginCount = 0, failedCount = 0;

    for (const auto& dir : dirs) {
        const juce::File dirFile(dir);
        if (!scannedJson.empty()) scannedJson += ",";
        if (!dirFile.isDirectory()) {
            scannedJson += std::string("{\"dir\":\"") + escape_json(dir) + "\",\"status\":\"missing\"}";
            continue;
        }
        scannedJson += std::string("{\"dir\":\"") + escape_json(dir) + "\",\"status\":\"scanned\"}";

        // Deterministic scan order — no RNG: collect top-level *.vst3 entries
        // (bundle dirs or files) and sort case-insensitively by path.
        juce::Array<juce::File> entries;
        dirFile.findChildFiles(entries, juce::File::findFilesAndDirectories, false, "*.vst3");
        std::vector<std::string> paths;
        paths.reserve(static_cast<size_t>(entries.size()));
        for (const auto& entry : entries) paths.push_back(entry.getFullPathName().toStdString());
        std::sort(paths.begin(), paths.end(), [](const std::string& a, const std::string& b) {
            const auto n = std::min(a.size(), b.size());
            for (size_t i = 0; i < n; ++i) {
                const int ca = std::tolower(static_cast<unsigned char>(a[i]));
                const int cb = std::tolower(static_cast<unsigned char>(b[i]));
                if (ca != cb) return ca < cb;
            }
            return a.size() < b.size();
        });

        for (const auto& path : paths) {
            juce::ChildProcess child;
            if (!child.start(juce::StringArray{ exePath, "--scan-worker", juce::String(path) })) {
                if (!failedJson.empty()) failedJson += ",";
                failedJson += std::string("{\"path\":\"") + escape_json(path) + "\",\"error\":\"scanner child failed to start\"}";
                ++failedCount;
                continue;
            }
            if (!child.waitForProcessToFinish(15000)) {
                child.kill();
                if (!failedJson.empty()) failedJson += ",";
                failedJson += std::string("{\"path\":\"") + escape_json(path) + "\",\"error\":\"scanner timeout after 15s\"}";
                ++failedCount;
                continue;
            }
            const int exitCode = child.getExitCode();
            const std::string out = child.readAllProcessOutput().toStdString();
            if (exitCode != 0) {
                if (!failedJson.empty()) failedJson += ",";
                failedJson += std::string("{\"path\":\"") + escape_json(path) + "\",\"error\":\"scanner worker crashed (exit " + std::to_string(exitCode) + ")\"}";
                ++failedCount;
                continue;
            }
            const std::string begin = "SCORCH_SCAN_BEGIN";
            const std::string end = "SCORCH_SCAN_END";
            const auto b = out.find(begin);
            const auto e = out.find(end);
            if (b == std::string::npos || e == std::string::npos || e < b) {
                if (!failedJson.empty()) failedJson += ",";
                // Exit 0 but NO markers = the worker died mid-scan (SIGABRT /
                // hard kill before printing — JUCE reports signal death as
                // exit 0 on POSIX). Windows abort() surfaces as a real exit
                // code above; here we still classify it as a crash.
                failedJson += std::string("{\"path\":\"") + escape_json(path) + "\",\"error\":\"scanner produced no result (worker crashed or was killed)\"}";
                ++failedCount;
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
                if (!pluginsJson.empty()) pluginsJson += ",";
                pluginsJson += line;
                ++pluginCount;
            }
        }
    }

    std::cout << "[engine] scan: " << pluginCount << " plugin(s), " << failedCount
              << " failed, dirs=" << dirs.size() << std::endl;
    ws.send(std::string("{\"type\":\"scan_result\",\"plugins\":[") + pluginsJson +
            "],\"failed\":[" + failedJson + "],\"scannedDirs\":[" + scannedJson + "]}");
}

// ─── Message handlers ───────────────────────────────────────────────────────
// Protocol v1 EXTENSION (additive, Stage 3b polish + 3c-1 scan + 3c-2 hosting):
//   transport play MAY carry "tick": <n>. Without it, play RESUMES from the
//   engine's lastTick (position at stop) — it never auto-resets to 0.
//   transport stop is PANIC: all voices die immediately (hosted plugin gets
//   a CC120 All-Sound-Off flush on all 16 channels).

// Host a VST3 by id/path (Stage 3c-2; 3d-4: one INSTANCE of possibly many —
// identity = the frontend's libraryGroup id, "hosted" for the legacy field).
// Returns "" on success, else a human-readable detail.
std::string loadHostedPlugin(const juce::var& pluginVar, const std::string& instanceId,
                             std::unique_ptr<HostedPlugin>& out) {
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
        const juce::PluginDescription* chosen = nullptr;
        if (!uid.empty()) {
            const long long wantUid = std::atoll(uid.c_str());
            for (const auto* t : types) {
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
        // Activate the stereo output bus into the graph (nominal rate/size;
        // audioDeviceAboutToStart re-prepares for the REAL device).
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
        inst->prepareToPlay(44100.0, 512);
        inst->setNonRealtime(false);
        auto hosted = std::make_unique<HostedPlugin>();
        hosted->instance = std::move(inst);
        hosted->name = chosen->name.toStdString();
        hosted->vendor = chosen->manufacturerName.toStdString();
        hosted->latencySamples = hosted->instance->getLatencySamples();
        hosted->uid = uid;
        hosted->path = path;
        hosted->instanceId = instanceId;
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
                     const std::string& channelsJson, const std::string& instanceId = "") {
    std::string msg = std::string("{\"type\":\"plugin_state\",\"state\":\"") + state + "\"";
    if (!instanceId.empty()) msg += ",\"instanceId\":\"" + escape_json(instanceId) + "\"";
    if (!name.empty()) msg += ",\"name\":\"" + escape_json(name) + "\"";
    if (!vendor.empty()) msg += ",\"vendor\":\"" + escape_json(vendor) + "\"";
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
    struct ReqInstance { std::string instanceId; int slot = 0; juce::var pluginVar; std::string stateB64; };
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
    if (metaVar.getDynamicObject()) {
        bpm = metaVar.getDynamicObject()->getProperty("bpm");
        ppqn = metaVar.getDynamicObject()->getProperty("ppqn");
        endTick = static_cast<int64_t>(static_cast<double>(metaVar.getDynamicObject()->getProperty("endTick")));
    }
    // Stage 3c-hotfix: non-finite / non-positive tempo degenerates
    // samplesPerTick() (inf / zero) — events would load but NEVER dispatch:
    // the other silent-empty-score path. Same treatment: hard fail, name it.
    if (!std::isfinite(bpm) || bpm <= 0.0) loadFail = loadFail.empty() ? "meta.bpm is not finite/positive" : loadFail;
    if (ppqn <= 0) loadFail = loadFail.empty() ? "meta.ppqn is not positive" : loadFail;

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
        ScoreSnapshot* old = g_score.exchange(snap, std::memory_order_acq_rel);
        if (old) {
            std::lock_guard<std::mutex> rlock(g_retireMutex);
            g_retiredScores.push_back({old, std::chrono::steady_clock::now()});
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
                                    chansJsonPerInst[r.instanceId], r.instanceId);
                    engineLog("[plugin] reuse while playing — no re-instantiate | seq " +
                              std::to_string(seq) + " instance=" + r.instanceId +
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
    ScoreSnapshot* old = g_score.exchange(snap, std::memory_order_acq_rel);
    if (old) {
        std::lock_guard<std::mutex> rlock(g_retireMutex);
        g_retiredScores.push_back({old, std::chrono::steady_clock::now()});
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
        g_engine.samplesProcessed.store(0);
        g_engine.playStartTick.store(startTick);
        g_engine.transportGen.fetch_add(1);  // invalidate pre-play buffer commits
        g_playPeakMax.store(0.0f, std::memory_order_relaxed);  // fresh session peak
        g_engine.playing.store(true);
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
        g_engine.samplesProcessed.store(0);
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
                  (wasPlaying ? " (rolling — musical release + resume re-attacks)" : " (stopped)"));
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
    juce::MessageManager::callAsync([iid, live] { openEditorWindow(iid, live); });
    engineLog("[editor] open requested instance=" + iid + " plugin=" + live->name);
}

// {"type":"closeEditor","instanceId"?} — idempotent (unknown id = no-op).
void handle_close_editor(const juce::var& json) {
    juce::DynamicObject* obj = json.getDynamicObject();
    std::string iid = obj ? obj->getProperty("instanceId").toString().toStdString() : "";
    if (iid.empty()) iid = "hosted";
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
    // --scan-worker mode (Stage 3c-1): scan ONE .vst3 path, print JSON between
    // markers, exit. Spawned by handle_scan() for crash isolation — never used
    // by the app itself.
    for (int i = 1; i < argc; ++i) {
        if (std::string(argv[i]) == "--scan-worker" && i + 1 < argc) {
            return runScanWorker(argv[i + 1]);
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
        // Blocks until main() calls stopDispatchLoop() at shutdown. The loop
        // is event-driven (no polling, no keep-alive): it wakes for every
        // posted JUCE message and sleeps otherwise.
        juce::MessageManager::getInstance()->runDispatchLoop();
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
                } else if (type == "mix") {
                    handle_mix(parsed);
                } else if (type == "dispatch_log") {
                    handle_dispatch_log(parsed, ws);
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
            // Stage 3c-polish (D2): retire aged publications FIRST — the
            // grace period guarantees any in-flight audio buffer holding the
            // old pointer finished long ago (250ms >> 23ms worst buffer).
            // Never freed on the audio thread; deliberately NOT drained at
            // exit (process exit reclaims — the 3c teardown policy).
            {
                const auto now = std::chrono::steady_clock::now();
                std::lock_guard<std::mutex> rlock(g_retireMutex);
                auto aged = [&now](const auto& p) {
                    return std::chrono::duration_cast<std::chrono::milliseconds>(now - p.second).count() >= 250;
                };
                for (auto it = g_retiredScores.begin(); it != g_retiredScores.end();) {
                    if (aged(*it)) { delete it->first; it = g_retiredScores.erase(it); }
                    else ++it;
                }
                for (auto it = g_retiredPlugins.begin(); it != g_retiredPlugins.end();) {
                    if (aged(*it)) {
                        if (it->first->instance) it->first->instance->releaseResources();
                        delete it->first;
                        it = g_retiredPlugins.erase(it);
                    } else ++it;
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
            };
            std::vector<EntryOutcome> outcomes(req.entries.size());
            bool superseded = false;
            for (size_t i = 0; i < req.entries.size(); ++i) {
                const PluginInitEntry& e = req.entries[i];
                const auto te0 = std::chrono::steady_clock::now();
                std::unique_ptr<HostedPlugin> h;
                const std::string hostErr = loadHostedPlugin(e.pluginVar, e.instanceId, h);
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
                    h->instance->setPlayConfigDetails(0, 2, devRate, devBuf);
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
            // ─── Publish the new SET (Stage 3d-4) ───
            // Successful entries take their parse-assigned slots; a requested
            // id whose instantiate FAILED RETAINS its previous instance (moved
            // into the new set at the requested slot — slots always mirror the
            // request, so the just-published routing table stays truthful);
            // ids absent from the request retire (the group vanished from the
            // project). Replaced/retired instances: editors close BEFORE the
            // swap, state captured after (alive in the 250ms retire grace).
            auto nextSet = std::make_shared<InstanceSet>();
            std::unordered_map<std::string, size_t> entryIdxById;
            for (size_t i = 0; i < req.entries.size(); ++i)
                entryIdxById[req.entries[i].instanceId] = i;
            int maxLat = 0;
            for (size_t i = 0; i < req.entries.size(); ++i) {
                if (!outcomes[i].hosted) continue;
                HostedPlugin* raw = outcomes[i].hosted.release();   // the set owns it from here
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
                    if (outcomes[eit->second].hosted == nullptr) {
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
            // Stage 3d-1: the outgoing instances' editors must not outlive
            // them — close by id BEFORE the swap (scheduled on the pump thread,
            // well inside the retire grace; the audio callback never touches
            // editors).
            for (HostedPlugin* old : retiredNow) closeEditorAsync(old->instanceId);
            g_instances.store(std::move(nextSet), std::memory_order_acq_rel);
            // Stage 3d-3: capture the OUTGOING instances' states (the user's
            // patches — a reload must not lose them). Alive in the retire grace.
            for (HostedPlugin* old : retiredNow) {
                if (old->instance) captureAndBroadcastState(*old, "replace");
                std::lock_guard<std::mutex> rlock(g_retireMutex);
                g_retiredPlugins.push_back({old, std::chrono::steady_clock::now()});
            }
            // Per-instance loaded receipts (log + plugin_state, additive
            // instanceId field). Retained-on-failure instances re-report too —
            // the frontend's editor gate keys on plugin_state per instance.
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
                    "\",\"latencyMs\":" + latBuf + ",\"channels\":[" + e.channelsJson + "]}";
                for (auto& client : server.getClients())
                    if (client) client->send(ps);
            }
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
