// scorch-engine — Stage 3c: VST3 hosting (BBCSO standalone) + scan.
// Protocol v1 EXTENSION (additive — v1 handshake messages unchanged):
//   client -> server: {"type":"load","events":[...],"meta":{bpm,ppqn,timeSignature,endTick}}
//   client -> server: {"type":"transport","command":"play"|"stop"|"seek","tick":<n?>}
//                     play: "tick" OPTIONAL (3b polish) — explicit start tick,
//                     or RESUME from the stopped position when omitted.
//                     stop: PANIC — kills all voices immediately.
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
//   server -> client: {"type":"state","playing":bool,"tick":<n>}  (~30Hz always;
//                     while stopped, tick = the remembered stop position)
// Existing v1 messages unchanged: hello, ping->pong, shutdown, unknown->error.
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
#include <cstdio>
#include <cstring>
#include <iostream>
#include <limits>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <juce_core/juce_core.h>
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace {

constexpr const char* kEngineVersion = "0.2.0";
constexpr int kProtocolVersion = 1;
constexpr int kDefaultPort = 9377;
constexpr int kMaxVoices = 64;
constexpr double kAttackMs = 10.0;
constexpr double kReleaseMs = 10.0;

std::atomic<bool> g_should_exit{false};
bool g_nullAudio = false;      // --null-audio: JUCE null device (CI / device-less)
bool g_forcedNoAudio = false;  // --no-audio: forced device-less (play → no_audio_device)

// ─── Engine event (parsed from JSON load message) ───────────────────────────
struct EngineEvent {
    int type;        // 0=NOTE_OFF, 1=NOTE_ON
    int channel;
    int pitch;       // data1
    int velocity;    // data2
    int64_t tick;    // timestampTicks
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

// ─── Engine state (shared between WS thread, audio thread, state thread) ────
// Stage 3b polish — position contract: lastTick is the SINGLE source of truth
// for "where the playhead is" whenever the transport is stopped (and the seed
// for play without an explicit tick). The audio callback re-commits it every
// buffer; stop/seek set it directly. currentTick() never reports a stale
// playStartTick again (the resume-from-0 desync bug).
struct EngineState {
    std::mutex eventsMutex;
    std::vector<EngineEvent> events;
    double bpm = 120.0;
    int ppqn = 960;
    int64_t endTick = 0;

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

    Voice voices[kMaxVoices];
    std::mutex voicesMutex;
    int64_t voiceAge = 0;

    double samplesPerTick() const {
        return sampleRate.load() * 60.0 / (bpm * ppqn);
    }

    int64_t currentTick() const {
        if (!playing.load()) return lastTick.load();
        return playStartTick.load() +
               static_cast<int64_t>(samplesProcessed.load() / samplesPerTick());
    }
};

EngineState g_engine;

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

        if (!g_engine.playing.load()) return;

        // Capture the transport generation BEFORE the position reads: any
        // play/seek that lands after this point invalidates this buffer's
        // commit (gen mismatch at the end), never half-updated state.
        const uint64_t gen0 = g_engine.transportGen.load(std::memory_order_relaxed);
        double spt = g_engine.samplesPerTick();
        int64_t startSample = g_engine.samplesProcessed.load();
        int64_t playStartTick = g_engine.playStartTick.load();

        // Dispatch events + render audio per-sample
        std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
        size_t eventIdx = 0;
        // Find the first event that hasn't been dispatched yet
        {
            std::lock_guard<std::mutex> elock(g_engine.eventsMutex);
            // Skip events before the current position
            for (; eventIdx < g_engine.events.size(); ++eventIdx) {
                int64_t eventSample = static_cast<int64_t>(
                    (g_engine.events[eventIdx].tick - playStartTick) * spt);
                if (eventSample >= startSample) break;
            }
        }

        for (int s = 0; s < numSamples; ++s) {
            int64_t absSample = startSample + s;

            // Dispatch events at this sample
            {
                std::lock_guard<std::mutex> elock(g_engine.eventsMutex);
                while (eventIdx < g_engine.events.size()) {
                    int64_t eventSample = static_cast<int64_t>(
                        (g_engine.events[eventIdx].tick - playStartTick) * spt);
                    if (eventSample > absSample) break;
                    dispatchEvent(g_engine.events[eventIdx]);
                    ++eventIdx;
                }
            }

            // Render all active voices
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

            // Write to output (mono → all channels)
            float out = static_cast<float>(sample * 0.2); // prevent clipping
            for (int ch = 0; ch < numOutputChannels; ++ch)
                outputChannelData[ch][s] = out;
        }

        // Commit — but only if no play/seek invalidated this buffer meanwhile.
        if (g_engine.transportGen.load(std::memory_order_relaxed) == gen0) {
            const int64_t committed = startSample + numSamples;
            g_engine.samplesProcessed.store(committed);
            g_engine.lastTick.store(playStartTick +
                static_cast<int64_t>(static_cast<double>(committed) / spt));

            // Stop at endTick
            const int64_t nowTick = playStartTick +
                static_cast<int64_t>(static_cast<double>(committed) / spt);
            if (g_engine.endTick > 0 && nowTick >= g_engine.endTick) {
                g_engine.playing.store(false);
                allNotesOff();
            }
        }
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* device) override {
        // Adopt the device's actual rate (real device or null device) so the
        // tick→sample scheduling math matches the running callback.
        if (device != nullptr)
            g_engine.sampleRate.store(device->getCurrentSampleRate());
    }

    void audioDeviceStopped() override {}

private:
    void dispatchEvent(const EngineEvent& ev) {
        if (ev.type == 1) { // NOTE_ON
            noteOn(ev.pitch, ev.velocity);
        } else { // NOTE_OFF
            noteOff(ev.pitch);
        }
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
            auto err = dev->open(juce::BigInteger(), outCh, 44100.0, 512);
            if (err.isNotEmpty())
                return "null audio device open failed: " + err.toStdString();
            g_engine.sampleRate.store(dev->getCurrentSampleRate());
            dev->start(&g_audioCallback);
            g_audio.nullDevice = std::move(dev);
            g_audio.ready = true;
            std::cout << "[engine] audio: null device (no hardware) @ "
                      << g_audio.nullDevice->getCurrentSampleRate() << " Hz" << std::endl;
            return "";
        }

        g_audio.manager = std::make_unique<juce::AudioDeviceManager>();
        auto result = g_audio.manager->initialiseWithDefaultDevices(0, 2);
        if (result.isNotEmpty()) {
            std::string detail = result.toStdString();
            g_audio.manager.reset();  // release; the next play retries
            return detail.empty() ? "no default audio device" : detail;
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
// Protocol v1 EXTENSION (additive, Stage 3b polish + 3c-1 scan):
//   transport play MAY carry "tick": <n>. Without it, play RESUMES from the
//   engine's lastTick (position at stop) — it never auto-resets to 0.
//   transport stop is PANIC: all voices die immediately.
void handle_load(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    if (!obj) { ws.send("{\"type\":\"error\",\"code\":\"bad_load\",\"echo\":\"load\"}"); return; }

    const auto& eventsVar = obj->getProperty("events");
    const auto& metaVar = obj->getProperty("meta");

    std::vector<EngineEvent> newEvents;
    if (eventsVar.isArray()) {
        for (auto& ev : *eventsVar.getArray()) {
            juce::DynamicObject* eobj = ev.getDynamicObject();
            if (!eobj) continue;
            EngineEvent ee;
            juce::String et = eobj->getProperty("eventType").toString();
            ee.type = (et == "NOTE_ON") ? 1 : 0;
            ee.channel = eobj->getProperty("channel");
            ee.pitch = eobj->getProperty("data1");
            ee.velocity = eobj->getProperty("data2");
            ee.tick = static_cast<int64_t>(static_cast<double>(eobj->getProperty("timestampTicks")));
            newEvents.push_back(ee);
        }
    }

    double bpm = 120.0;
    int ppqn = 960;
    int64_t endTick = 0;
    if (metaVar.getDynamicObject()) {
        bpm = metaVar.getDynamicObject()->getProperty("bpm");
        ppqn = metaVar.getDynamicObject()->getProperty("ppqn");
        endTick = static_cast<int64_t>(static_cast<double>(metaVar.getDynamicObject()->getProperty("endTick")));
    }

    {
        std::lock_guard<std::mutex> lock(g_engine.eventsMutex);
        g_engine.events = std::move(newEvents);
        g_engine.bpm = bpm;
        g_engine.ppqn = ppqn;
        g_engine.endTick = endTick;
    }

    std::cout << "[engine] loaded " << g_engine.events.size() << " events (bpm=" << bpm
              << " ppqn=" << ppqn << " endTick=" << endTick << ")" << std::endl;
    // Stage 3b polish — the load ack reports the CURRENT transport truth
    // (playing + current position), not a hardcoded {playing:false,tick:0}:
    // a reload during playback used to poison the UI playhead to 0 while the
    // engine kept playing (source-switch audit finding).
    ws.send(std::string("{\"type\":\"state\",\"playing\":") +
            (g_engine.playing.load() ? "true" : "false") +
            ",\"tick\":" + std::to_string(g_engine.currentTick()) + "}");
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
        // Panic-before-play: a fresh play must never overlap a previous
        // transport's ringing voices (the doubled-audio finding). Taking
        // voicesMutex also waits out any in-flight callback buffer.
        {
            std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
            for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
        }
        g_engine.samplesProcessed.store(0);
        g_engine.playStartTick.store(startTick);
        g_engine.transportGen.fetch_add(1);  // invalidate pre-play buffer commits
        g_engine.playing.store(true);
        std::cout << "[engine] transport play from tick " << startTick
                  << (hasTick ? " (explicit)" : " (resume)") << std::endl;
    } else if (cmd == "stop") {
        // Stage 3b polish — STOP IS PANIC: every voice dies NOW (no ring-out,
        // no overlap into the next play), and lastTick keeps the stopped
        // position so a later play-without-tick resumes exactly there.
        g_engine.playing.store(false);
        int killed = 0;
        {
            std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
            for (auto& v : g_engine.voices) {
                if (v.active || v.releasing) ++killed;
                v.releasing = false; v.active = false; v.env = 0; v.pitch = -1;
            }
        }
        std::cout << "[engine] transport stop: voices killed (n=" << killed
                  << ", tick=" << g_engine.lastTick.load() << ")" << std::endl;
    } else if (cmd == "seek") {
        int64_t tick = static_cast<int64_t>(static_cast<double>(obj->getProperty("tick")));
        if (tick < 0) tick = 0;
        g_engine.samplesProcessed.store(0);
        g_engine.playStartTick.store(tick);
        g_engine.lastTick.store(tick);
        g_engine.transportGen.fetch_add(1);  // pre-seek buffers must not commit
        // Hard position jump — ringing notes from the old position must not
        // bleed over the new one (same panic semantics as stop).
        {
            std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
            for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
        }
        std::cout << "[engine] transport seek to tick " << tick << std::endl;
    }
}

void handle_panic() {
    g_engine.playing.store(false);
    int killed = 0;
    {
        std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
        for (auto& v : g_engine.voices) {
            if (v.active || v.releasing) ++killed;
            v.releasing = false; v.active = false; v.env = 0; v.pitch = -1;
        }
    }
    g_engine.transportGen.fetch_add(1);
    std::cout << "[engine] panic — all notes off (n=" << killed << ")" << std::endl;
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
        if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
            if (port <= 0 || port > 65535) {
                std::cerr << "[engine] invalid port: " << argv[i] << std::endl;
                return 1;
            }
        }
    }

    ix::initNetSystem();

    // Stage 3b-fix: NO audio initialization at startup. Audio is brought up
    // lazily on the first transport play (or simulated via --null-audio), so
    // a headless machine boots cleanly and the protocol test does not depend
    // on audio hardware.
    std::cout << "[engine] audio policy: lazy init on first transport play";
    if (g_nullAudio) std::cout << " (--null-audio)";
    else if (g_forcedNoAudio) std::cout << " (--no-audio: forced device-less)";
    std::cout << std::endl;

    ix::WebSocketServer server(port, "127.0.0.1");

    server.setOnClientMessageCallback(
        [](std::shared_ptr<ix::ConnectionState> /*state*/,
           ix::WebSocket& ws,
           const ix::WebSocketMessagePtr& msg) {
            if (msg->type == ix::WebSocketMessageType::Open) {
                std::cout << "[engine] client connected" << std::endl;
                std::string hello = "{\"type\":\"hello\",\"engineVersion\":\"" +
                                    std::string(kEngineVersion) +
                                    "\",\"protocol\":" + std::to_string(kProtocolVersion) + "}";
                ws.send(hello);
            } else if (msg->type == ix::WebSocketMessageType::Message) {
                std::string message = msg->str;
                auto parsed = juce::JSON::parse(juce::String(message));
                juce::DynamicObject* obj = parsed.getDynamicObject();
                if (!obj) {
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
                    handle_load(parsed, ws);
                } else if (type == "transport") {
                    handle_transport(parsed, ws);
                } else if (type == "panic") {
                    handle_panic();
                } else if (type == "scan") {
                    handle_scan(parsed, ws);
                } else {
                    ws.send("{\"type\":\"error\",\"code\":\"unknown\",\"echo\":\"" + escape_json(message) + "\"}");
                }
            } else if (msg->type == ix::WebSocketMessageType::Close) {
                // Panic on disconnect — no stuck notes
                g_engine.playing.store(false);
                {
                    std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
                    for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
                }
                std::cout << "[engine] client disconnected (panic)" << std::endl;
            }
        });

    // State broadcast thread (~30Hz)
    std::thread state_thread([&server]() {
        while (!g_should_exit.load()) {
            if (g_engine.playing.load() || true) {
                int64_t tick = g_engine.currentTick();
                std::string state = "{\"type\":\"state\",\"playing\":" +
                    std::string(g_engine.playing.load() ? "true" : "false") +
                    ",\"tick\":" + std::to_string(tick) + "}";
                // Broadcast to all clients (frontend is the only client)
                auto clients = server.getClients();
                for (auto& client : clients) {
                    if (client) client->send(state);
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(33));
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
    shutdownAudio();
    ix::uninitNetSystem();
    std::cout << "[engine] clean exit 0" << std::endl;
    return 0;
}
