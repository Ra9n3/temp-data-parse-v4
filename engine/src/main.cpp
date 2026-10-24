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
// M3 PR1 protocol additions (additive; protocol stays 1):
//   load plugins[] entries gain optional "multiTimbral":true — the instance
//         accepts multiple tracks on distinct MIDI channels (the routing
//         validator's per-instance channel-collision guard becomes
//         conditional on it; absent = false = the M2 single-timbral rule).
//   {"type":"routing","routes":{"<trackId>":{"inst":"<instanceId>","ch":1..16},…}}
//         — the RUNTIME routing table (frontend-owned; the engine executes it
//         statelessly and applies it ATOMICALLY). R1 ATOMIC-OR-NOTHING: the
//         whole table validates against the loaded score's track table and
//         the PUBLISHED instance set before ANYTHING applies; one failure →
//         ONE receipt "route rejected: reason=…" and zero mutation. A valid
//         table REPLACES the whole mapping (full-table semantics: tracks
//         absent from it become unmapped; under the now-EXPLICIT table their
//         events DROP with the named receipt "track N unmapped, M notes
//         dropped" — never the synth fallback). Applies mid-play with no gap:
//         score snapshot (events re-channelled) + RoutingTable publish
//         back-to-back, abandoned wide channels CC120-flushed (no stuck
//         notes). Multi-timbral instances receive their tracks' channels;
//         single-timbral instances are refused >1 distinct channel. The
//         engine never sets programs — patch assignment stays in the UI.
//   server -> client: {"type":"routing_result","applied":bool,"v":<mapping
//         version>,"tracks":<K>|"reason":"…"} — v advances by EXACTLY ONE
//         per applied table and is UNCHANGED by a rejection (CI's atomicity
//         witness). Receipts: "route applied: track=N -> instance=X ch=Y",
//         "route applied: mapping v=N tracks=K".
//
// M3 PR2 protocol additions (additive; protocol version stays 1):
//   {"type":"strips","wires":[{"strip":"<stripId>","inst":"<instanceId>",
//         "pair":[a,a+1]},…]} — the AUDIO-domain wiring table (D1/D2: the
//         frontend owns it; the engine executes it statelessly and applies
//         it ATOMICALLY on the message thread). R1 ATOMIC-OR-NOTHING: the
//         whole table validates (unique strip ids, bus-aligned pairs within
//         each instance's live output channels, one strip per pair, ≤16
//         strips) before ANYTHING applies; one failure → ONE receipt
//         "[strip] rejected: reason=" and zero mutation. Full-table
//         semantics: strips of instances absent from the message are
//         unwired (named receipts); every output channel of a mentioned
//         instance is accounted (wired pair → strip, unwired channel →
//         named receipt, its default main→master wiring removed). Graph
//         shape: plugin node → StripMixerProcessor → output node; strips
//         sum at the output node. Lifecycle: a source-instance unload tears
//         its ACTIVE strips down (named receipts, R2/R4 flush semantics)
//         but the table entries SURVIVE inactive — a later load of the same
//         instanceId rewires + reactivates them (reload continuity, gains
//         restored). The R3 LAYOUT-CHANGE GUARD runs at every commit: a
//         table pair the live node can no longer feed is unwired with named
//         receipts + the stripLayoutChanged push — never a silent dead wire.
//   server -> client: {"type":"strips_result","applied":bool,"v":<strip
//         version>,"strips":<K>|"reason":"…"} — the routing_result
//         arithmetic (v +EXACTLY ONE per apply, unchanged on reject).
//         Receipts: "[strip] applied: v=N strips=K unwired=M tornDown=L",
//         "[strip] wired: …", "[strip] teardown: …", "[strip] layout
//         guard: …", "[strip] teardown flush: slot=S instance=X held=H
//         wiped" (R4).
//   {"type":"mix", … additive strip fields: "stripGains":{"s":0.0..4.0},
//         "stripMutes":[…],"stripSolos":[…]} — wired strips are AUDIO-domain
//         (mute = ramped gain-0; solo = SOLO-IN-PLACE, effective gains
//         recomputed + published per message through the ~10 ms ramp).
//         Receipts: "[strip] mix: solos=[…] mutes=[…] gains={…} ->
//         effective: …". The per-TRACK dispatch gate is unchanged.
//   {"type":"layoutAll"} — probe: every published instance's output layout.
//   server -> client: {"type":"layouts","instances":[{instanceId,buses,
//         channels,busChannels:[…]}]} and the pushes {"type":
//         "instanceLayout",…} (per commit), {"type":"stripLayoutChanged",
//         instanceId,liveChannels,unwired:[…],reason:"layout"} (R3 guard).
//         Engine receipts: "[layout] instance=X: B buses, C output channels".
//   SCORCH_STRIP_LOG=1 (engine env) — per-strip audio stats receipts
//         ("[strip] stats: strip=S pre=P post=Q blocks=N", 1 Hz drain;
//         prePeak = content truth, postPeak = delivery truth).
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
//
// 0.9.2 protocol additions (additive) — editor reopen + init-queue terminal
// receipts (field log 0.9.1, gate run 1):
//   load: OPTIONAL "openEditor":true — the editor intent rides the load.
//         Reuse path: the editor opens for the already-live instance EVEN
//         when the load answers "plugin set reused" (the field gap: no path
//         opened the editor of an already-live instance). Async path: the
//         editor opens at publish, after the loaded receipts. Receipts are
//         the standard editor family ([editor] open requested / opened /
//         closed instance=, plus the >10s pending watchdog).
//   TERMINAL RECEIPT INVARIANT (engine.log): every queued init (per seq)
//         ends with EXACTLY ONE of
//             "[plugin] loaded ..."                      (success, per entry)
//             "[plugin] init failed: seq= reason="       (failure or watchdog-declared jam)
//             "[plugin] init superseded: seq= by="       (replaced / coalesced)
//         — no silent drops, ever, including at shutdown ("reason=engine-
//         shutdown") and for a request overwritten while still queued.
//   INIT HEARTBEAT (engine.log): every stage of a running init emits
//         "[plugin] init stage=<instantiate|state-restore|prepare|commit|
//         publish|state-capture> instance= seq="; a request pending or
//         queued >10s warns every 10 s ("init pending >10s" / "init queued
//         >10s", with phase + elapsed + zero-movement age + the last
//         engine→plugin call breadcrumb — the D13 heartbeat); a request
//         still without its terminal receipt after
//         SCORCH_INIT_TERMINAL_TIMEOUT_MS (default 120000 ms — the 0.14.0
//         FLAT wall clock, restored by D13 after dump 211647) is DECLARED
//         failed by the watchdog ("reason=terminal-timeout" for the stuck
//         worker's request, "reason=queued-behind-jammed-init" for the ones
//         queued behind it) with a wire plugin_state error twin, a
//         STALL-BUNDLE diagnostic line, and an ALL-THREAD diagnostic dump
//         (init-stall-*.dmp — the worker's REAL stack names the wedge).
//         The declaration is log-only — the wedged thread is never touched.
//   COALESCING: a load whose plugin set (instanceId+uid+path per entry)
//         matches a queued/in-flight init FOLDS into it ("init superseded:
//         seq=NEW by=INFLIGHT (coalesced ...)") instead of answering
//         "reused" while an older init is still outstanding; the in-flight
//         init's per-instance receipts serve both requests.
//   LAZY-DEVICE RACE: the init worker never waits for the audio device —
//         each init logs which pre-prepare path it took ("init device=ready
//         rate=... " or "init device=not-started ... NOMINAL 44100/512
//         fallback"), and a device that starts between the pre-prepare and
//         the commit triggers the worker-side "re-prepared (worker,
//         device-ready race)" so the graph's message-thread prepare stays a
//         cheap same-settings re-prepare.
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

// ─── Milestone 1: the hosting path is the vendored AudioPluginHost core ────
// The hand-rolled hosting machinery is REPLACED by the vendor's: plugins live
// as nodes of a juce::AudioProcessorGraph (engine/src/host/AudioHostCore.h —
// the ported core of extras/AudioPluginHost). The graph owns the plugin
// instance from addNode() on; add/remove happen on the message thread; the
// vendor's RenderSequenceExchange frees a retired instance only after the
// audio thread provably swapped to the new sequence (the retire-list + grace
// timer + audio-proof janitor are gone — same guarantee, maintained by JUCE).
// The audio callback keeps the WHOLE event engine (score dispatch, wide
// channels, articulations, mute flush, the 3k pre-roll) and renders THE
// GRAPH instead of walking instance slots.
// Kept unchanged: the WS protocol and every message shape; the engine.log
// receipt discipline (every phase named — new receipts named below);
// --null-audio / --no-audio; the testvst fixtures; the scan/probe machinery.
// Deferred (later milestones — named, not silent): multi-instance routing
// (a plugins[] array with >1 entry is a protocol-shaped error → test-synth
// fallback), per-bus output routing (aux buses stay unconnected), the output
// gain/safety stage (--plugin-gain accepted, inert, receipt-named), new
// pre-roll work (the shipped 3k pre-roll is dispatch-layer and untouched).
// New explicit semantic (protocol-compatible): {"plugins": []} — an empty
// ARRAY, not an absent field — unloads the live plugin (state captured
// first). An ABSENT plugins field remains a score-only load that leaves the
// plugin resident (the source-switch protection).
// Engine version 0.9.0 → 0.9.1; protocol stays 1. 0.9.1 = the heavy-load
// hotfix (worker-side prepare/capture, guarded MM commit, crash forensics).
// NOTE for ghost-chasers: the host-core-v1 TAG already said 0.9.0 — a binary
// reporting 0.8.7 is a STALE ARTIFACT (built at downbeat-preroll-v1), not a
// host-core build.

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
#include <functional>
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

// Milestone 1: the vendored AudioPluginHost core (graph/filter model, node
// ownership, editor discipline). Same JUCE 8 dual licence as the framework.
#include "host/AudioHostCore.h"

// Milestone 2: the selector source table — the STABLE addresses of the audio
// callback's per-slot MidiBuffers. main() fills it ONCE via the callback's
// binder; the selectors read it inside graph->processBlock (the same audio
// thread as the fill, so the hand-off ordering is the callback's own).
std::atomic<juce::MidiBuffer*> scorchhost::g_selectorMidiSource[scorchhost::kMaxInstances] = {};
std::atomic<uint64_t> scorchhost::g_selectorEmitCount[scorchhost::kMaxInstances] = {};
std::atomic<int> scorchhost::g_selectorLastD1[scorchhost::kMaxInstances] = {};
std::atomic<uint64_t> scorchhost::g_selectorBlockCount[scorchhost::kMaxInstances] = {};

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketServer.h>

// ─── M1-hotfix (heavy-load death): CRASH FORENSICS ───────────────────────
// The 2026-10-18 defect: first heavy load (Falcon) → [mm] unresponsive 5–7 s
// → process death → the shell respawned within its 2 s poll. Death mode was
// UNNAVIGABLE: the shell spawns with stderr → null and no dump is captured
// anywhere, and the engine's watchdogs are log-only by design (forensics,
// not an executioner) — nothing in the engine, shell or frontend kills a
// live process, so the death is a CRASH; but WHICH crash (an escaping
// exception in the commit job, an AV inside plugin cold-init, an allocation
// failure) was unknowable post-mortem. This block makes the next occurrence
// NAME ITSELF:
//   "[crash] kind=... code=... addr=... thread=... dump=<path>"
// appended DIRECTLY to engine-crash.log BESIDE engine.log (%APPDATA%/scorch/
// — the same directory the receipts live in; raw stdio append, NOT
// engineLog(): the crashing thread may already hold the log mutex), plus a
// minidump in %APPDATA%/scorch/crashes/ via MiniDumpWriteDump (dbghelp
// loaded dynamically — no new link surface). Windows-only glue; other
// platforms keep default termination. An atomic guard keeps
// abort→SIGABRT→terminate cascades from logging twice. NO handler returns
// into normal execution: after the receipt, default termination proceeds.
#ifdef _WIN32
#include <csignal>
#include <shlobj.h>
#include <dbghelp.h>
#include <tlhelp32.h>   // TASK I module-guard: TH32CS_SNAPTHREAD (message-only windows live per-thread)
#pragma comment(lib, "shell32.lib")
#pragma comment(lib, "advapi32.lib")   // D14b: WER LocalDumps arming (RegCreateKeyExA)

namespace scorchcrash {
std::atomic<bool> g_crashHandled{false};

// <APPDATA>/scorch — the engine.log directory (JUCE userApplicationDataDirectory
// on Windows is %APPDATA%, Roaming). Falls back to a CWD-relative name when
// the shell-folder call fails (a crash handler must never give up entirely).
bool crashLogDir(char* out, size_t outLen) {
    char base[MAX_PATH];
    if (FAILED(SHGetFolderPathA(nullptr, CSIDL_APPDATA, nullptr, 0, base)))
        return false;
    const int n = std::snprintf(out, outLen, "%s\\scorch", base);
    return n > 0 && static_cast<size_t>(n) < outLen;
}

// Raw append — plain stdio so the handler never depends on JUCE, the log
// mutex, or an allocation that could itself be the crash site.
void rawReceipt(const char* kind, unsigned long code, const void* addr,
                const char* dumpPath) {
    char dir[MAX_PATH];
    char path[MAX_PATH];
    if (!crashLogDir(dir, sizeof(dir)))
        std::snprintf(path, sizeof(path), "engine-crash.log");
    else
        std::snprintf(path, sizeof(path), "%s\\engine-crash.log", dir);
    char line[512];
    const std::time_t tt = std::time(nullptr);
    std::tm tm{};
    localtime_s(&tm, &tt);
    std::snprintf(line, sizeof(line), "[%04d-%02d-%02d %02d:%02d:%02d] [crash] kind=%s code=0x%08lx addr=%p thread=%lu dump=%s\n",
                  tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec,
                  kind, code, addr,
                  static_cast<unsigned long>(GetCurrentThreadId()),
                  dumpPath != nullptr ? dumpPath : "none");
    FILE* f = nullptr;
    if (fopen_s(&f, path, "a") == 0 && f != nullptr) {
        std::fputs(line, f);
        std::fclose(f);
    }
    // D14b (field 20:42): the receipt must survive the death — the stdout
    // buffer can be lost to an unflushed fastfail (the pipe is fully
    // buffered), so the line is MIRRORED to stderr, which is unbuffered, and
    // every stream is flushed while the process is still alive.
    std::fputs(line, stderr);
    std::fflush(stderr);
    std::fflush(nullptr);
}

// Best-effort minidump in <APPDATA>/scorch/crashes/. `prefix` names the dump
// family: "scorch-engine" (crashes) vs "init-stall" (D13 watchdog captures).
void writeDump(EXCEPTION_POINTERS* ep, char* outPath, size_t outLen,
               const char* prefix = "scorch-engine") {
    outPath[0] = '\0';
    char dir[MAX_PATH];
    if (!crashLogDir(dir, sizeof(dir))) return;
    char crashDir[MAX_PATH];
    std::snprintf(crashDir, sizeof(crashDir), "%s\\crashes", dir);
    CreateDirectoryA(crashDir, nullptr);   // exists-ok
    const std::time_t tt = std::time(nullptr);
    std::tm tm{};
    localtime_s(&tm, &tt);
    std::snprintf(outPath, outLen, "%s\\%s-%04d%02d%02d-%02d%02d%02d.dmp",
                  crashDir, prefix, tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
                  tm.tm_hour, tm.tm_min, tm.tm_sec);
    HMODULE dh = LoadLibraryA("dbghelp.dll");
    if (dh == nullptr) { outPath[0] = '\0'; return; }
    using MiniDumpWriteDumpFn = BOOL(WINAPI*)(HANDLE, DWORD, HANDLE,
                                              MINIDUMP_TYPE, PMINIDUMP_EXCEPTION_INFORMATION,
                                              PMINIDUMP_USER_STREAM_INFORMATION,
                                              PMINIDUMP_CALLBACK_INFORMATION);
    auto writeDumpFn = reinterpret_cast<MiniDumpWriteDumpFn>(
        reinterpret_cast<void*>(GetProcAddress(dh, "MiniDumpWriteDump")));
    if (writeDumpFn == nullptr) { outPath[0] = '\0'; return; }
    HANDLE file = CreateFileA(outPath, GENERIC_WRITE, 0, nullptr,
                              CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) { outPath[0] = '\0'; return; }
    MINIDUMP_EXCEPTION_INFORMATION mei{};
    mei.ThreadId = GetCurrentThreadId();
    mei.ExceptionPointers = ep;
    mei.ClientPointers = FALSE;
    // TASK F (2026-10-21, run 39563546785 attempt 1 dump): verdict is a wild
    // WNDPROC call into an UNLOADED module (0xC0000005 EXECUTE at a mapped-out
    // hole; return address in user32 message dispatch; NOT a C++ exception).
    // MiniDumpWithUnloadedModules makes the NEXT dump LIST the unloaded DLL —
    // its name is the culprit; MiniDumpWithProcessThreadData carries the
    // per-thread state needed to tie the zombie window to its owning thread.
    // Diagnostic-only: these flags are read at dump-write time; no code path
    // changes (the one authorized engine-flag change of TASK F).
    writeDumpFn(GetCurrentProcess(), GetCurrentProcessId(), file,
                static_cast<MINIDUMP_TYPE>(MiniDumpNormal
                                           | MiniDumpWithUnloadedModules
                                           | MiniDumpWithProcessThreadData),
                ep != nullptr ? &mei : nullptr, nullptr, nullptr);
    CloseHandle(file);
}

// ─── D13 (dump 211647): the process must not survive its own crash dump ───
// The 0.14.0-era last-chance filter returned EXCEPTION_EXECUTE_HANDLER and
// relied on termination semantics; worse, ANY /EHa catch(...) frame between
// the fault and the filter swallows the AV BEFORE the filter ever runs — the
// engine could limp on past its own dump (or past no dump at all). D13: a
// FIRST-CHANCE vectored handler terminates the process deterministically on
// the fatal cohort, AFTER the dump + receipt. The ONE sanctioned exception is
// the M1 audio contract: ensureAudioReady()'s /EHa catch(...) converts a
// device-init AV into the clean no_audio_device protocol error (CI Test B
// depends on it) — that scope sets the thread-local flag below, and an AV on
// the probing thread inside that window passes through to the frame
// handlers exactly as before. Every other AV on every other thread: dump →
// receipt → TerminateProcess. Nothing catches TerminateProcess.
thread_local bool t_audioSehProbe = false;
struct AudioSehProbeScope {
    AudioSehProbeScope() { t_audioSehProbe = true; }
    ~AudioSehProbeScope() { t_audioSehProbe = false; }
    AudioSehProbeScope(const AudioSehProbeScope&) = delete;
    AudioSehProbeScope& operator=(const AudioSehProbeScope&) = delete;
};

LONG NTAPI vehFilter(PEXCEPTION_POINTERS ep) {
    if (ep == nullptr || ep->ExceptionRecord == nullptr) return EXCEPTION_CONTINUE_SEARCH;
    const unsigned long code = ep->ExceptionRecord->ExceptionCode;
    const bool fatal = code == EXCEPTION_ACCESS_VIOLATION          // 0xC0000005
                    || code == 0xC0000409ul                        // fail-fast
                    || code == EXCEPTION_ILLEGAL_INSTRUCTION        // 0xC000001D
                    || code == EXCEPTION_STACK_OVERFLOW;            // 0xC00000FD
    if (!fatal) return EXCEPTION_CONTINUE_SEARCH;
    if (t_audioSehProbe) return EXCEPTION_CONTINUE_SEARCH;   // M1 audio contract (thread-local: only the probing thread's own AV passes)
    if (g_crashHandled.exchange(true) == false) {
        char dump[MAX_PATH];
        writeDump(ep, dump, sizeof(dump));
        rawReceipt("veh-fatal", code, ep->ExceptionRecord->ExceptionAddress, dump);
        std::fflush(nullptr);
    }
    // Even if a prior handler already receipted this process, a NEW fatal AV
    // still ends here: the process never survives its own crash dump.
    TerminateProcess(GetCurrentProcess(), code);
    return EXCEPTION_CONTINUE_SEARCH;   // unreachable
}

LONG WINAPI sehFilter(EXCEPTION_POINTERS* ep) {
    if (g_crashHandled.exchange(true) == false && ep != nullptr && ep->ExceptionRecord != nullptr) {
        char dump[MAX_PATH];
        writeDump(ep, dump, sizeof(dump));
        rawReceipt("seh", ep->ExceptionRecord->ExceptionCode,
                   ep->ExceptionRecord->ExceptionAddress, dump);
        std::fflush(nullptr);
    }
    // D13: deterministic death — no reliance on filter-return semantics.
    TerminateProcess(GetCurrentProcess(),
                     ep != nullptr && ep->ExceptionRecord != nullptr
                         ? ep->ExceptionRecord->ExceptionCode
                         : EXCEPTION_ACCESS_VIOLATION);
    return EXCEPTION_EXECUTE_HANDLER;   // unreachable
}

void signalReceipt(int sig) {
    if (g_crashHandled.exchange(true) == false) {
        char dump[MAX_PATH];
        writeDump(nullptr, dump, sizeof(dump));
        rawReceipt("signal", static_cast<unsigned long>(sig), nullptr, dump);
    }
    std::fflush(nullptr);
    // Restore default and re-raise so the process still terminates the
    // normal way with the normal exit code.
    std::signal(sig, SIG_DFL);
    std::raise(sig);
}

[[noreturn]] void terminateReceipt() {
    if (g_crashHandled.exchange(true) == false) {
        char dump[MAX_PATH];
        writeDump(nullptr, dump, sizeof(dump));
        rawReceipt("terminate", 0, nullptr, dump);
    }
    std::fflush(nullptr);
    // D14b (field 20:42): NO CRT cascade past the receipt. std::abort()
    // re-enters the signal machinery and rides the UCRT fastfail path — a
    // window where a second fault could land BEFORE the receipt was visible
    // anywhere (the 20:42 shape: exit 0xC0000409, no receipt survived).
    // TerminateProcess is atomic: the receipt + dump above are already on
    // disk, the exit code is the same 0xC0000409 the CRT would have raised.
    TerminateProcess(GetCurrentProcess(), 0xC0000409ul);
    std::abort();   // unreachable
}

void invalidParameterHandler(const wchar_t*, const wchar_t*, const wchar_t*,
                             unsigned int, uintptr_t) {
    if (g_crashHandled.exchange(true) == false)
        rawReceipt("invalid-parameter", 0, nullptr, nullptr);
    std::fflush(nullptr);   // the receipt is on disk before the fastfail
    // CRT invalid-parameter errors normally fast-fail — let them.
}

void purecallReceipt() {
    if (g_crashHandled.exchange(true) == false)
        rawReceipt("purecall", 0, nullptr, nullptr);
    std::fflush(nullptr);
    std::abort();
}

// ─── D14b (field 20:42 silent fail-fast): arm WER LocalDumps for THIS exe ───
// The 20:42 run died with exit code 0xC0000409 and NOTHING else — the int-29h
// failfast cohort (GS-cookie, heap corruption, RaiseFailFastException) bypasses
// every in-process handler BY DESIGN: no VEH, no SEH, no terminate handler, no
// in-process MiniDumpWriteDump. Windows Error Reporting is OUT-of-process and
// DOES see it. LocalDumps (HKCU, no admin) makes WER write a FULL dump for any
// future failfast, next to the engine's own crash artifacts. Best-effort: any
// failure is silent here and the receipt below names the outcome.
char g_werDumpFolder[MAX_PATH] = {0};
bool g_werArmed = false;

void armWerLocalDumps() {
    g_werDumpFolder[0] = '\0';
    if (!crashLogDir(g_werDumpFolder, sizeof(g_werDumpFolder))) return;
    char werDir[MAX_PATH];
    std::snprintf(werDir, sizeof(werDir), "%s\\crashes-wer", g_werDumpFolder);
    CreateDirectoryA(werDir, nullptr);   // exists-ok
    char sub[MAX_PATH];
    std::snprintf(sub, sizeof(sub),
                  "SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\%s",
                  "scorch-engine.exe");
    HKEY k = nullptr;
    if (RegCreateKeyExA(HKEY_CURRENT_USER, sub, 0, nullptr,
                        REG_OPTION_NON_VOLATILE, KEY_SET_VALUE, nullptr,
                        &k, nullptr) != ERROR_SUCCESS)
        return;
    const DWORD dumpType = 2;      // MiniDumpFull
    const DWORD dumpCount = 10;
    RegSetValueExA(k, "DumpFolder", 0, REG_SZ,
                   reinterpret_cast<const BYTE*>(werDir),
                   static_cast<DWORD>(std::strlen(werDir) + 1));
    RegSetValueExA(k, "DumpType", 0, REG_DWORD,
                   reinterpret_cast<const BYTE*>(&dumpType), sizeof(dumpType));
    RegSetValueExA(k, "DumpCount", 0, REG_DWORD,
                   reinterpret_cast<const BYTE*>(&dumpCount), sizeof(dumpCount));
    RegCloseKey(k);
    std::snprintf(g_werDumpFolder, sizeof(g_werDumpFolder), "%s", werDir);
    g_werArmed = true;
}

void install() {
    // D13: FIRST-CHANCE — the fatal cohort never reaches a frame handler that
    // could swallow it (except the sanctioned audio-probe scope).
    AddVectoredExceptionHandler(1 /* call first */, vehFilter);
    SetUnhandledExceptionFilter(sehFilter);
    std::signal(SIGABRT, signalReceipt);
    std::signal(SIGSEGV, signalReceipt);
    std::signal(SIGFPE, signalReceipt);
    std::signal(SIGILL, signalReceipt);
    std::set_terminate(terminateReceipt);
    _set_invalid_parameter_handler(invalidParameterHandler);
    _set_purecall_handler(purecallReceipt);
    armWerLocalDumps();   // D14b: the silent failfast cohort dumps out-of-process
}
} // namespace scorchcrash
#endif // _WIN32

namespace {

// 0.9.2 — editor reopen + init-queue terminal receipts (field log 0.9.1, gate
// run 1): every queued init ends with exactly one terminal receipt (loaded /
// init failed: seq= reason= / init superseded: seq= by=); the init worker
// speaks stage receipts + >10s pending warnings; openEditor works on any live
// instance including after "plugin set reused" (and a load may carry
// "openEditor":true); the lazy-device window is receipted (nominal fallback +
// device-ready race re-prepare); matching requests coalesce into an in-flight
// init instead of answering "reused" while it is still outstanding.
// D12 receipt-provenance: the exact commit this binary was built at. CMake
// pins SCORCH_ENGINE_COMMIT from `git rev-parse` at configure time (with a
// "-dirty" suffix on a dirty tree; "unknown" on a non-git configure); a
// non-CMake dev build falls back to the literal below. It is carried in the
// --version output, the hello payload, and the [engine] start receipt so
// every bench/receipt record names the build that produced it. Metadata only:
// behavior is versioned by kEngineVersion alone — the commit never gates
// anything and is never compared by CI.
#ifndef SCORCH_ENGINE_COMMIT
#define SCORCH_ENGINE_COMMIT "dev-unpinned"
#endif

constexpr const char* kEngineVersion = "0.14.5";   // D14b (field run 2026-10-23 20:42 adjudication): the silent fail-fast closed — the 0.14.4 field run died with exit code 0xC0000409 (STATUS_STACK_BUFFER_OVERRUN — the abort()/fail-fast family) during the FIRST leg's async plugin init (falcon queued, seq 31; the stdout tail ends at 'plugin init queued'), leaving NO dump, NO [crash] line, and NO exit receipt — the crash machinery's every path (veh-fatal / seh / terminate / signal / invalid-parameter / purecall) writes a receipt first, so the silent shape is the un-interceptable cohort (a C++ throwable that escaped to std::terminate whose receipt window raced the death, or the memory-corruption fastfail cohort: GS-cookie / heap-corruption / RaiseFailFastException — int 29h, invisible to VEH/SEH/terminate BY DESIGN). THE FIXES. (1) THE THREADS CAN NO LONGER DIE SILENTLY: every engine-owned thread body (WS dispatch per-message, handle_load, the init worker's init segment, the MM pump, the MM heartbeat, the state broadcaster, the watchdog, the scan probe) runs under a catch-all — a C++ throwable is now a NAMED receipt ([ws] handler exception / [plugin] init worker exception ... reason=<what>) + the standard init-failed terminal + a protocol error reply, never an unobserved std::terminate (the D13 VEH-first policy is untouched: the fatal SEH cohort still terminates BEFORE any frame handler, /EHa catch(...) still cannot swallow it — the M1 audio-probe carve-out unchanged). (2) THE RECEIPTS SURVIVE THE DEATH: rawReceipt now mirrors the [crash] line to STDERR (unbuffered — survives the stdout buffer loss that hid the receipt from the bench transcript) and fflushes every stream after each receipt; terminateReceipt no longer re-enters the CRT (abort → SIGABRT → the fastfail cascade raced the receipt at 20:42) — it TerminateProcess(GetCurrentProcess(), 0xC0000409) directly, same exit code, atomic death after the receipt. (3) THE SILENT COHORT IS NOW DUMPABLE: every engine start arms WER LocalDumps for itself (HKCU\...\LocalDumps\scorch-engine.exe → DumpFolder=%APPDATA%\scorch\crashes-wer, DumpType=2 full, DumpCount=10, best-effort, receipted) — an int-29h failfast bypasses every in-process handler but NOT Windows Error Reporting, so the next GS-cookie/heap-corruption death produces a FULL dump out-of-process where the in-process MiniDumpWithUnloadedModules never could. (4) Harness/ps1 (separate commits in the same unit): the ps1 accepts the 0.14.4/0.14.5 builds with a per-version commit pin (SCORCH_FB_EXPECT_COMMIT → the mjs hello hard-assert), always surfaces the engine-crash.log lines ADDED during the run (the 20:42 receipt would have been hidden by the file-newness gate), pulls the Application event-log 1000/1001 rows for the run window (faulting module + offset — adjudicates a silent fastfail with zero user work), arms the same WER LocalDumps itself, and the empty-ExitCode shape (the 16:53 ps1 anomaly) is fallback-adjudicated: HasExited=True + no force-stop + the engine's own clean-exit receipt in engine.log = engine clean, ps1 anomaly NOTED, not RED. 0.14.4 was D14a (field run 2026-10-23 12:24): the post-receipt exit hang closed — _Exit ends in ExitProcess, which still walks DLL_PROCESS_DETACH for EVERY module still loaded at exit (loader lock); the D14 3-leg shape's first field run ended live on Falcon (field-falcon2 — the FIRST field run with Falcon loaded at exit) and the process stayed alive 29 s past its final 'clean exit 0' receipt, force-stopped. The exit is now TerminateProcess: detach-free, exit code 0 preserved, everything above the final receipt unchanged — no module's teardown behavior can wedge the process past its final receipt, by construction. 0.14.3 was D14 (field runs 190901 + the run-4 init-stall dump): the retire-capture wedge class is closed at BOTH sites without touching the D13 machinery. FIX A: an outgoing state capture (diff-remove/replace/unload (worker)) no longer runs unbounded on the init worker — it rides the plugin's own message thread (the MM pump thread) via SendMessageTimeout (SMTO_ABORTIFHUNG, 5 s hard ceiling) to the D14 MM capture window; on timeout/abort the capture is ABANDONED with the named receipt "[plugin] retire-capture abandoned (plugin MM wedged)" and the destroy→drain→unload continues (a lost autosave is acceptable; a wedged host is not). The ceiling is MANDATORY on every capture path, on-MM or direct: captureAndBroadcastState stamps a 5 s deadline around getStateInformation and the D14 monitor thread names any breach ("[plugin] capture abandoned (plugin MM wedged)"); a capture completing after its abandon is receipted and its result DISCARDED, never broadcast. Teardown bounds: every DestroyWindow step in the retire teardown stamps the same deadline; overruns are named abandon receipts — TASK J ordering (owner-thread destroy, drain) untouched, the bounds only observe. FIX B: discard-class retires skip capture ENTIRELY — the load request's additive "discardRetire":true (the field bench sends it on every leg) and the shutdown path both emit "[plugin] state capture SKIPPED (discard-class retire|engine shutting down)"; the bench path never depends on a plugin's message-thread health. OPTIONAL (non-gating) analysis, recorded in FIELD-BENCH.md: the wedged handler's async completion (BBCSO under play) needed the audio device cycle — Fix A's capture-on-MM + the open device processing through the retire is the sanctioned shape; a keep-device-open-on-silence policy stays parked. 0.14.2 was the D13 revert+diagnostics (field dump 211647: the 0.14.1 init rework is REVERTED to the 0.14.0 semantics that ran the Falcon leg clean twice — the watchdog is the FLAT wall clock again (SCORCH_INIT_TERMINAL_TIMEOUT_MS, default 120000; the 60 s zero-movement stall declared legitimately-slow single plugin calls — a GB-scale load inside ONE call has no phase transitions — and handed a healthy init to the abandon/discard machinery, whose half-wired plugin then met the message-thread pump: AV inside the LOADED Falcon's WNDPROC, init incomplete), and the MM state-capture gate is removed (state-capture is back to the exact 0.14.0 placement). KEPT from the rework: the shutdown abandonment (exit-path only — it never declares and never touches plugin state — bisect verdict: not in the dump-211647 chain) and all additive receipts (per-phase timings, breadcrumbs, heartbeats). NEW diagnostics (D13, mandatory): 10 s init heartbeats (phase + elapsed + zero-movement + last call), a full-process ALL-THREAD diagnostic dump at every watchdog declaration (the worker's REAL stack names the wedge — superseding the D12 no-suspend policy per directive), and dump-then-TERMINATE on any AV-class first-chance exception (the process must not survive its own crash dump; the M1 audio-probe AV contract keeps its thread-local carve-out). 0.14.1 was the D12 rework; 0.14.0 was the TASK J root fix
constexpr int kProtocolVersion = 1;
constexpr int kDefaultPort = 9377;
constexpr int kMaxVoices = 64;
// ─── Stage 3d-4: MULTI-INSTANCE HOSTING ────────────────────────────────
// The universal-hosting completion: each hosted plugin instance owns a
// private 16-channel MIDI namespace. Internal ("WIDE") channel = slot*16 + ch
// (slot 0..kMaxInstances-1, ch 1..16) — the ledger/articulation/mute-flush
// fabric is indexed by wide channel, so per-instance state can never cross
// instances. Slot 0's wide channels are numerically identical to the legacy
// 1..16 space, so every single-instance receipt/assertion is byte-stable.
// Plugins only ever SEE their own 1..16 (realChOfWide at MidiBuffer time).
// Milestone 2: kMaxInstances lives in host/AudioHostCore.h (host-core level
// config — the selectors and the per-slot buffers are keyed by it).
constexpr int kWideChannels = scorchhost::kMaxInstances * 16;   // 128
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
std::vector<RetiredScoreRef> g_retiredScores;

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

// ─── M3 PR1 — the runtime routing table (the standalone "routing" message) ──
// The mapping VERSION advances by EXACTLY ONE per APPLIED table; a rejected
// table (R1 atomic-or-nothing) never touches it — so CI asserts atomic swaps
// from the receipts alone ("route applied: mapping v=N tracks=K"; rejects
// echo the UNCHANGED v). The unmapped-drop counters are audio-thread-owned
// (relaxed increments inside the dispatch walk); the worker loop drains the
// DELTAS once per second into named receipts — the audio thread never logs.
constexpr size_t kMaxDropTrackSlots = 256;   // 1-based track slots counted for drops
std::atomic<uint64_t> g_routingVersion{0};
std::array<std::atomic<uint32_t>, kMaxDropTrackSlots> g_unmappedDrops{};

// ─── M3 PR2 — the strip mixer (per-{instanceId, outChannelPair} audio stage) ──
// D1 (reviewed + approved before any code): a per-strip StripMixerProcessor —
// engine GLUE (main.cpp, like InstanceMidiSelector — the vendored core stays
// byte-untouched and the graph's per-channel connection API is used as-is).
// One 2-in/2-out node per wired {instanceId, outChannelPair}; the graph wiring
// runs plugin node → strip node → output IO node, and multiple strips sum at
// the output node (the vendor's own destination-channel accumulation). The
// M2 unity guard is UNCHANGED in code: it measures the summed device buffer
// after graph->processBlock, which is now post-master (behind strip gains) —
// same semantics, new anchor (documented in ASSUMPTIONS).
//
// Param publication is the g_selectorMidiSource pattern: a FIXED array of
// atomics with stable process-lifetime addresses; the WS thread publishes the
// EFFECTIVE gain (mute/solo folded at publish — solo-in-place recomputed per
// mix message), the strip's audio block reads it once per block. The ramp is
// block-quantized: ramp parameters latch at block start, one lerp per sample
// (~10 ms), two multiplies per sample per channel — the D1 CPU budget.
constexpr int kMaxStrips = 16;
constexpr int kStripRampMs = 10;
// strip slot → effective target gain. Initialized to 1.0 (unity) before any
// thread starts; slots are leased to stripIds by the apply job and released
// at teardown (inactive strips hold no slot).
struct StripGainSlots {
    std::array<std::atomic<float>, kMaxStrips> a;
    StripGainSlots() { for (auto& v : a) v.store(1.0f, std::memory_order_relaxed); }
};
StripGainSlots g_stripTargetGain;
// Per-strip audio-thread stats (relaxed; worker-drained under
// SCORCH_STRIP_LOG=1 and reset per drain window — the g_unmappedDrops
// precedent: the audio thread never logs, the worker speaks the deltas).
struct StripStats {
    std::atomic<uint64_t> blocks { 0 };
    std::atomic<float> prePeak { 0.0f };    // max |in|  — content truth (alive even when muted)
    std::atomic<float> postPeak { 0.0f };   // max |out| — delivery truth (0 when muted/dead)
};
StripStats g_stripStats[kMaxStrips];
// Field-gate-2: the [stripmix] receipt's OWN per-strip window (in/out peaks +
// block count). Deliberately SEPARATE from g_stripStats: the [strip] stats
// drain (SCORCH_STRIP_LOG) exchanges ITS atomics every worker wake — a second
// consumer on the same atomics would steal peaks from it (and CI asserts those
// deltas verbatim). Two independent windows, zero interaction.
StripStats g_stripMixStats[kMaxStrips];
// The strip table (D2 ownership shape, same as RoutingTable): the frontend
// owns the wiring; the engine holds an immutable runtime snapshot published
// behind ONE atomic shared_ptr. An entry is the frontend's INTENT and
// outlives its source instance: a source unload tears the node down and
// marks the entry inactive (reason named) but KEEPS it — a later load of the
// same instanceId reactivates + rewires it (the reload-continuity contract;
// gains re-publish from the last mix state). Only a strips-table apply can
// remove entries (full-table semantics). v advances by EXACTLY ONE per
// APPLIED strips message, never on lifecycle events — CI's atomicity witness.
struct StripEntry {
    std::string stripId;
    std::string inst;
    int pair0 = -1;             // source channel a (bus-aligned even); a+1 = pair1
    int pair1 = -1;
    int slot = -1;              // strip-slot lease (-1 = released/inactive)
    bool active = false;        // node live in the graph + wired
    std::string reason;         // inactive reason ("source unloaded", "layout", ...)
};
struct StripSet {
    std::vector<StripEntry> strips;   // active first-stable order (apply order)
};
std::atomic<std::shared_ptr<const StripSet>> g_strips { std::make_shared<const StripSet>() };
std::atomic<uint64_t> g_stripVersion { 0 };
// The WS thread's last strip-mix intent (gains/mutes/solos) — the source of
// every effective-gain publish (per mix message, per strips apply, per
// reload-continuity rewire). Same discipline as g_lastMix (mutex, WS only).
struct LastStripMix {
    std::map<std::string, float> gains;      // stripId → gain (default 1.0)
    std::vector<std::string> mutes, solos;
};
std::mutex g_lastStripMixMutex;   // WS threads only — NEVER the audio thread
LastStripMix g_lastStripMix;      // guarded by g_lastStripMixMutex
// R4: the audio-side slot wipe (g_slotStateClearPending servicing) counts the
// abandoned held notes it clears — the worker speaks the named teardown-flush
// receipt (the CC120/all-sound-off semantics receipt; see the walk).
std::atomic<int> g_slotWipedHeldNotes[scorchhost::kMaxInstances] = {};
// R3: the strip layout guard's protocol push goes through the WS thread — the
// message-thread jobs set this flag with the payload; the worker drains ONE
// push per change (the audio thread never touches it).
std::mutex g_stripLayoutPushMutex;
struct StripLayoutPush { std::string instanceId; int liveChannels = -1; std::vector<std::string> unwired; bool pending = false; };
StripLayoutPush g_stripLayoutPush;   // guarded by g_stripLayoutPushMutex

// The strip node itself. 2-in/2-out ONLY: the input bus must stay STEREO
// (never disabled) because the plugin→strip connections address its input
// channels — a disabled input would invalidate them (and the device-walk's
// setPlayConfigDetails(0,2) probe must FAIL here, harmlessly, rather than
// silently disable the bus). Receipt-free by the glue-node convention; its
// per-block truth is the g_stripStats[slot] counters.
class StripMixerProcessor final : public juce::AudioProcessor
{
public:
    // Explicit stereo-in/stereo-out buses: the graph's addConnection
    // validates channel indices against the node's CURRENT layout, and the
    // vendor's builder never re-negotiates it after addNode — a bare default
    // constructor (no input bus) would make every plugin→strip connection
    // illegal forever. Declared here, the node is wireable the moment it
    // exists. (The local strips-mode run caught exactly this.)
    explicit StripMixerProcessor (int slotArg)
        : juce::AudioProcessor (juce::AudioProcessor::BusesProperties()
            .withInput ("In", juce::AudioChannelSet::stereo(), true)
            .withOutput ("Out", juce::AudioChannelSet::stereo(), true)),
          slot (slotArg) {}

    void prepareToPlay (double newSampleRate, int) override
    {
        sampleRate = newSampleRate > 0.0 ? newSampleRate : 44100.0;
        // A re-prepare must not glide from a stale ramp value: snap.
        rampPos = rampLen = 0;
        currentGain = g_stripTargetGain.a[(size_t) slot].load (std::memory_order_acquire);
    }
    void releaseResources() override {}

    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override
    {
        juce::ScopedNoDenormals noDenormals;
        midi.clear();   // strips are audio-only: no MIDI enters or leaves
        const int n = buffer.getNumSamples();
        const int chs = juce::jmin (2, buffer.getNumChannels());
        if (chs <= 0) return;

        // Block-quantized ramp latch: a target change starts a fresh ~10 ms
        // glide from the CURRENT interpolated value (no zipper, no jump).
        const float target = g_stripTargetGain.a[(size_t) slot].load (std::memory_order_acquire);
        if (rampLen == 0 || target != rampTo)
        {
            rampFrom = currentGain;
            rampTo = target;
            rampLen = juce::jmax (1, (int) (kStripRampMs * 0.001 * sampleRate));
            rampPos = 0;
        }

        float preMax = 0.0f, postMax = 0.0f;
        const float* inL = buffer.getReadPointer (0);
        const float* inR = chs > 1 ? buffer.getReadPointer (1) : inL;
        float* outL = buffer.getWritePointer (0);
        float* outR = chs > 1 ? buffer.getWritePointer (1) : outL;
        for (int s = 0; s < n; ++s)
        {
            float g;
            if (rampPos < rampLen)
                g = rampFrom + (rampTo - rampFrom) * ((float) rampPos / (float) rampLen);
            else
                g = rampTo;
            if (rampPos < rampLen) ++rampPos;
            currentGain = g;
            const float l = inL[s], r = inR[s];
            outL[s] = l * g;
            outR[s] = r * g;
            preMax = juce::jmax (preMax, juce::jmax (std::abs (l), std::abs (r)));
            postMax = juce::jmax (postMax, juce::jmax (std::abs (outL[s]), std::abs (outR[s])));
        }
        // One CAS-max per stat per block (never per sample).
        casMax (g_stripStats[(size_t) slot].prePeak, preMax);
        casMax (g_stripStats[(size_t) slot].postPeak, postMax);
        g_stripStats[(size_t) slot].blocks.fetch_add (1, std::memory_order_relaxed);
        // Field-gate-2: the same shape into the [stripmix] window — two
        // CAS-max + one fetch_add per BLOCK, nothing per sample.
        casMax (g_stripMixStats[(size_t) slot].prePeak, preMax);
        casMax (g_stripMixStats[(size_t) slot].postPeak, postMax);
        g_stripMixStats[(size_t) slot].blocks.fetch_add (1, std::memory_order_relaxed);
    }

    const juce::String getName() const override
    { return "Scorch Strip Mixer " + juce::String (slot); }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}
    double getTailLengthSeconds() const override { return 0.0; }
    // Stereo in / stereo out, always: see the class doc (a disabled input bus
    // would invalidate the plugin→strip connections).
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override
    {
        return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo()
            && layouts.getMainInputChannelSet() == juce::AudioChannelSet::stereo();
    }
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }
    // Pure: a strip's state IS its published atomics — nothing to serialize.
    void getStateInformation (juce::MemoryBlock&) override {}
    void setStateInformation (const void*, int) override {}

    const int slot;

private:
    static void casMax (std::atomic<float>& a, float v)
    {
        float cur = a.load (std::memory_order_relaxed);
        while (v > cur && !a.compare_exchange_weak (cur, v, std::memory_order_relaxed))
        { /* cur reloaded by CAS failure */ }
    }
    // Audio-thread owned ramp state (written only here, read only here).
    float sampleRate = 44100.0;
    float currentGain = 1.0f;
    float rampFrom = 1.0f, rampTo = 1.0f;
    int rampLen = 0, rampPos = 0;
};

// Message thread: publish the strip gains for the CURRENT table from the last
// mix state (reload-continuity: reactivated strips restore their gains,
// mutes and solos — the frontend's mix intent rides through the reload).
static float stripBaseGain(const LastStripMix& mix, const std::string& id) {
    auto it = mix.gains.find(id);
    return it != mix.gains.end() ? it->second : 1.0f;
}
static bool stripInList(const std::vector<std::string>& v, const std::string& id) {
    return std::find(v.begin(), v.end(), id) != v.end();
}
// Effective per-strip gain: solo-in-place over the ACTIVE strips (any ACTIVE
// strip soloed → non-soloed ACTIVE strips are muted; a solo naming a DEAD
// strip holds nothing — R2: mid-solo unload of the soloed strip must restore
// the survivors), else per-strip mute, else the strip's gain. The mute is a
// RAMPED gain-0 (the D1 audio-domain mute — the mute must be HEARD).
static bool anyActiveStripSolo(const StripSet& set, const LastStripMix& mix) {
    for (const auto& e : set.strips)
        if (e.active && stripInList(mix.solos, e.stripId)) return true;
    return false;
}
static float stripEffectiveGain(const LastStripMix& mix, const StripEntry& e, bool anyActiveSolo) {
    if (anyActiveSolo)
        return stripInList(mix.solos, e.stripId) ? stripBaseGain(mix, e.stripId) : 0.0f;
    if (stripInList(mix.mutes, e.stripId)) return 0.0f;
    return stripBaseGain(mix, e.stripId);
}
// WS thread: publish effective gains to every ACTIVE strip's slot (called
// after every mix message AND every strips apply AND every lifecycle change —
// the R2 recompute path rides the teardown/reactivate publishes).
static void publishStripGains(const StripSet& set, const LastStripMix& mix) {
    const bool anySolo = anyActiveStripSolo(set, mix);
    for (const auto& e : set.strips) {
        if (!e.active || e.slot < 0 || e.slot >= kMaxStrips) continue;
        g_stripTargetGain.a[(size_t) e.slot].store(stripEffectiveGain(mix, e, anySolo),
                                                   std::memory_order_release);
    }
}

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

// ─── Milestone 2 — TEMPORARY OUTPUT GUARD (the full stage is the NEXT task) ──
// The ×2 default output gain is RETIRED: the shipped default is 1.0 UNITY and
// NO multiplication is applied anywhere (the graph renders straight to the
// master). --plugin-gain stays ACCEPTED but INERT (receipt-named) — per-bus
// gains + a soft limiter are the named next milestone, NOT this one. What M2
// ships instead is OBSERVABILITY: the audio thread counts samples whose
// post-sum magnitude exceeds 1.0 (g_clipCount, folded into the existing peak
// truth pass — zero extra passes), the init worker's janitor emits a
// rate-limited per-render peak receipt + an immediate clip-advance receipt,
// and the [stop] receipt carries the cumulative clip total. The manual gate's
// "clip counter zero" reads this counter on real plugins at unity.
// M4 CLOSE-OUT: per-bus gains SHIPPED as the M3 strips; the soft limiter
// SHIPPED as the M4 output stage (see the M4 block). The counter RE-ANCHORS
// to POST-limiter — nonzero behind an armed limiter names a limiter defect —
// and the guard's "temporary" status retires.
std::atomic<float> g_hostedOutputGain{1.0f};
// Samples (post-sum, pre-device) with |value| > 1.0 since process start.
// Audio-thread incremented (one compare inside the peak truth pass), read by
// the worker janitor + the [stop] receipt.
std::atomic<uint64_t> g_clipCount{0};

// Session peak for the receipt pair: reset at play, maxed by the callback,
// logged at stop ("[stop] ... | session peak X").
std::atomic<float> g_playPeakMax{0.0f};

// ─── Milestone 4 — THE REAL OUTPUT STAGE (the soft-knee brickwall limiter) ──
// The M2 guard's "temporary" status retires here: observability grows teeth.
// D3 (reviewed + approved before any code): POST-GRAPH, PRE-DEVICE, inside
// the audio callback — the exact anchor where the M2 peak truth pass already
// measures. NOT a graph node, for three named reasons: (1) zero topology
// change — no render-sequence accounting churn, no R3 layout-guard
// interaction; (2) it cannot be wired around — every sample reaching the
// device crosses this stage regardless of future wiring or bus shapes;
// (3) the latency system is untouched — zero ADDED latency by design (no
// lookahead; "Parked: latency" respected). The M2 clip counter RE-ANCHORS
// to post-limiter: samples above unity behind an armed limiter name a
// DEFECT, so the manual gate's "clip counter zero" becomes the limiter's
// own regression tripwire. SCORCH_LIMITER_OFF=1 (receipt-named, CI-only)
// runs the raw path so CI can prove the re-anchored counter still advances
// (the zero must not be vacuous) — and the multi mode's frozen pre-M4
// graph-semantics window (three summed sources ~1.18) runs behind the same
// bypass, receipt-named in the workflow.
//
// D4: hand-rolled soft-knee brickwall, engine GLUE (main.cpp, like
// StripMixerProcessor — the vendored core stays byte-untouched; NO juce_dsp
// dependency). Stereo-LINKED envelope on max(|L|,|R|) (imaging preserved):
// instant attack, exponential release (~80 ms, rate-derived per buffer).
// Knee geometry in dB (T = 0 dBFS ceiling, W = 12): transparent at or below
// -6 dBFS; the Zolzer-form soft knee y = x - (x+6)^2/24 spans [-6, +6] dB —
// derivative-continuous at BOTH knee edges (1 at the transparent side, 0 at
// the clamp side), output mathematically unable to exceed the ceiling
// (1:1 clamp only above +6 dB over). At ceiling-level input the knee reads
// -1.5 dB (1.5 dB of intended reduction — see R-C). The CI amplitudes
// (.198/.394 ~ -14/-8 dBFS) sit below the knee: gain there is EXACTLY 1.0 —
// the R2/R3 peak assertions stay byte-exact (mathematical transparency,
// not a tolerance argument).
// R-C (in-knee documentation, per the rider): material peaking between
// -6 dBFS and the ceiling gets GENTLE INTENDED reduction — e.g. a -3 dBFS
// peak renders ~ -3.375 dBFS (0.375 dB of knee reduction). That is the knee
// WORKING, not a defect; documented in ASSUMPTIONS so a future "why did my
// -3 dB peak move" question has a receipt to point at.
// R-A (the denormal rider): the multiplicative release decay is the classic
// denormal GENERATOR under sustained digital silence (env shrinks until it
// enters the denormal range and x86 microcode assists stall the audio
// thread). The explicit floor env = max(env * decay, kLimiterEnvFloor)
// (1e-9, ~ -180 dBFS) fires EVERY sample before any use — the envelope can
// never enter denormal territory regardless of FTZ. JUCE's
// ScopedNoDenormals (FTZ/DAZ) also guards the thread; per the rider, the
// named defense is the FLOOR (primary, unconditional), FTZ is
// belt-and-braces.
// Fixed defaults, NOT protocol-configurable: protocol stays 1, zero new
// wire messages; --plugin-gain stays accepted-but-inert exactly as before.
constexpr float kLimiterKneeStartDb = -6.0f;   // reduction begins here
constexpr float kLimiterKneeWidthDb = 12.0f;   // full clamp at +6 dB over the ceiling
constexpr float kLimiterReleaseMs = 80.0f;
constexpr float kLimiterEnvFloor = 1e-9f;      // R-A: the denormal floor (~ -180 dBFS)
std::atomic<bool> g_limiterBypassed{std::getenv("SCORCH_LIMITER_OFF") != nullptr};    // SCORCH_LIMITER_OFF (receipt-named at device open; read once at startup, before any thread)
std::atomic<float> g_limiterGrDb{0.0f};        // last buffer's max gain reduction, dB
std::atomic<float> g_limiterGrMaxDb{0.0f};     // session max GR, dB (reset at play; [stop] carries it)
static std::string limiterArmedReceipt() {
    return std::string("[audio] limiter: armed (ceiling 1.0, knee -6 dB, release 80 ms, zero added latency") +
           (g_limiterBypassed.load(std::memory_order_relaxed)
                ? "; BYPASS via SCORCH_LIMITER_OFF - the clip counter measures the raw path)"
                : "; post-limiter clip counter armed - nonzero now names a defect)");
}

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
    // M3 PR1: TRUE only for tables installed by the standalone "routing"
    // message (the frontend-owned full table). Under an EXPLICIT table an
    // unmapped track's events are DROPPED with a named, counted receipt
    // ("track N unmapped, M notes dropped") — never the synth fallback
    // (falling back would SOUND a track the frontend deliberately unmapped).
    // Load-built tables (the M2 routing map, the legacy flat "channels" map,
    // or no map) keep FALSE: byte-stable synth-fallback behavior for every
    // pre-M3 shape. The field rides the same atomic snapshot swap as the
    // rest of the table — the audio thread reads it lock-free.
    bool explicitRouting = false;
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
    // Milestone 1: the AudioPluginInstance's OWNER is the vendored graph (the
    // node takes the unique_ptr at addPluginNode()). Before commit the init
    // worker holds it here; after commit `instance` is null and `rawInstance`
    // mirrors the node's processor while the node is live (message-thread /
    // worker reads only — never the audio thread).
    std::unique_ptr<juce::AudioPluginInstance> instance;   // pre-commit only
    // Live in the graph. ATOMIC: the audio thread reads it (dispatch + render
    // gating) while the message thread's retire job nulls it after
    // removeNode. The pointee is immortal-by-policy: the vendor's render
    // sequence keeps a removed instance alive at least until the audio
    // thread swapped away from the sequence that references it (and the
    // graveyard keeps the meta — and its listener — forever).
    std::atomic<juce::AudioPluginInstance*> rawInstance { nullptr };
    juce::AudioProcessorGraph::NodeID nodeID {};           // valid while live
    // Milestone 2: the instance's SELECTOR node id (the MIDI bridge) — the
    // retire must remove BOTH nodes (a stale selector leaks a clear+emit op
    // into every rebuild and skews the render-sequence buffer accounting).
    juce::AudioProcessorGraph::NodeID selectorNodeID {};
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
    // M3 PR1: the instance accepts MULTIPLE tracks on distinct MIDI channels
    // (multi-timbral libraries — patch assignment stays in the plugin UI, the
    // engine never sets programs). Default FALSE = single-timbral: the
    // routing-table validator refuses >1 distinct channel on this instance
    // (the M2 per-instance channel-collision guard, now per-instance-
    // conditional). Carried from the load's additive "multiTimbral":true;
    // immutable after publish like the rest of the identity block.
    bool multiTimbral = false;
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
    std::vector<BusRouting> outputRouting;   // 3e-3: parsed for protocol
                                             // compatibility, DEFERRED by
                                             // milestone 1 (receipt names it;
                                             // entries are never applied)
    // Stage 3i — runtime latency tracking (see the block above HostedPlugin).
    // The listener is registered right after the load-time prepare and stays
    // attached for the instance's whole life.
    std::unique_ptr<LatencyListener> latencyListener;
    std::atomic<bool> latencyNotified{false};

    // Milestone 1: NO destructor detach, and NO destructor at all — retired
    // metas are RETAINED to process exit (the graveyard, below). The vendor
    // may keep the plugin instance alive in an old render sequence for up to
    // 500 ms after removeNode; a latencyChanged notification landing in that
    // window must find its listener (and its atomic flag) alive. The old
    // ~HostedPlugin detach assumed the meta outlived the instance by
    // construction; under the vendor's teardown the guarantee runs the OTHER
    // way, so the meta's lifetime IS the process lifetime — the same
    // leak-at-exit policy the audio path already applies deliberately.
};
// ─── Milestone 1: the vendored host graph ───────────────────────────────────
// ─── Milestone 2: N instances — the published InstanceSet + slot leases ─────
// g_host owns the AudioProcessorGraph + the master output node (the vendor
// core in host/AudioHostCore.h). The audio thread reads ONLY:
//   * g_host.graph() — raw pointer, stable for the process;
//   * g_liveSet — ONE atomic shared_ptr to an immutable per-slot array of
//     HostedPlugin* (the pointees are immortal: retired metas are graveyard-
//     retained), loaded ONCE per buffer;
//   * g_slotLatencySamples[slot] — the per-instance F4 latency mirrors.
// The graph renders ALL nodes in ONE processBlock call; per-instance MIDI
// reaches each plugin through its InstanceMidiSelector (HostCore::addPluginNode
// wires it). The published
// InstanceSet (main.cpp) is the audio-thread truth, the graph's node table is
// the message-thread truth. Retired metas move to the graveyard and are NEVER freed
// (listener lifetime — see the HostedPlugin block).
scorchhost::HostCore g_host;
struct InstanceSet {
    // slot → meta (nullptr = no live instance in that slot). Immutable after
    // publication; the worker builds the next set and swaps it in.
    std::array<HostedPlugin*, scorchhost::kMaxInstances> bySlot {};
};
std::atomic<std::shared_ptr<const InstanceSet>> g_liveSet{
    std::make_shared<const InstanceSet>()};
std::mutex g_hostGraveyardMutex;   // guards the vector only (never the audio thread)
std::vector<std::shared_ptr<HostedPlugin>> g_hostGraveyard;   // retained to exit
// Per-instance latency mirrors (3d-4's slotLatency, M1-era global mirror
// restored per slot). Published at commit / AboutToStart / 3i republish; read
// by the audio thread's F4 shift (the OWNING instance's latency, not a mix).
std::atomic<int> g_slotLatencySamples[scorchhost::kMaxInstances] = {};
// Legacy convenience (name unchanged): the MAX reported latency across the
// live set — the play/seek pre-roll snapshot and the receipts' mirror.
std::atomic<int> g_pluginLatencySamples{0};

// ─── Milestone 2: slot leases ───────────────────────────────────────────────
// A slot is LEASED to an instanceId for the session: kept instances keep
// their slot (survivor wide channels are byte-stable across diffs — the
// held-note ledger, articulation state and mute-flush flags are wide-indexed,
// so a re-slotted survivor would orphan its state); removed instances free
// their slot; new instances lease the lowest free slot. Granted at parse time
// (WS thread, so the routing table's wide channels are computed against the
// SAME assignment the worker will honor), honored by the worker at diff
// time. A request superseded before the worker saw it leaves a stale lease —
// the worker's diff GCs leases that match neither a live instance nor the
// current request.
std::mutex g_slotLeaseMutex;
std::array<std::string, scorchhost::kMaxInstances> g_slotLease{};   // slot → iid ("" = free)

// Lease the lowest free slot for iid (or return its existing lease). WS
// thread (parse) — also used by the worker's stale-lease repair.
static int slotLeaseFor(const std::string& iid) {
    std::lock_guard<std::mutex> lock(g_slotLeaseMutex);
    for (int s = 0; s < scorchhost::kMaxInstances; ++s)
        if (g_slotLease[s] == iid) return s;
    for (int s = 0; s < scorchhost::kMaxInstances; ++s) {
        if (g_slotLease[s].empty()) { g_slotLease[s] = iid; return s; }
    }
    return -1;   // full — the parse refuses the request before this can matter
}
// Release every lease held by iid. Worker-side (diff removals + GC).
static void slotLeaseRelease(const std::string& iid) {
    if (iid.empty()) return;
    std::lock_guard<std::mutex> lock(g_slotLeaseMutex);
    for (auto& l : g_slotLease) if (l == iid) l.clear();
}

// Live-set access helpers. A published set is IMMUTABLE; metas are immortal
// (graveyard), so the raw pointers it carries are safe to read lock-free.
static std::shared_ptr<const InstanceSet> liveSetSnapshot() {
    return g_liveSet.load(std::memory_order_acquire);
}
static HostedPlugin* findLiveInstance(const std::string& iid) {
    if (iid.empty()) return nullptr;
    auto set = liveSetSnapshot();
    if (!set) return nullptr;
    for (HostedPlugin* m : set->bySlot)
        if (m != nullptr && m->instanceId == iid) return m;
    return nullptr;
}
static HostedPlugin* findLiveInstanceBySlot(int slot) {
    if (slot < 0 || slot >= scorchhost::kMaxInstances) return nullptr;
    auto set = liveSetSnapshot();
    return set ? set->bySlot[slot] : nullptr;
}
static int liveInstanceCount() {
    int n = 0;
    if (auto set = liveSetSnapshot())
        for (HostedPlugin* m : set->bySlot) if (m != nullptr) ++n;
    return n;
}
// Recompute the max-mirror from the live set (publish sites: worker diff,
// AboutToStart, retires).
static void republishMaxLatencyMirror() {
    int mx = 0;
    if (auto set = liveSetSnapshot())
        for (HostedPlugin* m : set->bySlot)
            if (m != nullptr) mx = std::max(mx, static_cast<int>(m->latencySamples));
    g_pluginLatencySamples.store(mx, std::memory_order_release);
}
// Per-slot audio-state reset request (audio-thread self-serviced at the next
// buffer boundary): clears the slot's held-note ledger rows, articulation
// knowledge and mute-flush flags. Set when a slot's instance is REMOVED — a
// stale held note would fire a spurious note-off into whatever instance
// later leases the slot.
std::atomic<bool> g_slotStateClearPending[scorchhost::kMaxInstances] = {};

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
    // Milestone 2: the walk covers EVERY live instance (the published set;
    // the graveyard mutex only guards the vector — metas are immortal, so
    // the reads below are race-free without it). Per-instance published
    // value = the instance's SLOT mirror (the F4 shift's truth).
    struct LiveRef { HostedPlugin* h; int slot; int published; };
    std::vector<LiveRef> lives;
    {
        int s = -1;
        for (HostedPlugin* m : liveSetSnapshot()->bySlot) {
            ++s;
            if (m == nullptr || m->rawInstance.load(std::memory_order_acquire) == nullptr)
                continue;
            lives.push_back({m, s, g_slotLatencySamples[s].load(std::memory_order_acquire)});
        }
    }
    if (lives.empty()) {
        std::lock_guard<std::mutex> lock(g_latencyJobMutex);
        g_latencyPending.clear();
        return;
    }
    std::vector<std::pair<std::string, int>> notifiedNow;
    for (const auto& L : lives) {
        HostedPlugin* h = L.h;
        {
            const bool flagged = h->latencyNotified.exchange(false, std::memory_order_acq_rel);
            const int published = L.published;
            if (flagged) {
                const int v = static_cast<int>(h->rawInstance.load(std::memory_order_acquire)->getLatencySamples());
                if (v != published) notifiedNow.emplace_back(h->instanceId, v);
            }
            if (safetyWalk && !flagged) {
                const int v = static_cast<int>(h->rawInstance.load(std::memory_order_acquire)->getLatencySamples());
                if (v != published) {
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
        }
    }
    for (const auto& c : notifiedNow) latencyTryEnqueue(c.first, c.second);
    // A candidate whose instance vanished (retired/failed) is dropped — the
    // republish job re-checks against a fresh load anyway, this just keeps
    // the map from holding dead entries.
    std::lock_guard<std::mutex> lock(g_latencyJobMutex);
    for (auto it = g_latencyPending.begin(); it != g_latencyPending.end();) {
        if (findLiveInstance((*it).first) == nullptr)
            it = g_latencyPending.erase(it);
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
struct LatencyApplied { std::string instanceId; int oldV; int newV; };
void latencyRepublishJob(std::vector<LatencyCorrection> candidates) {
    const auto t0 = std::chrono::steady_clock::now();
    std::vector<LatencyApplied> applied;
    {
        // Milestone 2: per-instance resolution from the live set; the
        // correction lands on the instance's OWN mirror (the F4 shift reads
        // per slot) AND the max-mirror is recomputed. The ONE-WRITE DISCIPLINE
        // (Stage 3j field invariant) holds per instance: the
        // h->latencySamples refresh happens BEFORE the published mirror
        // store, so a racing load/reuse receipt rebuilds the CORRECTED
        // value, never a stale one — the resurrection window is closed, not
        // narrowed. If the candidate's instance is gone (retired/failed),
        // it drops silently — the safety net re-detects against whatever is
        // live then.
        for (const auto& c : candidates) {
            HostedPlugin* h = findLiveInstance(c.instanceId);
            if (h == nullptr) continue;                                    // gone — drop silently
            const int slot = h->slot;
            const int oldV = (slot >= 0 && slot < scorchhost::kMaxInstances)
                ? g_slotLatencySamples[slot].load(std::memory_order_acquire)
                : g_pluginLatencySamples.load(std::memory_order_acquire);
            if (oldV == c.newValue) continue;                              // converged — no-op
            h->latencySamples = static_cast<double>(c.newValue);
            if (slot >= 0 && slot < scorchhost::kMaxInstances)
                g_slotLatencySamples[slot].store(c.newValue, std::memory_order_release);
            applied.push_back({h->instanceId, oldV, c.newValue});
        }
    }
    if (applied.empty()) {
        engineLog("[latency] publish: no effective change after rebuild — skipped");
        return;
    }
    // Committed — receipts only here. The meta refresh already happened
    // ABOVE (the Stage 3j one-write discipline: h never lags the published
    // mirror on this thread, so no later load can rebuild the stale value).
    for (auto& a : applied) {
        engineLog("[latency] republish instance=" + a.instanceId +
                  " old=" + std::to_string(a.oldV) +
                  " new=" + std::to_string(a.newV) +
                  " samples (stage 3i)" +
                  " — one buffer of timing discontinuity accepted");
    }
    republishMaxLatencyMirror();
    const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();
    engineLog("[latency] publish: node latency corrected=" +
              std::to_string(applied.size()) + " elapsed=" + std::to_string(ms) + "ms");
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
    // Field-gate B-1: duplicate same-instance requests FOLDED into the one
    // queued job (the field evidence: 11 queued Falcon editors behind one
    // wedged message thread). The count lands in the >10s watchdog receipt.
    int folds = 0;
};
std::mutex g_pendingEditorMutex;
bool g_pendingEditorActive = false;
bool g_pendingEditorNamed = false;   // one named receipt per pending epoch
PendingEditorOpen g_pendingEditorOpen;

// ─── Field-gate B-2 — MESSAGE-THREAD OCCUPANCY FORENSICS ────────────────
// The 3f-7 heartbeat answers "is the message thread responsive"; the field
// wedge (three 10:55 minidumps) needs the NEXT question answered too:
// WHAT is it doing and how deep is the queue. Two instruments, both
// lock-light and off-MM-readable:
//   1. NAMED MM JOBS — an RAII scope (MmNamedJob) at the top of every MM
//      job body that can plausibly wedge (editor open/close/destroy, state
//      capture, strips apply, node retire, device reconfigure). Registered
//      ONLY when the thread really is the message thread
//      (getInstanceWithoutCreating — never creating the singleton from a
//      worker: the pump owns MM creation, the 3i comment above). Nesting
//      follows a save/restore discipline: the innermost running job is the
//      one named — that IS "what it is doing now".
//   2. QUEUE DEPTH — g_editorJobsQueued counts editor-family MM jobs
//      (open/focus/destroy) posted but not yet run. JUCE exposes no queue
//      length; this named family is the one the field wedge piled up, and
//      the heartbeat's probe staleness already measures the general queue
//      latency. Both numbers ride the same occupancy suffix.
// Consumers: the 3f-7 unresponsive/recovered lines, the editor >10s
// pending watchdog, and the init pending/queued >10s warnings — every
// >10s declaration now names its blocker (or names none: mmJob=none means
// the MM is idle-in-principle and the staleness is queue backlog).
static long long mmNowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
static bool mmIsMessageThreadSafe() {
    auto* mm = juce::MessageManager::getInstanceWithoutCreating();
    return mm != nullptr && mm->isThisTheMessageThread();
}
std::mutex g_mmJobMutex;
std::string g_mmJobName;          // guarded by g_mmJobMutex; empty = no named job running
long long g_mmJobStartMs = 0;     // guarded by g_mmJobMutex
std::atomic<int> g_editorJobsQueued{0};   // editor MM jobs posted, not yet run
// The 3f-7 heartbeat stamp, FILE scope now (was a main() local) — the
// watchdog sites below read it for the same occupancy suffix.
std::atomic<long long> g_mmHeartbeatMs{0};
struct MmNamedJob {
    explicit MmNamedJob(const std::string& name) {
        registered = false;
        if (!mmIsMessageThreadSafe()) return;
        std::lock_guard<std::mutex> lk(g_mmJobMutex);
        prev = g_mmJobName;
        prevStart = g_mmJobStartMs;
        g_mmJobName = name;
        g_mmJobStartMs = mmNowMs();
        registered = true;
    }
    void rename(const std::string& name) {   // refine once more is known (plugin name)
        if (!registered) return;
        std::lock_guard<std::mutex> lk(g_mmJobMutex);
        g_mmJobName = name;
    }
    ~MmNamedJob() {
        if (!registered) return;
        std::lock_guard<std::mutex> lk(g_mmJobMutex);
        g_mmJobName = std::move(prev);
        g_mmJobStartMs = prevStart;
    }
    MmNamedJob(const MmNamedJob&) = delete;
    MmNamedJob& operator=(const MmNamedJob&) = delete;
    bool registered;
    std::string prev;
    long long prevStart = 0;
};
// The shared suffix — appended by every >10s declaration. Lock-held string
// build, called at most 1 Hz per site (watchdog cadences), never on the
// audio thread.
static std::string mmOccupancySuffix() {
    const int q = g_editorJobsQueued.load(std::memory_order_relaxed);
    std::lock_guard<std::mutex> lk(g_mmJobMutex);
    if (g_mmJobName.empty())
        return "mmJob=none editorJobs=" + std::to_string(q);
    const long long s = (mmNowMs() - g_mmJobStartMs) / 1000;
    return "mmJob=" + g_mmJobName + " for " + std::to_string(s) +
           "s editorJobs=" + std::to_string(q);
}

// Defined further down (JSON helpers + close converge point); forward-declared
// so the window class and open path can reference them.
std::string escape_json(const std::string& s);
void destroyEditorWindow(const std::string& iid, bool captureOnClose = true);
struct HostedPlugin;
void captureAndBroadcastState(juce::AudioPluginInstance* inst, const HostedPlugin& h, const char* trigger);
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
        ++g_editorJobsQueued;
        juce::MessageManager::callAsync([iid = this->iid] {
            destroyEditorWindow(iid, true);
            --g_editorJobsQueued;
        });
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
    // Field-gate B-2: this is THE classic wedge site (createEditor() inside
    // a plugin UI) — the named scope survives until every terminal path
    // returns, so a hang here reads "mmJob=openEditor(...) for Ns" in the
    // next >10s declaration.
    MmNamedJob _mmNamedJob("openEditor(" + iid + ")");
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
    if (owner == nullptr || owner->rawInstance.load(std::memory_order_acquire) == nullptr) {
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
    // Milestone 1 (vendor editor path): createEditorIfNeeded() — the
    // AudioPluginHost's one-editor-per-processor rule. A processor that
    // already owns an editor returns IT instead of building a second one
    // (createEditor() could hand back two live editors for one processor —
    // undefined behavior most plugins never test).
    _mmNamedJob.rename("openEditor(" + iid + "," + owner->name + ")");
    auto* ed = owner->rawInstance.load(std::memory_order_acquire)->createEditorIfNeeded();
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

// ─── D14: the bounded-op tokens (the 5 s ceiling machinery) ─────────────
// The 2026-10-22 run-4 field dump + the 190901 STALL-BUNDLE named the same
// wedge twice: a thread (the init worker in the field, potentially the MM)
// parked INSIDE a plugin call that never returns, while the code around it
// waited unbounded. D14 gives every outgoing capture and every teardown
// window-destroy a hard 5 s ceiling with a NAMED abandon receipt. The bound
// cannot unstick a call already running inside plugin code (thread physics,
// documented — not hidden): what it buys is (1) the caller stops WAITING
// (the worker's SendMessageTimeout), (2) the wedge is NAMED at 5 s and
// FORENSIC at 120 s (the D13 watchdog + all-thread dump, untouched).
constexpr unsigned kCaptureBoundMs = 5000;   // the hard ceiling (the 3–5 s band, upper edge)

struct CaptureBoundToken {
    std::mutex mtx;
    bool active = false;
    bool fired = false;        // one abandon receipt per stamped step
    long long deadlineMs = 0;
    long long gen = 0;         // the abandon generation at stamp time
    std::string what;          // "capture" | "teardown-destroy" | "editor-destroy"
    std::string iid, detail;
};
CaptureBoundToken g_captureBound;    // getStateInformation bounds (on-MM + direct paths)
CaptureBoundToken g_windowOpBound;   // DestroyWindow bounds (retire teardown steps)
std::atomic<long long> g_captureAbandonGen{0};   // bumped by the monitor on a capture abandon
// Sender-watched captures (the worker's SendMessageTimeout wait) skip the
// monitor token: the kernel wait IS their bound. Set only by the MM capture
// window proc around its own captureAndBroadcastState call.
thread_local bool t_captureSenderWatched = false;

static long long d14SteadyMsNow() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
static long long captureBoundStamp(CaptureBoundToken& t, const char* what,
                                   const std::string& iid, const std::string& detail) {
    std::lock_guard<std::mutex> lk(t.mtx);
    t.active = true;
    t.fired = false;
    t.deadlineMs = d14SteadyMsNow() + static_cast<long long>(kCaptureBoundMs);
    t.gen = g_captureAbandonGen.load(std::memory_order_acquire);
    t.what = what;
    t.iid = iid;
    t.detail = detail;
    return t.gen;
}
static void captureBoundClear(CaptureBoundToken& t) {
    std::lock_guard<std::mutex> lk(t.mtx);
    t.active = false;
}

// Message-thread side of close. Every path (protocol close, X button,
// retirement) converges here; the map is the single source of truth.
// captureOnClose: USER-initiated closes (protocol closeEditor, the X button)
// trigger a 3d-3 state capture — edits happen in the editor, so the close is
// the natural commit point. Retirement closes (closeAllEditors*) pass false:
// the init worker captures the OUTGOING instance itself (trigger "replace")
// and a live-pointer race here would capture whichever instance is current.
void destroyEditorWindow(const std::string& iid, bool captureOnClose) {
    // Field-gate B-2: editor destructors are the other classic wedge shape
    // (the 3f-7 heartbeat's own comment) — name the job while it runs.
    MmNamedJob _mmNamedJob("destroyEditor(" + iid + ")");
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
        // D14 teardown bound: the editor destructor runs plugin code — the
        // same 5 s ceiling, named overrun receipt on breach.
        captureBoundStamp(g_windowOpBound, "editor-destroy", iid,
                          "editor window delete (plugin destructor runs)");
        win->setVisible(false);
        delete win;   // setContentOwned(ed, true) frees the editor with the window
        captureBoundClear(g_windowOpBound);
        const long long closeMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - tc0).count();
        engineLog("[editor] close END instance=" + iid + " " + std::to_string(closeMs) + " ms");
    }
    broadcastJson(std::string("{\"type\":\"editorClosed\",\"instanceId\":\"") + escape_json(iid) + "\"}");
    engineLog("[editor] closed instance=" + iid);
    if (captureOnClose) {
        // Milestone 2: capture the OWNING instance — resolved from the live
        // set by id (the legacy "hosted" id matches the reserved legacy
        // instance, whose registry id IS "hosted").
        HostedPlugin* h = findLiveInstance(iid == "hosted" ? "hosted" : iid);
        if (h != nullptr)
            captureAndBroadcastState(h->rawInstance.load(std::memory_order_acquire), *h, "editor-close");
    }
}

// Schedule-close helpers (callable from ANY thread; execution on the pump).
void closeEditorAsync(const std::string& iid) {
    ++g_editorJobsQueued;
    juce::MessageManager::callAsync([iid] {
        destroyEditorWindow(iid, true);
        --g_editorJobsQueued;
    });
}
// Shutdown path: schedule close-all and WAIT (bounded) so the pump actually
// runs it before stopDispatchLoop — clean window teardown on graceful exit.
// A hard kill needs nothing: the OS reaps the process's windows.
void closeAllEditorsAtShutdown() {
    std::atomic<bool> done{false};
    ++g_editorJobsQueued;
    juce::MessageManager::callAsync([&done] {
        std::vector<std::string> ids;
        {
            std::lock_guard<std::mutex> lock(g_editorMutex);
            for (auto& kv : g_editors) ids.push_back(kv.first);
        }
        for (const auto& id : ids) destroyEditorWindow(id, false);
        --g_editorJobsQueued;
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

// ─── D12: the last engine→plugin call breadcrumb ──────────────────────────
// The watchdog's stall bundle must distinguish "slow first load" from
// "deadlock" WITHOUT suspending the worker (a raw stack needs a suspended
// thread that may hold plugin/JUCE locks — its own wedge risk, declined by
// policy). Every engine→plugin call in the init paths stamps this lock-free
// record BEFORE entering the call and re-stamps on return; a call wedged
// inside plugin code holds nothing the watchdog needs, so the bundle is
// readable exactly when the wedge is live.
static long long initSteadyMsNow() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}
struct InitCallBreadcrumb {
    std::atomic<const char*> call{""};   // static site literal ("loadHostedPlugin(create)", "getStateInformation", ...)
    std::atomic<long long> atMs{0};      // steady ms of the LAST stamp (enter or exit)
    std::atomic<bool> inside{false};     // true between the enter and exit stamps
};
InitCallBreadcrumb g_initCallBreadcrumb;
static void initBreadcrumbEnter(const char* call) {
    g_initCallBreadcrumb.call.store(call, std::memory_order_release);
    g_initCallBreadcrumb.atMs.store(initSteadyMsNow(), std::memory_order_release);
    g_initCallBreadcrumb.inside.store(true, std::memory_order_release);
}
static void initBreadcrumbExit();   // defined with the init registry (stamps intra-phase progress)
struct InitBreadcrumbScope {
    explicit InitBreadcrumbScope(const char* call) { initBreadcrumbEnter(call); }
    ~InitBreadcrumbScope() { initBreadcrumbExit(); }
    InitBreadcrumbScope(const InitBreadcrumbScope&) = delete;
    InitBreadcrumbScope& operator=(const InitBreadcrumbScope&) = delete;
};
static std::string initBreadcrumbSuffix() {
    const char* c = g_initCallBreadcrumb.call.load(std::memory_order_acquire);
    if (c == nullptr || c[0] == '\0') return "lastCall=none";
    const long long age = initSteadyMsNow() - g_initCallBreadcrumb.atMs.load(std::memory_order_acquire);
    return std::string("lastCall=") + c +
           (g_initCallBreadcrumb.inside.load(std::memory_order_acquire)
                ? " (INSIDE for " : " (returned ") +
           std::to_string(age) + " ms ago)";
}
// Capture the CURRENT live instance and broadcast the blob. Callable from
// the message thread AND the init worker (getStateInformation is host-callable
// from any thread; plugins guard internally). try/catch: a plugin that
// throws in getStateInformation must not kill anything.
void captureAndBroadcastState(juce::AudioPluginInstance* inst, const HostedPlugin& h, const char* trigger) {
    // Field-gate B-2: getStateInformation on the message thread is the wedge
    // shape the 3f-7 heartbeat names first. The named scope registers ONLY
    // when this really runs on the MM (it also runs on the init worker —
    // the M1-hotfix path — where an MM occupancy claim would be a lie).
    MmNamedJob _mmNamedJob("captureState(" + h.instanceId + ")");
    // Stage 3f-7 (4b): BEGIN before the first call into the plugin
    // (getStateInformation) and END with the elapsed ms after it — the same
    // receipt shape the editor close got, so a slow/hung capture is located
    // by its last line in engine.log.
    // D14 Fix B (shutdown): the exit path is discard-class by definition —
    // no capture can ship anywhere useful once the client is gone, and a
    // shutdown-time capture must never be the thing a wedged plugin hangs.
    if (g_should_exit.load(std::memory_order_acquire)) {
        engineLog("[plugin] state capture SKIPPED (engine shutting down) instance=" + h.instanceId +
                  " (" + trigger + ") — discard-class at shutdown (D14 Fix B)");
        return;
    }
    if (inst == nullptr) {
        engineLog("[plugin] capture SKIPPED instance=" + h.instanceId + " (" + trigger +
                  ") — no live plugin instance (already retired)");
        return;
    }
    const auto tc0 = std::chrono::steady_clock::now();
    engineLog("[plugin] capture BEGIN instance=" + h.instanceId + " (" + trigger + ")");
    try {
        juce::MemoryBlock mb;
        InitBreadcrumbScope _bc("getStateInformation");   // D12: the watchdog's last-call breadcrumb covers ALL capture triggers
        // D14: the hard ceiling on EVERY capture path (on-MM or direct).
        // Sender-watched captures (the worker's SendMessageTimeout wait) are
        // exempt — the kernel wait is their bound.
        const bool stampBound = !t_captureSenderWatched;
        long long genBefore = 0;
        if (stampBound)
            genBefore = captureBoundStamp(g_captureBound, "capture", h.instanceId, trigger);
        inst->getStateInformation(mb);
        if (stampBound) captureBoundClear(g_captureBound);
        const long long capMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - tc0).count();
        if (stampBound && genBefore != g_captureAbandonGen.load(std::memory_order_acquire)) {
            // The monitor already receipted the abandon — this result is
            // DEAD. Nothing ships: the caller moved on at the ceiling.
            engineLog("[plugin] capture completed AFTER abandon instance=" + h.instanceId +
                      " " + std::to_string(capMs) + " ms (" + trigger +
                      ") — result DISCARDED (the abandon receipt is above; nothing ships)");
            return;
        }
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

// ─── D14 Fix A: the MM capture window + the bounded sender ────────────
// The window lives ON the MM pump thread (created by the pump lambda before
// runDispatchLoop) — the thread the plugins treat as their own message
// thread. The worker's outgoing captures are SENT here with
// SendMessageTimeout(SMTO_ABORTIFHUNG, 5 s): a healthy plugin sees the
// capture run in its home context (exactly the receipts it always had); a
// wedged MM leaves the wait timing out and the capture ABANDONED — the named
// receipt fires in the sender and the destroy→drain→unload continues.
#ifdef _WIN32
struct BoundedCaptureRequest {
    juce::AudioPluginInstance* inst;
    const HostedPlugin* meta;
    const char* trigger;
    std::atomic<bool> abandoned{false};
};
std::mutex g_boundedCaptureMutex;
BoundedCaptureRequest* g_boundedCaptureReq = nullptr;   // single slot: the init worker is the only sender, the MM the only server
std::atomic<HWND> g_mmCaptureWindow{nullptr};
constexpr UINT WM_SCORCH_BOUNDED_CAPTURE = WM_APP + 0x0D14;   // SENT (never posted) — the bounded capture request

LRESULT CALLBACK mmCaptureWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_SCORCH_BOUNDED_CAPTURE) {
        BoundedCaptureRequest* req = nullptr;
        {
            std::lock_guard<std::mutex> lk(g_boundedCaptureMutex);
            req = g_boundedCaptureReq;
            g_boundedCaptureReq = nullptr;   // served — the slot clears before the capture runs (the sender's 5 s wait is not extended by the capture)
        }
        if (req == nullptr) return 1;   // stale send (sender already abandoned+cleared) — nothing to do
        if (req->abandoned.load(std::memory_order_acquire)) {
            engineLog(std::string("[plugin] bounded capture arrived AFTER the abandon (") +
                      req->trigger + ") — the retire already proceeded; no capture runs");
            return 0;
        }
        t_captureSenderWatched = true;
        struct SenderWatched { ~SenderWatched() { t_captureSenderWatched = false; } } _sw;
        // The capture runs HERE — on the plugin's own message thread. The
        // sender is already watching with its own 5 s kernel wait; the
        // monitor token is skipped for exactly this path. If the capture
        // outlives the sender's wait, it still COMPLETES and ships (a slow
        // but healthy capture loses nothing) — the abandon only stops the
        // WAITER, which is what keeps destroy→drain→unload moving.
        captureAndBroadcastState(req->inst, *req->meta, req->trigger);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

void createMmCaptureWindowOnThisThread() {
    WNDCLASSW wc{};
    wc.lpfnWndProc = mmCaptureWndProc;
    wc.hInstance = GetModuleHandleW(nullptr);
    wc.lpszClassName = L"ScorchEngineMmCaptureWindow";
    RegisterClassW(&wc);   // exists-ok on re-entry
    // HWND_MESSAGE: message-only — no broadcast noise, and invisible to the
    // module-window sweeps (this window is OURS, never the plugin's).
    const HWND hwnd = CreateWindowExW(0, wc.lpszClassName, L"", 0,
                                      0, 0, 0, 0, HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
    g_mmCaptureWindow.store(hwnd, std::memory_order_release);
    engineLog(hwnd != nullptr
        ? std::string("[plugin] D14 MM capture window armed (message-only, on the MM pump thread) — outgoing captures ride it bounded ") +
              std::to_string(kCaptureBoundMs) + " ms (SMTO_ABORTIFHUNG)"
        : std::string("[plugin] D14 MM capture window FAILED (err=") + std::to_string(GetLastError()) +
              ") — outgoing captures fall back to the direct path under the monitor bound");
}

// The worker's bounded outgoing capture. true = served (the capture ran on
// the plugin's message thread); false = the bound fired, the capture is
// ABANDONED (the named receipt is emitted here) and the caller proceeds to
// destroy→drain→unload.
bool boundedRetireCaptureOnMessageThread(juce::AudioPluginInstance* inst,
                                         const HostedPlugin& h, const char* trigger) {
    const HWND hwnd = g_mmCaptureWindow.load(std::memory_order_acquire);
    if (hwnd == nullptr || !IsWindow(hwnd)) {
        // Startup/shutdown race: no window (or already reaped). The DIRECT
        // capture path — still bounded by the monitor token, never bare.
        engineLog(std::string("[plugin] retire-capture on the DIRECT path (no MM window; ") +
                  trigger + ") — bounded by the D14 monitor token");
        captureBoundStamp(g_captureBound, "capture", h.instanceId, trigger);
        captureAndBroadcastState(inst, h, trigger);
        captureBoundClear(g_captureBound);
        return true;
    }
    BoundedCaptureRequest req{inst, &h, trigger};
    {
        std::lock_guard<std::mutex> lk(g_boundedCaptureMutex);
        if (g_boundedCaptureReq != nullptr) {
            // A previous request is still unserved — the MM is not pumping
            // sent messages (the wedged shape). Never queue behind it.
            engineLog(std::string("[plugin] retire-capture abandoned (plugin MM wedged) instance=") +
                      h.instanceId + " trigger=" + trigger +
                      " (a prior bounded capture is still unserved — the MM is not pumping)"
                      " — a lost autosave is acceptable; a wedged host is not. Continuing destroy→drain→unload.");
            return false;
        }
        g_boundedCaptureReq = &req;
    }
    DWORD_PTR dwResult = 0;
    SetLastError(0);
    const auto t0 = std::chrono::steady_clock::now();
    const LRESULT r = SendMessageTimeoutW(hwnd, WM_SCORCH_BOUNDED_CAPTURE, 0, 0,
                                          SMTO_ABORTIFHUNG, kCaptureBoundMs, &dwResult);
    const long long waitedMs = d14SteadyMsNow() -
        std::chrono::duration_cast<std::chrono::milliseconds>(
            t0.time_since_epoch()).count();
    {
        std::lock_guard<std::mutex> lk(g_boundedCaptureMutex);
        if (g_boundedCaptureReq == &req) g_boundedCaptureReq = nullptr;   // timed out before service — clear our own slot
    }
    if (r != 0) {
        engineLog(std::string("[plugin] retire-capture served on the plugin's message thread (") +
                  trigger + ") instance=" + h.instanceId +
                  " wait=" + std::to_string(waitedMs) + " ms");
        return true;
    }
    req.abandoned.store(true, std::memory_order_release);   // a late-arriving handler must no-op
    engineLog(std::string("[plugin] retire-capture abandoned (plugin MM wedged) instance=") +
              h.instanceId + " trigger=" + trigger +
              " bound=" + std::to_string(kCaptureBoundMs) + "ms waited=" + std::to_string(waitedMs) +
              "ms err=" + std::to_string(GetLastError()) +
              " — a lost autosave is acceptable; a wedged host is not. Continuing destroy→drain→unload.");
    return false;
}
#else
// Non-Windows build: the capture is host-callable from any thread (documented
// since 3d-3); the direct path under the monitor token is the bound.
bool boundedRetireCaptureOnMessageThread(juce::AudioPluginInstance* inst,
                                         const HostedPlugin& h, const char* trigger) {
    captureBoundStamp(g_captureBound, "capture", h.instanceId, trigger);
    captureAndBroadcastState(inst, h, trigger);
    captureBoundClear(g_captureBound);
    return true;
}
#endif

// The D14 bound monitor — 1 s slices, additive (the D13 watchdog is
// untouched). Names any capture / teardown-destroy step that blew its 5 s
// ceiling, ONCE per stamped step. A capture abandon also bumps the abandon
// generation: the capturing thread's post-call check then DISCARDS the
// result. A step that clears inside its ceiling is never spoken of.
void d14BoundMonitorBody() {
    while (!g_should_exit.load(std::memory_order_acquire)) {
        std::this_thread::sleep_for(std::chrono::milliseconds(1000));
        if (g_should_exit.load(std::memory_order_acquire)) break;
        const long long now = d14SteadyMsNow();
        {
            std::lock_guard<std::mutex> lk(g_captureBound.mtx);
            if (g_captureBound.active && !g_captureBound.fired && now >= g_captureBound.deadlineMs) {
                g_captureBound.fired = true;
                g_captureAbandonGen.fetch_add(1, std::memory_order_acq_rel);
                engineLog("[plugin] capture abandoned (plugin MM wedged) instance=" + g_captureBound.iid +
                          " trigger=" + g_captureBound.detail +
                          " bound=" + std::to_string(kCaptureBoundMs) +
                          "ms — the caller no longer waits; the result is discarded when/if the call returns");
            }
        }
        {
            std::lock_guard<std::mutex> lk(g_windowOpBound.mtx);
            if (g_windowOpBound.active && !g_windowOpBound.fired && now >= g_windowOpBound.deadlineMs) {
                g_windowOpBound.fired = true;
                engineLog("[plugin] teardown destroy overrun (abandon receipt) instance=" + g_windowOpBound.iid +
                          " (" + g_windowOpBound.what + ": " + g_windowOpBound.detail +
                          ") — DestroyWindow did not return within " + std::to_string(kCaptureBoundMs) +
                          "ms; TASK J ordering continues around it when it returns (the D13 watchdog is the forensic backstop)");
            }
        }
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
// ─── 0.9.2 — TERMINAL RECEIPT INVARIANT (field log 0.9.1, gate run 1) ───
// The field evidence: seq 2 and seq 8 logged "plugin init queued" and then
// NOTHING — no loaded, no failed, no superseded — while the engine stayed
// alive (transport + musical-release receipts continued). A jammed worker
// (or a request queued behind one) had NO path to a terminal receipt: the
// worker IS the jam, and every receipt it would send lives after the jam.
// The invariant this registry enforces:
//   every queued init (per seq) ends with EXACTLY ONE terminal receipt:
//     "[plugin] loaded ..." (per entry, at publish)
//     "[plugin] init failed: seq= reason="
//     "[plugin] init superseded: seq= by="
//   — no silent drops, ever. The watchdog thread declares the terminal on
//   behalf of a wedged worker (log-only declarations — killing a thread
//   that holds plugin/JUCE locks wedges the process harder than the hang);
//   the worker, when it eventually unblocks, discovers the declaration and
//   DISCARDS its result instead of double-emitting.
struct InitReceiptRecord {
    long long seq = 0;
    bool unload = false;              // unload requests keep their own terminal ("unload complete")
    std::string fingerprint;          // "iid|uid|path" per entry, ';' joined (the coalescing key)
    std::chrono::steady_clock::time_point queuedAt{};
    std::chrono::steady_clock::time_point phaseSince{};   // D12: last phase/progress movement (the stall clock; {} means queuedAt)
    bool inFlight = false;            // popped by the init worker
    bool terminal = false;            // exactly-one terminal receipt has been emitted
    std::string terminalKind;         // "loaded" | "failed" | "superseded"
    std::string phase;                // last known stage (the warnings name it)
    std::string instanceId;           // the phase's instance (or "-")
    std::string firstIid;             // the request's first entry id (the wire twin's address)
    std::chrono::steady_clock::time_point lastWarnAt{};   // 10 s warning cadence
};
std::mutex g_initReceiptMutex;
std::vector<InitReceiptRecord> g_initReceipts;   // small (a handful of live requests)

// The terminal declaration bound — REVERTED to the 0.14.0 FLAT WALL CLOCK
// (D13, field dump 211647). Why the 0.14.1 progress-aware stall was the
// firing pin: a GB-scale first load spends MINUTES inside ONE engine→plugin
// call (create/prepare streaming samples from disk) — no phase transitions,
// no breadcrumb returns, so its zero-movement clock crossed 60 s while the
// load was perfectly healthy; the watchdog declared it failed and handed a
// HALF-CONSTRUCTED plugin to the abandon/discard machinery. The flat wall
// clock is the semantics the Falcon leg ran clean with TWICE on the field
// machine (2026-10-22, runs 1 and 2). SCORCH_INIT_PROGRESS_STALL_MS and
// SCORCH_INIT_HARD_CAP_MS are no longer read (their era is named in the
// bench canon); SCORCH_INIT_TERMINAL_TIMEOUT_MS keeps its original meaning
// (default 120000; CI's 12 s jam wiring unchanged — a jam never completes,
// so the flat clock fires at exactly the CI-set age). Log-only: the
// declaration never touches the wedged thread; the diagnostic dump (D13)
// suspends threads inside MiniDumpWriteDump — the sanctioned mechanism.
static long long initTerminalTimeoutMs() {
    static const long long v = [] {
        long long x = 120000;
        if (const char* e = std::getenv("SCORCH_INIT_TERMINAL_TIMEOUT_MS")) {
            const long long p = std::atoll(e);
            if (p >= 1000) x = p;
        }
        return x;
    }();
    return v;
}

// Mark terminal. Returns false when the record was ALREADY terminal — the
// exactly-one enforcement point (the caller must not emit a second receipt).
static bool initRegistryMarkTerminal(long long seq, const char* kind) {
    std::lock_guard<std::mutex> lk(g_initReceiptMutex);
    for (auto& r : g_initReceipts) {
        if (r.seq != seq) continue;
        if (r.terminal) return false;
        r.terminal = true;
        r.terminalKind = kind;
        return true;
    }
    return false;   // unknown seq — the caller's receipt is still allowed (defensive)
}
static bool initRegistryIsTerminal(long long seq) {
    std::lock_guard<std::mutex> lk(g_initReceiptMutex);
    for (const auto& r : g_initReceipts) if (r.seq == seq) return r.terminal;
    return false;
}
static void initRegistrySetPhase(long long seq, const char* phase, const std::string& iid) {
    std::lock_guard<std::mutex> lk(g_initReceiptMutex);
    for (auto& r : g_initReceipts) {
        if (r.seq != seq || r.terminal) continue;
        r.phase = phase;
        r.instanceId = iid;
        r.phaseSince = std::chrono::steady_clock::now();   // D12: a phase transition is movement — the stall clock restarts
    }
}
// D12: an intra-phase progress stamp (a plugin call RETURNED) — every
// in-flight request's stall clock restarts. Called from initBreadcrumbExit.
static void initRegistryBumpProgress() {
    const auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lk(g_initReceiptMutex);
    for (auto& r : g_initReceipts)
        if (!r.terminal && r.inFlight) r.phaseSince = now;
}
static void initBreadcrumbExit() {
    g_initCallBreadcrumb.atMs.store(initSteadyMsNow(), std::memory_order_release);
    g_initCallBreadcrumb.inside.store(false, std::memory_order_release);
    initRegistryBumpProgress();   // a completed call is honest intra-phase progress
}
// The coalescing lookup (#5): a NON-terminal record (queued or in-flight)
// with the same fingerprint. Returns its seq, or 0.
static long long initRegistryFindMatching(const std::string& fingerprint, long long excludeSeq) {
    std::lock_guard<std::mutex> lk(g_initReceiptMutex);
    for (auto it = g_initReceipts.rbegin(); it != g_initReceipts.rend(); ++it) {
        if (it->terminal || it->unload || it->seq == excludeSeq) continue;
        if (it->fingerprint == fingerprint && !it->fingerprint.empty()) return it->seq;
    }
    return 0;
}
static void initRegistryEnqueue(long long seq, bool unload, const std::string& fingerprint,
                                const std::string& firstIid = "") {
    std::lock_guard<std::mutex> lk(g_initReceiptMutex);
    InitReceiptRecord r;
    r.seq = seq;
    r.unload = unload;
    r.fingerprint = fingerprint;
    r.firstIid = firstIid;   // the wire twin of a watchdog declaration addresses THIS
    r.queuedAt = std::chrono::steady_clock::now();
    g_initReceipts.push_back(std::move(r));
    // Forensic bound: terminal records stay for the log's benefit only —
    // keep the last 32 so a long session cannot grow the vector unbounded.
    if (g_initReceipts.size() > 64) {
        std::vector<InitReceiptRecord> kept;
        for (const auto& rec : g_initReceipts) if (!rec.terminal) kept.push_back(rec);
        if (kept.size() > 48) kept.erase(kept.begin(), kept.end() - 48);
        size_t terminalKept = 0;
        for (auto it = g_initReceipts.rbegin(); it != g_initReceipts.rend() && terminalKept < 32; ++it) {
            if (it->terminal) { kept.push_back(*it); ++terminalKept; }
        }
        g_initReceipts.swap(kept);
    }
}

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
// 0.9.2: the guard now ALSO (a) emits the stage receipt ("init stage=<phase>")
// — the heartbeat contract: while an init runs, engine.log shows WHICH stage
// it is in, within seconds, and (b) writes the phase into the request's
// registry record so the >10s pending warnings name the stuck stage.
class InitPhaseGuard {
public:
    InitPhaseGuard(const char* phase, const std::string& iid, long long seq = -1)
        : phaseName_(phase), iid_(iid), seq_(seq) {
        std::lock_guard<std::mutex> lk(g_initPhase.mtx);
        g_initPhase.phase = phase;
        g_initPhase.instanceId = iid;
        g_initPhase.startedAt = std::chrono::steady_clock::now();
        g_initPhase.active = true;
        g_initPhase.named = false;
        if (seq >= 0) {
            initRegistrySetPhase(seq, phase, iid);
            engineLog(std::string("[plugin] init stage=") + phase + " instance=" + iid +
                      " seq " + std::to_string(seq));
        }
    }
    ~InitPhaseGuard() {
        long long ms = 0;
        {
            std::lock_guard<std::mutex> lk(g_initPhase.mtx);
            ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - g_initPhase.startedAt).count();
            g_initPhase.active = false;
        }
        // D12 receipt: per-leg init phase timings (ms per phase) — the bench
        // receipt's engine.log half parses these to show where a leg's init
        // time actually went (and the stall bundle's in-phase age reads
        // against them).
        if (seq_ >= 0)
            engineLog("[plugin] init timing phase=" + phaseName_ + " instance=" + iid_ +
                      " seq " + std::to_string(seq_) + " ms=" + std::to_string(ms));
    }
    InitPhaseGuard(const InitPhaseGuard&) = delete;
    InitPhaseGuard& operator=(const InitPhaseGuard&) = delete;
private:
    std::string phaseName_;
    std::string iid_;
    long long seq_;
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
    // M3 PR1: the entry's additive "multiTimbral":true — the routing-table
    // validator's per-instance channel-collision rule is conditional on it.
    bool multiTimbral = false;
};
struct PluginInitRequest {
    // Stage 3d-4: the load's FULL desired instance set (replace-all semantics:
    // instances absent from this list retire when the set publishes).
    // Milestone 1: at most ONE entry (multi-entry sets are refused at parse).
    // unload=true ({"plugins": []} — explicit empty array) hosts zero plugins:
    // the live instance retires with its state captured.
    std::vector<PluginInitEntry> entries;
    long long seq = 0;
    bool unload = false;
    // 0.9.2: the load-carried editor intent ("openEditor":true) — honored at
    // publish (after the loaded receipts) on the async path; the reuse path
    // honors its own copy on the WS thread.
    bool openEditor = false;
    // D14 Fix B: additive "discardRetire":true — this request's OUTGOING
    // retires are discard-class: NO state capture runs on the retiring
    // instances (the field bench marks every leg; the shutdown path is
    // discard-class by definition). The bench path never depends on a
    // plugin's message-thread health.
    bool discardRetire = false;
};
std::mutex g_pluginInitMutex;
std::condition_variable g_pluginInitCv;
PluginInitRequest g_pluginInitRequest;   // guarded by g_pluginInitMutex
bool g_pluginInitPending = false;        // guarded by g_pluginInitMutex
uint64_t g_pluginInitGen = 0;            // guarded; bumped per queued request
// 0.9.2: the seq of the NEWEST queued request (guarded by g_pluginInitMutex).
// The superseded receipts' "by=" must name the request that took our place —
// the generation counter alone cannot answer "which seq superseded me".
long long g_pluginInitNewestSeq = 0;     // guarded by g_pluginInitMutex
// D12: set once when the init worker's loop has EXITED — the shutdown path
// polls it for a bounded 10 s; a worker still inside a plugin call after the
// bound is abandoned (detached, never joined) so a wedged worker can never
// stop engine exit.
std::atomic<bool> g_pluginInitWorkerExited{false};

// Real device config, captured in audioDeviceAboutToStart. A hot-swapped
// instance is prepared with THESE numbers before it becomes visible to the
// audio callback (create-time prepare uses nominal 44100/512 — preparing a
// swapped-in instance only at the next device start was the mis-prepared
// half of the empty-score regression).
std::atomic<int> g_deviceBufferSize{512};
// M1-hotfix (heavy-load death): true once audioDeviceAboutToStart ran for a
// real or null device. g_engine.sampleRate cannot serve this role — it
// initializes to 44100.0 (a legal device rate), so "device not started yet"
// is not derivable from the rate alone. The init worker's worker-side
// real-device prepare (the legacy init-thread pattern) reads this to pick
// device settings vs the graph's current (nominal) settings.
std::atomic<bool> g_deviceStarted{false};

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
// Field-gate B-3: render-source attribution — per-buffer maxima of the TWO
// render paths, measured PRE-mix (the graph render's own output state
// before the synth tail adds over it; the synth scratch before it lands).
// The 1 Hz render-peak receipt names src=graph|fallback from these: ties →
// graph (the primary path), both zero → src=graph peak 0.000 (no material
// anywhere). PRE-limiter magnitudes: attribution of MATERIAL, not of the
// M4 output conditioning that runs after the mix.
std::atomic<float> g_lastPeakGraph{0.0f};
std::atomic<float> g_lastPeakSynth{0.0f};

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
        // Zero the output buffer
        for (int ch = 0; ch < numOutputChannels; ++ch)
            std::memset(outputChannelData[ch], 0, sizeof(float) * numSamples);

        // ── Stage 3c-polish (D2): this function performs NO lock and NO
        // allocation. Voices are audio-thread-owned: kill/release requests
        // are self-serviced HERE at the boundary.

        // ONE atomic load per shared object. Published objects are immutable
        // (score snapshot / routing table / instance set), so plain pointer
        // loads suffice. Milestone 2: the live plugin SET is the per-slot
        // InstanceSet — the buffer-start snapshot is ONE shared_ptr load; the
        // pointees are immortal (graveyard), so the raw pointers inside are
        // safe to dereference for the whole buffer.
        const auto liveSet = g_liveSet.load(std::memory_order_acquire);
        HostedPlugin* const* const setSlots =
            liveSet ? liveSet->bySlot.data() : nullptr;
        // Per-slot liveness for this buffer (rawInstance != nullptr = live).
        // anyPluginRendering gates the graph render call entirely.
        bool slotRendering[scorchhost::kMaxInstances] = {};
        bool anyPluginRendering = false;
        if (liveSet) {
            for (int s = 0; s < scorchhost::kMaxInstances; ++s) {
                HostedPlugin* m = liveSet->bySlot[s];
                slotRendering[s] = m != nullptr &&
                    m->rawInstance.load(std::memory_order_acquire) != nullptr;
                anyPluginRendering |= slotRendering[s];
            }
        }
        const bool pluginRendering = anyPluginRendering;
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
        uint64_t bufClips = 0;   // M2 output guard: this buffer's unity violations

        // Stage 3c-polish (D2): kill requests from PANIC and the play-time
        // pre-panic guard — instant (env=0), self-serviced at the boundary.
        if (g_voiceKillPending.exchange(false, std::memory_order_relaxed)) {
            for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
        }

        // Reusable per-buffer MIDI buffers (members, one per slot): clear()
        // keeps the internal capacity — steady-state dispatch allocates nothing.
        for (int i = 0; i < scorchhost::kMaxInstances; ++i) instMidi[i].clear();

        // Milestone 2 — per-slot state clears (diff removals): the worker set
        // the flag when an instance was REMOVED from that slot; the audio
        // thread self-services the ledger/articulation/mute-flush wipe at the
        // boundary (audio-thread-owned state, never touched cross-thread).
        for (int s = 0; s < scorchhost::kMaxInstances; ++s) {
            if (g_slotStateClearPending[s].exchange(false, std::memory_order_relaxed)) {
                // M3 PR2 (R4): COUNT the abandoned held notes before the wipe —
                // the teardown-flush receipt's audio-thread truth ("the same
                // CC120 flush as mid-play rebinds", all-sound-off semantics:
                // the notes die instantly with the slot's state; the worker
                // speaks the count).
                int wipedHeld = 0;
                for (int c = 0; c < 16; ++c) {
                    const int wide = wideChannelOf(s, c + 1);
                    for (int p = 0; p < 128; ++p)
                        if (g_heldPluginNotes[wide - 1][p]) ++wipedHeld;   // every abandoned pitch
                }
                g_slotWipedHeldNotes[s].fetch_add(wipedHeld, std::memory_order_relaxed);
                for (int c = 0; c < 16; ++c) {
                    g_heldPluginNotes[wideChannelOf(s, c + 1) - 1].clear();
                    g_muteFlushPending[wideChannelOf(s, c + 1) - 1].store(false,
                        std::memory_order_relaxed);
                }
                for (int c = 0; c < 16; ++c)
                    g_articulation[wideChannelOf(s, c + 1) - 1].store(0xFF,
                        std::memory_order_relaxed);   // UNKNOWN — the first CC#32 re-fires
            }
        }

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
            // Milestone 2: the walk covers EVERY LIVE slot's namespace (a held
            // note above wide 16 is real now — the per-slot gate is the set
            // snapshot taken at buffer start).
            if (pluginRendering && liveSet) {
                for (int wide = 1; wide <= kWideChannels; ++wide) {
                    const int slot = slotOfWide(wide);
                    if (!slotRendering[slot]) continue;
                    for (int p = 0; p < 128; ++p)
                        if (g_heldPluginNotes[wide - 1][p]) {
                            instMidi[slot].addEvent(
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
        if (panicFlush && pluginRendering && liveSet) {
            // Milestone 2: CC120 on ALL 16 channels of EVERY live instance.
            for (int slot = 0; slot < scorchhost::kMaxInstances; ++slot) {
                if (!slotRendering[slot]) continue;
                for (int ch = 1; ch <= 16; ++ch) {
                    instMidi[slot].addEvent(juce::MidiMessage::controllerEvent(ch, 120, 0), 0);
                    g_heldPluginNotes[wideChannelOf(slot, ch) - 1].clear();   // all sound off = nothing held
                }
            }
        }
        // Mute/solo lost-audibility flush: per-WIDE-channel atomic flags — no
        // mutex, no vector (the test-synth voices are killed via the kill
        // flag above; they don't need a MIDI round-trip). Milestone 2: routed
        // into the OWNING slot's buffer, gated on that slot being live.
        bool anyMuteFlush = false;
        if (pluginRendering && liveSet) {
            for (int wide = 1; wide <= kWideChannels; ++wide) {
                const int slot = slotOfWide(wide);
                if (!slotRendering[slot]) continue;
                if (g_muteFlushPending[wide - 1].exchange(false, std::memory_order_relaxed)) {
                    instMidi[slot].addEvent(
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
            // Milestone 2: the graph renders FIRST (the vendor's output node
            // ASSIGNS the master channels — the buffer was zeroed at entry),
            // then the synth tail adds below. The release/panic/flush walks
            // above filled the per-slot instMidi buffers; each live plugin
            // receives ITS buffer through its InstanceMidiSelector (the graph
            // render call itself takes an EMPTY incoming buffer — the shared
            // MidiInOp path is retired with M2). A plugin that just retired
            // stops contributing from this buffer on — its tail dies with the
            // vendor's sequence swap.
            if (pluginRendering) {
                if (auto* g = g_host.graph()) {
                    diagMidiHandoffProbe();   // DIAG site 1: the per-slot buffers as handed to the graph
                    graphMidiIn.clear();
                    juce::AudioBuffer<float> outWrap(outputChannelData, numOutputChannels, numSamples);
                    g->processBlock(outWrap, graphMidiIn);
                    diagGraphProbe();         // DIAG sites 2+3: post-render graph state
                }
            }
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
            // M4 output stage: the limiter runs BEFORE the peak truth pass —
            // the pass measures what the DEVICE will actually get
            // (post-limiter), so its clip count is the re-anchored defect
            // counter and the session peak is the post-M4 truth.
            processOutputLimiter(outputChannelData, numOutputChannels, numSamples);
            // Milestone 1: the graph render above (before the synth tail)
            // covers the plugin path — tails drain, panic/flush CCs were fed
            // through instMidi[0] by the walks; the output node assigned the
            // master channels and the synth tail adds over it.
            // Summed-buffer peak + M2 clip counter (see the playing branch —
            // 3d-4 honesty); measured AFTER the graph + synth renders so it
            // sees the full mix. The clip count folds into this pass (one
            // extra compare per sample — no extra pass).
            for (int s = 0; s < numSamples; ++s) {
                float mx = 0.0f;
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    mx = std::max(mx, std::abs(outputChannelData[ch][s]));
                peak = std::max(peak, mx);
                if (mx > 1.0f) ++bufClips;   // M2 output guard: post-sum unity violation
            }
            if (bufClips > 0)
                g_clipCount.fetch_add(bufClips, std::memory_order_relaxed);
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
        // OWNING instance's reported latency (3d-4: per-slot; M2: from the
        // per-slot mirror) so the audible attack lands on the grid.
        auto isPluginRouted = [&](const EngineEvent& ev) -> bool {
            if (!pluginRendering || routing == nullptr || ev.trackRef == 0) return false;
            if (ev.trackRef >= routing->slotChannel.size()) return false;
            if (routing->slotChannel[ev.trackRef] <= 0 ||
                routing->pluginChannels.count(ev.channel) == 0) return false;
            const int slot = slotOfWide(ev.channel);
            return slot < scorchhost::kMaxInstances && slotRendering[slot];
        };
        // F4 shift for a routed event: the OWNING instance's published latency
        // (the per-slot mirror — two instances' latencies are independent).
        auto latencyFor = [&](const EngineEvent& ev) -> int {
            const int slot = slotOfWide(ev.channel);
            return (slot >= 0 && slot < scorchhost::kMaxInstances)
                ? g_slotLatencySamples[slot].load(std::memory_order_relaxed)
                : g_pluginLatencySamples.load(std::memory_order_relaxed);
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
                // M3 PR1: under an EXPLICIT routing table an unmapped track is
                // DROPPED, counted and NAMED (the 1 Hz janitor pass speaks the
                // deltas: "track N unmapped, M notes dropped") — never the
                // synth fallback, never silence without a receipt. Legacy
                // tables (explicitRouting=false) keep the byte-stable
                // fallback; trackRef-0 events (no trackId) always keep it.
                if (!toPlugin && routing != nullptr && routing->explicitRouting &&
                    ev.trackRef != 0 && ev.trackRef <= kMaxDropTrackSlots &&
                    (ev.trackRef > routing->slotChannel.size() ||
                     routing->slotChannel[ev.trackRef] == 0)) {
                    g_unmappedDrops[ev.trackRef - 1].fetch_add(1, std::memory_order_relaxed);
                    ++eventIdx;
                    continue;
                }
                // Same clamp rule as the skip walk above (Phase 2 floor: the
                // muted pre-roll window, -preRoll — start-tick events
                // pre-fire into it; past events never reach here, the skip
                // walk consumed them by tick).
                const int64_t eventSample = std::max<int64_t>(-preRoll,
                    static_cast<int64_t>((ev.tick - playStartTick) * spt) -
                    (ev.tick >= playStartTick && toPlugin ? latencyFor(ev) : 0));
                if (eventSample > absSample) break;
                dispatchTo(ev, toPlugin, static_cast<int>(absSample - eventSample),
                           absSample, spt, playStartTick, liveSet, slotRendering, routing, mix);
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
            // Milestone 2: the vendored graph renders ALL live instances (each
            // through its InstanceMidiSelector); the synth path adds on top.
            // The graph render call itself takes an EMPTY incoming buffer —
            // the shared MidiInOp path is retired with M2.
            if (pluginRendering) {
                if (auto* g = g_host.graph()) {
                    diagMidiHandoffProbe();   // DIAG site 1: the per-slot buffers as handed to the graph
                    graphMidiIn.clear();
                    juce::AudioBuffer<float> outWrap(outputChannelData, numOutputChannels, numSamples);
                    g->processBlock(outWrap, graphMidiIn);
                    diagGraphProbe();         // DIAG sites 2+3: post-render graph state
                }
            }
            const bool noPlugin = !pluginRendering;
            // Field-gate B-3: muteCount is computed BEFORE the add loop so
            // per-source maxima only see the UNMUTED region — muted samples
            // contribute nothing by construction (the memset below zeroes
            // them; the truth pass reports honest silence). graphPk reads
            // the buffer's PRE-ADD state (the graph render's contribution
            // alone — zero when nothing is hosted, the assign branch
            // overwrites silence); synthPk reads the synth scratch (the
            // fallback contribution alone). Two extra compares per sample,
            // same order as the existing truth pass; no lock, no allocation.
            const int64_t muteCount = startSample < 0
                ? std::min<int64_t>(static_cast<int64_t>(numSamples), -startSample) : 0;
            float graphPk = 0.0f, synthPk = 0.0f;
            for (int s = 0; s < numSamples; ++s) {
                const float out = synthScratch[static_cast<size_t>(s)];
                if (s >= muteCount) {
                    synthPk = std::max(synthPk, std::fabs(out));
                    if (!noPlugin) {
                        for (int ch = 0; ch < numOutputChannels; ++ch)
                            graphPk = std::max(graphPk, std::fabs(outputChannelData[ch][s]));
                    }
                }
                if (noPlugin) {
                    for (int ch = 0; ch < numOutputChannels; ++ch)
                        outputChannelData[ch][s] = out;
                } else {
                    for (int ch = 0; ch < numOutputChannels; ++ch)
                        outputChannelData[ch][s] += out;
                }
            }
            g_lastPeakGraph.store(graphPk, std::memory_order_relaxed);
            g_lastPeakSynth.store(synthPk, std::memory_order_relaxed);
            // Phase 2 — MUTED PRE-ROLL, sample-accurate: samples before
            // timeline zero rendered the latency-line priming + the
            // pre-fired start-tick events into the buffer; they are
            // discarded here. The audible transport begins at sample 0 =
            // the grid position of playStartTick. The peak truth pass below
            // measures the POST-mute buffer — a muted pre-roll reports
            // peak 0 (honest silence, no phantom pre-roll peak).
            if (muteCount > 0) {
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    std::memset(outputChannelData[ch], 0,
                                sizeof(float) * static_cast<size_t>(muteCount));
                peak = 0.0f;   // the pre-mute loose per-source bounds are discarded with the window
            }
            // M4 output stage FIRST (post-graph, post-mute, pre-device — the
            // D3 anchor): the truth pass below measures the POST-limiter
            // buffer, so the session peak is the device truth and the clip
            // count is the re-anchored defect counter.
            processOutputLimiter(outputChannelData, numOutputChannels, numSamples);
            // Stage 3d-4: the session peak is measured on the SUMMED device
            // buffer (Σ instances + synth), NOT per-source — two 0.79 sources
            // are a 1.57 mix, and the receipt must say so. Single-source peaks
            // above are a loose lower bound only; this pass is the truth.
            // Milestone 2 output guard: the clip counter folds into the same
            // pass (one compare per sample — no extra pass). Post-M4 this pass
            // is POST-limiter: nonzero counts name a limiter defect.
            for (int s = 0; s < numSamples; ++s) {
                float mx = 0.0f;
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    mx = std::max(mx, std::abs(outputChannelData[ch][s]));
                peak = std::max(peak, mx);
                if (mx > 1.0f) ++bufClips;   // M2 output guard: post-sum unity violation
            }
            if (bufClips > 0)
                g_clipCount.fetch_add(bufClips, std::memory_order_relaxed);
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
        g_deviceStarted.store(true, std::memory_order_release);   // M1-hotfix: worker-side prepare reads this
        // Milestone 1: the graph re-prepares on the MESSAGE THREAD (the
        // vendor's discipline — the Nodes table and the rebuild are
        // message-thread objects; the old device-thread per-instance loop is
        // gone). This job runs AFTER any queued topology jobs (MM FIFO), so
        // a commit racing the device start lands before the reconfigure.
        // Until the job runs, the vendor's settings guard renders the graph
        // SILENT rather than wrong-config (the mismatch branch of
        // AudioProcessorGraph::processBlock) — an honest, bounded blip.
        ensureScratch(static_cast<size_t>(device->getCurrentBufferSizeSamples()));
        const double rate = device->getCurrentSampleRate();
        const int buf = static_cast<int>(device->getCurrentBufferSizeSamples());
        const std::string devName = device->getName().toStdString();
        const std::string devType = device->getTypeName().toStdString();
        // The playhead's address is stable for the process (the global
        // callback object — the same one-address guarantee Stage 3e-2 built).
        EnginePlayHead* ph = &playHead;
        juce::MessageManager::callAsync([rate, buf, devName, devType, ph] {
            MmNamedJob _mmNamedJob("audioDeviceReconfigure");   // field-gate B-2
            if (g_host.graph() == nullptr) {
                engineLog("[audio] device start — no host graph (nothing hosted yet): reconfigure skipped");
                return;
            }
            const auto t0 = std::chrono::steady_clock::now();
            // The vendor's reconfigure: per-node playhead re-assert + bus
            // negotiation (0-in/2-out) + output buses re-enabled (the
            // negotiation disables non-main buses — the engine's ordering),
            // then graph prepareToPlay (sync on the MM — every node prepared
            // at the device settings).
            g_host.reconfigureForDevice(rate, buf, ph);
            // DIAG site 2: the graph object's state right after the re-prepare
            // (message thread). graphLat is written ONLY by a render-sequence
            // build — 128 here means a plugin-containing sequence was built at
            // these settings; 0 means the graph object never rebuilt.
            if (auto* g = g_host.graph())
                engineLog("[host-core] DIAG site2 post-reconfigure graphSR=" +
                          std::to_string(static_cast<int>(g->getSampleRate())) +
                          " graphBlock=" + std::to_string(g->getBlockSize()) +
                          " graphLat=" + std::to_string(g->getLatencySamples()) +
                          " graphOutCh=" + std::to_string(g->getTotalNumOutputChannels()) +
                          " graphNodes=" + std::to_string(g->getNumNodes()));
            // Milestone 2: walk the LIVE SET — per-instance meta refresh +
            // per-slot mirror publish + the AboutToStart latency line per
            // instance (the legacy single line generalized; the D3 single-
            // instance assertion sees the same figures for its one instance).
            int slot = -1;
            for (HostedPlugin* h : liveSetSnapshot()->bySlot) {
                ++slot;
                if (h == nullptr || h->rawInstance.load(std::memory_order_acquire) == nullptr)
                    continue;
                const int lat = static_cast<int>(
                    h->rawInstance.load(std::memory_order_acquire)->getLatencySamples());
                // ONE-WRITE discipline: the meta refresh lands BEFORE the
                // published mirror (the 3j field invariant).
                h->latencySamples = static_cast<double>(lat);
                const int prevMirror = g_slotLatencySamples[slot].load(std::memory_order_acquire);
                g_slotLatencySamples[slot].store(lat, std::memory_order_release);
                const double devMs = static_cast<double>(buf) / rate * 1000.0;
                const double plugMs = static_cast<double>(lat) / rate * 1000.0;
                std::cout << "[engine] latency: device=" << devMs << "ms plugin=" << plugMs
                          << "ms total=" << (devMs + plugMs) << "ms instance=" << h->instanceId << std::endl;
                engineLog("[plugin] prepared rate=" + std::to_string(static_cast<int>(rate)) +
                          " buffer=" + std::to_string(buf) +
                          " latencySamples=" + std::to_string(lat) +
                          " instance=" + h->instanceId +
                          " (device actual: \"" + devName + "\" type=" + devType + ")");
                // Stage 3i — THIRD PRODUCER (preserved): the re-prepare may
                // have changed the plugin's reported latency; feed the same
                // enqueue path so the published mirror (what the F4 shift and
                // the pre-roll snapshot read) follows through the republish.
                if (lat != prevMirror ||
                    lat != g_pluginLatencySamples.load(std::memory_order_acquire))
                    latencyTryEnqueue(h->instanceId, lat);
            }
            republishMaxLatencyMirror();
            const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - t0).count();
            engineLog("[audio] graph re-prepared rate=" + std::to_string(static_cast<int>(rate)) +
                      " buffer=" + std::to_string(buf) + " elapsed=" + std::to_string(ms) + "ms" +
                      " (device actual: \"" + devName + "\" type=" + devType + ")");
        });
    }

    void audioDeviceStopped() override {}

    // ── M4 output stage (D3): post-graph, pre-device, audio-thread-only. ──
    // Gain computed from a stereo-LINKED envelope (max across channels);
    // per-sample g guarantees |out| = g*|in| <= mapped(env) <= ceiling with
    // zero lookahead (g is derived from the SAME sample's link). One exp()
    // per BUFFER (rate-derived decay), one log10/pow10 per sample ONLY above
    // the knee — healthy signals never pay. R-A: the envelope floor fires
    // every sample (see the M4 block receipt).
    void processOutputLimiter(float* const* chData, int numCh, int numSamples) {
        if (g_limiterBypassed.load(std::memory_order_relaxed)) return;
        const double rate = g_engine.sampleRate.load(std::memory_order_relaxed);
        const float decay = rate > 0.0
            ? static_cast<float>(std::exp(-1000.0 / (kLimiterReleaseMs * rate)))
            : 0.99974f;
        const float kneeStart = std::pow(10.0f, kLimiterKneeStartDb / 20.0f);
        const float twoW = 2.0f * kLimiterKneeWidthDb;
        float bufGrDb = 0.0f;
        for (int s = 0; s < numSamples; ++s) {
            float link = 0.0f;
            for (int ch = 0; ch < numCh; ++ch)
                link = std::max(link, std::fabs(chData[ch][s]));
            limiterEnv = std::max(link, limiterEnv * decay);   // instant attack
            // R-A: the explicit denormal floor — EVERY sample, before any use.
            limiterEnv = std::max(limiterEnv, kLimiterEnvFloor);
            if (limiterEnv <= kneeStart) continue;   // below the knee: gain EXACTLY 1.0
            const float envDb = 20.0f * std::log10(limiterEnv);
            float g;
            if (envDb >= 0.5f * kLimiterKneeWidthDb) {
                g = 1.0f / limiterEnv;               // full clamp: out = ceiling exactly
            } else {
                const float over = envDb - kLimiterKneeStartDb;   // in [0, W]
                const float yDb = envDb - over * over / twoW;     // Zolzer soft knee
                g = std::pow(10.0f, (yDb - envDb) / 20.0f);
            }
            const float grDb = -20.0f * std::log10(std::max(g, kLimiterEnvFloor));
            if (grDb > bufGrDb) bufGrDb = grDb;
            for (int ch = 0; ch < numCh; ++ch) chData[ch][s] *= g;
        }
        g_limiterGrDb.store(bufGrDb, std::memory_order_relaxed);
        const float prevGr = g_limiterGrMaxDb.load(std::memory_order_relaxed);
        if (bufGrDb > prevGr) g_limiterGrMaxDb.store(bufGrDb, std::memory_order_relaxed);
    }

private:
    std::vector<float> synthScratch;              // synth contribution per buffer
    juce::MidiBuffer midiBuf;                     // reusable per-buffer MIDI (clear() keeps capacity)
    // Stage 3d-4: ONE reusable MidiBuffer PER SLOT (same steady-state
    // no-alloc contract) — each instance receives only its own events.
    juce::MidiBuffer instMidi[scorchhost::kMaxInstances];
    // Milestone 2: the graph render call's incoming buffer (EMPTY — the
    // shared MidiInOp path is retired; the selectors are the per-instance
    // MIDI path). Clear-per-buffer, capacity never grows.
    juce::MidiBuffer graphMidiIn;
    // M4 output stage: the envelope state. Audio-thread-owned (written and
    // read ONLY inside processOutputLimiter); initialized at the R-A floor so
    // the first buffer's decay multiply cannot start in denormal territory.
    float limiterEnv = kLimiterEnvFloor;

    // ── Milestone 1 silence diagnosis (the three instrumented sites) ──
    // One-shot [host-core] DIAG receipts; audio thread. Steady state (after
    // the receipts) is one counter increment per buffer; the probes allocate
    // ONLY on their one-shot blocks (1/8/64 + the first midi hand-off).
    //   site 1 — the MidiBuffer actually handed to the graph/node: any event
    //            with a NEGATIVE sample position = the F4 clamp rule (events
    //            never posted before buffer start; clamp to 0) did not
    //            survive the migration; corrupted input can masquerade as any
    //            downstream symptom, so this receipt gates the fix order.
    //   site 2 — the graph's re-prepare as the AUDIO THREAD sees it:
    //            getLatencySamples() is written ONLY by a render-sequence
    //            build (handleAsyncUpdate), so 128 proves a plugin-containing
    //            sequence was BUILT and SET; blocks 1/8/64 catch early-missing
    //            vs late-arriving sequences (device opens, then the MM job).
    //   site 3 — render-sequence membership + the through-connection: the live
    //            node in the table, wired to the OUTPUT node (MIDI wired in is
    //            not enough if audio has no path out), plus every node's
    //            channel/prepare/suspend state.
    int  diagRenderBlocks = 0;
    int  lastProbeNodes = -1;
    bool diagMidiProbed = false;

    void diagMidiHandoffProbe() {
        if (diagMidiProbed) return;
        int n = 0, neg = 0, minPos = 0;
        // Milestone 2: the hand-off surface is EVERY live slot's buffer (each
        // reaches its plugin through the selector) — the probe walks them all.
        for (int s = 0; s < scorchhost::kMaxInstances; ++s) {
            for (const auto& me : instMidi[s]) {
                ++n;
                if (me.samplePosition < 0) {
                    ++neg;
                    minPos = std::min(minPos, static_cast<int>(me.samplePosition));
                }
            }
        }
        if (n == 0) return;   // nothing dispatched into this buffer yet — keep watching
        diagMidiProbed = true;
        if (neg > 0)
            engineLog("[host-core] DIAG site1 midi-in NEGATIVE positions count=" +
                      std::to_string(neg) + " minS=" + std::to_string(minPos) +
                      " total=" + std::to_string(n) +
                      " — the F4 clamp (clamp-to-0 at buffer hand-off) did not survive the migration");
        else
            engineLog("[host-core] DIAG site1 midi-in clean: events=" + std::to_string(n) +
                      " negatives=0 (min sample position >= 0)");
    }

    void diagGraphProbe() {
        ++diagRenderBlocks;
        // Milestone 2: one receipt per TOPOLOGY CHANGE as the audio thread
        // sees it (node count transitions) — a mid-play add/remove whose
        // rebuild dropped a node/wiring is visible here within one buffer.
        if (lastProbeNodes != -1) {
            auto* gNow = g_host.graph();
            const int nNow = gNow ? gNow->getNumNodes() : -1;
            if (nNow != lastProbeNodes) {
                std::string det;
                if (gNow) {
                    det = " conns=" + std::to_string(gNow->getConnections().size());
                    for (auto* nd : gNow->getNodes())
                        if (auto* p = nd->getProcessor())
                        {
                            det += " uid" + std::to_string(nd->nodeID.uid) +
                                   "{in=" + std::to_string(p->getTotalNumInputChannels()) +
                                   " out=" + std::to_string(p->getTotalNumOutputChannels()) +
                                   " lat=" + std::to_string(p->getLatencySamples()) +
                                   std::string(p->isSuspended() ? " SUSPENDED" : "");
                            if (auto* sel = dynamic_cast<scorchhost::InstanceMidiSelector*> (p))
                                det += " SLOT=" + std::to_string(sel->slot);
                            det += "}";
                        }
                    // The MIDI wiring VERBATIM (selector → plugin pairs) — a
                    // cross-wired selector feed is visible here.
                    for (const auto& cn : gNow->getConnections())
                        if (cn.source.isMIDI())
                            det += " midi:uid" + std::to_string(cn.source.nodeID.uid) +
                                   "->uid" + std::to_string(cn.destination.nodeID.uid);
                }
                engineLog("[host-core] DIAG topology change: graphNodes=" + std::to_string(nNow) + det);
            }
        }
        lastProbeNodes = [&] { auto* gNow = g_host.graph(); return gNow ? gNow->getNumNodes() : -1; }();
        if (diagRenderBlocks != 1 && diagRenderBlocks != 8 && diagRenderBlocks != 64) return;
        auto* g = g_host.graph();
        if (g == nullptr) {
            engineLog("[host-core] DIAG render-block n=" + std::to_string(diagRenderBlocks) +
                      " graph=null live=" + std::to_string(g_host.live() ? 1 : 0));
            return;
        }
        std::string nodes;
        // Milestone 2: the audio-wired path check is per INSTANCE (each live
        // instance's node → output), no single "live" node any more.
        const auto outID = g_host.outputNodeID();
        int liveInstances = 0, wiredInstances = 0;
        if (auto set = liveSetSnapshot()) {
            for (HostedPlugin* m : set->bySlot) {
                if (m == nullptr) continue;
                ++liveInstances;
                if (outID.uid != 0 && g->isConnected(m->nodeID, outID)) ++wiredInstances;
            }
        }
        for (auto* nd : g->getNodes())
            if (auto* p = nd->getProcessor())
                nodes += " uid" + std::to_string(nd->nodeID.uid) + "{in=" +
                         std::to_string(p->getTotalNumInputChannels()) +
                         " out=" + std::to_string(p->getTotalNumOutputChannels()) +
                         " sr=" + std::to_string(static_cast<int>(p->getSampleRate())) +
                         " blk=" + std::to_string(p->getBlockSize()) +
                         " lat=" + std::to_string(p->getLatencySamples()) +
                         std::string(p->isSuspended() ? " SUSPENDED" : "") + "}";
        engineLog("[host-core] DIAG render-block n=" + std::to_string(diagRenderBlocks) +
                  " graphSR=" + std::to_string(static_cast<int>(g->getSampleRate())) +
                  " graphBlock=" + std::to_string(g->getBlockSize()) +
                  " graphLat=" + std::to_string(g->getLatencySamples()) +
                  " graphOutCh=" + std::to_string(g->getTotalNumOutputChannels()) +
                  " graphNodes=" + std::to_string(g->getNumNodes()) +
                  " liveInstances=" + std::to_string(liveInstances) +
                  " wiredToOut=" + std::to_string(wiredInstances) +
                  " conns=" + std::to_string(static_cast<int>(g->getConnections().size())) +
                  " devSR=" + std::to_string(static_cast<int>(g_engine.sampleRate.load())) +
                  " devBlock=" + std::to_string(g_deviceBufferSize.load()) +
                  " |" + nodes);
    }

public:
    // Stage 3e-2: the playhead every hosted instance sees. One stable address
    // (g_audioCallback is a namespace-level global); loadHostedPlugin and the
    // worker prepare paths hand &playHead to every instance. Public — the
    // hosting code lives outside this class.
    EnginePlayHead playHead;

    // Milestone 2: publish the per-slot buffer addresses to the selectors
    // (called ONCE from main(); the addresses are stable for the process).
    void bindSelectorSources() {
        for (int s = 0; s < scorchhost::kMaxInstances; ++s)
            scorchhost::g_selectorMidiSource[s].store(&instMidi[s], std::memory_order_release);
    }

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

    // Milestone 1/2: renderPlugin is GONE — the vendored graph renders every
    // live instance (main bus → master stereo wiring in HostCore::addPluginNode)
    // and the output gain/safety stage stays deferred. M2's TEMPORARY output
    // guard: unity (no multiplication — --plugin-gain accepted, inert,
    // receipt-named) + the clip counter + per-render peak receipts (the peak
    // truth pass + g_clipCount above; the worker janitor speaks them). Per-bus
    // output routing and the aux-bus master fold return with the output-stage
    // milestone.

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
                    const std::shared_ptr<const InstanceSet>& liveSet,
                    const bool* slotRendering,
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
        // built-in test synth. Milestone 2: the owning slot is resolved from
        // the buffer-start set snapshot (wide channel → slot → meta); a slot
        // that raced a retire drops the event, never crashes.
        if (toPlugin && liveSet) {
            const int slot = slotOfWide(ev.channel);
            HostedPlugin* h = nullptr;
            if (slot >= 0 && slot < scorchhost::kMaxInstances && slotRendering[slot])
                h = liveSet->bySlot[slot];
            if (h == nullptr || h->rawInstance.load(std::memory_order_acquire) == nullptr)
                return;   // raced a retire: drop, never crash
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

// Milestone 2: the selector source table is DEFINED at global scope right after
// the AudioHostCore.h include (a namespace-sounding member cannot be defined
// inside the anonymous namespace — see the definition site).

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

#ifdef _WIN32
    // D13: the M1 audio AV contract keeps its carve-out — device-init AVs on
    // THIS thread pass through the first-chance vehFilter to the /EHa
    // catch(...) below (clean no_audio_device protocol error, CI Test B).
    scorchcrash::AudioSehProbeScope _audioSehProbeGuard;
#endif
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
                engineLog(std::string("[audio] output guard (M2): unity — no multiplication (--plugin-gain accepted, inert; requested x") +
                          gainBuf + ") | clip counter " +
                      std::to_string(g_clipCount.load(std::memory_order_relaxed)) +
                      " | latency compensation " +
                          std::to_string(g_pluginLatencySamples.load(std::memory_order_relaxed)) +
                          " samples (max across live instances; plugin-reported)");
                // M4 (D5): the one-shot armed receipt — named at every device
                // open, ASCII-only (the D7 Windows grep lesson).
                engineLog(limiterArmedReceipt());
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
            engineLog(std::string("[audio] output guard (M2): unity — no multiplication (--plugin-gain accepted, inert; requested x") +
                      gainBuf + ") | clip counter " +
                      std::to_string(g_clipCount.load(std::memory_order_relaxed)) +
                      " | latency compensation " +
                      std::to_string(g_pluginLatencySamples.load(std::memory_order_relaxed)) +
                      " samples (max across live instances; plugin-reported)");
            // M4 (D5): the one-shot armed receipt — named at every device
            // open, ASCII-only (the D7 Windows grep lesson).
            engineLog(limiterArmedReceipt());
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
// D14 receipt debt: the failed scan row carries the plugin NAME — the
// receipt names the failed plugin, not just its path. A .vst3 BUNDLE (a
// directory) is named by the bundle; a flat DLL by the file basename.
static std::string scanRowNameFor(const std::string& path) {
    const auto slash = path.find_last_of("/\\");
    std::string base = (slash == std::string::npos) ? path : path.substr(slash + 1);
    if (base.size() > 5) {
        std::string tail = base.substr(base.size() - 5);
        for (auto& c : tail) if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        if (tail == ".vst3") base.erase(base.size() - 5);
    }
    return base;
}

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
                      "\",\"name\":\"" + escape_json(scanRowNameFor(path)) +
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

// ─── TASK I — the module-guard: no module unload while a window's WNDPROC ───
// lives in that module. Verdict being acted on (TASK F, dump
// 20261021-075340): user32 message dispatch called a WNDPROC whose code
// region was already unmapped (0xC0000005 EXECUTE at RIP=the window's proc,
// inside user32 dispatch). The audit (docs/wndproc-audit.md) reduced the
// in-process unload inventory to ONE site: the hosted plugin DLL, freed by
// JUCE's VST3 module-handle cache when the last instance of its path retires
// (the D5 CI finding) — and the windows that can carry a WNDPROC inside it
// are the plugin's own: its editor tree, and — the ghost — the infrastructure
// window of the plugin DLL's PRIVATE JUCE copy (the fixture is JUCE-linked;
// its second MessageManager boots at the load's hasEditor view probe and
// survives until the DLL's loader-lock static teardown at FreeLibrary, where
// DestroyWindow is documented-unreliable). The guard runs BEFORE the free
// trigger: any window whose WNDPROC resolves into the retiring plugin's path
// gets its dispatch detached into user32 (DefWindowProcW — never unmaps); a
// window that cannot be detached PINS its module (GetModuleHandleExW PIN —
// the code region can never unmap; the leak is the safe failure, receipted).
// Windows-only: the crash class is user32 dispatch into unmapped code.
#ifdef _WIN32
namespace scorchguard {

// The load path currently being instantiated (the pre-commit instance holds
// a module-cache reference the live set cannot see). Set inside
// loadHostedPlugin, cleared at its scope exit; the orphan gate reads it so a
// same-path replace never sweeps the INCOMING instance's windows.
std::mutex g_loadPathMutex;
std::string g_loadInFlightPath;

std::string wideToUtf8(const wchar_t* w) {
    if (w == nullptr) return {};
    return juce::String(w).toStdString();
}

// TASK J: the machinery carries module paths as std::wstring — overload so
// the receipt concatenations compile (the C2664 the db03aae acceptance run
// named: wideToUtf8(w.module) at the teardown/verify sites).
std::string wideToUtf8(const std::wstring& w) {
    return wideToUtf8(w.c_str());
}

std::wstring utf8ToWide(const std::string& s) {
    const juce::String js(s.c_str());
    return std::wstring(static_cast<const wchar_t*>(js.toUTF16()));
}

// Case-insensitive, slash-normalized comparison key; a trailing separator is
// stripped so a bundle DIRECTORY path prefixes its inner DLL path cleanly.
std::wstring pathKey(const std::wstring& p) {
    std::wstring k;
    k.reserve(p.size());
    for (const wchar_t c : p) {
        wchar_t lc = c;
        if (lc >= L'A' && lc <= L'Z') lc = lc - L'A' + L'a';
        k.push_back(lc == L'/' ? L'\\' : lc);
    }
    while (!k.empty() && k.back() == L'\\') k.pop_back();
    return k;
}

std::string hexAddr(uintptr_t v) {
    char buf[32];
    std::snprintf(buf, sizeof(buf), "0x%llx", static_cast<unsigned long long>(v));
    return buf;
}

// thread_local: the MM thread (retire) and the init worker (load-abort) can
// sweep concurrently — EnumWindows/EnumThreadWindows call back ON the calling
// thread, so the collection pointer never crosses threads.
thread_local std::vector<HWND>* g_sweepOut = nullptr;

BOOL CALLBACK sweepChildEnumProc(HWND hwnd, LPARAM) {
    g_sweepOut->push_back(hwnd);
    EnumChildWindows(hwnd, sweepChildEnumProc, 0);   // recurse the full tree
    return TRUE;
}

BOOL CALLBACK sweepTopEnumProc(HWND hwnd, LPARAM) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == GetCurrentProcessId()) {
        g_sweepOut->push_back(hwnd);
        EnumChildWindows(hwnd, sweepChildEnumProc, 0);
    }
    return TRUE;
}

BOOL CALLBACK sweepThreadEnumProc(HWND hwnd, LPARAM) {
    // Message-only windows (the JUCE-infrastructure shape) are invisible to
    // EnumWindows; every thread of this process contributes them here.
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == GetCurrentProcessId()) {
        g_sweepOut->push_back(hwnd);
        EnumChildWindows(hwnd, sweepChildEnumProc, 0);
    }
    return TRUE;
}

std::vector<HWND> collectProcessWindows() {
    std::vector<HWND> out;
    g_sweepOut = &out;
    EnumWindows(sweepTopEnumProc, 0);
    const HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        THREADENTRY32 te {};
        te.dwSize = sizeof(te);
        if (Thread32First(snap, &te)) {
            do {
                if (te.th32OwnerProcessID != GetCurrentProcessId()) continue;
                EnumThreadWindows(te.th32ThreadID, sweepThreadEnumProc, 0);
            } while (Thread32Next(snap, &te));
        }
        CloseHandle(snap);
    }
    g_sweepOut = nullptr;
    return out;
}

// ─── TASK J root fix — the teardown machinery (design R1/R2, audit item W5) ──
// The brief: "everywhere: destroy windows → drain/pump pending messages →
// then unload the module." The only window that can outlive its module is W5
// (docs/window-module-lifecycle.md §2) — the plugin DLL's private JUCE
// infrastructure window, owned by whichever thread first touched the plugin's
// GUI stack (in CI: the init worker, via the load's hasEditor view probe,
// main.cpp's load-path comment names the exact point). The machinery:
// classify the retiring module's windows by owning thread; destroy each on
// its OWNER thread (DestroyWindow is same-thread-or-fail — the cross-thread
// destroy inside the DLL's loader-lock static teardown is the confirmed
// silent-failure mechanism); drain the owning thread's queue (bounded) so
// pending messages dispatch while the module is still mapped; only then does
// the free become schedulable (the retire's phase 2). The demoted guard's
// fail-loud backstop lives in verifyForModule below (design R3).

struct ModuleWindow { HWND hwnd; DWORD tid; std::wstring module; };

// The init worker's thread id — set at plugin_init_thread start (the thread
// the load's view probe boots the plugin's private JUCE stack on, i.e. the
// W5 owner in CI). Zero until then (early retires have no worker-owned
// windows to hand over — the classify step treats 0 as "unknown owner").
std::atomic<uint32_t> g_initWorkerTid{0};

// Collect + classify: every window of this process whose WNDPROC's module
// file lives inside pluginPath (bundle-prefix match, case-insensitive — the
// same rule the guard has always used).
std::vector<ModuleWindow> collectModuleWindows(const std::string& pluginPath) {
    std::vector<ModuleWindow> out;
    const std::wstring wantKey = pathKey(utf8ToWide(pluginPath));
    if (wantKey.empty()) return out;
    for (const HWND hwnd : collectProcessWindows()) {
        const LONG_PTR proc = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
        if (proc == 0) continue;
        wchar_t modPath[MAX_PATH] = {};
        HMODULE mod = nullptr;
        if (GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                   GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                               reinterpret_cast<LPCWSTR>(proc), &mod) &&
            mod != nullptr)
            GetModuleFileNameW(mod, modPath, MAX_PATH);
        const std::wstring modKey = pathKey(std::wstring(modPath));
        if (modKey.empty() || modKey.rfind(wantKey, 0) != 0) continue;
        out.push_back({hwnd, GetWindowThreadProcessId(hwnd, nullptr), std::wstring(modPath)});
    }
    // DEDUPE (repro run 39679840849 receipt): a TOP-LEVEL window is enumerated
    // by BOTH EnumWindows and EnumThreadWindows (the collector's two passes) —
    // the same ghost hwnd was listed twice per sweep (windows=2 for ONE
    // physical window). Destroying an already-destroyed hwnd is harmless, but
    // the receipts and counts must speak the truth: one window, one destroy.
    std::sort(out.begin(), out.end(),
              [](const ModuleWindow& a, const ModuleWindow& b) { return a.hwnd < b.hwnd; });
    out.erase(std::unique(out.begin(), out.end(),
                          [](const ModuleWindow& a, const ModuleWindow& b) { return a.hwnd == b.hwnd; }),
              out.end());
    return out;
}

// Same-thread destroy + bounded drain (audit item W5). Valid ONLY on the
// window-owning thread: DestroyWindow delivers WM_DESTROY/WM_NCDESTROY
// inline, and the drain then DISPATCHES whatever was already queued for this
// thread's windows while the module is still mapped — the brief's
// "drain/pump pending messages" before the unload. Bounded: 256 messages.
// Skips (never destroys) windows whose owner is not the calling thread —
// ownership was verified at classification, re-verified here against the
// live window (a window can die between collect and destroy).
int destroyAndDrainOnThisThread(const std::vector<ModuleWindow>& wins,
                                const std::string& iid, const std::string& path) {
    const DWORD self = GetCurrentThreadId();
    int destroyed = 0;
    // D14 teardown bound: the whole destroy+drain step is ONE stamped op —
    // a plugin wedging inside WM_DESTROY is a named overrun receipt, not a
    // silent hang (the D13 watchdog remains the forensic backstop).
    captureBoundStamp(g_windowOpBound, "teardown-destroy", iid,
                      "module windows destroy+drain on the owner thread");
    for (const ModuleWindow& w : wins) {
        if (w.tid != self) continue;   // not ours — never DestroyWindow cross-thread
        // THE 445e7cf RUN'S BUG (acceptance 39687874816: 46 retires, every
        // window classified current-thread-owned, ZERO destroyed, all
        // pinned): GetWindowThreadProcessId's OUT-PARAM receives the PROCESS
        // id and its RETURN is the owning THREAD id — the old re-check
        // compared the process id against the thread id and skipped every
        // window. The RETURN is the re-check.
        const DWORD liveTid = GetWindowThreadProcessId(w.hwnd, nullptr);
        if (liveTid == 0 || liveTid != self) continue;
        const BOOL ok = DestroyWindow(w.hwnd);
        ++destroyed;
        engineLog(std::string("[module-teardown] destroyed hwnd=") + hexAddr(reinterpret_cast<uintptr_t>(w.hwnd)) +
                  " thread=" + std::to_string(self) +
                  " (current-thread destroy — WM_DESTROY delivered inline) ok=" + (ok ? "1" : "0") +
                  " instance=" + iid + " module=" + wideToUtf8(w.module));
    }
    if (destroyed == 0) { captureBoundClear(g_windowOpBound); return 0; }
    int drained = 0;
    MSG msg;
    while (drained < 256 && PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
        ++drained;
    }
    if (drained > 0)
        engineLog("[module-teardown] drained " + std::to_string(drained) +
                  " queued message(s) on thread " + std::to_string(self) +
                  " while the module is still mapped instance=" + iid + " module=" + path);
    captureBoundClear(g_windowOpBound);
    return destroyed;
}

// The shared-ownership lock (the brief's refcount/lock clause), factored:
// true = no live instance and no in-flight load shares the path, so the
// module CAN free — and only then may its windows be torn down (a live
// instance keeps its windows; JUCE's module-cache refcount keeps the module
// mapped for it). Logs the orphan=no receipt itself.
bool moduleIsOrphaned(const std::string& iid, const std::string& pluginPath, const char* why) {
    int samePath = 0;
    if (auto set = liveSetSnapshot()) {
        for (HostedPlugin* m : set->bySlot) {
            if (m == nullptr || m->instanceId == iid) continue;
            if (m->rawInstance.load(std::memory_order_acquire) == nullptr) continue;
            if (_stricmp(m->path.c_str(), pluginPath.c_str()) == 0) ++samePath;
        }
    }
    bool sameLoadInFlight = false;
    {
        std::lock_guard<std::mutex> lock(g_loadPathMutex);
        sameLoadInFlight = g_pluginLoadActive.load(std::memory_order_acquire) &&
                           _stricmp(g_loadInFlightPath.c_str(), pluginPath.c_str()) == 0;
    }
    if (samePath > 0 || sameLoadInFlight) {
        engineLog(std::string("[module-teardown] ") + why + " instance=" + iid + " orphan=no (" +
                  std::string(samePath > 0
                                  ? std::to_string(samePath) + " live instance(s) share the module"
                                  : "a same-path load is in flight — its instance holds the module ref") +
                  ") — the module cannot free; teardown skipped");
        return false;
    }
    return true;
}

// The worker job queue: retires of DIFFERENT modules can overlap (retireAll
// loops); each carries its own window subset + its own MM continuation.
struct TeardownJob {
    std::string iid;
    std::string path;
    std::vector<ModuleWindow> windows;   // the worker-owned subset
    std::function<void()> onDone;        // runs on the MM after the ack
};
std::mutex g_teardownMutex;
std::vector<TeardownJob> g_teardownQueue;

// Worker-side pump — called from the init worker's loop each pass (~100 ms
// cadence). Destroys the job's windows on THIS thread (the owner), drains,
// acks via the MM continuation (callAsync — phase 2 is always a fresh MM
// dispatch). If the worker is mid-load, the job waits for the next pass: the
// continuation (and thus the node removal that schedules the free) lands
// later — ordering is never violated, only deferred.
void runPendingTeardownJobs() {
    std::vector<TeardownJob> jobs;
    {
        std::lock_guard<std::mutex> lock(g_teardownMutex);
        jobs.swap(g_teardownQueue);
    }
    for (TeardownJob& job : jobs) {
        const int destroyed = destroyAndDrainOnThisThread(job.windows, job.iid, job.path);
        engineLog("[module-teardown] worker ack instance=" + job.iid + " module=" + job.path +
                  " destroyed=" + std::to_string(destroyed) + " of " +
                  std::to_string(job.windows.size()) + " handed window(s) (a window the worker does not own is named in the found receipts and refused by the phase-2 verify)");
        if (job.onDone) juce::MessageManager::callAsync(std::move(job.onDone));
    }
}

// MM phase-1 (design R1): the orphan gate, then destroy what the CALLING
// thread owns (synchronous — WM_DESTROY is inline), hand the init worker the
// rest, and schedule onDone on the MM (via callAsync — phase 2 is always a
// fresh dispatch, never inline re-entry). Windows owned by any OTHER thread
// (a plugin's own window thread — W7 in the audit map) are left for
// verifyForModule's fail-loud backstop. onDone runs even on every
// short-circuit — phase 2 must always happen.
void beginModuleTeardown(const std::string& iid, const std::string& pluginPath,
                         const char* why, std::function<void()> onDone) {
    if (!moduleIsOrphaned(iid, pluginPath, why)) {
        if (onDone) juce::MessageManager::callAsync(std::move(onDone));
        return;
    }
    const std::vector<ModuleWindow> wins = collectModuleWindows(pluginPath);
    std::vector<ModuleWindow> workerOwned;
    const DWORD self = GetCurrentThreadId();
    const uint32_t workerTid = g_initWorkerTid.load(std::memory_order_acquire);
    int directCount = 0;
    for (const ModuleWindow& w : wins) {
        // OBSERVABILITY (the d7f5778 acceptance run's lesson: phase 1 printed
        // destroyed=0 handed-to-worker=0 while phase 2 pinned the ghost 15 ms
        // later - the per-window classification was invisible). One line per
        // found window, with the classification and the stored worker tid.
        const char* klass = w.tid == self ? "current-thread-owned (destroyed on this thread)"
                          : (workerTid != 0 && w.tid == static_cast<DWORD>(workerTid))
                                ? "init-worker-owned (handed to the worker)"
                                : "other-owner (handed to the worker; the worker destroys it only if it owns it - else phase 2 refuses the unload)";
        engineLog(std::string("[module-teardown] found hwnd=") +
                  hexAddr(reinterpret_cast<uintptr_t>(w.hwnd)) +
                  " thread=" + std::to_string(w.tid) +
                  " workerTid=" + std::to_string(workerTid) +
                  " module=" + wideToUtf8(w.module) +
                  " - " + klass);
        if (w.tid == self) { ++directCount; continue; }
        // EVERY non-MM window is handed to the worker - the worker
        // re-verifies ownership per window (destroyAndDrainOnThisThread only
        // ever destroys windows of ITS OWN thread) and the job receipt names
        // anything it had to leave. This removes the g_initWorkerTid
        // single-point-of-failure from the destroy path: a window owned by
        // the init worker is destroyed even if the stored tid were stale or
        // zero; a window owned by a foreign plugin thread cannot be
        // destroyed from here at all and lands in phase 2's fail-loud pin.
        workerOwned.push_back(w);
    }
    const size_t workerCount = workerOwned.size();
    int destroyedDirect = 0;
    if (directCount > 0)
        destroyedDirect = destroyAndDrainOnThisThread(wins, iid, pluginPath);
    engineLog(std::string("[module-teardown] ") + why + " instance=" + iid +
              " module=" + pluginPath + " found=" + std::to_string(wins.size()) +
              " calling-thread destroyed=" + std::to_string(destroyedDirect) +
              " handed-to-worker=" + std::to_string(workerCount) +
              " (destroy windows + drain BEFORE the node removal schedules the free)");
    if (workerCount > 0) {
        TeardownJob job;
        job.iid = iid;
        job.path = pluginPath;
        job.windows = std::move(workerOwned);
        job.onDone = std::move(onDone);
        {
            std::lock_guard<std::mutex> lock(g_teardownMutex);
            g_teardownQueue.push_back(std::move(job));
        }
        return;   // the worker's ack continues via callAsync
    }
    if (onDone) juce::MessageManager::callAsync(std::move(onDone));
}

// THE DEMOTED GUARD (design R3, audit item §3): the fail-loud backstop.
// Runs AFTER the teardown (destroy+drain) and BEFORE the free becomes
// schedulable. Every window still living in the module is a teardown-order
// DEFECT: log loudly and PIN the module (GetModuleHandleExW PIN — the
// refuse-unload semantics: the FreeLibrary becomes a refcount decrement that
// can never unmap). The leak is the safe failure, receipted; the crash class
// stays structurally closed. NO detach — the guard never carries the
// teardown again (the brief: "never the load-bearing mechanism").
void verifyForModule(const std::string& iid, const std::string& pluginPath, const char* why) {
    if (!moduleIsOrphaned(iid, pluginPath, why)) return;
    const std::vector<ModuleWindow> wins = collectModuleWindows(pluginPath);
    int pinned = 0, failed = 0;
    for (const ModuleWindow& w : wins) {
        engineLog(std::string("[module-guard] TEARDOWN-ORDER RESIDUE hwnd=") +
                  hexAddr(reinterpret_cast<uintptr_t>(w.hwnd)) +
                  " thread=" + std::to_string(w.tid) +
                  " module=" + wideToUtf8(w.module) +
                  " — the destroy+drain did not clear this window; REFUSING the unload");
        const LONG_PTR proc = GetWindowLongPtrW(w.hwnd, GWLP_WNDPROC);
        HMODULE pinMod = nullptr;
        if (proc != 0 &&
            GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                                   GET_MODULE_HANDLE_EX_FLAG_PIN,
                               reinterpret_cast<LPCWSTR>(proc), &pinMod) &&
            pinMod != nullptr) {
            ++pinned;
            engineLog("[module-guard] PINNED module=" + wideToUtf8(w.module) +
                      " — stays mapped for process life (safe leak, unmapped dispatch impossible)");
        } else {
            ++failed;
            engineLog("[module-guard] UNRESOLVED hwnd=" + hexAddr(reinterpret_cast<uintptr_t>(w.hwnd)) +
                      " module=" + wideToUtf8(w.module) +
                      " — PIN failed (err=" + std::to_string(GetLastError()) +
                      ") — the crash window stays armed; the next dump names this module");
        }
    }
    engineLog(std::string("[module-guard] ") + why + " instance=" + iid + " orphan=yes windows=" +
              std::to_string(wins.size()) + " pinned=" + std::to_string(pinned) +
              " failed=" + std::to_string(failed) + " module=" + pluginPath +
              (wins.empty()
                   ? " — teardown verified: no window's WNDPROC lives in the module; the free may proceed"
                   : " — TEARDOWN-ORDER RESIDUE: unload REFUSED (the module is pinned for process life; the leak is the safe failure)"));
}

// Load-abort teardown (design R2, audit item §3-load-abort): same-thread
// destroy + drain, then the verify backstop. Runs on the init worker — the
// same thread the load's view probe booted the plugin's private JUCE stack
// on — so the DLL's loader-lock static teardown at the destructor's
// FreeLibrary finds its window already gone.
void teardownModuleWindowsForLoadAbort(const std::string& iid, const std::string& pluginPath) {
    if (!moduleIsOrphaned(iid, pluginPath, "load-abort")) return;
    const std::vector<ModuleWindow> wins = collectModuleWindows(pluginPath);
    const int destroyed = destroyAndDrainOnThisThread(wins, iid, pluginPath);
    engineLog("[module-teardown] load-abort instance=" + iid + " module=" + pluginPath +
              " destroyed=" + std::to_string(destroyed) + " of " + std::to_string(wins.size()) +
              " window(s) on this thread (the free runs here — same-thread teardown before FreeLibrary)");
    verifyForModule(iid, pluginPath, "load-abort");
}

} // namespace scorchguard
#endif // _WIN32

// Host a VST3 by id/path (Stage 3c-2; 3d-4: one INSTANCE of possibly many —
// identity = the frontend's libraryGroup id, "hosted" for the legacy field).
// Stage 3e-3: routing (optional per-load outputRouting) rides in and lands
// on the immutable instance before publish. Returns "" on success, else a
// human-readable detail.
std::string loadHostedPlugin(const juce::var& pluginVar, const std::string& instanceId,
                             int slot,
                             std::unique_ptr<HostedPlugin>& out,
                             std::vector<BusRouting> routing = {},
                             bool multiTimbral = false,
                             std::string* resolvedPathOut = nullptr) {
    juce::DynamicObject* pobj = pluginVar.getDynamicObject();
    if (pobj == nullptr) return "plugin field must be an object";
    const std::string path = pobj->getProperty("path").toString().toStdString();
    const std::string uid = pobj->getProperty("uid").toString().toStdString();
    if (path.empty()) return "plugin.path is required";
    if (resolvedPathOut != nullptr) *resolvedPathOut = path;   // D13: the pre-commit destroy-ordering guard needs the module path
    if (instanceId.empty()) return "plugin.instanceId is required (multi-instance hosting)";
    try {
#ifdef _WIN32
        // TASK I: announce the load path for the module-guard's orphan gate —
        // a pre-commit instance holds a module-cache reference the live set
        // cannot see, and a same-path replace must never sweep the INCOMING
        // instance's windows out from under it.
        struct LoadPathAnnounce {
            explicit LoadPathAnnounce(const std::string& p) {
                std::lock_guard<std::mutex> lock(scorchguard::g_loadPathMutex);
                scorchguard::g_loadInFlightPath = p;
            }
            ~LoadPathAnnounce() {
                std::lock_guard<std::mutex> lock(scorchguard::g_loadPathMutex);
                scorchguard::g_loadInFlightPath.clear();
            }
        } loadPathAnnounce(path);
#endif
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
#ifdef _WIN32
        // TASK J root fix (design R2, audit item §3-load-abort): any death
        // from HERE to the success commit leaves the instance engine-owned;
        // its destructor frees the DLL ON THIS THREAD (the worker). The
        // teardown runs at scope exit BEFORE that destruction (declared
        // after, so it destructs first): destroy the module's windows on
        // this — their OWNING — thread + drain, then the fail-loud verify.
        // A no-output-bus refusal or an exception during capability capture
        // (the view probe — the point where the plugin's private JUCE copy
        // boots its infrastructure window) both land here.
        struct PreCommitTeardownInst {
            const std::string* iidRef;
            const std::string* pathRef;
            const std::unique_ptr<juce::AudioPluginInstance>* instRef;
            ~PreCommitTeardownInst() {
                if (instRef->get() != nullptr)
                    scorchguard::teardownModuleWindowsForLoadAbort(*iidRef, *pathRef);
            }
        } preCommitTeardownInst{&instanceId, &path, &inst};
#endif
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
#ifdef _WIN32
        // TASK J root fix (design R2, audit item §3-load-abort): the same
        // teardown for the post-move window — a throw while `hosted` holds
        // the instance (the probe-queue or channel-table block) still frees
        // the DLL at scope exit, ON THIS THREAD. Runs BEFORE that destruction
        // (reverse declaration order).
        struct PreCommitTeardownHosted {
            const std::string* iidRef;
            const std::string* pathRef;
            const std::unique_ptr<HostedPlugin>* hostedRef;
            ~PreCommitTeardownHosted() {
                if (hostedRef->get() != nullptr && (*hostedRef)->instance != nullptr)
                    scorchguard::teardownModuleWindowsForLoadAbort(*iidRef, *pathRef);
            }
        } preCommitTeardownHosted{&instanceId, &path, &hosted};
#endif
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
        hosted->slot = slot;   // Milestone 2: the LEASED slot (wide-channel owner)
        hosted->multiTimbral = multiTimbral;   // M3 PR1: routing-validator flag
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
                      " — total " + std::to_string(totalOut) + "-out (milestone 1: the MAIN bus drives"
                      " the master via the host graph wiring; per-bus output routing is DEFERRED —"
                      " aux buses stay unconnected)");
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
                         std::vector<BusRouting> routing;   // 3e-3: optional outputRouting
                         bool multiTimbral = false; };   // M3 PR1: additive load flag
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
            ReqInstance r;
            r.instanceId = iid;
            // Milestone 2: the slot is LEASED (kept instances keep their slot
            // across diffs — wide channels, ledger and articulation state stay
            // stable; new instances lease the lowest free slot). The worker
            // honors this assignment at diff time. A full lease table refuses
            // the request here (protocol-shaped, same as any parse failure).
            r.slot = slotLeaseFor(iid);
            if (r.slot < 0) {
                channelsBad = true;
                channelsBadDetail = "too many plugin instances (max " +
                                    std::to_string(scorchhost::kMaxInstances) + " slots leased)";
                continue;
            }
            r.pluginVar = pv;
            r.stateB64 = po->getProperty("state").toString().toStdString();
            parseOutputRouting(po->getProperty("outputRouting"), r.routing);
            // M3 PR1: additive "multiTimbral":true (default false = the M2
            // single-timbral semantics, byte-stable). Absent = false.
            r.multiTimbral = static_cast<bool>(static_cast<double>(po->getProperty("multiTimbral")));
            reqInstances.push_back(std::move(r));
        }
    }
    // Milestone 1: "plugins" PRESENT AS AN ARRAY is itself meaningful — an
    // explicit EMPTY array is the unload request (host zero plugins). An
    // absent plugins field stays a score-only load (plugin stays resident —
    // the source-switch protection).
    const bool pluginsArraySent = obj->getProperty("plugins").isArray();
    const auto& pluginVar = obj->getProperty("plugin");
    if (!pluginsArraySent && pluginVar.getDynamicObject() != nullptr) {
        // Legacy single-plugin load → the reserved "hosted" instance. The
        // lease table keeps "hosted" at slot 0 (first lease) so wide == wire
        // channel, byte-stable with every pre-M2 receipt.
        ReqInstance r;
        r.instanceId = "hosted";
        r.slot = slotLeaseFor("hosted");
        if (r.slot < 0) {
            channelsBad = true;
            channelsBadDetail = "no free slot for the legacy instance (lease table full)";
        } else {
            r.pluginVar = pluginVar;
            r.stateB64 = pluginVar.getDynamicObject()->getProperty("state").toString().toStdString();
            parseOutputRouting(pluginVar.getDynamicObject()->getProperty("outputRouting"), r.routing);
            reqInstances.push_back(std::move(r));
        }
    }
    const bool pluginRequested = !reqInstances.empty();
    // Milestone 2: the >1-instance DEFERRAL is LIFTED — plugins[] may carry
    // up to kMaxInstances entries; the worker diffs the request against the
    // live set (kept / added / changed / removed) and hosts every entry.
    // Milestone 1 — EXPLICIT UNLOAD: {"plugins": []} (an empty ARRAY, not an
    // absent field) means "host zero plugins". Documented in ASSUMPTIONS.md.
    const bool unloadRequested = pluginsArraySent && !pluginRequested && !channelsBad;
    // D14 Fix B: additive "discardRetire":true — the caller marks this
    // request's outgoing retires discard-class (the field bench marks every
    // leg): no state capture runs on the retiring instances at all.
    const bool discardRetireRequested =
        static_cast<bool>(static_cast<double>(obj->getProperty("discardRetire")));

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
    int ownChClamped = 0;   // events whose own channel fell outside 1..16 and was substituted with 1 — NAMED in the [load] receipt, never silent
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
            if (ch < 1 || ch > 16) {
                // The own channel is inert for a ROUTED track (the routing
                // override replaces it at dispatch), but for an UNROUTED track
                // it IS the test-synth wire channel — so the substitution is
                // counted and NAMED in the [load] receipt (the same doctrine
                // as the skip counters above: substitutions are never silent).
                ++ownChClamped;
                ch = 1;
            }
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

    // ─── Milestone 2 — ROLLING-TRANSPORT CONTRACT (diff-based, replaces the
    // 3c-regression wholesale rejection) ──
    // A load whose plugin SET exactly matches the live set (every requested
    // instanceId is live with the SAME uid+path, and no live instance is
    // absent from the request) takes the routing-only reuse fast path —
    // milliseconds, no re-instantiate. ANY OTHER set is now APPLIED as a diff
    // while the transport keeps rolling: the worker retires only the removed/
    // changed nodes, instantiates only the added/changed entries, and the
    // vendor's lock-free render-sequence swap lands the topology without a
    // gap for the survivors (their processors stay in the new sequence,
    // prepared at identical settings — the M1-hotfix worker-side prepare
    // keeps the message-thread rebuild a cheap re-prepare). The old
    // load_rejected path is GONE: rejecting a mid-play plugin-set change was
    // the M1 shape of the empty-score regression, and the diff machinery +
    // worker-side prepare closed that class at its root.
    // ─── 0.9.2 — COALESCING (#5), checked BEFORE the guard ───
    // A request whose set matches a queued/in-flight init FOLDS into that
    // init's result instead of answering "reused" while an older init is
    // still outstanding (the field bug: later same-set reloads masked the
    // jammed seq-2 init via the reuse path — the reuse answer described the
    // OLD live instance while the in-flight init was about to replace it).
    // The fingerprint (iid|uid|path per entry) makes "same set" exact; a
    // folded request emits its terminal receipt immediately ("init
    // superseded: seq=NEW by=INFLIGHT") and is served by the in-flight
    // init's per-instance receipts (same instanceIds → same wire keys).
    bool midPlayReuse = false;
    bool pluginCoalesced = false;
    long long coalesceInto = 0;
    const std::string reqFingerprint = [&]() {
        std::string fp;
        if (!pluginRequested || channelsBad) return fp;
        for (const auto& r : reqInstances) {
            juce::DynamicObject* po = r.pluginVar.getDynamicObject();
            const std::string uid = po ? po->getProperty("uid").toString().toStdString() : "";
            const std::string path = po ? po->getProperty("path").toString().toStdString() : "";
            if (!fp.empty()) fp += ";";
            fp += r.instanceId + "|" + uid + "|" + path;
        }
        return fp;
    }();
    if (pluginRequested && !channelsBad) {
        coalesceInto = initRegistryFindMatching(reqFingerprint, seq);
        if (coalesceInto > 0) pluginCoalesced = true;
    }
    if (pluginRequested && !channelsBad && !pluginCoalesced && g_engine.playing.load()) {
        // Exact set match (both directions) vs the LIVE SET.
        auto set = liveSetSnapshot();
        bool exact = set != nullptr && liveInstanceCount() == static_cast<int>(reqInstances.size());
        std::string mismatch;
        if (exact) {
            for (const auto& r : reqInstances) {
                juce::DynamicObject* po = r.pluginVar.getDynamicObject();
                const std::string reqUid = po ? po->getProperty("uid").toString().toStdString() : "";
                const std::string reqPath = po ? po->getProperty("path").toString().toStdString() : "";
                HostedPlugin* h = findLiveInstance(r.instanceId);
                if (h == nullptr) { exact = false; mismatch = "instance \"" + r.instanceId + "\" is not hosted"; break; }
                if (h->uid != reqUid || h->path != reqPath) {
                    exact = false; mismatch = "instance \"" + r.instanceId + "\" changed binary"; break;
                }
            }
            if (exact) {
                for (HostedPlugin* h : set->bySlot) {
                    if (h == nullptr) continue;
                    bool requested = false;
                    for (const auto& r : reqInstances)
                        if (r.instanceId == h->instanceId) { requested = true; break; }
                    if (!requested) { exact = false; mismatch = "hosted instance \"" + h->instanceId + "\" absent from load"; break; }
                }
            }
        }
        if (exact) midPlayReuse = true;
        // NOT exact: the request QUEUES as a diff (below) — the transport is
        // never rejected for a set change any more (M2 contract; the runner
        // asserts the mid-play apply + continuity). `mismatch` documents the
        // first reason the exact test failed (log-only; the diff receipts in
        // the worker name the classes per instance).
        (void) mismatch;
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
        if (cit != channelOfTrack.end()) {
            // Field-proven grammar fix (0.12.3): the raw WIDE channel printed
            // here ("[ch17]") read as an ILLEGAL wire MIDI channel and sent
            // the field analysis chasing a fold that never happened. The
            // receipt now names all three spaces explicitly: the wire channel
            // the plugin hears, the instance slot owning the namespace, and
            // the wide encoding (slot*16+ch). "[ch1 s0 w1]" == legacy (wide
            // == wire); "[ch1 s1 w17]" == the SECOND instance's ch1.
            const int wide = cit->second;
            const int slot = slotOfWide(wide);
            disp = "[ch" + std::to_string(wide - slot * 16) +
                   " s" + std::to_string(slot) +
                   " w" + std::to_string(wide) + "]";
        }
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
              " | ownChannel" + (chStr.empty() ? " none" : chStr) +
              (ownChClamped > 0 ? " | ownChannelClamped=" + std::to_string(ownChClamped) +
                " (own channel outside 1..16 substituted with 1; routed tracks unaffected — the override replaces the own channel)" : "") +
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
        engineLog("[load] plugin set REFUSED: " + channelsBadDetail +
                  " — every track falls back to the built-in test synth (the app never dead-ends)");
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

        // 0.9.2: the load may carry its editor intent ("openEditor":true) —
        // the REOPEN DECOUPLED FROM LOAD contract. Honored on the reuse path
        // (the reload that answers "reused" still reopens the editor — the
        // exact field gap: "no path opens the editor of an already-live
        // instance") and on the async path (at publish, after the loaded
        // receipts). A folded request skips it: the in-flight init owns the
        // editor intent for the set.
        const bool loadWantsEditor = [&]() {
            juce::DynamicObject* lobj = json.getDynamicObject();
            if (lobj == nullptr) return false;
            const auto& ev = lobj->getProperty("openEditor");
            return ev.isBool() ? static_cast<bool>(ev) : ev.toString().equalsIgnoreCase("true");
        }();

        if (pluginCoalesced) {
            // ── 0.9.2 coalescing fold: the in-flight init's receipts serve
            // this request. No queueing, no reuse answer, no wire state here
            // (the in-flight init's per-instance plugin_state receipts carry
            // the SAME instanceIds and land on every client). The terminal
            // receipt below is this seq's exactly-one.
            engineLog("[plugin] init superseded: seq=" + std::to_string(seq) + " by=" +
                      std::to_string(coalesceInto) +
                      " (coalesced — the request's set matches the in-flight init; its terminal receipts serve this request)");
            initRegistryMarkTerminal(seq, "superseded");
            std::cout << "[engine] plugin request coalesced into in-flight seq "
                      << coalesceInto << " (seq " << seq << ")" << std::endl;
        } else if (midPlayReuse) {
            // ── Fast path: the SAME plugin SET on a rolling transport. Every
            // node stays untouched (no re-instantiate, no remove/add, no
            // release) — only events + routing swapped above. This is the
            // mid-play live-edit reload, and it costs milliseconds.
            {
                for (const auto& r : reqInstances) {
                    HostedPlugin* h = findLiveInstance(r.instanceId);
                    if (h == nullptr) continue;   // raced a retire — the worker path owns it
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
                    engineLog("[plugin] instance kept instance=" + h->instanceId +
                              " slot=" + std::to_string(h->slot) +
                              " (set reused — no re-instantiate) | seq " +
                              std::to_string(seq));
                    engineLog("[plugin] reuse while playing — no re-instantiate | seq " +
                              std::to_string(seq) + " instance=" + r.instanceId +
                              " latencySamples=" + std::to_string(static_cast<int>(h->latencySamples)) +
                              " channels=[" + chansJsonPerInst[r.instanceId] + "]");
                    // 0.9.2: the load-carried editor intent — REOPEN on an
                    // already-live instance. The same flow as handle_open_editor
                    // (pending record for the >10s watchdog, MM job re-resolves
                    // the instance at run time); a repeat request RAISES.
                    if (loadWantsEditor && !r.instanceId.empty()) {
                        const std::string iid = r.instanceId;
                        // Field-gate B-1: the load-carried intent folds too —
                        // an open job for this instance already queued/in
                        // flight satisfies it; queueing a second one would
                        // rebuild the same pileup.
                        bool folded = false;
                        {
                            std::lock_guard<std::mutex> pl(g_pendingEditorMutex);
                            if (g_pendingEditorActive && g_pendingEditorOpen.iid == iid) {
                                ++g_pendingEditorOpen.folds;
                                folded = true;
                            } else {
                                g_pendingEditorOpen = PendingEditorOpen{ iid, std::chrono::steady_clock::now(), {}, 0 };
                                g_pendingEditorActive = true;
                                g_pendingEditorNamed = false;
                            }
                        }
                        if (folded) {
                            engineLog("[editor] open coalesced instance=" + iid +
                                      " (load-carried openEditor — a job for this instance is already queued/starting; folded)");
                        } else {
                            ++g_editorJobsQueued;
                            juce::MessageManager::callAsync([iid] {
                                HostedPlugin* hh = findLiveInstance(iid);
                                openEditorWindow(iid, hh);
                                --g_editorJobsQueued;
                            });
                            engineLog("[editor] open requested instance=" + iid +
                                      " (load-carried openEditor — reuse path, editor reopen decoupled from load)");
                        }
                    }
                }
                std::cout << "[engine] plugin set reused (mid-play, seq " << seq
                          << ", " << reqInstances.size() << " instance(s))" << std::endl;
            }
        } else {
            // ── Async init (Milestone 2: a DIFF request — the worker computes
            // kept/added/changed/removed vs the live set at run time). Each
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
                e.multiTimbral = r.multiTimbral;   // M3 PR1: the validator flag rides the entry
                auto cit = chansJsonPerInst.find(r.instanceId);
                if (cit != chansJsonPerInst.end()) e.channelsJson = cit->second;
                entries.push_back(std::move(e));
            }
            const size_t n = entries.size();
            long long supersededPendingSeq = 0;
            {
                std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                if (g_pluginInitPending) {
                    // 0.9.2: the request still sitting in the queue slot is
                    // overwritten BEFORE the worker ever saw it — without a
                    // receipt this was a SILENT DROP (queued → vanished; the
                    // exact "no terminal receipt" class). Its terminal:
                    // superseded by the request that replaces it.
                    supersededPendingSeq = g_pluginInitRequest.seq;
                }
                g_pluginInitRequest = PluginInitRequest{std::move(entries), seq, false, loadWantsEditor, discardRetireRequested};
                g_pluginInitPending = true;
                ++g_pluginInitGen;
                g_pluginInitNewestSeq = seq;
            }
            if (supersededPendingSeq > 0) {
                engineLog("[plugin] init superseded: seq=" + std::to_string(supersededPendingSeq) +
                          " by=" + std::to_string(seq) +
                          " (overwritten while still queued — never started)");
                initRegistryMarkTerminal(supersededPendingSeq, "superseded");
            }
            initRegistryEnqueue(seq, false, reqFingerprint,
                                reqInstances.empty() ? std::string() : reqInstances.front().instanceId);
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
    } else if (unloadRequested) {
        // ── Milestone 1: explicit unload ({"plugins": []}). Queue a zero-
        // entry request: the worker retires the live instance through the
        // vendor path (editor close → state capture → removeNode) with all
        // its receipts.
        long long supersededPendingSeq = 0;
        {
            std::lock_guard<std::mutex> lock(g_pluginInitMutex);
            if (g_pluginInitPending) {
                supersededPendingSeq = g_pluginInitRequest.seq;   // 0.9.2: no silent drops
            }
            g_pluginInitRequest = PluginInitRequest{{}, seq, true, false, discardRetireRequested};
            g_pluginInitPending = true;
            ++g_pluginInitGen;
            g_pluginInitNewestSeq = seq;
        }
        if (supersededPendingSeq > 0) {
            engineLog("[plugin] init superseded: seq=" + std::to_string(supersededPendingSeq) +
                      " by=" + std::to_string(seq) +
                      " (overwritten while still queued — never started)");
            initRegistryMarkTerminal(supersededPendingSeq, "superseded");
        }
        initRegistryEnqueue(seq, true, "");
        g_pluginLoadActive.store(true, std::memory_order_release);
        g_pluginInitCv.notify_one();
        engineLog("[plugin] unload requested (explicit empty plugins[] array) | seq " + std::to_string(seq) +
                  " — the live instance retires with its state captured (receipts follow)");
        std::cout << "[engine] plugin unload queued (async, seq " << seq << ")" << std::endl;
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
// M3 PR2 (additive, protocol 1 unchanged): the strip fields —
//   "stripGains": {"<stripId>": 0.0..4.0, ...}
//   "stripMutes": ["<stripId>", ...]
//   "stripSolos": ["<stripId>", ...]
// ride the SAME message: wired strips are AUDIO-domain (the D1 answer) — the
// mute is a ramped gain-0, solo is SOLO-IN-PLACE (any strip soloed → every
// non-soloed strip's effective gain is 0), recomputed and published by the WS
// thread on EVERY mix message (the strip atomics; the ~10 ms ramp glides the
// change — the mute must be HEARD). The per-TRACK (MIDI dispatch) gate above
// is UNCHANGED and orthogonal: synth-fallback/unwired paths stay byte-stable.
// Unknown strip ids are receipt-named (the tolerant mix precedent), and the
// strip state persists for the reload-continuity publish (g_lastStripMix).
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
    // ── M3 PR2: the strip fields (additive; absent fields leave the last
    // strip state untouched — the track fields' own precedent). ──
    LastStripMix nextStrips;
    {
        std::lock_guard<std::mutex> slk(g_lastStripMixMutex);
        nextStrips = g_lastStripMix;   // carry the previous strip intent
    }
    std::vector<std::string> unknownStrips;
    if (auto* gainsObj = obj->getProperty("stripGains").getDynamicObject()) {
        nextStrips.gains.clear();
        const auto& props = gainsObj->getProperties();
        for (int i = 0; i < props.size(); ++i) {
            const std::string id = props.getName(i).toString().toStdString();
            if (id.empty()) continue;
            double g = static_cast<double>(props.getValueAt(i));
            if (!(g >= 0.0) || g > 4.0) {   // NaN/negative/over-range → clamp, named
                engineLog("[strip] mix: gains." + id + "=" + std::to_string(g) +
                          " out of range [0,4] — clamped");
                g = juce::jlimit(0.0, 4.0, g);
            }
            nextStrips.gains[id] = static_cast<float>(g);
        }
    }
    for (const auto& [field, list] : std::initializer_list<std::pair<const char*, std::vector<std::string>*>>{
             {"stripMutes", &nextStrips.mutes}, {"stripSolos", &nextStrips.solos}}) {
        const auto& arr = obj->getProperty(field);
        if (!arr.isArray()) continue;
        list->clear();
        for (auto& v : *arr.getArray()) {
            std::string id = v.toString().toStdString();
            if (id.empty()) continue;
            if (std::find(list->begin(), list->end(), id) == list->end()) list->push_back(id);
        }
    }
    {
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
    // ── M3 PR2: publish the effective strip gains + the named receipt. ──
    {
        const auto set = g_strips.load(std::memory_order_acquire);
        if (set != nullptr) {
            const bool anySolo = anyActiveStripSolo(*set, nextStrips);
            std::string eff, unknown;
            size_t activeCount = 0;
            for (const auto& e : set->strips) {
                if (!e.active) continue;
                ++activeCount;
                if (!eff.empty()) eff += " ";
                eff += e.stripId + "=" +
                       juce::String(stripEffectiveGain(nextStrips, e, anySolo), 2).toStdString();
            }
            for (const auto& [id, g] : nextStrips.gains) {
                bool known = false;
                for (const auto& e : set->strips) if (e.stripId == id) { known = true; break; }
                if (!known && !stripInList(nextStrips.mutes, id) && !stripInList(nextStrips.solos, id))
                    unknownStrips.push_back(id + " (gain)");
            }
            for (const auto& id : nextStrips.mutes) {
                bool known = false;
                for (const auto& e : set->strips) if (e.stripId == id) { known = true; break; }
                if (!known) unknownStrips.push_back(id + " (mute)");
            }
            for (const auto& id : nextStrips.solos) {
                bool known = false;
                for (const auto& e : set->strips) if (e.stripId == id) { known = true; break; }
                if (!known) unknownStrips.push_back(id + " (solo)");
            }
            for (const auto& u : unknownStrips)
                engineLog("[strip] mix: unknown strip id " + u + " ignored (not in the table)");
            if (activeCount > 0) {
                std::string solos, mutes, gains;
                for (const auto& id : nextStrips.solos) { if (!solos.empty()) solos += ","; solos += id; }
                for (const auto& id : nextStrips.mutes) { if (!mutes.empty()) mutes += ","; mutes += id; }
                for (const auto& [id, g] : nextStrips.gains) {
                    if (!gains.empty()) gains += ",";
                    gains += id + ":" + juce::String(g, 2).toStdString();
                }
                engineLog("[strip] mix: solos=[" + solos + "] mutes=[" + mutes + "] gains={" + gains +
                          "} -> effective: " + eff +
                          (nextStrips.solos.empty() ? "" : " (solo-in-place)"));
            }
        }
        std::lock_guard<std::mutex> slk(g_lastStripMixMutex);
        g_lastStripMix = std::move(nextStrips);
        if (auto set2 = g_strips.load(std::memory_order_acquire))
            publishStripGains(*set2, g_lastStripMix);
    }
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

// ─── M3 PR1 — the runtime routing table ("routing" message; see the header) ──
void handle_routing(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    const auto reject = [&ws](const std::string& reason) {
        engineLog("[routing] route rejected: reason=" + reason);
        ws.send(std::string("{\"type\":\"routing_result\",\"applied\":false,\"reason\":\"") +
                escape_json(reason) + "\",\"v\":" + std::to_string(g_routingVersion.load()) + "}");
    };
    if (obj == nullptr) { reject("message is not an object"); return; }
    juce::DynamicObject* routes = obj->getProperty("routes").getDynamicObject();
    if (routes == nullptr) { reject("routes must be an object of trackId -> {inst, ch}"); return; }
    ScoreSnapshot* cur = g_score.load(std::memory_order_acquire);
    if (cur == nullptr) { reject("no score loaded (the routing table binds the loaded score's tracks)"); return; }
    const auto table = g_routing.load(std::memory_order_acquire);
    if (table == nullptr) { reject("no routing table published (internal)"); return; }
    const auto liveSet = g_liveSet.load(std::memory_order_acquire);

    // ── R1 validation pass: NOTHING mutates until every entry has passed. ──
    std::map<std::string, int> newChannelOfTrack;         // trackId → WIDE channel
    std::map<std::string, std::string> newInstanceOfTrack;
    std::map<std::pair<std::string, int>, std::string> seenInstCh;   // (iid, ch) → first trackId
    std::map<std::string, std::vector<int>> channelsPerInst;
    const auto& rprops = routes->getProperties();
    for (int i = 0; i < rprops.size(); ++i) {
        const std::string trackId = rprops.getName(i).toString().toStdString();
        juce::DynamicObject* ro = rprops.getValueAt(i).getDynamicObject();
        if (trackId.empty() || ro == nullptr) { reject("routing entries must be {inst, ch} objects"); return; }
        if (table->slotOf.find(trackId) == table->slotOf.end()) {
            reject("unknown trackId \"" + trackId + "\" (not in the loaded score's track table)");
            return;
        }
        const std::string inst = ro->getProperty("inst").toString().toStdString();
        const int ch = static_cast<int>(static_cast<double>(ro->getProperty("ch")));
        if (ch < 1 || ch > 16) {
            reject("channel must be an integer 1-16 (track " + trackId + ")");
            return;
        }
        int slot = -1;
        bool instMulti = false;
        if (liveSet != nullptr) {
            for (const auto* m : liveSet->bySlot) {
                if (m != nullptr && m->instanceId == inst) { slot = m->slot; instMulti = m->multiTimbral; break; }
            }
        }
        if (slot < 0) {
            reject("routing references unknown instanceId \"" + inst +
                   "\" (not in the published set) (track " + trackId + ")");
            return;
        }
        const auto collision = seenInstCh.find({inst, ch});
        if (collision != seenInstCh.end()) {
            reject("instance \"" + inst + "\" channel " + std::to_string(ch) +
                   " assigned to both \"" + collision->second + "\" and \"" + trackId + "\"");
            return;
        }
        auto& chans = channelsPerInst[inst];
        if (std::find(chans.begin(), chans.end(), ch) == chans.end()) chans.push_back(ch);
        if (!instMulti && chans.size() > 1) {
            reject("instance \"" + inst + "\" is single-timbral (no multiTimbral flag) but the table assigns " +
                   std::to_string(chans.size()) + " distinct channels (track \"" + trackId +
                   "\" would ride channel " + std::to_string(ch) + ")");
            return;
        }
        seenInstCh[{inst, ch}] = trackId;
        newChannelOfTrack[trackId] = wideChannelOf(slot, ch);
        newInstanceOfTrack[trackId] = inst;
    }

    // ── Apply: build the new table (slots/trackNames PRESERVED — mix slots
    // are stable; only the channel binding changes), re-channel the score's
    // events, publish BOTH back-to-back (the load path's two-store order). ──
    RoutingTable rebuilt = *table;
    rebuilt.channelOfTrack.clear();
    rebuilt.pluginChannels.clear();
    rebuilt.slotChannel.assign(rebuilt.trackNames.size() + 1, 0);
    for (const auto& [trackId, wide] : newChannelOfTrack) {
        rebuilt.channelOfTrack[trackId] = wide;
        const uint32_t slot = rebuilt.slotOf[trackId];
        rebuilt.slotChannel[slot] = wide;
        rebuilt.pluginChannels.insert(wide);
    }
    rebuilt.explicitRouting = true;

    // Rebind flush: every track ABANDONING a plugin-routed wide channel (or
    // losing its mapping outright) gets the OLD channel CC120-flushed next
    // buffer — a mid-play rebind cannot leave stuck notes on the abandoned
    // channel (the mute-flush machinery, the "mute must be HEARD" precedent).
    int rebinds = 0;
    for (const auto& [trackId, oldWide] : table->channelOfTrack) {
        if (table->pluginChannels.count(oldWide) == 0) continue;
        const auto nit = newChannelOfTrack.find(trackId);
        if (nit == newChannelOfTrack.end() || nit->second != oldWide) {
            g_muteFlushPending[oldWide - 1].store(true, std::memory_order_relaxed);
            ++rebinds;
        }
    }

    ScoreSnapshot* snap = new ScoreSnapshot();
    snap->events = cur->events;
    for (auto& ev : snap->events) {
        if (ev.trackRef == 0 || ev.trackRef > rebuilt.trackNames.size()) continue;
        const auto it = newChannelOfTrack.find(rebuilt.trackNames[ev.trackRef - 1]);
        if (it != newChannelOfTrack.end()) ev.channel = static_cast<uint8_t>(it->second);
    }
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
    g_routing.store(std::make_shared<const RoutingTable>(std::move(rebuilt)), std::memory_order_release);
    // A new binding context resets the per-channel articulation knowledge —
    // the first CC#32 re-sends (the load precedent).
    resetArticulations();

    const uint64_t v = g_routingVersion.fetch_add(1, std::memory_order_acq_rel) + 1;
    std::vector<std::pair<int, std::string>> lines;   // (slot, receipt) — sorted by slot
    for (const auto& [trackId, wide] : newChannelOfTrack) {
        const auto sit = table->slotOf.find(trackId);
        const int slot = sit != table->slotOf.end() ? static_cast<int>(sit->second) : 0;
        lines.emplace_back(slot,
            "[routing] route applied: track=" + std::to_string(slot) +
            " -> instance=" + newInstanceOfTrack[trackId] +
            " ch=" + std::to_string(realChOfWide(wide)) + " (" + trackId + ")");
    }
    std::sort(lines.begin(), lines.end());
    for (const auto& [slot, line] : lines) engineLog(line);
    engineLog("[routing] route applied: mapping v=" + std::to_string(v) +
              " tracks=" + std::to_string(lines.size()) +
              " (rebinds=" + std::to_string(rebinds) + " flushed)");
    ws.send(std::string("{\"type\":\"routing_result\",\"applied\":true,\"v\":") +
            std::to_string(v) + ",\"tracks\":" + std::to_string(lines.size()) + "}");
}

// ─── M3 PR2 — strips: message-thread graph operations ───────────────────────
// All graph mutation for strips happens ON THE MESSAGE THREAD (the vendor's
// Nodes-table discipline — the same thread addPluginNode/removeNodeByID run
// on). The WS handler validates (R1 atomic-or-nothing) and enqueues ONE job;
// FIFO ordering serializes it against the commit/retire jobs. Strip nodes go
// through g_host.graph()->addNode/removeNode DIRECTLY (public API — the
// vendored core stays byte-untouched): removeNodeByID is reserved for PLUGIN
// nodes because it owns liveCount_ (the "is anything live" counter); strip
// nodes must not pollute it.

// The strip node map: stripId → graph node. MESSAGE THREAD ONLY (created/
// destroyed by the jobs below — never touched by WS/audio/worker threads).
std::mutex g_stripNodesMutex;   // belt-and-braces: all callers ARE the message thread
std::map<std::string, juce::AudioProcessorGraph::Node::Ptr> g_stripNodes;

// Message thread: the node's LIVE output channel count (the R3 truth — the
// meta's captured layout can drift from the live processor; this is what the
// guard audits against).
static int stripLiveOutputChannels(juce::AudioProcessorGraph::Node::Ptr node) {
    if (node == nullptr || node->getProcessor() == nullptr) return -1;
    return node->getProcessor()->getTotalNumOutputChannels();
}

// Message thread: connect ONE wired pair through its strip node. Removes the
// default main→master connections this pair replaces (they exist only for
// channels 0/1 — the vendored addPluginNode wiring), then wires
// plugin a/b → strip in0/in1 and strip out0/out1 → master 0/1. Idempotent per
// endpoint pair (addConnection refuses duplicates; removeConnection returns
// false on absence — both receipt-free no-ops).
static bool wireStripPair(juce::AudioProcessorGraph& graph,
                          juce::AudioProcessorGraph::NodeID pluginID,
                          juce::AudioProcessorGraph::NodeID outputID,
                          juce::AudioProcessorGraph::NodeID stripID,
                          int a, int b) {
    if (b != a + 1 || a < 0) return false;
    // Defaults first (only the main bus pair has them): a strip wired over
    // [0,1] must REPLACE the direct wiring, not sum with it (the frontend's
    // table is the whole truth for the pairs it manages).
    if (a == 0) {
        graph.removeConnection({ { pluginID, 0 }, { outputID, 0 } });
        graph.removeConnection({ { pluginID, 1 }, { outputID, 1 } });
        // Mono-fold shape (vendored wiring duplicates channel 0 to master R):
        graph.removeConnection({ { pluginID, 0 }, { outputID, 1 } });
    }
    const bool inOk = graph.addConnection({ { pluginID, a }, { stripID, 0 } })
                   && graph.addConnection({ { pluginID, b }, { stripID, 1 } });
    const bool outOk = graph.addConnection({ { stripID, 0 }, { outputID, 0 } })
                    && graph.addConnection({ { stripID, 1 }, { outputID, 1 } });
    return inOk && outOk;
}

// Message thread: create the node for ONE strip entry (the caller has already
// leased e.slot) and wire it. Returns the node (nullptr = the graph refused —
// caller receipts).
static juce::AudioProcessorGraph::Node::Ptr createAndWireStripNode(
        juce::AudioProcessorGraph& graph,
        juce::AudioProcessorGraph::NodeID pluginID,
        juce::AudioProcessorGraph::NodeID outputID,
        StripEntry& e) {
    auto node = graph.addNode(std::make_unique<StripMixerProcessor>(e.slot));
    if (node == nullptr) return nullptr;
    if (!wireStripPair(graph, pluginID, outputID, node->nodeID, e.pair0, e.pair1)) {
        graph.removeNode(node->nodeID);
        return nullptr;
    }
    {
        std::lock_guard<std::mutex> lk(g_stripNodesMutex);
        g_stripNodes[e.stripId] = node;
    }
    return node;
}

// Message thread: remove ONE strip's node (the vendor retires it via the
// render-sequence exchange — the same ≤500 ms policy as plugin nodes; the
// slot's atomics outlive it, a retiring node may render one stale-gain block
// window, documented in ASSUMPTIONS).
static void removeStripNode(const std::string& stripId, const StripEntry& e) {
    juce::AudioProcessorGraph::Node::Ptr node;
    {
        std::lock_guard<std::mutex> lk(g_stripNodesMutex);
        auto it = g_stripNodes.find(stripId);
        if (it != g_stripNodes.end()) { node = it->second; g_stripNodes.erase(it); }
    }
    if (node != nullptr && g_host.graph() != nullptr)
        g_host.graph()->removeNode(node->nodeID);
    (void) e;
}

// Message thread: the R2/R3-aware per-instance strip reconcile — called from
// the commit job AFTER the plugin node is live. For every table entry bound
// to this instanceId:
//   live pair valid   → reactivate (if inactive) + create/wire the node +
//                       receipt (the reload-continuity path: unload → reload
//                       restores the wiring with its gains);
//   live pair INVALID → the R3 LAYOUT-CHANGE GUARD: the strip stays dead,
//                       the receipt names it, the stripLayoutChanged push
//                       fires — never a silent dead wire.
// Publishes the updated table on any change.
static void rewireStripsForInstanceOnMessageThread(const std::string& iid,
                                                   juce::AudioProcessorGraph::Node::Ptr pluginNode) {
    auto cur = g_strips.load(std::memory_order_acquire);
    if (cur == nullptr || cur->strips.empty()) return;
    auto* graph = g_host.graph();
    if (graph == nullptr || pluginNode == nullptr) return;
    const auto outputID = g_host.outputNodeID();
    const int liveCh = stripLiveOutputChannels(pluginNode);

    bool changed = false;
    std::vector<std::string> guardUnwired;
    auto next = std::make_shared<StripSet>(*cur);
    for (auto& e : next->strips) {
        if (e.inst != iid) continue;
        const bool valid = e.pair0 >= 0 && e.pair1 == e.pair0 + 1 && e.pair1 < liveCh;
        if (!valid) {
            // R3: the live node cannot feed this pair. Unwire cleanly (the
            // node may still exist from a same-message apply — remove it),
            // keep the TABLE entry (the frontend's intent), name everything.
            if (e.active) { removeStripNode(e.stripId, e); e.active = false; changed = true; }
            e.slot = -1;
            e.reason = "layout";
            guardUnwired.push_back(e.stripId);
            engineLog("[strip] layout guard: strip=" + e.stripId + " instance=" + iid +
                      " pair=[" + std::to_string(e.pair0) + "," + std::to_string(e.pair1) +
                      "] exceeds live output channels " + std::to_string(liveCh) +
                      " — unwired (named, never a silent dead wire)");
            continue;
        }
        if (e.active) continue;   // kept node — connections untouched
        // (Re)activate: lease a strip slot, create the node, wire, publish.
        bool slotTaken[kMaxStrips] = {};
        for (const auto& o : next->strips)
            if (o.active && o.slot >= 0 && o.slot < kMaxStrips) slotTaken[o.slot] = true;
        int slot = -1;
        for (int s = 0; s < kMaxStrips; ++s) if (!slotTaken[s]) { slot = s; break; }
        if (slot < 0) {
            e.reason = "strip limit exhausted";
            engineLog("[strip] rewired SKIPPED strip=" + e.stripId + " instance=" + iid +
                      " — " + e.reason);
            continue;
        }
        e.slot = slot;
        e.active = false;
        auto node = createAndWireStripNode(*graph, pluginNode->nodeID, outputID, e);
        if (node == nullptr) {
            e.slot = -1;
            e.reason = "graph refused the strip node";
            engineLog("[strip] rewired FAILED strip=" + e.stripId + " instance=" + iid +
                      " — the graph refused the node/wiring");
            continue;
        }
        e.active = true;
        e.reason.clear();
        changed = true;
        engineLog("[strip] wired: strip=" + e.stripId + " instance=" + iid +
                  " pair=[" + std::to_string(e.pair0) + "," + std::to_string(e.pair1) +
                  "] slot=" + std::to_string(slot) + " gain=" +
                  juce::String(stripEffectiveGain(g_lastStripMix, e, anyActiveStripSolo(*next, g_lastStripMix)), 2).toStdString() +
                  " (restored on load)");
    }
    if (changed) {
        g_strips.store(next, std::memory_order_release);
        publishStripGains(*next, g_lastStripMix);
    }
    if (!guardUnwired.empty()) {
        std::lock_guard<std::mutex> lk(g_stripLayoutPushMutex);
        g_stripLayoutPush = { iid, liveCh, guardUnwired, true };
    }
}

// Message thread: tear down every ACTIVE strip bound to iid (the source
// unload path — R2/R4). The TABLE entries stay (inactive, reason named): a
// later reload of the same instanceId reactivates them. R4's note hygiene is
// the audio-side slot wipe (g_slotStateClearPending → counts abandoned held
// notes → the worker's teardown-flush receipt); the retire job's own receipt
// names the strips and the flush handoff.
static void teardownStripsForInstanceOnMessageThread(const std::string& iid) {
    auto cur = g_strips.load(std::memory_order_acquire);
    if (cur == nullptr || cur->strips.empty()) return;
    bool changed = false;
    auto next = std::make_shared<StripSet>(*cur);
    for (auto& e : next->strips) {
        if (e.inst != iid || !e.active) continue;
        removeStripNode(e.stripId, e);
        e.active = false;
        e.slot = -1;
        e.reason = "source unloaded";
        changed = true;
        engineLog("[strip] teardown: strip=" + e.stripId + " instance=" + iid +
                  " pair=[" + std::to_string(e.pair0) + "," + std::to_string(e.pair1) +
                  "] — source unloaded; abandoned notes flushed by the slot wipe"
                  " (all-sound-off semantics, receipted by the worker); the table"
                  " entry survives for the next load");
    }
    if (changed) {
        g_strips.store(next, std::memory_order_release);
        publishStripGains(*next, g_lastStripMix);
    }
}

// Message thread: the strips-table apply (ONE job per message — R1: the whole
// table validates on the WS thread first, and THIS job re-validates every
// live truth before ANY mutation; one failure = zero mutation = applied:false).
// Full-table semantics: the message IS the table — instances absent from it
// lose their strips (receipted); instances present get exactly their wires,
// and every output channel they own is accounted (wired pair → strip,
// unwired channel → named receipt).
struct StripsApplyOutcome {
    std::atomic<bool> done { false };
    std::atomic<bool> ok { false };
    std::string error;             // guarded by done-then-read (the bounded wait)
    uint64_t appliedV = 0;
    size_t wiredCount = 0, unwiredCount = 0, tornDownCount = 0;
    std::vector<std::string> receipts;
};
static void applyStripsJob(std::shared_ptr<StripsApplyOutcome> out,
                           std::shared_ptr<std::vector<StripEntry>> wanted,
                           std::shared_ptr<std::vector<std::string>> wantedInsts) {
    MmNamedJob _mmNamedJob("applyStrips");   // field-gate B-2: graph mutation on the MM
    auto* graph = g_host.graph();
    if (graph == nullptr) { out->error = "no host graph"; out->done.store(true); return; }
    const auto outputID = g_host.outputNodeID();
    const auto cur = g_strips.load(std::memory_order_acquire);

    // ── Live re-validation pass: NOTHING mutates until everything passes. ──
    std::map<std::string, juce::AudioProcessorGraph::Node::Ptr> nodeOf;   // iid → live plugin node
    std::map<std::string, int> liveChOf;
    const auto liveNow = g_liveSet.load(std::memory_order_acquire);
    for (const auto& iid : *wantedInsts) {
        HostedPlugin* m = nullptr;
        if (liveNow != nullptr)
            for (auto* h : liveNow->bySlot)
                if (h != nullptr && h->instanceId == iid) { m = h; break; }
        juce::AudioProcessorGraph::Node::Ptr node;
        int ch = -1;
        if (m != nullptr && m->rawInstance.load(std::memory_order_acquire) != nullptr
            && m->nodeID.uid != 0 && graph->getNodeForId(m->nodeID) != nullptr) {
            node = graph->getNodeForId(m->nodeID);
            ch = stripLiveOutputChannels(node);
        }
        if (node == nullptr || ch < 0) {
            out->error = "instance \"" + iid + "\" has no live plugin node (state changed since validation)";
            out->done.store(true);
            return;
        }
        nodeOf[iid] = node;
        liveChOf[iid] = ch;
    }
    for (const auto& w : *wanted) {
        if (w.pair0 < 0 || w.pair1 != w.pair0 + 1 || w.pair1 >= liveChOf[w.inst]) {
            out->error = "instance \"" + w.inst + "\" pair [" + std::to_string(w.pair0) + "," +
                         std::to_string(w.pair1) + "] exceeds live output channels " +
                         std::to_string(liveChOf[w.inst]) + " (layout changed since validation)";
            out->done.store(true);
            return;
        }
    }

    // ── Mutate: the validation gate has passed. ──
    std::vector<StripEntry> nextStrips;
    // (a) teardown: every CURRENT ACTIVE entry that no wire in the message
    //     re-creates — an instance absent from the message (full-table
    //     semantics: the frontend owns the table) OR a stripId the message
    //     replaced/renamed. Inactive entries of absent instances die silently
    //     here (they were already receipted at their own teardown).
    {
        std::set<std::string> wantedIds;
        for (const auto& w : *wanted) wantedIds.insert(w.stripId);
        for (const auto& e : cur->strips) {
            if (!e.active) continue;
            if (wantedIds.count(e.stripId) != 0) continue;
            removeStripNode(e.stripId, e);
            ++out->tornDownCount;
            out->receipts.push_back("[strip] unwired: strip=" + e.stripId + " instance=" + e.inst +
                                    " pair=[" + std::to_string(e.pair0) + "," + std::to_string(e.pair1) +
                                    "] — removed by strips table (not in the message)");
        }
    }
    // (b) build the new table: one entry per wire (slot leased here — lowest
    //     free — BEFORE the node exists; the processor reads its slot atomics).
    for (const auto& w : *wanted) {
        StripEntry e = w;
        bool slotTaken[kMaxStrips] = {};
        for (const auto& done : nextStrips)
            if (done.active && done.slot >= 0 && done.slot < kMaxStrips) slotTaken[done.slot] = true;
        int slot = -1;
        for (int s = 0; s < kMaxStrips; ++s) if (!slotTaken[s]) { slot = s; break; }
        if (slot < 0) {
            out->error = "strip limit exhausted (" + std::to_string(kMaxStrips) + ") while wiring \"" +
                         w.stripId + "\"";
            out->receipts.push_back("[strip] wired FAILED: strip=" + w.stripId + " — " + out->error);
            // Wired prefix stays; the unwired remainder is receipted + inactive.
            std::vector<StripEntry> finalTable;
            for (const auto& req : *wanted) {
                StripEntry f = req;
                f.active = false; f.slot = -1; f.reason = "apply failed before this wire";
                finalTable.push_back(f);
            }
            for (size_t k = 0; k < nextStrips.size() && k < finalTable.size(); ++k)
                finalTable[k] = nextStrips[k];
            g_strips.store(std::make_shared<const StripSet>(StripSet{ finalTable }),
                           std::memory_order_release);
            publishStripGains(*g_strips.load(std::memory_order_acquire), g_lastStripMix);
            out->done.store(true);
            return;
        }
        e.slot = slot;
        e.active = false;
        auto node = createAndWireStripNode(*graph, nodeOf[w.inst]->nodeID, outputID, e);
        if (node == nullptr) {
            // Mid-apply graph refusal: the vendor's builder assembled-and-
            // swapped or refused; the failure is contained and receipted (the
            // commit-path precedent). The successfully wired prefix stays —
            // the NEXT strips message reconciles; the receipts name everything.
            out->error = "the graph refused the strip node/wiring for strip \"" + w.stripId + "\"";
            out->receipts.push_back("[strip] wired FAILED: strip=" + w.stripId + " instance=" + w.inst +
                                    " pair=[" + std::to_string(w.pair0) + "," + std::to_string(w.pair1) + "]");
            std::vector<StripEntry> finalTable;
            for (const auto& req : *wanted) {
                StripEntry f = req;
                f.active = false; f.slot = -1; f.reason = "apply failed before this wire";
                finalTable.push_back(f);
            }
            for (size_t k = 0; k < nextStrips.size() && k < finalTable.size(); ++k)
                finalTable[k] = nextStrips[k];
            g_strips.store(std::make_shared<const StripSet>(StripSet{ finalTable }),
                           std::memory_order_release);
            publishStripGains(*g_strips.load(std::memory_order_acquire), g_lastStripMix);
            out->done.store(true);
            return;
        }
        e.active = true;
        nextStrips.push_back(e);
        ++out->wiredCount;
        const bool anySolo = std::any_of(nextStrips.begin(), nextStrips.end(),
            [&](const StripEntry& s) { return s.active && stripInList(g_lastStripMix.solos, s.stripId); });
        out->receipts.push_back("[strip] wired: strip=" + w.stripId + " instance=" + w.inst +
                                " pair=[" + std::to_string(w.pair0) + "," + std::to_string(w.pair1) +
                                "] slot=" + std::to_string(e.slot) + " gain=" +
                                juce::String(stripEffectiveGain(g_lastStripMix, e, anySolo), 2).toStdString());
    }
    // (c) unwired-channel accounting: every channel of every wanted instance
    //     not covered by a wired pair is NAMED (never silent) and its default
    //     direct wiring (main pair only) is removed — the table is the whole
    //     truth for instances it mentions.
    for (const auto& [iid, ch] : liveChOf) {
        (void) ch;
        // Which channels does the instance own? Walk its captured bus table
        // (immutable meta) for the NAMED receipt, live count for the truth.
        HostedPlugin* m = nullptr;
        if (liveNow != nullptr)
            for (auto* h : liveNow->bySlot)
                if (h != nullptr && h->instanceId == iid) { m = h; break; }
        const int total = liveChOf[iid];
        int covered = 0;
        for (const auto& w : *wanted)
            if (w.inst == iid) covered = std::max(covered, w.pair1 + 1);
        // Defaults for the main pair go when a strip covers [0,1] — already
        // removed by wireStripPair. If NOTHING covers the main pair, remove
        // the defaults explicitly (the table says this instance is unwired).
        if (covered == 0) {
            graph->removeConnection({ { nodeOf[iid]->nodeID, 0 }, { outputID, 0 } });
            graph->removeConnection({ { nodeOf[iid]->nodeID, 1 }, { outputID, 1 } });
            graph->removeConnection({ { nodeOf[iid]->nodeID, 0 }, { outputID, 1 } });
        }
        // Per-channel named receipts, bus-attributed from the meta's table.
        int bus = 0, busStart = 0;
        const std::vector<int>* busTable = m != nullptr ? &m->outputBusChannels : nullptr;
        for (int c = 0; c < total; ++c) {
            if (busTable != nullptr) {
                while (bus < (int) busTable->size() && c >= busStart + (*busTable)[bus]) {
                    busStart += (*busTable)[bus];
                    ++bus;
                }
            }
            if (c < covered) continue;
            ++out->unwiredCount;
            out->receipts.push_back("[strip] instance=" + iid + " channel " + std::to_string(c) +
                                    " (bus " + std::to_string(bus) + ") unwired — named, silent by design");
        }
    }
    // (d) slot leases were assigned by createAndWireStripNode (lowest-free);
    //     publish the table + the gains, advance v by EXACTLY ONE.
    g_strips.store(std::make_shared<const StripSet>(StripSet{ nextStrips }),
                   std::memory_order_release);
    publishStripGains(*g_strips.load(std::memory_order_acquire), g_lastStripMix);
    out->appliedV = g_stripVersion.fetch_add(1, std::memory_order_acq_rel) + 1;
    out->ok.store(true);
    out->done.store(true);
}

// {"type":"strips","wires":[{"strip":"s1","inst":"inst-a","pair":[0,1]},…]}
// — the audio-domain counterpart of the routing table (D2 ownership: the
// frontend owns the wiring; the engine validates atomically, applies on the
// message thread, publishes an immutable snapshot, echoes ONE result).
// R1 ATOMIC-OR-NOTHING: any validation failure = exactly one
// "[strip] rejected: reason=" receipt, zero mutation, v unchanged.
// Protocol stays 1 (additive): strips_result + [strip] receipts only.
void handle_strips(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    const auto reject = [&ws](const std::string& reason) {
        engineLog("[strip] rejected: reason=" + reason);
        ws.send(std::string("{\"type\":\"strips_result\",\"applied\":false,\"reason\":\"") +
                escape_json(reason) + "\",\"v\":" + std::to_string(g_stripVersion.load()) + "}");
    };
    if (obj == nullptr) { reject("message is not an object"); return; }
    const auto& wiresVar = obj->getProperty("wires");
    if (!wiresVar.isArray()) { reject("wires must be an array of {strip, inst, pair} (empty array = full teardown)"); return; }

    // ── R1 validation pass (WS thread, published truth only) ──
    auto wanted = std::make_shared<std::vector<StripEntry>>();
    std::set<std::string> stripIds;
    std::set<std::pair<std::string, int>> pairTaken;   // (iid, pair0)
    std::set<std::string> wantedInsts0;
    for (const auto& wv : *wiresVar.getArray()) {
        juce::DynamicObject* w = wv.getDynamicObject();
        if (w == nullptr) { reject("each wire must be an object {strip, inst, pair}"); return; }
        StripEntry e;
        e.stripId = w->getProperty("strip").toString().toStdString();
        e.inst = w->getProperty("inst").toString().toStdString();
        if (e.stripId.empty() || e.stripId.size() > 64) { reject("strip id must be a non-empty string (<=64 chars)"); return; }
        if (!stripIds.insert(e.stripId).second) { reject("duplicate strip id \"" + e.stripId + "\""); return; }
        if (e.inst.empty()) { reject("strip \"" + e.stripId + "\" is missing inst"); return; }
        const auto& pairVar = w->getProperty("pair");
        if (!pairVar.isArray() || pairVar.getArray()->size() != 2) { reject("strip \"" + e.stripId + "\" pair must be [a, a+1]"); return; }
        e.pair0 = static_cast<int>(static_cast<double>(pairVar.getArray()->getUnchecked(0)));
        e.pair1 = static_cast<int>(static_cast<double>(pairVar.getArray()->getUnchecked(1)));
        if (e.pair1 != e.pair0 + 1 || e.pair0 < 0) { reject("strip \"" + e.stripId + "\" pair must be [a, a+1]"); return; }
        if (e.pair0 % 2 != 0) { reject("strip \"" + e.stripId + "\" pair start must be bus-aligned (even channel)"); return; }
        if (!pairTaken.insert({ e.inst, e.pair0 }).second) {
            reject("instance \"" + e.inst + "\" pair [" + std::to_string(e.pair0) + "," +
                   std::to_string(e.pair1) + "] wired twice");
            return;
        }
        wantedInsts0.insert(e.inst);
        wanted->push_back(e);
    }
    if (wanted->size() > kMaxStrips) {
        reject("strip limit is " + std::to_string(kMaxStrips) + " (message carries " +
               std::to_string(wanted->size()) + ")");
        return;
    }
    const auto liveNow = g_liveSet.load(std::memory_order_acquire);
    for (const auto& iid : wantedInsts0) {
        HostedPlugin* m = nullptr;
        if (liveNow != nullptr)
            for (auto* h : liveNow->bySlot)
                if (h != nullptr && h->instanceId == iid) { m = h; break; }
        if (m == nullptr) { reject("unknown instanceId \"" + iid + "\" (not in the published set)"); return; }
        if (m->rawInstance.load(std::memory_order_acquire) == nullptr) {
            reject("instance \"" + iid + "\" has no live node (wire strips after the load commits)");
            return;
        }
    }
    for (const auto& e : *wanted) {
        if (liveNow == nullptr) { reject("no published instance set (internal)"); return; }
        HostedPlugin* m = nullptr;
        for (auto* h : liveNow->bySlot)
            if (h != nullptr && h->instanceId == e.inst) { m = h; break; }
        if (m == nullptr) { reject("unknown instanceId \"" + e.inst + "\" (not in the published set)"); return; }
        if (e.pair1 >= m->totalOutputChannels) {
            reject("strip \"" + e.stripId + "\" pair [" + std::to_string(e.pair0) + "," +
                   std::to_string(e.pair1) + "] exceeds instance \"" + e.inst + "\" output channels " +
                   std::to_string(m->totalOutputChannels));
            return;
        }
    }

    // ── Apply: ONE message-thread job, bounded wait (the commit-path shape). ──
    auto insts = std::make_shared<std::vector<std::string>>(wantedInsts0.begin(), wantedInsts0.end());
    auto out = std::make_shared<StripsApplyOutcome>();
    juce::MessageManager::callAsync([out, wanted, insts] { applyStripsJob(out, wanted, insts); });
    const auto t0 = std::chrono::steady_clock::now();
    while (!out->done.load(std::memory_order_acquire) && !g_should_exit.load()) {
        if (std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - t0).count() >= 10000) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    if (!out->done.load(std::memory_order_acquire)) {
        reject("the message-thread apply job did not run within 10000 ms");
        return;
    }
    for (const auto& line : out->receipts) engineLog(line);
    if (!out->ok.load()) {
        // The job mutated partially (mid-apply graph refusal) or re-validated
        // false: the receipts above name the exact state; the echo carries
        // applied:false with the UNCHANGED v when nothing applied.
        engineLog("[strip] rejected: reason=" + out->error);
        ws.send(std::string("{\"type\":\"strips_result\",\"applied\":false,\"reason\":\"") +
                escape_json(out->error) + "\",\"v\":" + std::to_string(g_stripVersion.load()) + "}");
        return;
    }
    engineLog("[strip] applied: v=" + std::to_string(out->appliedV) +
              " strips=" + std::to_string(out->wiredCount) +
              " unwired=" + std::to_string(out->unwiredCount) +
              " tornDown=" + std::to_string(out->tornDownCount));
    ws.send(std::string("{\"type\":\"strips_result\",\"applied\":true,\"v\":") +
            std::to_string(out->appliedV) + ",\"strips\":" + std::to_string(out->wiredCount) + "}");
}

// {"type":"layoutAll"} — additive probe: every published instance's output
// layout (bus/channel counts), from the immutable metas. The frontend's
// strip-wiring UI rides this (the [layout] receipts name the same truth).
void handle_layoutAll(const juce::var& json, ix::WebSocket& ws) {
    (void) json;
    const auto liveNow = g_liveSet.load(std::memory_order_acquire);
    std::string rows;
    if (liveNow != nullptr) {
        for (auto* h : liveNow->bySlot) {
            if (h == nullptr) continue;
            if (!rows.empty()) rows += ",";
            rows += "{\"instanceId\":\"" + escape_json(h->instanceId) + "\",\"buses\":" +
                    std::to_string(h->outputBusChannels.size()) + ",\"channels\":" +
                    std::to_string(h->totalOutputChannels) + ",\"busChannels\":[";
            for (size_t b = 0; b < h->outputBusChannels.size(); ++b)
                rows += (b ? "," : "") + std::to_string(h->outputBusChannels[b]);
            rows += "]}";
        }
    }
    ws.send("{\"type\":\"layouts\",\"instances\":[" + rows + "]}");
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
        g_limiterGrMaxDb.store(0.0f, std::memory_order_relaxed);  // fresh session GR ceiling
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
        char grMaxBuf[16];
        std::snprintf(grMaxBuf, sizeof(grMaxBuf), "%.2f",
                      static_cast<double>(g_limiterGrMaxDb.load(std::memory_order_relaxed)));
        engineLog("[stop] transport stop — musical release: voices releasing n=" +
                  std::to_string(releasing) + ", plugin note-offs m=" + std::to_string(held) +
                  ", lastTick " + std::to_string(g_engine.lastTick.load()) +
                  " | session peak " + peakBuf +
                  " | clipsTotal " + std::to_string(g_clipCount.load(std::memory_order_relaxed)) +
                  " (post-limiter; nonzero names a limiter defect)" +
                  " | limiter grMax " + grMaxBuf + "dB" +
                  (g_limiterBypassed.load(std::memory_order_relaxed)
                       ? " (limiter off via SCORCH_LIMITER_OFF)" : " (M4 output stage armed)"));
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
    // frontend sends the track's libraryGroup id).
    // Milestone 2: the request resolves across the WHOLE live set — any of
    // the N instances can be addressed by id, independently (the per-instance
    // editor contract). An empty id resolves to the first live instance (slot
    // order — the legacy "hosted" namespace is slot 0 when it exists).
    juce::DynamicObject* obj = json.getDynamicObject();
    std::string iid = obj ? obj->getProperty("instanceId").toString().toStdString() : "";
    HostedPlugin* live = nullptr;
    if (iid.empty()) {
        auto set = liveSetSnapshot();
        if (set) {
            for (HostedPlugin* m : set->bySlot)
                if (m != nullptr && m->rawInstance.load(std::memory_order_acquire) != nullptr) { live = m; break; }
        }
        if (live != nullptr) iid = live->instanceId;
    } else {
        live = findLiveInstance(iid);
    }
    if (live == nullptr || live->rawInstance.load(std::memory_order_acquire) == nullptr) {
        ws.send(std::string("{\"type\":\"error\",\"code\":\"editor_unavailable\",\"echo\":\"openEditor\",\"detail\":\"no hosted plugin instance\"}"));
        engineLog("[editor] open refused — no live instance" +
                  (iid.empty() ? std::string() : " (requested id \"" + iid + "\")"));
        return;
    }
    bool alreadyOpen = false;
    {
        std::lock_guard<std::mutex> lock(g_editorMutex);
        alreadyOpen = g_editors.count(iid) != 0;
    }
    if (alreadyOpen) {
        // One editor per instance: a repeat request RAISES the existing
        // window and re-echoes editorOpened (focused) — never a second one.
        ++g_editorJobsQueued;
        juce::MessageManager::callAsync([iid] {
            PluginEditorWindow* win = nullptr;
            {
                std::lock_guard<std::mutex> lock(g_editorMutex);
                auto it = g_editors.find(iid);
                if (it != g_editors.end()) win = it->second;
            }
            if (win != nullptr) win->toFront(true);
            --g_editorJobsQueued;
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
    // Field-gate B-1 — THE COALESCING FOLD. A request arriving while this
    // instance's open job is still queued/starting (or blocked inside
    // createEditor) folds into it: ONE queued openEditor job per instance,
    // ever. The field evidence is 11 queued Falcon editors behind one wedged
    // message thread — each accepted request used to queue its own MM job,
    // and a queue that deep both bloats the wedge and multiplies the focus
    // storm on recovery. Same pattern as the 0.9.2 init coalescing fold.
    // The pending record is NOT reset here: the watchdog must name the TRUE
    // age of the OLDEST request; the duplicate count lands in the same
    // record and rides the >10s receipt.
    {
        std::lock_guard<std::mutex> pl(g_pendingEditorMutex);
        if (g_pendingEditorActive && g_pendingEditorOpen.iid == iid) {
            ++g_pendingEditorOpen.folds;
            engineLog("[editor] open coalesced instance=" + iid +
                      " duplicate=" + std::to_string(g_pendingEditorOpen.folds + 1) +
                      " (a job for this instance is already queued/starting — folded, not queued again)");
            return;
        }
        g_pendingEditorOpen = PendingEditorOpen{ iid, std::chrono::steady_clock::now(), {}, 0 };
        g_pendingEditorActive = true;
        g_pendingEditorNamed = false;
    }
    ++g_editorJobsQueued;
    juce::MessageManager::callAsync([iid] {
        HostedPlugin* h = findLiveInstance(iid);   // re-resolve at message-thread run time
        openEditorWindow(iid, h);
        --g_editorJobsQueued;
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
        // D13 REVERT (dump 211647): the 0.14.1 gate on g_pluginLoadActive is
        // GONE — state-capture is back to the exact 0.14.0 placement and
        // semantics (always capture, on the MM, exactly as every CI-green era
        // did). The gate was part of the rework the field run bisected out;
        // nothing in 0.14.0 ever needed it and the bench canon names the
        // revert.
        // Milestone 2: EVERY live instance — one pluginSavedState per
        // instance, each carrying its instanceId (slot order, deterministic).
        for (HostedPlugin* h : liveSetSnapshot()->bySlot) {
            if (h == nullptr) continue;
            captureAndBroadcastState(h->rawInstance.load(std::memory_order_acquire), *h, "request");
        }
    });
}

// Milestone 2 — the vendor retire job, PER INSTANCE. Runs ON the message
// thread (the graph's Nodes table is message-thread property): close the
// instance's editor (receipted, synchronous — we ARE the message thread),
// then the vendor's removeNodeByID. FIFO callAsync ordering guarantees a
// retire enqueued before a commit lands before it — the diff flow relies on
// this for replace semantics (retire-old before commit-new). The meta is
// resolved by instanceId from the CURRENT published set at job-run time (no
// raw captures across threads); its rawInstance is nulled FIRST: the dispatch
// layer stops feeding THAT instance from the next buffer, while the other
// instances of the set keep rendering untouched (the no-disturbance part of
// the unload-semantics contract).
// M1-hotfix (heavy-load death): the state capture NEVER runs here — it lives
// on the init worker (triggers "replace (worker)" / "unload (worker)" /
// "diff-remove (worker)") because a heavyweight library's getStateInformation
// is seconds-class and must never run inside a message-thread job. Editor
// close stays here: window teardown is message-thread property and is not
// seconds-class.
// TASK J root fix (design R1, audit item §3-retire) — retire phase 2: runs
// on the MM as a FRESH dispatch after the module teardown acks (the retire's
// windows destroyed on their OWNER threads + drained). The invariant chain:
// destroy → drain → verify (pin-on-residue) → node removal → free scheduled.
// The free (RenderSequenceExchange) is a LATER dispatch on this same thread,
// so it can never precede the teardown.
void finishRetireInstanceNode(const std::string& iid,
                              std::chrono::steady_clock::time_point t0) {
    MmNamedJob _mmNamedJob("retireFinish(" + iid + ")");   // field-gate B-2
    HostedPlugin* old = findLiveInstance(iid);
    if (old == nullptr || old->rawInstance.load(std::memory_order_acquire) == nullptr)
        return;   // retired by another path while the teardown was in flight
    // An editor opened during the teardown gap (the instance was still
    // published) is closed here — idempotent when there is none.
    destroyEditorWindow(old->instanceId, false);
#ifdef _WIN32
    // The demoted guard (design R3): verify the teardown cleared the module;
    // any residue is a teardown-order defect — PIN the module (refuse the
    // unload), never the load-bearing mechanism.
    scorchguard::verifyForModule(old->instanceId, old->path, "retire");
#endif
    // Milestone 2: remove the PLUGIN node AND its selector (the MIDI bridge)
    // — the vendor disconnects both automatically.
    auto selNode = g_host.removeNodeByID(old->selectorNodeID);
    auto node = g_host.removeNodeByID(old->nodeID);
    old->rawInstance.store(nullptr, std::memory_order_release);
    old->nodeID = {};
    old->selectorNodeID = {};
    // The published latency follows the instance down: its slot mirror zeroes
    // (the F4 shift reads per slot) and the max-mirror is recomputed from the
    // survivors (the next play's pre-roll snapshot).
    if (old->slot >= 0 && old->slot < scorchhost::kMaxInstances)
        g_slotLatencySamples[old->slot].store(0, std::memory_order_release);
    republishMaxLatencyMirror();
    const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - t0).count();
    if (node != nullptr)
        engineLog("[plugin] node removed instance=" + old->instanceId + " removeMs=" + std::to_string(ms) +
                  " — vendor teardown: the instance frees when the old render sequence retires"
                  " (RenderSequenceExchange timer, at most ~500 ms later, never on the audio thread)");
    else
        engineLog("[plugin] node remove SKIPPED instance=" + old->instanceId +
                  " (no live node in the graph) removeMs=" + std::to_string(ms) + "ms");
}

void retireInstanceNodeOnMessageThread(const std::string& iid) {
    MmNamedJob _mmNamedJob("retireNode(" + iid + ")");   // field-gate B-2
    HostedPlugin* old = findLiveInstance(iid);
    if (old == nullptr || old->rawInstance.load(std::memory_order_acquire) == nullptr) {
        engineLog("[plugin] retire SKIPPED — instance not live at message-thread run (requested id \"" +
                  iid + "\")");
        return;
    }
    destroyEditorWindow(old->instanceId, false);   // the editor must not outlive the node
    const auto t0 = std::chrono::steady_clock::now();
    // M3 PR2 (R2/R4): tear down this instance's ACTIVE strips BEFORE the
    // plugin node removal — receipts name every strip; the table entries
    // survive (inactive) for the next load. The R4 note hygiene rides the
    // audio-side slot wipe this retire triggers (g_slotStateClearPending set
    // by the worker's removal/unload paths): the wipe counts the abandoned
    // held notes it clears and the worker speaks the teardown-flush receipt.
    teardownStripsForInstanceOnMessageThread(iid);
#ifdef _WIN32
    // TASK J root fix (design R1, audit item §3-retire): the node removal in
    // phase 2 schedules the module free (RenderSequenceExchange, ≤~500 ms,
    // this thread). BEFORE it: destroy the retiring module's windows on
    // their OWNER threads and drain pending messages — the brief's ordering
    // (destroy → drain → unload) made structural: phase 2 cannot run until
    // the teardown acks, and the free cannot be scheduled before phase 2.
    scorchguard::beginModuleTeardown(old->instanceId, old->path, "retire",
                                     [iid, t0] { finishRetireInstanceNode(iid, t0); });
#else
    finishRetireInstanceNode(iid, t0);
#endif
}

// The ALL-instance form (unload everything: the superseded-commit path and
// any legacy caller that wants the whole set gone).
void retireAllInstanceNodesOnMessageThread() {
    std::vector<std::string> ids;
    if (auto set = liveSetSnapshot())
        for (HostedPlugin* m : set->bySlot)
            if (m != nullptr && m->rawInstance.load(std::memory_order_acquire) != nullptr)
                ids.push_back(m->instanceId);
    for (const auto& id : ids) retireInstanceNodeOnMessageThread(id);
}

// ─── D14b: the init worker's catch-all terminal ─────────────────────────────
// A C++ throwable escaping the worker's init segment becomes a named terminal
// receipt (the exactly-one invariant holds), NOT an unobserved std::terminate.
// The 2026-10-23 20:42 field run died with exit code 0xC0000409 and no receipt
// anywhere — this closes the exception cohort of that shape.
void declareInitWorkerExceptionTerminal(const char* kind, const std::string& what) {
    long long seq = 0;
    std::string iid;
    {
        std::lock_guard<std::mutex> lk(g_initReceiptMutex);
        for (auto& r : g_initReceipts) {
            if (r.inFlight && !r.terminal) {
                seq = r.seq;
                iid = r.firstIid.empty() ? r.instanceId : r.firstIid;
                break;
            }
        }
    }
    if (seq > 0 && initRegistryMarkTerminal(seq, "failed")) {
        engineLog("[plugin] init failed: seq=" + std::to_string(seq) +
                  " reason=worker-exception kind=" + kind +
                  (iid.empty() ? std::string() : " instance=" + iid) +
                  " what=\"" + what + "\"" +
                  " — the worker's catch-all converted a would-be std::terminate into this terminal receipt (D14b: the silent fail-fast cohort)");
    } else {
        engineLog(std::string("[plugin] init worker exception: kind=") + kind +
                  " what=\"" + what + "\" (no in-flight request to mark terminal — the loop continues; D14b: no silent thread death)");
    }
    {
        std::lock_guard<std::mutex> lock(g_pluginInitMutex);
        g_pluginLoadActive.store(g_pluginInitPending, std::memory_order_release);
    }
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
            // 0.9.2: the probe measures CAPABILITIES, not load timing — the
            // M1-hotfix slow knobs shape the ENGINE's load path and must not
            // make a probe sleep (a 20 s probe child overlapping the next
            // create was the D5 CI failure's timing hazard). Strip them
            // (an empty value reads as 0 = disabled in the fixture).
#ifdef _WIN32
            _putenv_s("SCORCH_TESTVST_SLOW_CREATE_S", "");
            _putenv_s("SCORCH_TESTVST_SLOW_CREATE_N", "");
            _putenv_s("SCORCH_TESTVST_SLOW_PREPARE_N", "");
            _putenv_s("SCORCH_TESTVST_SLOW_PREPARE_S", "");
            _putenv_s("SCORCH_TESTVST_EDITOR_JAM_MS", "");
#else
            setenv("SCORCH_TESTVST_SLOW_CREATE_S", "", 1);
            setenv("SCORCH_TESTVST_SLOW_CREATE_N", "", 1);
            setenv("SCORCH_TESTVST_SLOW_PREPARE_N", "", 1);
            setenv("SCORCH_TESTVST_SLOW_PREPARE_S", "", 1);
            setenv("SCORCH_TESTVST_EDITOR_JAM_MS", "", 1);
#endif
            return runProbeWorker(argv[i + 1], argv[i + 2]);
        }
    }

#ifdef _WIN32
    // M1-hotfix: crash forensics FIRST — before any thread, any JUCE, any
    // socket. The next heavy-load death names itself ([crash] receipt +
    // minidump) instead of leaving a [mm] wedge and a respawn as the only
    // evidence.
    scorchcrash::install();
    // D14b: the WER banner prints AFTER arg handling (next to the listening
    // line) — the --version stdout contract is exactly one version line +
    // nothing else (run 131's CI version check feeds the whole stdout to a
    // strict -notmatch; a pre-arg-loop banner broke it).
#endif

    int port = kDefaultPort;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--version") {
            // "audio: built-in" is the compile-gate-absence proof: a gated
            // (mute) build would not report audio support here.
            std::cout << "scorch-engine " << kEngineVersion
                      << " (commit " << SCORCH_ENGINE_COMMIT
                      << ", protocol " << kProtocolVersion
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
        // M2 output guard: the flag stays ACCEPTED (protocol stability) but
        // is INERT — the shipped default is unity and nothing multiplies.
        // The per-bus gain stage + soft limiter are the NEXT milestone.
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

    // 0.9.2: the fixture's create-jam latch token — a per-session value the
    // fixture (and any probe child, which inherits the env) uses to key its
    // "jam at most once" latch FILE (see ScorchTestSynth.h: a Windows
    // FreeLibrary + module reload resets the fixture's static create counter,
    // so a counter alone re-arms the jam; the FILE survives module reloads).
    // Port + monotonic clock: unique per engine session, deterministic enough.
    {
        const long long tok = std::chrono::steady_clock::now().time_since_epoch().count();
        const std::string jamToken = std::to_string(port) + "-" + std::to_string(tok);
#ifdef _WIN32
        _putenv_s("SCORCH_TESTVST_JAM_TOKEN", jamToken.c_str());
#else
        setenv("SCORCH_TESTVST_JAM_TOKEN", jamToken.c_str(), 1);
#endif
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
        // Stage 3i: the latency watchdog timer lives on the message thread —
        // started HERE so the Timer is created on the same thread that pumps
        // it (JUCE requirement), for the process lifetime. Every 2000 ms it
        // drains the plugin-notification flags (immediate path, no debounce)
        // and walks every live instance as the safety net for plugins that
        // change WITHOUT notifying (2-identical-reads debounce there).
        g_latencyWatch = new LatencyWatchTimer();
        g_latencyWatch->startTimer(2000);
#ifdef _WIN32
        // D14 Fix A: the bounded-capture target lives ON the MM pump thread —
        // the thread every hosted plugin treats as its own message thread.
        createMmCaptureWindowOnThisThread();
#endif
        // Blocks until main() calls stopDispatchLoop() at shutdown. The loop
        // is event-driven (no polling, no keep-alive): it wakes for every
        // posted JUCE message and sleeps otherwise.
        // D14b: a throwing message-thread job (a callAsync lambda — the retire
        // jobs, the D14 capture, the editor ops all run HERE) used to unwind
        // out of runDispatchLoop and out of this thread — an unobserved
        // std::terminate and a dead MM. The pump now receipts the throwable
        // and RESUMES dispatching; stopDispatchLoop() still ends it normally.
        while (!g_should_exit.load()) {
            try {
                juce::MessageManager::getInstance()->runDispatchLoop();
                break;   // normal exit — stopDispatchLoop() was called
            } catch (const std::exception& mmEx) {
                std::string whatSafe;
                try { whatSafe = mmEx.what(); } catch (...) { whatSafe = "(what() threw)"; }
                if (whatSafe.size() > 200) whatSafe.resize(200);
                engineLog(std::string("[engine] MM pump exception: ") + whatSafe +
                          " — the dispatch loop RESUMES (D14b: a throwing message-thread job cannot kill the MM silently)");
            } catch (...) {
                engineLog("[engine] MM pump exception: unknown (non-std throwable) — the dispatch loop RESUMES (D14b)");
            }
        }
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
    // (g_mmHeartbeatMs lives at FILE scope now — field-gate B-2 moved it out
    // of main() so every >10s declaration can read the same stamp.)
    std::thread mm_heartbeat_thread([]() {
        auto nowMs = []() {
            return std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now().time_since_epoch()).count();
        };
        g_mmHeartbeatMs.store(nowMs(), std::memory_order_release);
        bool unresponsiveNamed = false;
        long long stallStartMs = 0;
        while (!g_should_exit.load()) {
            try {
            std::this_thread::sleep_for(std::chrono::milliseconds(1000));
            if (g_should_exit.load()) break;
            juce::MessageManager::callAsync([nowMs] {
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
                engineLog("[mm] message thread unresponsive for " + std::to_string(s) + " s — " +
                          mmOccupancySuffix());
                broadcastJson(std::string("{\"type\":\"engineDiagnostic\",\"mm\":\"unresponsive\",\"seconds\":") +
                              std::to_string(s) + "}");
            } else if (fresh && unresponsiveNamed) {
                unresponsiveNamed = false;
                const long long s = (now - stallStartMs) / 1000;
                engineLog("[mm] message thread recovered after " + std::to_string(s) + " s — " +
                          mmOccupancySuffix());
                broadcastJson(std::string("{\"type\":\"engineDiagnostic\",\"mm\":\"recovered\",\"seconds\":") +
                              std::to_string(s) + "}");
            }
            } catch (const std::exception& thEx) {
                std::string whatSafe;
                try { whatSafe = thEx.what(); } catch (...) { whatSafe = "(what() threw)"; }
                if (whatSafe.size() > 200) whatSafe.resize(200);
                engineLog(std::string("[engine] MM heartbeat thread exception: ") + whatSafe +
                          " — the loop continues (D14b: no silent thread death)");
            } catch (...) {
                engineLog("[engine] MM heartbeat thread exception: unknown (non-std throwable) — the loop continues (D14b)");
        }}});

    // D14: the bound monitor — names capture/teardown steps that blew the
    // 5 s ceiling (additive; the D13 watchdog is untouched).
    std::thread d14_bound_monitor([]() { d14BoundMonitorBody(); });

    // Stage 3b-fix: NO audio initialization at startup. Audio is brought up
    // lazily on the first transport play (or simulated via --null-audio), so
    // a headless machine boots cleanly and the protocol test does not depend
    // on audio hardware.
    std::cout << "[engine] audio policy: lazy init on first transport play";
    if (g_nullAudio) std::cout << " (--null-audio)";
    else if (g_forcedNoAudio) std::cout << " (--no-audio: forced device-less)";
    std::cout << std::endl;
    // Milestone 2: the per-instance MIDI selectors read their slot's buffer
    // through this table — bind the STABLE addresses once, before any device
    // or load can exist.
    g_audioCallback.bindSelectorSources();
    engineLog(std::string("[engine] start v") + kEngineVersion + " commit " +
              SCORCH_ENGINE_COMMIT + " port " +
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
                // hello carries the build commit (D12 receipt-provenance) —
                // additive field; protocol 1 consumers read engineVersion only.
                std::string hello = "{\"type\":\"hello\",\"engineVersion\":\"" +
                                    std::string(kEngineVersion) +
                                    "\",\"commit\":\"" + std::string(SCORCH_ENGINE_COMMIT) +
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
                try {
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
                } else if (type == "routing") {
                    handle_routing(parsed, ws);
                } else if (type == "strips") {
                    handle_strips(parsed, ws);   // M3 PR2: the strip wiring table
                } else if (type == "layoutAll") {
                    handle_layoutAll(parsed, ws);   // M3 PR2: per-instance layout probe
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
                } catch (const std::exception& wsEx) {
                    std::string whatSafe;
                    try { whatSafe = wsEx.what(); } catch (...) { whatSafe = "(what() threw)"; }
                    if (whatSafe.size() > 200) whatSafe.resize(200);
                    engineLog(std::string("[ws] handler exception: ") + whatSafe +
                              " — the dispatch continues; the client gets an error reply (D14b: no silent thread death)");
                    try {
                        ws.send(std::string("{\"type\":\"error\",\"code\":\"handler_exception\",\"detail\":\"") +
                                escape_json(whatSafe) + "\"}");
                    } catch (...) {}
                } catch (...) {
                    engineLog("[ws] handler exception: unknown (non-std throwable) — the dispatch continues (D14b: no silent thread death)");
                    try { ws.send("{\"type\":\"error\",\"code\":\"handler_exception\",\"detail\":\"unknown\"}"); } catch (...) {}
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
            try {
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
            } catch (const std::exception& thEx) {
                std::string whatSafe;
                try { whatSafe = thEx.what(); } catch (...) { whatSafe = "(what() threw)"; }
                if (whatSafe.size() > 200) whatSafe.resize(200);
                engineLog(std::string("[engine] state broadcaster thread exception: ") + whatSafe +
                          " — the loop continues (D14b: no silent thread death)");
            } catch (...) {
                engineLog("[engine] state broadcaster thread exception: unknown (non-std throwable) — the loop continues (D14b)");
        }}});

    // Stage 3c-regression — plugin init worker: instantiates VST3s OFF the WS
    // thread (BBCSO took 5.7s and froze the loop behind it). Single worker,
    // latest request wins; the instance is prepared for the REAL device
    // config BEFORE it becomes visible to the audio callback; plugin_state +
    // engine.log receipts are emitted on completion. Joined after
    // server.stop() like the state broadcaster, so sends stay valid.
    std::thread plugin_init_thread([&server]() {
#ifdef _WIN32
        // TASK J root fix (design R1): this thread owns the plugin's private
        // JUCE infrastructure window (the load's hasEditor view probe boots
        // it HERE) — the teardown handoff targets it, and the worker pumps
        // the pending module-teardown jobs each pass (~100 ms cadence).
        scorchguard::g_initWorkerTid.store(static_cast<uint32_t>(GetCurrentThreadId()),
                                           std::memory_order_release);
#endif
        uint64_t seenGen = 0;
        // M2 output-guard janitor state (this thread only).
        uint64_t janitorLastClips = 0;
        std::chrono::steady_clock::time_point janitorLastClipEmit{}, janitorLastPeakEmit{};
        // M4: the limiter gr-advance receipt's state (same 1 Hz discipline).
        float janitorLastGr = 0.0f;
        std::chrono::steady_clock::time_point janitorLastGrEmit{};
        while (!g_should_exit.load()) {
            try {
#ifdef _WIN32
            // TASK J root fix (design R1): the module-teardown pump — destroy
            // retired modules' worker-owned windows on THIS (owning) thread +
            // bounded drain, then ack the retire's phase 2 on the MM.
            scorchguard::runPendingTeardownJobs();
#endif
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
                    // Milestone 1: the PLUGIN retire queue is GONE — the vendored
                    // graph owns plugin teardown (RenderSequenceExchange frees a
                    // removed instance only after the audio thread swapped to
                    // the sequence that excludes it; the meta is graveyard-
                    // retained). The SCORE queue above keeps its audio-proof
                    // discipline: score snapshots are engine-owned arrays the
                    // dispatch walk reads directly — nothing in the vendor
                    // replaces that contract.
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
                        // Field-gate B-2: the declaration carries the MM
                        // occupancy (WHAT the message thread is doing, how
                        // deep the editor queue is) and the B-1 fold count —
                        // "11 queued Falcon editors" is now observable as
                        // folds=10 on ONE job, not 11 silent queued jobs.
                        engineLog(std::string("[editor] open pending >10s instance=") +
                                  g_pendingEditorOpen.iid +
                                  " folds=" + std::to_string(g_pendingEditorOpen.folds) +
                                  (started
                                       ? " — createEditor() has not returned; message thread blocked inside plugin editor creation"
                                       : " — message-thread job has not started; message thread appears wedged") +
                                  " | " + mmOccupancySuffix());
                    }
                }
            }
            // ── Milestone 2 output guard — the OBSERVABILITY half ──
            // The audio thread counts per-buffer peaks (g_lastPeak) and
            // post-sum samples above unity (g_clipCount). This janitor pass
            // speaks them: an immediate (1/s rate-limited) receipt whenever
            // the clip counter advances, and a 1 Hz per-render peak receipt
            // while the transport rolls. The [stop] receipt carries the
            // cumulative total too. Receipts are LOG-side only — the audio
            // thread never logs.
            {
                const uint64_t clips = g_clipCount.load(std::memory_order_relaxed);
                const float nowPeak = g_lastPeak.load(std::memory_order_relaxed);
                const bool playingNow = g_engine.playing.load(std::memory_order_relaxed);
                const auto now = std::chrono::steady_clock::now();
                if (clips != janitorLastClips &&
                    std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - janitorLastClipEmit).count() >= 1000) {
                    engineLog("[audio] clip counter +" + std::to_string(clips - janitorLastClips) +
                              " total=" + std::to_string(clips) +
                              " peak=" + std::to_string(nowPeak) +
                              " (post-LIMITER samples above unity: behind an armed limiter this names a DEFECT; the SCORCH_LIMITER_OFF CI run asserts the counter still advances)");
                    janitorLastClips = clips;
                    janitorLastClipEmit = now;
                }
                if (playingNow &&
                    std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - janitorLastPeakEmit).count() >= 1000) {
                    char pb[16];
                    std::snprintf(pb, sizeof(pb), "%.3f", static_cast<double>(nowPeak));
                    std::string selCounts;
                    for (int sl = 0; sl < scorchhost::kMaxInstances; ++sl)
                        selCounts += (sl ? "," : "") +
                            std::to_string(scorchhost::g_selectorEmitCount[sl].load(std::memory_order_relaxed)) +
                            "/" + std::to_string(scorchhost::g_selectorLastD1[sl].load(std::memory_order_relaxed)) +
                            "/" + std::to_string(scorchhost::g_selectorBlockCount[sl].load(std::memory_order_relaxed));
                    char grb[16];
                    std::snprintf(grb, sizeof(grb), "%.2f",
                                  static_cast<double>(g_limiterGrDb.load(std::memory_order_relaxed)));
                    engineLog(std::string("[audio] render peak=") + pb +
                              " clipsTotal=" + std::to_string(clips) +
                              " gr=" + grb + "dB" +
                              " instances=" + std::to_string(liveInstanceCount()) +
                              " selectorEmitted=[" + selCounts + "]" +
                              (g_limiterBypassed.load(std::memory_order_relaxed)
                                   ? " limiter=off (SCORCH_LIMITER_OFF)"
                                   : " limiter=armed (M4 output stage, post-graph)") +
                              // Field-gate B-3: WHOSE audio was that — the
                              // peak's material source for THIS buffer
                              // (pre-mix maxima; ties → graph, the primary
                              // path; both zero → graph at peak 0.000).
                              " src=" +
                              (g_lastPeakGraph.load(std::memory_order_relaxed) >=
                                       g_lastPeakSynth.load(std::memory_order_relaxed)
                                   ? "graph" : "fallback"));
                    janitorLastPeakEmit = now;
                }
                // M4 (D5): the limiter gr-advance receipt — the same 1 Hz
                // delta discipline as the clip counter, for the KNEE engaging.
                // Engaging the knee is INTENDED behavior (R-C: gentle
                // reduction between -6 dBFS and the ceiling), so this receipt
                // is the observability half, not an alarm: CI's hot run
                // asserts it appears, and every healthy-level run asserts
                // it stays SILENT (the transparency proof's log side).
                const float grNow = g_limiterGrMaxDb.load(std::memory_order_relaxed);
                if (grNow > janitorLastGr + 0.05f &&
                    std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - janitorLastGrEmit).count() >= 1000) {
                    char gdb[16], gmb[16];
                    std::snprintf(gdb, sizeof(gdb), "%.2f",
                                  static_cast<double>(grNow - janitorLastGr));
                    std::snprintf(gmb, sizeof(gmb), "%.2f", static_cast<double>(grNow));
                    engineLog(std::string("[audio] limiter gr + ") + gdb +
                              " sessionMax=" + gmb + "dB" +
                              " (the knee engaging - intended M4 reduction below the ceiling)");
                    janitorLastGr = grNow;
                    janitorLastGrEmit = now;
                }
            }
            // ── M3 PR1 — the unmapped-drop receipts (1 Hz, delta-emitted) ──
            // The audio thread counts dropped events per track slot under an
            // explicit routing table; this pass speaks the DELTAS so a drop is
            // always named within a second, never silent, never logged from
            // the audio thread. Not gated on playback: the final drops that
            // straddle a stop are still spoken.
            {
                static std::array<uint32_t, kMaxDropTrackSlots> dropLastSeen{};
                static std::chrono::steady_clock::time_point dropLastEmit{};
                const auto dropNow = std::chrono::steady_clock::now();
                if (std::chrono::duration_cast<std::chrono::milliseconds>(
                        dropNow - dropLastEmit).count() >= 1000) {
                    const auto rt = g_routing.load(std::memory_order_acquire);
                    for (size_t ds = 1; ds <= kMaxDropTrackSlots; ++ds) {
                        const uint32_t nowCount = g_unmappedDrops[ds - 1].load(std::memory_order_relaxed);
                        const uint32_t delta = nowCount - dropLastSeen[ds - 1];
                        if (delta == 0) continue;
                        dropLastSeen[ds - 1] = nowCount;
                        std::string name;
                        if (rt != nullptr && ds <= rt->trackNames.size())
                            name = " (" + rt->trackNames[ds - 1] + ")";
                        engineLog("[routing] track " + std::to_string(ds) + " unmapped, " +
                                  std::to_string(delta) + " notes dropped" + name);
                    }
                    dropLastEmit = dropNow;
                }
            }

            // ── M3 PR2 worker drains (1 Hz, the same sampler as the drops) ──
            // (1) R4 teardown-flush receipts: the audio-side slot wipe counted
            //     the abandoned held notes it cleared (all-sound-off semantics)
            //     — speak them, once, with the instance identity from the
            //     graveyard/live set.
            for (int s = 0; s < scorchhost::kMaxInstances; ++s) {
                const int held = g_slotWipedHeldNotes[s].exchange(0, std::memory_order_relaxed);
                if (held <= 0) continue;
                std::string iid;
                {
                    std::lock_guard<std::mutex> lk(g_hostGraveyardMutex);
                    for (auto it = g_hostGraveyard.rbegin(); it != g_hostGraveyard.rend(); ++it)
                        if (*it != nullptr && (*it)->slot == s) { iid = (*it)->instanceId; break; }
                }
                if (iid.empty())
                    if (auto set = liveSetSnapshot())
                        for (auto* h : set->bySlot)
                            if (h != nullptr && h->slot == s) { iid = h->instanceId; break; }
                engineLog("[strip] teardown flush: slot=" + std::to_string(s) +
                          (iid.empty() ? "" : " instance=" + iid) +
                          " held=" + std::to_string(held) +
                          " wiped — all-sound-off (CC120) semantics for the abandoned"
                          " notes (the rebind-flush precedent); the node's voices die"
                          " with the vendor sequence retire");
            }
            // (2) R3 layout-guard protocol push: the message-thread guard set
            //     the payload — ONE push per change, from here (the audio
            //     thread never sends).
            {
                std::string iid, unwiredJson;
                int liveChannels = -1;
                {
                    std::lock_guard<std::mutex> lk(g_stripLayoutPushMutex);
                    if (g_stripLayoutPush.pending) {
                        g_stripLayoutPush.pending = false;
                        iid = g_stripLayoutPush.instanceId;
                        liveChannels = g_stripLayoutPush.liveChannels;
                        for (size_t i = 0; i < g_stripLayoutPush.unwired.size(); ++i) {
                            if (!unwiredJson.empty()) unwiredJson += ",";
                            unwiredJson += "\"" + escape_json(g_stripLayoutPush.unwired[i]) + "\"";
                        }
                    } else {
                        iid.clear();
                    }
                }
                if (!iid.empty()) {
                    broadcastJson(std::string("{\"type\":\"stripLayoutChanged\",\"instanceId\":\"") +
                                  escape_json(iid) + "\",\"liveChannels\":" +
                                  std::to_string(liveChannels) + ",\"unwired\":[" + unwiredJson +
                                  "],\"reason\":\"layout\"}");
                    engineLog("[strip] layout push sent: instance=" + iid +
                              " liveChannels=" + std::to_string(liveChannels));
                }
            }
            // (3) Strip stats (SCORCH_STRIP_LOG=1 — CI observability): per
            //     ACTIVE strip, the drain-window pre/post peaks + block count,
            //     then the window resets. prePeak = content truth (alive even
            //     when muted), postPeak = delivery truth (0 when muted/dead).
            {
                static const bool stripLogEnabled = std::getenv("SCORCH_STRIP_LOG") != nullptr;
                if (stripLogEnabled) {
                    const auto set = g_strips.load(std::memory_order_acquire);
                    if (set != nullptr) {
                        for (const auto& e : set->strips) {
                            if (!e.active || e.slot < 0 || e.slot >= kMaxStrips) continue;
                            StripStats& st = g_stripStats[e.slot];
                            const uint64_t blocks = st.blocks.exchange(0, std::memory_order_relaxed);
                            if (blocks == 0) continue;
                            const float pre = st.prePeak.exchange(0.0f, std::memory_order_relaxed);
                            const float post = st.postPeak.exchange(0.0f, std::memory_order_relaxed);
                            engineLog("[strip] stats: strip=" + e.stripId +
                                      " instance=" + e.inst +
                                      " pair=[" + std::to_string(e.pair0) + "," + std::to_string(e.pair1) +
                                      "] pre=" + juce::String(pre, 4).toStdString() +
                                      " post=" + juce::String(post, 4).toStdString() +
                                      " blocks=" + std::to_string(blocks));
                        }
                    }
                }
            }
            // (3b) Field-gate-2: the 1 Hz [stripmix] receipt — per ACTIVE strip
            //      with content in the window, in/out peaks as dB (the
            //      shared-instance loudness probe: strip-level truth that pairs
            //      with the janitor's master-level receipt). The greppable
            //      contract is the FIRST FOUR fields — [stripmix] strip=<id>
            //      inst=<name> in_db=<x> out_db=<x> — extras (linear peaks,
            //      pair, blocks) ride AFTER so the shape stays stable. Own
            //      window: never touches g_stripStats (the [strip] drain's
            //      atomics). No env gate: always-on like the janitor, silent
            //      strips emit nothing (blocks==0 in the window).
            {
                static std::chrono::steady_clock::time_point stripMixLastEmit{};
                const auto nowMix = std::chrono::steady_clock::now();
                if (std::chrono::duration_cast<std::chrono::milliseconds>(
                        nowMix - stripMixLastEmit).count() >= 1000) {
                    stripMixLastEmit = nowMix;
                    const auto setMx = g_strips.load(std::memory_order_acquire);
                    if (setMx != nullptr) {
                        for (const auto& e : setMx->strips) {
                            if (!e.active || e.slot < 0 || e.slot >= kMaxStrips) continue;
                            StripStats& sm = g_stripMixStats[(size_t) e.slot];
                            const uint64_t mblocks = sm.blocks.exchange(0, std::memory_order_relaxed);
                            if (mblocks == 0) continue;   // silent window: no line
                            const float mpre = sm.prePeak.exchange(0.0f, std::memory_order_relaxed);
                            const float mpost = sm.postPeak.exchange(0.0f, std::memory_order_relaxed);
                            char preDb[16], postDb[16];
                            if (mpre > 0.0f)
                                std::snprintf(preDb, sizeof(preDb), "%.2f", 20.0 * std::log10((double) mpre));
                            else
                                std::snprintf(preDb, sizeof(preDb), "%s", "-inf");
                            if (mpost > 0.0f)
                                std::snprintf(postDb, sizeof(postDb), "%.2f", 20.0 * std::log10((double) mpost));
                            else
                                std::snprintf(postDb, sizeof(postDb), "%s", "-inf");
                            engineLog("[stripmix] strip=" + e.stripId +
                                      " inst=" + e.inst +
                                      " in_db=" + preDb +
                                      " out_db=" + postDb +
                                      " in=" + juce::String(mpre, 4).toStdString() +
                                      " out=" + juce::String(mpost, 4).toStdString() +
                                      " pair=[" + std::to_string(e.pair0) + "," + std::to_string(e.pair1) + "]" +
                                      " blocks=" + std::to_string(mblocks));
                        }
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
            // 0.9.2: a request the watchdog already declared terminal (the
            // worker was jammed on an OLDER request while this one sat queued)
            // is DISCARDED, never executed — a second "loaded" after the
            // declared "failed" would break the exactly-one invariant.
            if (initRegistryIsTerminal(req.seq)) {
                engineLog("[plugin] init skipped — seq " + std::to_string(req.seq) +
                          " was already declared terminal while the worker was stuck (no second terminal receipt; reload to retry)");
                {
                    std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                    g_pluginLoadActive.store(g_pluginInitPending, std::memory_order_release);
                }
                continue;
            }
            {
                std::lock_guard<std::mutex> lk(g_initReceiptMutex);
                for (auto& r : g_initReceipts) {
                    if (r.seq == req.seq && !r.terminal) {
                        r.inFlight = true; r.phase = "dequeue"; r.instanceId = "-";
                        r.phaseSince = std::chrono::steady_clock::now();   // D12: the stall clock starts at dequeue
                    }
                }
            }
            // ── 0.9.2 LAZY-DEVICE RACE (#4): the audit receipt ──
            // seq 2 of the field log was queued BEFORE the audio device
            // existed ("lazy init on first transport play" precedes the
            // device-ready line). The worker NEVER waits for the device —
            // there is no blocking await to jam on — and this receipt names
            // the path it took, per request, so the log answers "did the
            // prepare use real or nominal settings?" without guesswork:
            // device=ready → real captured settings; device=not-started →
            // NOMINAL 44100/512 fallback and audioDeviceAboutToStart
            // re-prepares on device-ready. Both paths complete; neither
            // blocks indefinitely.
            if (g_deviceStarted.load(std::memory_order_acquire)) {
                engineLog("[plugin] init device=ready rate=" +
                          std::to_string(static_cast<int>(g_engine.sampleRate.load())) +
                          " buffer=" + std::to_string(g_deviceBufferSize.load()) +
                          " seq " + std::to_string(req.seq) +
                          " — pre-prepare at real device settings");
            } else {
                engineLog("[plugin] init device=not-started seq " + std::to_string(req.seq) +
                          " — pre-prepare at NOMINAL 44100/512 (fallback path — never waits for the device);"
                          " AboutToStart re-prepares on device-ready");
            }
            // ── Milestone 1: EXPLICIT UNLOAD ({"plugins": []}) ──
            // The live instance retires through the vendor path: editor close
            // → removeNode, one message-thread job. No plugin_state follows
            // (matching the old vanished-group behavior — the frontend knows
            // the group it removed). M1-hotfix: the state capture runs HERE on
            // the worker (trigger "unload (worker)") — a heavyweight
            // library's getStateInformation must never sit inside a
            // message-thread job (the same seconds-class MM exposure the
            // replace path had).
            if (req.unload) {
                // ── Milestone 2: unload = the diff with an EMPTY request set —
                // EVERY live instance retires (capture → editor close → vendor
                // removeNode, per instance). M1-hotfix: the state capture runs
                // HERE on the worker (trigger "unload (worker)") — a
                // heavyweight library's getStateInformation must never sit
                // inside a message-thread job.
                engineLog("[plugin] unload running | seq " + std::to_string(req.seq) +
                          " — retiring ALL live instances (" +
                          std::to_string(liveInstanceCount()) +
                          ") (worker capture → editor close → vendor removeNode, per instance)");
                for (HostedPlugin* oldMeta : liveSetSnapshot()->bySlot) {
                    if (oldMeta == nullptr) continue;
                    juce::AudioPluginInstance* oldInst =
                        oldMeta->rawInstance.load(std::memory_order_acquire);
                    if (oldInst == nullptr) continue;
                    if (req.discardRetire) {
                        // D14 Fix B: discard-class unload — no capture (see
                        // the diff-remove site).
                        engineLog("[plugin] state capture SKIPPED (discard-class retire) instance=" +
                                  oldMeta->instanceId +
                                  " (unload (worker)) | seq " + std::to_string(req.seq) +
                                  " — destroy→drain→unload proceeds with no plugin-call dependency (D14 Fix B)");
                        continue;
                    }
                    // 0.9.2: the capture is a NAMED phase now — a hung
                    // getStateInformation here was invisible to the
                    // watchdog (no phase record) and the request had
                    // no path to a terminal receipt.
                    // D14 Fix A: the phase guard now wraps a BOUNDED send
                    // (the plugin's message thread, 5 s ceiling) — never a
                    // bare worker-side plugin call.
                    InitPhaseGuard pg("state-capture", oldMeta->instanceId, req.seq);
                    boundedRetireCaptureOnMessageThread(oldInst, *oldMeta, "unload (worker)");
                }
                auto doneU = std::make_shared<std::atomic<bool>>(false);
                juce::MessageManager::callAsync([doneU] {
                    retireAllInstanceNodesOnMessageThread();
                    doneU->store(true, std::memory_order_release);
                });
                const auto tu0 = std::chrono::steady_clock::now();
                while (!doneU->load(std::memory_order_acquire) && !g_should_exit.load()) {
                    const auto w = std::chrono::duration_cast<std::chrono::milliseconds>(
                        std::chrono::steady_clock::now() - tu0).count();
                    if (w >= 10000) break;
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
                const long long uMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - tu0).count();
                if (doneU->load(std::memory_order_acquire)) {
                    // The unload's terminal receipt (its "exactly one"): the
                    // existing completion line, registry-marked.
                    if (initRegistryMarkTerminal(req.seq, "loaded"))
                        engineLog("[plugin] unload complete | seq " + std::to_string(req.seq) +
                                  " elapsed=" + std::to_string(uMs) + "ms");
                    // Milestone 2: the published set goes EMPTY; every lease
                    // frees; every slot's audio state clears at the next
                    // buffer boundary (no stale held notes for a future
                    // re-add); the latency mirrors follow down.
                    {
                        auto next = std::make_shared<const InstanceSet>();
                        g_liveSet.store(next, std::memory_order_release);
                        {
                            std::lock_guard<std::mutex> lk(g_slotLeaseMutex);
                            for (auto& l : g_slotLease) l.clear();
                        }
                        for (int sl = 0; sl < scorchhost::kMaxInstances; ++sl) {
                            g_slotStateClearPending[sl].store(true, std::memory_order_release);
                            g_slotLatencySamples[sl].store(0, std::memory_order_release);
                        }
                        republishMaxLatencyMirror();
                    }
                } else if (!g_should_exit.load()) {
                    // 0.9.2: the retire job never ran — the old code logged
                    // "unload complete" regardless (a dishonest receipt).
                    if (initRegistryMarkTerminal(req.seq, "failed"))
                        engineLog("[plugin] init failed: seq=" + std::to_string(req.seq) +
                                  " reason=unload-retire-timeout (the message-thread retire job did not run within 10000 ms)" +
                                  " — unload NOT confirmed after " + std::to_string(uMs) + "ms");
                }
                {
                    std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                    g_pluginLoadActive.store(g_pluginInitPending, std::memory_order_release);
                }
                continue;
            }
            // Stage 3f-7: the load is in progress until this iteration ends —
            // the probe thread pauses for all of it (queue time already set
            // the flag on the WS thread; this re-assert covers superseding
            // requests that were queued while a previous iteration ran).
            g_pluginLoadActive.store(true, std::memory_order_release);
            const auto t0 = std::chrono::steady_clock::now();
            // ─── Milestone 2: DIFF-BASED REUSE ───
            // The request is diffed against the LIVE SET at run time (the set
            // may have changed since the WS thread parsed it — an older
            // request may have completed in between). Classes, per
            // instanceId, identity = uid+path:
            //   kept     — live with the SAME binary: untouched (no
            //              re-instantiate, no re-prepare, no node churn); a
            //              receipt + a wire plugin_state re-echo.
            //   added    — not live: instantiate (the entry loop below).
            //   changed  — live with a DIFFERENT binary: capture the old
            //              state (worker), retire the old node, instantiate
            //              the new one into the SAME slot.
            //   removed  — live but absent from the request: capture +
            //              retire, free the slot lease, clear the slot's
            //              audio state at the next buffer boundary.
            // First: lease GC — a request superseded before the worker saw it
            // leaves a lease that matches neither a live instance nor this
            // request; free those (removed leases free in the removal pass).
            {
                std::vector<std::string> stale;
                {
                    std::lock_guard<std::mutex> lk(g_slotLeaseMutex);
                    for (auto& l : g_slotLease) {
                        if (l.empty()) continue;
                        const bool live = findLiveInstance(l) != nullptr;
                        bool requested = false;
                        for (const auto& e : req.entries) if (e.instanceId == l) { requested = true; break; }
                        if (!live && !requested) { stale.push_back(l); l.clear(); }
                    }
                }
                for (const auto& id : stale)
                    engineLog("[plugin] slot lease GC: \"" + id +
                              "\" (superseded before the worker saw it — slot freed)");
            }
            auto liveNow = liveSetSnapshot();
            std::vector<std::string> removedIds, removedSlots, keptIds, changedIds, addedIds;
            for (const auto& e : req.entries) {
                HostedPlugin* h = findLiveInstance(e.instanceId);
                if (h == nullptr) {
                    addedIds.push_back(e.instanceId);
                    continue;
                }
                juce::DynamicObject* po = e.pluginVar.getDynamicObject();
                const std::string uid = po ? po->getProperty("uid").toString().toStdString() : "";
                const std::string path = po ? po->getProperty("path").toString().toStdString() : "";
                if (h->uid == uid && h->path == path) keptIds.push_back(e.instanceId);
                else changedIds.push_back(e.instanceId);
            }
            for (HostedPlugin* m : liveNow->bySlot) {
                if (m == nullptr) continue;
                bool requested = false;
                for (const auto& e : req.entries) if (e.instanceId == m->instanceId) { requested = true; break; }
                if (!requested) {
                    removedIds.push_back(m->instanceId);
                    removedSlots.push_back(std::to_string(m->slot));
                }
            }
            engineLog("[plugin] set diff: kept=" + std::to_string(keptIds.size()) +
                      " added=" + std::to_string(addedIds.size()) +
                      " removed=" + std::to_string(removedIds.size()) +
                      " changed=" + std::to_string(changedIds.size()) +
                      " | seq " + std::to_string(req.seq) +
                      " (live now: " + std::to_string(liveInstanceCount()) + ")");
            for (const auto& id : keptIds)
                engineLog("[plugin] instance kept instance=" + id + " | seq " + std::to_string(req.seq));
            for (const auto& id : addedIds)
                engineLog("[plugin] instance added instance=" + id + " | seq " + std::to_string(req.seq));
            for (const auto& id : changedIds)
                engineLog("[plugin] instance changed instance=" + id +
                          " (binary swapped — retire old, instantiate new, SAME slot) | seq " +
                          std::to_string(req.seq));
            if (req.discardRetire)
                engineLog("[plugin] discard-class retires for seq " + std::to_string(req.seq) +
                          " (client-marked) — outgoing captures SKIPPED (D14 Fix B: the retire path never depends on a plugin's message-thread health)");
            // ── REMOVED pass (before anything else — survivors must never
            // wait behind a removal). Per instance: worker-side state capture
            // ("diff-remove (worker)") → retire MM job → bounded wait → free
            // the lease → clear the slot's audio state + latency mirror. The
            // survivors' nodes are untouched: no re-prepare, no audio gap (the
            // vendor's swap is lock-free on the audio thread).
            for (size_t ri = 0; ri < removedIds.size(); ++ri) {
                const std::string& iid = removedIds[ri];
                HostedPlugin* m = findLiveInstance(iid);
                if (m == nullptr) continue;
                juce::AudioPluginInstance* oldInst = m->rawInstance.load(std::memory_order_acquire);
                if (oldInst != nullptr) {
                    if (req.discardRetire) {
                        // D14 Fix B: the bench (and any client that marks it)
                        // retires DISCARD-CLASS — no capture at all. The
                        // harness path must never depend on a plugin's
                        // message-thread health.
                        engineLog("[plugin] state capture SKIPPED (discard-class retire) instance=" + iid +
                                  " (diff-remove (worker)) | seq " + std::to_string(req.seq) +
                                  " — destroy→drain→unload proceeds with no plugin-call dependency (D14 Fix B)");
                    } else {
                        // D14 Fix A: the outgoing capture rides the plugin's
                        // own message thread, bounded 5 s (SendMessageTimeout,
                        // SMTO_ABORTIFHUNG). A wedge here can no longer hold
                        // the worker: timeout → abandon receipt → the
                        // destroy→drain→unload below proceeds.
                        InitPhaseGuard pg("state-capture", iid, req.seq);
                        boundedRetireCaptureOnMessageThread(oldInst, *m, "diff-remove (worker)");
                    }
                }
                auto doneR = std::make_shared<std::atomic<bool>>(false);
                juce::MessageManager::callAsync([doneR, iid] {
                    retireInstanceNodeOnMessageThread(iid);
                    doneR->store(true, std::memory_order_release);
                });
                const auto tr0 = std::chrono::steady_clock::now();
                while (!doneR->load(std::memory_order_acquire) && !g_should_exit.load()) {
                    if (std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - tr0).count() >= 10000) break;
                    std::this_thread::sleep_for(std::chrono::milliseconds(10));
                }
                if (doneR->load(std::memory_order_acquire)) {
                    engineLog("[plugin] instance removed instance=" + iid + " slot=" + removedSlots[ri] +
                              " | seq " + std::to_string(req.seq) +
                              " (survivors untouched — no re-prepare, no audio gap)");
                    slotLeaseRelease(iid);
                    if (m->slot >= 0 && m->slot < scorchhost::kMaxInstances) {
                        g_slotStateClearPending[m->slot].store(true, std::memory_order_release);
                        g_slotLatencySamples[m->slot].store(0, std::memory_order_release);
                    }
                } else if (!g_should_exit.load()) {
                    engineLog("[plugin] instance remove DID NOT CONFIRM within 10000 ms instance=" + iid +
                              " | seq " + std::to_string(req.seq) +
                              " (message-thread retire job did not run — the lease and slot stay; reload to retry)");
                }
            }
            // ─── Stage 3d-4 (M2 revision): instantiate the ADDED/CHANGED
            // entries, entry by entry. Per-entry independence: one broken
            // binary must not kill the other instances of the set (a changed
            // entry whose instantiate fails RETAINS its previous instance —
            // the old node was not retired yet; an added entry leaves its
            // slot empty). A newer load supersedes the whole request (checked
            // after each entry — the not-yet-applied remainder is discarded).
            struct EntryOutcome {
                // Milestone 1: the committed meta (graveyard-retained) or
                // nullptr — the unique_ptr era ended with the InstanceSet.
                HostedPlugin* committed = nullptr;
                std::string err;
                long long initMs = 0;
                // 3e-3 FIX (3d-4 bug): success is tracked EXPLICITLY (the
                // original release()-nulls-the-pointer ambiguity — history:
                // every successful replace was misread as a failure until the
                // flag landed). Kept for the same reason.
                bool succeeded = false;
                // Milestone 2: the diff class this entry ran as (kept entries
                // never enter the loop; recorded for the publish receipts).
                const char* diffClass = "added";
            };
            std::vector<EntryOutcome> outcomes(req.entries.size());
            bool superseded = false;
            bool abandoned = false;   // 0.9.2: the watchdog declared this seq terminal while we were jammed
            // Stage 3d-3 (M2 kept-path revision): apply the project's
            // embedded state to an instance — shared by the instantiate path
            // (added/changed) and the KEPT path (an identical-identity entry
            // that still carries a state embed: the PROJECT's state wins over
            // whatever the live instance happens to hold — deterministic
            // project reloads; without this the diff silently ignored the
            // embed and the 3d-3 restore receipt vanished from the host
            // phase-O round-trip). Same documented order: instantiate → state
            // → prepare. A restore failure NEVER kills hosting.
            auto applyEmbeddedState = [](HostedPlugin* h, const PluginInitEntry& e, long long seq) {
                // The pointer duality (M1 InstanceSet): a PRE-COMMIT meta owns
                // the plugin in `instance` (unique_ptr); a COMMITTED meta —
                // which is what every KEPT entry resolves to — has instance==
                // null and the live processor in `rawInstance` (worker reads
                // are the documented discipline; the pointee is immortal-
                // by-policy while the node is live).
                juce::AudioPluginInstance* proc = nullptr;
                if (h) proc = h->instance ? h->instance.get() : h->rawInstance.load(std::memory_order_acquire);
                if (!h || !proc || e.stateB64.empty()) return;
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
                        InitPhaseGuard pg("state-restore", e.instanceId, seq);   // 3f-6 watchdog phase
                        InitBreadcrumbScope _bc("setStateInformation(project-embed)");   // D12
                        proc->setStateInformation(mos.getData(), static_cast<int>(restoredBytes));
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
            };
            for (size_t i = 0; i < req.entries.size(); ++i) {
                const PluginInitEntry& e = req.entries[i];
                // KEPT entries skip the heavyweight path entirely — that is
                // the diff contract (zero re-inits of untouched instances).
                // An embedded state is NOT "untouched" though: apply it to the
                // live instance (project's state wins).
                if (std::find(keptIds.begin(), keptIds.end(), e.instanceId) != keptIds.end()) {
                    outcomes[i].diffClass = "kept";
                    outcomes[i].succeeded = true;
                    outcomes[i].committed = findLiveInstance(e.instanceId);
                    applyEmbeddedState(outcomes[i].committed, e, req.seq);
                    continue;
                }
                outcomes[i].diffClass = std::find(changedIds.begin(), changedIds.end(), e.instanceId) != changedIds.end()
                    ? "changed" : "added";
                const auto te0 = std::chrono::steady_clock::now();
                std::unique_ptr<HostedPlugin> h;
                std::string hModulePath;   // D13: the pre-commit destroy-ordering guard's module path
                // Stage 3f-6: phase watchdog record — a plugin hanging inside
                // createPluginInstance is named after 60 s by the watchdog
                // thread (log only). 0.9.2: the guard also emits the stage
                // receipt and feeds the >10s pending warnings.
                std::string hostErr;
                {
                    InitPhaseGuard pg("instantiate", e.instanceId, req.seq);
                    InitBreadcrumbScope _bc("loadHostedPlugin(create)");   // D12
                    hostErr = loadHostedPlugin(e.pluginVar, e.instanceId, e.slot, h, e.routing, e.multiTimbral, &hModulePath);
                }
#ifdef _WIN32
                // ── D13: PRE-COMMIT DESTROY ORDERING (the hole run
                // 39818111671's dump named) ──
                // The R2 load-abort teardown covers death INSIDE
                // loadHostedPlugin; past it, `h` owns the instance — and
                // EVERY destruction outside a commit (the abandoned discard,
                // the superseded discard, the shutdown break) freed the
                // module with NO destroy→drain→verify ordering: a window the
                // half-booted GUI stack left behind stayed ARMED with its
                // WNDPROC in the module, and the free unmapped it (last
                // refcount) — the next editor activity pumped the ghost
                // (EXEC-DEP, user32 dispatch frame, the TASK F signature).
                // This guard runs the WORKER-side teardown (the windows'
                // owner is this thread; moduleIsOrphaned skips when another
                // live instance or a same-path load still holds the module
                // ref — then the free is a decrement, not an unmap) right
                // before ~h, and DISARMS at commit (h.release() — the
                // committed instance leaves via the live-set retire path,
                // which has its own ordering).
                struct PreCommitDestroyGuard {
                    const std::unique_ptr<HostedPlugin>* hRef;
                    const std::string* iidRef;
                    const std::string* pathRef;
                    ~PreCommitDestroyGuard() {
                        if (hRef->get() != nullptr && !pathRef->empty())
                            scorchguard::teardownModuleWindowsForLoadAbort(*iidRef, *pathRef);
                    }
                } preCommitDestroyGuard{&h, &e.instanceId, &hModulePath};
#endif
                outcomes[i].initMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - te0).count();
                {
                    std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                    superseded = seenGen != g_pluginInitGen;
                }
                // 0.9.2: the watchdog may have declared THIS request terminal
                // while the create was jammed (terminal-timeout) — the worker
                // discards its result instead of double-emitting.
                abandoned = initRegistryIsTerminal(req.seq);
                if (g_should_exit.load() || superseded || abandoned) break;
                if (!hostErr.empty()) {
                    outcomes[i].err = hostErr;
                    const bool isChanged = outcomes[i].diffClass == std::string("changed");
                    engineLog("[plugin] FAILED after " + std::to_string(outcomes[i].initMs) + "ms: " + hostErr +
                              " — instance \"" + e.instanceId + "\"" +
                              (isChanged ? " retains its previous instance (the old node was NOT retired)"
                                         : " leaves its slot empty") + " | seq " +
                              std::to_string(req.seq));
                    std::cout << "[engine] plugin load FAILED (" << e.instanceId << "): " << hostErr << std::endl;
                    const std::string ps = std::string("{\"type\":\"plugin_state\",\"state\":\"error\",\"instanceId\":\"") +
                        escape_json(e.instanceId) + "\",\"detail\":\"" +
                        escape_json(hostErr) + (isChanged ? " — previous instance retained\"}" : "\"}");
                    for (auto& client : server.getClients())
                        if (client) client->send(ps);
                    continue;
                }
                // Stage 3d-3 — restore the project's embedded state BEFORE the
                // real-device prepare (documented order: instantiate → state →
                // prepare). A restore failure NEVER kills hosting: the receipt
                // names it and the plugin runs on its default state.
                // (M2 kept-path revision: the block moved into the shared
                // applyEmbeddedState helper — identical behavior here, plus
                // kept entries with an embed now get the same treatment.)
                applyEmbeddedState(h.get(), e, req.seq);
                // ── M1-hotfix (heavy-load death): the legacy init-thread
                // prepare, restored ──
                // The migration dropped the worker-side real-device prepare and
                // let the graph's inline rebuild call plugin prepareToPlay ON
                // THE MESSAGE THREAD (the vendor's NodeStates::applySettings
                // prepares every unprepared node on the main thread — its
                // documented invariant). For a heavyweight library that put a
                // multi-second plugin call inside a message-thread job: the
                // [mm] heartbeat named 5–7 s unresponsive during the user's
                // Falcon loads, and the commit lambda (then unguarded) died
                // with the process. The legacy pattern (Stage 3c-regression →
                // 3e-3, the old code's comments document exactly why): the
                // WORKER prepares the instance for the real device BEFORE the
                // instance becomes visible to the audio callback. The vendor's
                // per-node prepare on the MM still runs (its invariant, not
                // ours to remove — no vendored-core modifications) — but it
                // now lands on an instance already prepared at IDENTICAL
                // settings: the cheap re-prepare, not the cold one.
                // Order preserved (documented 3d-3): instantiate → state →
                // prepare → commit.
                double prepRateOfEntry = g_deviceStarted.load(std::memory_order_acquire)
                                             ? g_engine.sampleRate.load()
                                             : g_host.sampleRate();
                int prepBufOfEntry = g_deviceStarted.load(std::memory_order_acquire)
                                         ? g_deviceBufferSize.load()
                                         : g_host.blockSize();
                {
                    const double prepRate = prepRateOfEntry;
                    const int prepBuf = prepBufOfEntry;
                    if (h != nullptr && h->instance) {
                        InitPhaseGuard pg("prepare", e.instanceId, req.seq);   // 3f-6 watchdog phase
                        InitBreadcrumbScope _bc("prepareToPlay(worker)");   // D12
                        // Stage 3e-2: playhead re-asserted before the prepare
                        // (plugins cache the pointer; re-assert is cheap and
                        // proof against wrapper resets).
                        h->instance->setPlayHead(&g_audioCallback.playHead);
                        h->instance->setPlayConfigDetails(0, 2, prepRate, prepBuf);
                        // Stage 3e-3: the negotiation disables non-main output
                        // buses — re-enable ALL output buses AFTER it (same
                        // ordering as loadHostedPlugin and AboutToStart).
                        for (int b = 0; b < h->instance->getBusCount(false); ++b)
                            if (auto* bus = h->instance->getBus(false, b)) bus->enable(true);
                        h->instance->prepareToPlay(prepRate, prepBuf);
                        const int preparedLat =
                            static_cast<int>(h->instance->getLatencySamples());
                        h->latencySamples = static_cast<double>(preparedLat);
                        engineLog("[plugin] prepared (worker) rate=" +
                                  std::to_string(static_cast<int>(prepRate)) +
                                  " buffer=" + std::to_string(prepBuf) +
                                  " latencySamples=" + std::to_string(preparedLat) +
                                  " instance=" + e.instanceId +
                                  (g_deviceStarted.load(std::memory_order_acquire)
                                       ? " (real device)"
                                       : " (nominal — device not started yet; AboutToStart re-prepares)") +
                                  " — pre-commit: the graph's message-thread prepare is a same-settings re-prepare");
                    }
                }
                // ── M1-hotfix (heavy-load death): the retire's state capture
                // moved BACK to the worker ──
                // The migration put captureAndBroadcastState inside the
                // message-thread retire job; for a heavyweight outgoing
                // library getStateInformation is seconds-class ON THE MM (the
                // legacy code documented it host-callable from ANY thread and
                // captured on this worker — trigger "replace"). Captured here,
                // before the retire job is queued; the job below only closes
                // the editor and removes the node.
                // Milestone 2: this is the CHANGED-entry capture — the OLD
                // instance of THIS instanceId (the whole-set capture is gone
                // with the replace-all semantics; added entries have nothing
                // to capture).
                if (outcomes[i].diffClass == std::string("changed")) {
                    HostedPlugin* oldMeta = findLiveInstance(e.instanceId);
                    if (oldMeta != nullptr) {
                        juce::AudioPluginInstance* oldInst =
                            oldMeta->rawInstance.load(std::memory_order_acquire);
                        if (oldInst != nullptr) {
                            if (req.discardRetire) {
                                // D14 Fix B: discard-class replace — no capture.
                                engineLog("[plugin] state capture SKIPPED (discard-class retire) instance=" +
                                          oldMeta->instanceId +
                                          " (replace (worker)) | seq " + std::to_string(req.seq) +
                                          " — destroy→drain→unload proceeds with no plugin-call dependency (D14 Fix B)");
                            } else {
                                // 0.9.2: NAMED phase — a hung getStateInformation in
                                // the replace capture was invisible to the watchdog
                                // (no phase record between "prepare" and "commit").
                                // D14 Fix A: bounded — rides the plugin's message
                                // thread, 5 s ceiling, never a bare worker call.
                                InitPhaseGuard pg("state-capture", oldMeta->instanceId, req.seq);
                                boundedRetireCaptureOnMessageThread(oldInst, *oldMeta, "replace (worker)");
                            }
                        }
                    }
                }
                // ── 0.9.2 LAZY-DEVICE RACE (#4): the device-ready re-check ──
                // The pre-prepare above picked its settings from
                // g_deviceStarted; the device can START between that read and
                // this commit (first transport play during a load — the exact
                // lazy-init window). At the old settings the graph's
                // message-thread prepare would be a COLD one (settings differ
                // → the wrapper's early-out misses) — the M1 regression (b)
                // reopened by a race, seconds-class ON THE MM. Re-preparing
                // HERE on the worker at the now-real settings keeps the MM
                // call a cheap same-settings re-prepare. Bounded, receipted,
                // never blocks.
                if (h != nullptr && h->instance &&
                    g_deviceStarted.load(std::memory_order_acquire)) {
                    const double nowRate = g_engine.sampleRate.load();
                    const int nowBuf = g_deviceBufferSize.load();
                    if (std::abs(nowRate - prepRateOfEntry) > 0.5 || nowBuf != prepBufOfEntry) {
                        InitPhaseGuard pg("prepare", e.instanceId, req.seq);
                        InitBreadcrumbScope _bc("prepareToPlay(worker,device-race)");   // D12
                        h->instance->setPlayHead(&g_audioCallback.playHead);
                        h->instance->setPlayConfigDetails(0, 2, nowRate, nowBuf);
                        for (int b = 0; b < h->instance->getBusCount(false); ++b)
                            if (auto* bus = h->instance->getBus(false, b)) bus->enable(true);
                        h->instance->prepareToPlay(nowRate, nowBuf);
                        const int reLat = static_cast<int>(h->instance->getLatencySamples());
                        h->latencySamples = static_cast<double>(reLat);
                        engineLog("[plugin] re-prepared (worker, device-ready race) rate=" +
                                  std::to_string(static_cast<int>(nowRate)) +
                                  " buffer=" + std::to_string(nowBuf) +
                                  " latencySamples=" + std::to_string(reLat) +
                                  " instance=" + e.instanceId +
                                  " — the pre-prepare ran at nominal but the device started before the commit"
                                  " (the graph's message-thread prepare stays a same-settings re-prepare)");
                    }
                }
                // ── Milestone 1 COMMIT: the vendor's node lifecycle ──
                // The graph still prepares the node itself at the graph's
                // current settings (its prepare-on-main-thread invariant — not
                // ours to remove), but the M1-hotfix worker-side prepare above
                // lands FIRST at identical settings, so the message-thread
                // call is a cheap re-prepare, never the cold one. What remains
                // here: retire the outgoing instance (editor close →
                // removeNode, ONE message-thread job — its state capture moved
                // to the worker above), then commit (addPluginNode, whose
                // inline rebuild prepares at the graph's settings and makes
                // the latency real), then the receipts.
                if (!e.routing.empty()) {
                    std::string rStr;
                    for (const auto& rr : e.routing) {
                        if (!rStr.empty()) rStr += ", ";
                        rStr += "bus" + std::to_string(rr.busIndex) +
                                (rr.mute ? " MUTE" : " gain=" + std::to_string(rr.gain));
                    }
                    engineLog("[plugin] outputRouting instance=" + e.instanceId + ": " + rStr +
                              " — DEFERRED (milestone 1): entries are NOT applied; all output buses"
                              " sum at gain 1 with the main bus driving the master");
                }
                {
                    InitPhaseGuard pg("commit", e.instanceId, req.seq);   // 3f-6 watchdog phase
                    // (a) retire-first (CHANGED entries only): ONE MM job
                    //     (editor close → removeNode for the OLD node of THIS
                    //     instanceId). FIFO puts it before the commit job.
                    //     Milestone 2: survivors are untouched — only the
                    //     replaced instance's node goes. The state capture
                    //     already ran on the worker (M1-hotfix).
                    const bool entryIsChanged = outcomes[i].diffClass == std::string("changed");
                    if (entryIsChanged) {
                        juce::MessageManager::callAsync([iid = e.instanceId] {
                            retireInstanceNodeOnMessageThread(iid);
                        });
                    }
                    // (b) commit: ownership moves here — the meta into the
                    //     graveyard (retained to exit: the LatencyListener must
                    //     outlive the instance, which the vendor may keep in an
                    //     old render sequence up to 500 ms), the instance into
                    //     the graph node.
                    auto committed = std::make_shared<std::atomic<bool>>(false);
                    std::shared_ptr<HostedPlugin> metaShared(h.release());
                    HostedPlugin* rawMeta = metaShared.get();
                    const long long seqSnapshot = req.seq;
                    const int entrySlot = e.slot;
                    juce::MessageManager::callAsync([metaShared, committed, seqSnapshot,
                                                     slot = entrySlot,
                                                     iid = e.instanceId]() mutable {
                        HostedPlugin* m = metaShared.get();
                        {
                            std::lock_guard<std::mutex> lock(g_hostGraveyardMutex);
                            g_hostGraveyard.push_back(std::move(metaShared));   // retained to exit
                        }
                        auto inst = std::move(m->instance);   // the graph owns it from here
                        const auto tN = std::chrono::steady_clock::now();
                        // M1-hotfix (heavy-load death): this lambda runs on the
                        // message thread and calls INTO PLUGIN CODE (the
                        // vendor's inline rebuild → NodeStates::applySettings →
                        // prepareToPlay on the main thread). Uncaught, an
                        // exception or SEH here escaped runDispatchLoop →
                        // std::terminate → process death — the user's Falcon
                        // loads died exactly like that and the engine's
                        // watchdogs (all log-only) never had a chance. The MM
                        // has no realtime constraint, so a guard is safe; the
                        // audio thread NEVER gains one. The vendor's builder
                        // assembles a NEW sequence locally and swaps at the
                        // end, so a throw leaves the previously-built sequence
                        // live — the failure is contained and receipted.
                        try {
                            juce::AudioProcessorGraph::NodeID selID {};
                            auto node = g_host.addPluginNode(std::move(inst), slot, &selID);
                            m->selectorNodeID = selID;
                            if (node == nullptr) {
                                engineLog("[plugin] commit FAILED — the host graph refused the node | seq " +
                                          std::to_string(seqSnapshot) + " instance=" + iid);
                                committed->store(true, std::memory_order_release);
                                return;
                            }
                            m->nodeID = node->nodeID;
                            m->rawInstance.store(
                                dynamic_cast<juce::AudioPluginInstance*>(node->getProcessor()),
                                std::memory_order_release);
                            // Milestone 1 silence fix, second half: the GRAPH's
                            // playhead. The graph forwards getPlayHead() to every
                            // node at every block (NodeOp::process), overwriting
                            // any per-instance setPlayHead — the graph-level
                            // pointer is the one that survives. Re-asserted at
                            // every device start (reconfigureForDevice).
                            g_host.setPlayhead(&g_audioCallback.playHead);
                            const long long liveMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                                std::chrono::steady_clock::now() - tN).count();
                            // The midi-input wiring receipt (M2 form): the
                            // plugin's MIDI arrives ONLY through its per-instance
                            // InstanceMidiSelector (selector → plugin connection)
                            // — the shared midiInputNode is unwired. The receipt
                            // verifies the SELECTOR feed, the actual note path.
                            const auto midiInID = g_host.midiInputNodeID();
                            const bool midiWired = node->getProcessor() != nullptr &&
                                node->getProcessor()->acceptsMidi() &&
                                g_host.graph() != nullptr;
                            engineLog("[plugin] node live instance=" + iid +
                                      " slot=" + std::to_string(slot) +
                                      " nodeUID=" + std::to_string(node->nodeID.uid) +
                                      " midiSelector=slot" + std::to_string(slot) +
                                      " midiWired=" + (midiWired ? "1" : "0") +
                                      " liveMs=" + std::to_string(liveMs) +
                                      " (graph prepared at rate " +
                                      std::to_string(static_cast<int>(g_host.sampleRate())) +
                                      " buffer " + std::to_string(g_host.blockSize()) + ")");
                            // ── M3 PR2 — strip rewire + layout probe (the commit
                            // is the layout-change checkpoint; R3 guard inside).
                            // rewireStripsForInstanceOnMessageThread:
                            //   • reactivate + rewire the instance's table
                            //     strips against the NEW node (reload
                            //     continuity — unload → reload restores the
                            //     wiring with its gains);
                            //   • the R3 LAYOUT-CHANGE GUARD: a table pair the
                            //     live node can no longer feed is unwired with
                            //     named receipts + the stripLayoutChanged push
                            //     (never a silent dead wire).
                            rewireStripsForInstanceOnMessageThread(iid, node);
                            // The [layout] probe receipt (the brief's "instance
                            // X: 2 buses, 4 channels" grammar) + the additive
                            // instanceLayout push. Live-node truth, not the
                            // captured table (the guard may just have fired).
                            {
                                const int buses = m->outputBusChannels.size();
                                const int chans = node->getProcessor() != nullptr
                                    ? node->getProcessor()->getTotalNumOutputChannels()
                                    : m->totalOutputChannels;
                                std::string busList;
                                for (size_t b = 0; b < m->outputBusChannels.size(); ++b)
                                    busList += (b ? "," : "") + std::to_string(m->outputBusChannels[b]);
                                engineLog("[layout] instance=" + iid + ": " + std::to_string(buses) +
                                          " buses, " + std::to_string(chans) + " output channels" +
                                          (busList.empty() ? "" : " (busChannels=[" + busList + "])"));
                                std::string push = std::string("{\"type\":\"instanceLayout\",\"instanceId\":\"") +
                                    escape_json(iid) + "\",\"buses\":" + std::to_string(buses) +
                                    ",\"channels\":" + std::to_string(chans) + ",\"busChannels\":[";
                                for (size_t b = 0; b < m->outputBusChannels.size(); ++b)
                                    push += (b ? "," : "") + std::to_string(m->outputBusChannels[b]);
                                push += "]}";
                                broadcastJson(push);
                            }
                        } catch (const std::exception& ex) {
                            engineLog("[plugin] commit FAILED exception=" +
                                      std::string(ex.what() ? ex.what() : "unknown") +
                                      " | seq " + std::to_string(seqSnapshot) + " instance=" + iid +
                                      " — the previously-built render sequence stays live; the plugin is NOT hosted");
                        } catch (...) {
                            engineLog("[plugin] commit FAILED SEH/unknown | seq " +
                                      std::to_string(seqSnapshot) + " instance=" + iid +
                                      " — the previously-built render sequence stays live; the plugin is NOT hosted");
                        }
                        committed->store(true, std::memory_order_release);
                    });
                    // (c) bounded, exit-aware wait — the worker must not race
                    // ahead of the commit (the loaded receipts read the meta).
                    const auto tw0 = std::chrono::steady_clock::now();
                    while (!committed->load(std::memory_order_acquire) &&
                           !g_should_exit.load()) {
                        const auto waitedMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                            std::chrono::steady_clock::now() - tw0).count();
                        if (waitedMs >= 10000) break;
                        std::this_thread::sleep_for(std::chrono::milliseconds(10));
                    }
                    if (committed->load(std::memory_order_acquire)) {
                        HostedPlugin* m = rawMeta;
                        if (m != nullptr && m->rawInstance.load(std::memory_order_acquire) != nullptr) {
                            const int lat = static_cast<int>(
                                m->rawInstance.load(std::memory_order_acquire)->getLatencySamples());
                            // ONE-WRITE: meta before the mirror (3j invariant) —
                            // per SLOT now (the F4 shift reads the owning
                            // instance's mirror); the max-mirror recomputes at
                            // publish.
                            m->latencySamples = static_cast<double>(lat);
                            if (entrySlot >= 0 && entrySlot < scorchhost::kMaxInstances)
                                g_slotLatencySamples[entrySlot].store(lat, std::memory_order_release);
                            outcomes[i].committed = m;
                            outcomes[i].succeeded = true;
                            const double devRate = g_engine.sampleRate.load();
                            const int devBuf = g_deviceBufferSize.load();
                            engineLog("[plugin] prepared (async) rate=" +
                                      std::to_string(static_cast<int>(devRate > 0.0 ? devRate : g_host.sampleRate())) +
                                      " buffer=" + std::to_string(devRate > 0.0 ? devBuf : g_host.blockSize()) +
                                      " latencySamples=" + std::to_string(lat) +
                                      " instance=" + e.instanceId +
                                      " (via the host graph — AboutToStart re-prepares for the real device)");
                        } else if (!g_should_exit.load()) {
                            outcomes[i].err = "the host graph refused the node";
                        }
                    } else if (!g_should_exit.load()) {
                        outcomes[i].err = "commit did not complete within 10000 ms (message thread wedged?)";
                    }
                }
            }
            if (g_should_exit.load()) continue;   // unique_ptrs free the set
            if (superseded || abandoned) {
                // A newer load queued behind this instantiate (superseded) or
                // the watchdog declared this seq terminal while a phase was
                // jammed (abandoned) — discard the whole iteration; the loop
                // picks up the newest request next pass. Milestone 2: ONLY the
                // nodes this iteration COMMITTED are retired (the survivors of
                // a partial apply belong to the live set; the newest request's
                // diff governs them) — kept instances are never touched here.
                long long totalMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - t0).count();
                bool committedSomething = false;
                std::vector<std::string> committedIds;
                for (const auto& o : outcomes)
                    if (o.succeeded && o.diffClass != std::string("kept")) {
                        committedSomething = true;
                        if (o.committed != nullptr) committedIds.push_back(o.committed->instanceId);
                    }
                // 0.9.2: ABANDONED takes precedence over SUPERSEDED — the
                // dominant fact is the watchdog's terminal declaration (a
                // queued-behind request ALSO bumped the generation, so both
                // flags can be true; the declaration is what the log promised).
                if (abandoned) {
                    // The terminal receipt already went out from the watchdog
                    // (exactly-one). The worker's result is garbage — name the
                    // discard, retire anything committed.
                    engineLog("[plugin] init abandoned — the watchdog already declared seq " +
                              std::to_string(req.seq) + " terminal (worker result discarded after " +
                              std::to_string(totalMs) + "ms)" +
                              (committedSomething ? " — retiring the already-committed node(s)" : " — nothing committed"));
                    for (const auto& id : committedIds)
                        juce::MessageManager::callAsync([id] { retireInstanceNodeOnMessageThread(id); });
                    continue;
                }
                // Superseded: the terminal receipt in the NEW grammar, with
                // the by= naming the request that took this one's place. If
                // the registry says the seq is ALREADY terminal (the watchdog
                // raced the supersede), provenance only — never a second
                // terminal receipt.
                if (initRegistryMarkTerminal(req.seq, "superseded")) {
                    long long bySeq = 0;
                    {
                        std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                        bySeq = g_pluginInitNewestSeq;
                    }
                    if (committedSomething) {
                        engineLog("[plugin] init superseded: seq=" + std::to_string(req.seq) +
                                  " by=" + std::to_string(bySeq) +
                                  " after " + std::to_string(totalMs) +
                                  "ms — retiring the already-committed node(s)");
                        for (const auto& id : committedIds)
                            juce::MessageManager::callAsync([id] { retireInstanceNodeOnMessageThread(id); });
                    } else {
                        engineLog("[plugin] init superseded: seq=" + std::to_string(req.seq) +
                                  " by=" + std::to_string(bySeq) +
                                  " after " + std::to_string(totalMs) +
                                  "ms — nothing committed, set discarded");
                    }
                } else {
                    engineLog("[plugin] init discarded — seq " + std::to_string(req.seq) +
                              " was already declared terminal while this iteration ran (watchdog raced the supersede)"
                              " — the worker's result is dropped, no second terminal receipt");
                }
                continue;
            }
            // ─── Milestone 2 publish: the diff result becomes the truth ───
            // (a) the new InstanceSet (audio-thread truth): the live snapshot
            // with removed slots nulled and committed metas placed at their
            // slots — ONE atomic store;
            // (b) per-instance receipts: ADDED/CHANGED entries speak
            // "loaded" (+ capabilities); KEPT entries re-echo plugin_state
            // loaded (the frontend's hosted-set refresh — no plugin calls);
            // (c) the diff summary + the seq's EXACTLY-ONE terminal receipt.
            InitPhaseGuard publishGuard("publish", "-", req.seq);   // 3f-6 watchdog phase
            const auto tPub = std::chrono::steady_clock::now();
            const auto pubMs = [&tPub]() {
                return std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - tPub).count();
            };
            bool anyCommitted = false;
            std::string firstFailure;
            HostedPlugin* firstCommitted = nullptr;
            {
                auto next = std::make_shared<InstanceSet>(*liveNow);
                for (size_t ri = 0; ri < removedIds.size(); ++ri) {
                    // The removal pass already retired the node; the set slot
                    // goes null now (removedSlots carries the printed slot, so
                    // re-derive from the id).
                    HostedPlugin* m = nullptr;
                    for (HostedPlugin* cand : liveNow->bySlot)
                        if (cand != nullptr && cand->instanceId == removedIds[ri]) { m = cand; break; }
                    if (m != nullptr && m->slot >= 0 && m->slot < scorchhost::kMaxInstances)
                        next->bySlot[m->slot] = nullptr;
                }
                for (size_t i = 0; i < req.entries.size(); ++i) {
                    HostedPlugin* h = outcomes[i].committed;
                    if (h == nullptr) continue;
                    const int sl = h->slot;
                    if (sl >= 0 && sl < scorchhost::kMaxInstances) next->bySlot[sl] = h;
                }
                g_liveSet.store(std::shared_ptr<const InstanceSet>(next), std::memory_order_release);
                republishMaxLatencyMirror();
            }
            for (size_t i = 0; i < req.entries.size(); ++i) {
                const PluginInitEntry& e = req.entries[i];
                HostedPlugin* h = outcomes[i].committed;
                if (h == nullptr) {   // failed entry — already spoke
                    if (firstFailure.empty() && !outcomes[i].err.empty()) firstFailure = outcomes[i].err;
                    continue;
                }
                if (firstCommitted == nullptr) firstCommitted = h;
                anyCommitted = true;
                const bool isKept = outcomes[i].diffClass == std::string("kept");
                if (isKept) {
                    engineLog("[plugin] kept name=" + h->name +
                              " instance=" + h->instanceId + " slot=" + std::to_string(h->slot) +
                              " | seq " + std::to_string(req.seq) +
                              " channels=[" + e.channelsJson + "] (no re-instantiate)");
                    std::cout << "[engine] plugin kept: instance=" << h->instanceId
                              << " channels=[" << e.channelsJson << "]" << std::endl;
                } else {
                    engineLog("[plugin] loaded name=" + h->name + " vendor=" + h->vendor +
                              " instance=" + h->instanceId + " slot=" + std::to_string(h->slot) +
                              " diffClass=" + outcomes[i].diffClass +
                              " | seq " + std::to_string(req.seq) +
                              " channels=[" + e.channelsJson + "]");
                    std::cout << "[engine] plugin loaded: name=" << h->name
                              << " instance=" << h->instanceId
                              << " init=" << (outcomes[i].initMs) << "ms"
                              << " channels=[" << e.channelsJson << "]" << std::endl;
                }
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
                // instantiate time (pre-serialized on the instance). Kept
                // instances re-echo their immutable record too (no plugin
                // calls — the pre-serialized fields re-wrapped).
                if (!h->capabilitiesFields.empty()) {
                    const std::string caps = std::string("{\"type\":\"plugin_capabilities\",\"instanceId\":\"") +
                        escape_json(h->instanceId) + "\"," + h->capabilitiesFields + "}";
                    for (auto& client : server.getClients())
                        if (client) client->send(caps);
                    engineLog("[plugin] capabilities sent instance=" + h->instanceId +
                              " classId=\"" + h->classId + "\"");
                }
            }
            engineLog("[plugin] publish: done | seq " + std::to_string(req.seq) +
                      " kept=" + std::to_string(keptIds.size()) +
                      " added=" + std::to_string(addedIds.size()) +
                      " removed=" + std::to_string(removedIds.size()) +
                      " changed=" + std::to_string(changedIds.size()) +
                      " live=" + std::to_string(liveInstanceCount()) +
                      " elapsed=" + std::to_string(pubMs()) + "ms");
            // 0.9.2 — the request's EXACTLY-ONE terminal receipt: the per-entry
            // "loaded" lines above ARE the loaded terminal (registry-marked);
            // a set with NOTHING committed gets the failed grammar instead —
            // before this stage a single-entry request whose instantiate
            // failed had per-entry receipts but the seq itself had no terminal.
            if (anyCommitted) {
                initRegistryMarkTerminal(req.seq, "loaded");
                // 0.9.2: the load-carried editor intent on the async path —
                // the editor opens when the instance is LIVE (publish), the
                // reopen decoupled from the load's own completion timing.
                if (req.openEditor && firstCommitted != nullptr) {
                    const std::string iid = firstCommitted->instanceId;
                    // Field-gate B-1: the async-publish fold — same contract
                    // as the WS handler and the reuse path.
                    bool folded = false;
                    {
                        std::lock_guard<std::mutex> pl(g_pendingEditorMutex);
                        if (g_pendingEditorActive && g_pendingEditorOpen.iid == iid) {
                            ++g_pendingEditorOpen.folds;
                            folded = true;
                        } else {
                            g_pendingEditorOpen = PendingEditorOpen{ iid, std::chrono::steady_clock::now(), {}, 0 };
                            g_pendingEditorActive = true;
                            g_pendingEditorNamed = false;
                        }
                    }
                    if (folded) {
                        engineLog("[editor] open coalesced instance=" + iid +
                                  " (load-carried openEditor — async path; a job for this instance is already queued/starting, folded)");
                    } else {
                        ++g_editorJobsQueued;
                        juce::MessageManager::callAsync([iid] {
                            HostedPlugin* hh = findLiveInstance(iid);
                            openEditorWindow(iid, hh);
                            --g_editorJobsQueued;
                        });
                        engineLog("[editor] open requested instance=" + iid +
                                  " (load-carried openEditor — async path, editor opens at publish)");
                    }
                }
            } else if (initRegistryMarkTerminal(req.seq, "failed")) {
                engineLog("[plugin] init failed: seq=" + std::to_string(req.seq) +
                          " reason=" + (firstFailure.empty() ? "no instance committed (unknown failure)"
                                                             : firstFailure) +
                          " — every entry of the set spoke its own plugin_state error; the set has no terminal instance");
            }
            // Stage 3f-7: the load iteration is over — clear the probe pause
            // unless ANOTHER request is already queued behind it.
            {
                std::lock_guard<std::mutex> lock(g_pluginInitMutex);
                g_pluginLoadActive.store(g_pluginInitPending, std::memory_order_release);
            }
            } catch (const std::exception& iwEx) {
                std::string whatSafe;
                try { whatSafe = iwEx.what(); } catch (...) { whatSafe = "(what() threw)"; }
                if (whatSafe.size() > 200) whatSafe.resize(200);
                declareInitWorkerExceptionTerminal("std::exception", whatSafe);
            } catch (...) {
                declareInitWorkerExceptionTerminal("unknown", std::string());
            }
        }
        g_pluginInitWorkerExited.store(true, std::memory_order_release);   // D12: the shutdown path's bounded wait reads this
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
    // ─── 0.9.2 — the registry sweep (items #1 + #2) ───
    // The 3f-6 record names the PHASE; only the request REGISTRY can name the
    // REQUEST. Every second, for every non-terminal record:
    //   age > 10 s  → the heartbeat warning ("init pending >10s" while the
    //                 worker runs it, "init queued >10s" while it sits behind
    //                 a busy worker), repeated every 10 s — a stuck worker is
    //                 visible in engine.log within seconds, the same pattern
    //                 as the editor's >10s pending watchdog.
    //   total age > initTerminalTimeoutMs() (default 120 s — the 0.14.0 FLAT
    //                 wall clock, RESTORED by D13 after dump 211647: the 0.14.1
    //                 zero-movement stall declared legitimately-slow single
    //                 plugin calls — a GB-scale load inside ONE call has no
    //                 phase transitions — and armed the abandon/discard
    //                 machinery against a healthy init) →
    //                 the TERMINAL DECLARATION on the wedged request's
    //                 behalf: "init failed: seq= reason=terminal-timeout ..."
    //                 for the in-flight one, "... reason=queued-behind-jammed-init"
    //                 for the queued ones. A STALL-BUNDLE line (phase,
    //                 zero-movement age, last engine→plugin call breadcrumb,
    //                 worker tid) precedes the declaration and an init-stall
    //                 ALL-THREAD dump follows it (the worker's REAL stack —
    //                 D13 stack capture on watchdog fire). Exactly-one is
    //                 enforced by initRegistryMarkTerminal; the worker
    //                 discovers the declaration and discards its result
    //                 when it unblocks.
    std::thread plugin_init_watchdog([&server]() {
        while (!g_should_exit.load()) {
            try {
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
            if (active && !named && !phase.empty()) {
                const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                    std::chrono::steady_clock::now() - startedAt).count();
                if (ms >= 60000) {
                    engineLog("[plugin] init WATCHDOG phase=" + phase + " instance=" + iid + " " +
                              std::to_string(ms) + " ms");
                    std::lock_guard<std::mutex> lk(g_initPhase.mtx);
                    g_initPhase.named = true;   // one WATCHDOG line per phase occurrence
                }
            }
            // ── 0.9.2 registry sweep — D13: the FLAT wall clock (reverted) ──
            const long long terminalMs = initTerminalTimeoutMs();
            bool stallDumped = false;
            struct Declaration { long long seq; std::string line; bool wireError; std::string iid; std::string detail; };
            std::vector<Declaration> declarations;
            {
                std::lock_guard<std::mutex> lk(g_initReceiptMutex);
                const auto now = std::chrono::steady_clock::now();
                for (auto& r : g_initReceipts) {
                    if (r.terminal) continue;
                    const long long age = std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - r.queuedAt).count();
                    const long long zeroMoveMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                        now - (r.phaseSince == std::chrono::steady_clock::time_point{}
                                   ? r.queuedAt : r.phaseSince)).count();
                    // D13 fire condition — the 0.14.0 FLAT WALL CLOCK: total
                    // age >= initTerminalTimeoutMs(). No zero-movement stall,
                    // no hard cap: a slow-but-moving load is NEVER declared
                    // (that was the 0.14.1 regression — dump 211647). The
                    // zero-movement age and the last-call breadcrumb stay in
                    // the receipts as DIAGNOSTICS only.
                    if (age >= terminalMs) {
                        // D13 diagnostic bundle FIRST — the log reads cause →
                        // verdict. "Slow first load" vs "deadlock": lastCall
                        // INSIDE with a growing age names the wedged call;
                        // lastCall returned with fresh stamps names a
                        // slow-but-alive load between phases. The dump receipt
                        // (emitted right after the sweep, below) carries the
                        // worker's REAL stack.
                        declarations.push_back({r.seq,
                            "[plugin] init STALL-BUNDLE seq=" + std::to_string(r.seq) +
                            " phase=" + (r.phase.empty() ? "unknown" : r.phase) +
                            " instance=" + (r.instanceId.empty() ? "-" : r.instanceId) +
                            " zeroMovement=" + std::to_string(zeroMoveMs / 1000) + "s" +
                            " totalAge=" + std::to_string(age / 1000) + "s" +
                            " " + initBreadcrumbSuffix() +
                            " workerTid=" + std::to_string(scorchguard::g_initWorkerTid.load(std::memory_order_acquire)) +
                            " (D13: the all-thread diagnostic dump follows this bundle)",
                            false, "", ""});
                        stallDumped = true;
                        // The terminal declaration on the wedged request's
                        // behalf (emitted outside the mutex).
                        if (r.inFlight) {
                            declarations.push_back({r.seq,
                                "[plugin] init failed: seq=" + std::to_string(r.seq) +
                                " reason=terminal-timeout (worker stuck in phase=" +
                                (r.phase.empty() ? "unknown" : r.phase) + " instance=" +
                                (r.instanceId.empty() ? "-" : r.instanceId) +
                                " for " + std::to_string(age / 1000) +
                                "s; no terminal receipt is possible from a wedged worker) — declared by the watchdog;"
                                " the worker's eventual result will be discarded",
                                true, !r.firstIid.empty() ? r.firstIid : r.instanceId,
                                "init declared failed after " + std::to_string(age / 1000) +
                                "s (terminal-timeout — worker stuck in phase " +
                                (r.phase.empty() ? "unknown" : r.phase) + ")"});
                        } else {
                            declarations.push_back({r.seq,
                                "[plugin] init failed: seq=" + std::to_string(r.seq) +
                                " reason=queued-behind-jammed-init (the worker has not reached this request for " +
                                std::to_string(age / 1000) +
                                "s; an older init is stuck) — declared by the watchdog; reload to retry",
                                true, !r.firstIid.empty() ? r.firstIid : r.instanceId,
                                "init declared failed after " + std::to_string(age / 1000) +
                                "s (queued-behind-jammed-init — the worker never reached this request)"});
                        }
                        r.terminal = true;
                        r.terminalKind = "failed";
                        continue;
                    }
                    if (age >= 10000) {
                        const long long sinceWarn = r.lastWarnAt.time_since_epoch().count() == 0
                            ? 1000000
                            : std::chrono::duration_cast<std::chrono::milliseconds>(
                                  now - r.lastWarnAt).count();
                        if (sinceWarn >= 10000) {
                            r.lastWarnAt = now;
                            const long long secs = age / 1000;
                            if (r.inFlight) {
                                declarations.push_back({r.seq,
                                    "[plugin] init pending >10s seq " + std::to_string(r.seq) +
                                    " phase=" + (r.phase.empty() ? "unknown" : r.phase) +
                                    " instance=" + (r.instanceId.empty() ? "-" : r.instanceId) +
                                    " (" + std::to_string(secs) + "s)" +
                                    " zeroMovement=" + std::to_string(zeroMoveMs / 1000) + "s" +
                                    " " + initBreadcrumbSuffix() +
                                    " — the init is still running (terminal declaration at " +
                                    std::to_string(terminalMs / 1000) + "s) | " + mmOccupancySuffix(),
                                    false, "", ""});
                            } else {
                                declarations.push_back({r.seq,
                                    "[plugin] init queued >10s seq " + std::to_string(r.seq) +
                                    " (" + std::to_string(secs) +
                                    "s) — the worker has not reached this request yet (terminal declaration at " +
                                    std::to_string(terminalMs / 1000) + "s) | " + mmOccupancySuffix(),
                                    false, "", ""});
                            }
                        }
                    }
                }
            }
#ifdef _WIN32
            // D13: stack capture on watchdog fire — ONE all-thread diagnostic
            // dump per declaration sweep, BEFORE the receipts emit. The worker's
            // REAL stack (plus every other thread's) is in the file; this
            // supersedes the D12 no-suspend policy per directive —
            // MiniDumpWriteDump freezes threads internally (the sanctioned
            // mechanism), and the declared init is dead by definition.
            if (stallDumped) {
                char stallDumpPath[MAX_PATH];
                scorchcrash::writeDump(nullptr, stallDumpPath, sizeof(stallDumpPath), "init-stall");
                engineLog(std::string("[plugin] init stall-dump: ") +
                          (stallDumpPath[0] != '\0' ? stallDumpPath : "(dump write failed)") +
                          " (D13: ALL-thread snapshot at the declaration — the worker's REAL stack names the wedge)");
            }
#endif
            for (const auto& d : declarations) {
                engineLog(d.line);
                // The wire-side twin of the failed declaration: the frontend's
                // hosting pill must stop spinning when a jammed init is
                // declared failed — the per-entry error path does this for
                // ordinary failures; the watchdog covers the jammed ones.
                if (d.wireError && !d.iid.empty() && d.iid != "-") {
                    const std::string ps = std::string("{\"type\":\"plugin_state\",\"state\":\"error\",\"instanceId\":\"") +
                        escape_json(d.iid) + "\",\"detail\":\"" +
                        escape_json(d.detail) + "\"}";
                    for (auto& client : server.getClients())
                        if (client) client->send(ps);
                }
            }
            } catch (const std::exception& thEx) {
                std::string whatSafe;
                try { whatSafe = thEx.what(); } catch (...) { whatSafe = "(what() threw)"; }
                if (whatSafe.size() > 200) whatSafe.resize(200);
                engineLog(std::string("[engine] init watchdog thread exception: ") + whatSafe +
                          " — the loop continues (D14b: no silent thread death)");
            } catch (...) {
                engineLog("[engine] init watchdog thread exception: unknown (non-std throwable) — the loop continues (D14b)");
        }}});

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
            try {
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
            } catch (const std::exception& thEx) {
                std::string whatSafe;
                try { whatSafe = thEx.what(); } catch (...) { whatSafe = "(what() threw)"; }
                if (whatSafe.size() > 200) whatSafe.resize(200);
                engineLog(std::string("[engine] scan probe thread exception: ") + whatSafe +
                          " — the loop continues (D14b: no silent thread death)");
            } catch (...) {
                engineLog("[engine] scan probe thread exception: unknown (non-std throwable) — the loop continues (D14b)");
        }}});

    std::cout << "[engine] scorch-engine " << kEngineVersion
              << " listening on 127.0.0.1:" << port << std::endl;
#ifdef _WIN32
    std::cout << "[engine] WER LocalDumps: "
              << (scorchcrash::g_werArmed ? "armed -> " : "arm FAILED (best-effort) ")
              << scorchcrash::g_werDumpFolder << std::endl;
#endif

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
    // ── D12: abandonment BEFORE the join — the terminal receipt invariant
    // holds at shutdown even when the worker is WEDGED. Every still-
    // non-terminal seq (queued or in-flight) gets its named engine-shutdown
    // failed receipt NOW, before we know whether the worker can exit; the
    // in-flight line names the phase + zero-movement age.
    // D13 bisect verdict: this block STAYS — it is EXIT-PATH only (it never
    // declares mid-run and never touches plugin state: the invariant "a
    // plugin window receives dispatched messages ONLY while its wrapper is
    // fully constructed and attached" is untouched by it) and it is not in
    // the dump-211647 chain; it is what replaced 190901's unbounded join →
    // force-kill shape.
    {
        std::vector<std::string> abandonLines;
        {
            std::lock_guard<std::mutex> lk(g_initReceiptMutex);
            const auto now = std::chrono::steady_clock::now();
            for (auto& r : g_initReceipts) {
                if (r.terminal) continue;
                r.terminal = true;
                r.terminalKind = "failed";
                const long long zeroMoveMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                    now - (r.phaseSince == std::chrono::steady_clock::time_point{}
                               ? r.queuedAt : r.phaseSince)).count();
                abandonLines.push_back(
                    "[plugin] init failed: seq=" + std::to_string(r.seq) +
                    " reason=engine-shutdown (the init was still " +
                    (r.inFlight ? "RUNNING" : "queued") + " at exit" +
                    (r.inFlight
                         ? " — abandoned; worker was in phase=" +
                               (r.phase.empty() ? "unknown" : r.phase) +
                               " instance=" + (r.instanceId.empty() ? "-" : r.instanceId) +
                               ", zero movement for " + std::to_string(zeroMoveMs / 1000) + "s"
                         : "") +
                    ")");
            }
        }
        for (const std::string& l : abandonLines) engineLog(l);
    }
    // D12: bounded worker wait — the worker exits within 10 s of the
    // shutdown flag, or it is wedged inside a plugin call and is ABANDONED:
    // detached, never joined, and the editor/device teardown is skipped (a
    // wedged worker must never stop engine exit — the deliberate-leak policy
    // already documents that nothing is freed at exit; the OS reaps the
    // rest). Exit code stays 0: an abandoned wedge is a named shutdown
    // shape, not a crash.
    bool workerExited = false;
    for (int i = 0; i < 100; ++i) {
        if (g_pluginInitWorkerExited.load(std::memory_order_acquire)) { workerExited = true; break; }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    bool workerAbandoned = false;
    if (workerExited) {
        plugin_init_thread.join();
    } else {
        workerAbandoned = true;
        std::string phase, iid;
        {
            std::lock_guard<std::mutex> lk(g_initPhase.mtx);
            phase = g_initPhase.phase;
            iid = g_initPhase.instanceId;
        }
        engineLog("[engine] init worker ABANDONED at shutdown (no exit within 10000 ms; last phase=" +
                  (phase.empty() ? "unknown" : phase) + " instance=" +
                  (iid.empty() ? "-" : iid) +
                  ") — detached; skipping editor/device teardown around a live plugin call (the deliberate-leak policy)");
        plugin_init_thread.detach();
    }
    // Stage 3f-6: the watchdog sleeps in 1 s slices and re-checks
    // g_should_exit — join is bounded.
    plugin_init_watchdog.join();
    // Stage 3f-7 (4a): the heartbeat sleeps in 1 s slices — join is bounded.
    mm_heartbeat_thread.join();
    // D14: the bound monitor sleeps in 1 s slices and re-checks the exit
    // flag — join is bounded.
    d14_bound_monitor.join();
    // Stage 3f-2: the probe thread checks g_should_exit between its 250 ms
    // wait slices and kills any in-flight probe child — join is bounded.
    scan_probe_thread.join();
    if (workerAbandoned) {
        // D12: the wedged-worker exit path — nothing past this point touches
        // plugin state (no editor closes, no device stop around a live plugin
        // call); the exit receipts are above, the OS reaps the process. The
        // wedged thread dies with the process (TerminateProcess kills all
        // threads and — D14a — skips the DLL_PROCESS_DETACH walk: a wedged
        // plugin's module is guaranteed still loaded here, and its detach
        // is the prime detach-deadlock candidate; same fix as the clean
        // exit below).
        engineLog("[engine] exit 0 (shutdown abandoned a wedged init worker — teardown skipped by policy; exit receipts above)");
        std::cout << "[engine] exit 0 (init worker abandoned at shutdown)" << std::endl;
        std::fflush(nullptr);
        TerminateProcess(GetCurrentProcess(), 0);
    }
    // Stage 3d-1: graceful exit closes editor windows FIRST (bounded wait —
    // the pump is still running). A hard kill needs nothing: the OS reaps
    // the process's windows, so orphans are impossible either way.
    closeAllEditorsAtShutdown();
    // M3 PR1: the FINAL unmapped-drop drain — the 1 Hz sampler's last pass
    // can miss drops that landed inside its final second (the CI stop + the
    // shutdown race); no silent drops at exit, ever. Full cumulative counts.
    {
        const auto rt = g_routing.load(std::memory_order_acquire);
        for (size_t ds = 1; ds <= kMaxDropTrackSlots; ++ds) {
            const uint32_t total = g_unmappedDrops[ds - 1].load(std::memory_order_relaxed);
            if (total == 0) continue;
            std::string name;
            if (rt != nullptr && ds <= rt->trackNames.size())
                name = " (" + rt->trackNames[ds - 1] + ")";
            engineLog("[routing] track " + std::to_string(ds) + " unmapped, " +
                      std::to_string(total) + " notes dropped" + name + " [final at shutdown]");
        }
    }
    // Wake the MM pump (join would otherwise block forever) and let it die.
    juce::MessageManager::getInstance()->stopDispatchLoop();
    mm_pump_thread.join();
    shutdownAudio();
    ix::uninitNetSystem();
    engineLog("[engine] clean exit 0");
    std::cout << "[engine] clean exit 0" << std::endl;
    // Milestone 1: hard-exit past static destructors. The process holds the
    // deliberately-leaked host graph (its RenderSequenceExchange timer, the
    // still-alive VST3 instance with its listeners) and the graveyard metas
    // — tearing the JUCE/VST3 statics down around live leaked audio objects
    // deadlocks in exit handlers (the same hazard class the shutdown policy
    // already documents for module teardown). Everything the engine owns is
    // flushed and joined above; the OS reclaims the rest — the documented
    // policy, now also covering the exit path.
    // D14a (field run 2026-10-23 12:24): _Exit still terminates via
    // ExitProcess, which walks DLL_PROCESS_DETACH for EVERY module still
    // loaded at exit — under the loader lock. The D14 3-leg bench shape ends
    // live on field-falcon2 — the FIRST field run where Falcon is the loaded
    // module at exit (run-4/D12/D13 ended live on BBCSO) — and the process
    // stayed alive 29 s past this final receipt (force-stopped): a
    // plugin/driver detach deadlock, the same hazard class one level down.
    // TerminateProcess skips detach callbacks entirely — exit code 0 is
    // preserved, everything above is unchanged, and NO module's teardown
    // behavior can wedge the process past its final receipt, by construction.
    std::fflush(nullptr);
    TerminateProcess(GetCurrentProcess(), 0);
    return 0;   // unreachable
}
