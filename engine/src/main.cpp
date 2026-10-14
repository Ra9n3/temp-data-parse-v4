// scorch-engine — Stage 3b: note stream over the wire + engine audio rendering.
// Protocol v1 EXTENSION (additive — v1 handshake messages unchanged):
//   client -> server: {"type":"load","events":[...],"meta":{bpm,ppqn,timeSignature,endTick}}
//   client -> server: {"type":"transport","command":"play"|"stop"|"seek","tick":<n?>}
//   client -> server: {"type":"panic"}
//   server -> client: {"type":"state","playing":bool,"tick":<n>}  (~30Hz when playing)
// Existing v1 messages unchanged: hello, ping->pong, shutdown, unknown->error.
//
// Test synth: sine oscillator per note, voice allocation (steal oldest),
// gain envelope (attack/release ~10ms). Every NoteOn must sound, every NoteOff
// must stop. No VST3, no samples, no CC rendering. Loopback ONLY (127.0.0.1).

// MSVC needs _USE_MATH_DEFINES before <cmath> for M_PI.
// NOMINMAX prevents windows.h (pulled in by JUCE/IXWebSocket) from defining
// min/max macros that conflict with std::min/std::max/std::numeric_limits.
#ifdef _MSC_VER
#define _USE_MATH_DEFINES
#define NOMINMAX
#endif
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
#if SCORCH_ENGINE_AUDIO
#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_devices/juce_audio_devices.h>
#endif

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace {

constexpr const char* kEngineVersion = "0.1.0";
constexpr int kProtocolVersion = 1;
constexpr int kDefaultPort = 9377;
constexpr int kMaxVoices = 64;
constexpr double kAttackMs = 10.0;
constexpr double kReleaseMs = 10.0;

std::atomic<bool> g_should_exit{false};

// ─── Engine event (parsed from JSON load message) ───────────────────────────
struct EngineEvent {
    int type;        // 0=NOTE_OFF, 1=NOTE_ON
    int channel;
    int pitch;       // data1
    int velocity;    // data2
    int64_t tick;    // timestampTicks
};

// ─── Synth voice ────────────────────────────────────────────────────────────
#if SCORCH_ENGINE_AUDIO
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
#endif

// ─── Engine state (shared between WS thread, audio thread, state thread) ────
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

#if SCORCH_ENGINE_AUDIO
    Voice voices[kMaxVoices];
    std::mutex voicesMutex;
    int64_t voiceAge = 0;
#else
    // No audio: voices are stubbed out. The protocol logic still works;
    // note-on/note-off are accepted but produce no sound.
    std::mutex voicesMutex; // kept for lock_guard compatibility
#endif

    double samplesPerTick() const {
        return sampleRate.load() * 60.0 / (bpm * ppqn);
    }

    int64_t currentTick() const {
        if (!playing.load()) return playStartTick.load();
        return playStartTick.load() +
               static_cast<int64_t>(samplesProcessed.load() / samplesPerTick());
    }
};

EngineState g_engine;

// ─── Audio callback ─────────────────────────────────────────────────────────
#if SCORCH_ENGINE_AUDIO
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

        g_engine.samplesProcessed.store(startSample + numSamples);

        // Stop at endTick
        if (g_engine.endTick > 0 && g_engine.currentTick() >= g_engine.endTick) {
            g_engine.playing.store(false);
            allNotesOff();
        }
    }

    void audioDeviceAboutToStart(juce::AudioIODevice* /*device*/) override {
        double rate = g_engine.sampleRate.load();
        // Update sample rate if changed
        // (device->getCurrentSampleRate() would be ideal but we keep it simple)
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
juce::AudioDeviceManager g_deviceManager;
#endif // SCORCH_ENGINE_AUDIO

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

// ─── Message handlers ───────────────────────────────────────────────────────
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
            ee.tick = static_cast<int64_t>((int64_t)eobj->getProperty("timestampTicks"));
            newEvents.push_back(ee);
        }
    }

    double bpm = 120.0;
    int ppqn = 960;
    int64_t endTick = 0;
    if (metaVar.getDynamicObject()) {
        bpm = metaVar.getDynamicObject()->getProperty("bpm");
        ppqn = metaVar.getDynamicObject()->getProperty("ppqn");
        endTick = static_cast<int64_t>((int64_t)metaVar.getDynamicObject()->getProperty("endTick"));
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
    ws.send("{\"type\":\"state\",\"playing\":false,\"tick\":0}");
}

void handle_transport(const juce::var& json, ix::WebSocket& ws) {
    juce::DynamicObject* obj = json.getDynamicObject();
    if (!obj) return;
    juce::String cmd = obj->getProperty("command").toString();

    if (cmd == "play") {
        g_engine.samplesProcessed.store(0);
        g_engine.playStartTick.store(0);
        g_engine.playing.store(true);
        std::cout << "[engine] transport play" << std::endl;
    } else if (cmd == "stop") {
        g_engine.playing.store(false);
        // All notes off
#if SCORCH_ENGINE_AUDIO
        {
            std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
            for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
        }
#endif
        std::cout << "[engine] transport stop" << std::endl;
    } else if (cmd == "seek") {
        int64_t tick = static_cast<int64_t>((int64_t)obj->getProperty("tick"));
        g_engine.playStartTick.store(tick);
        g_engine.samplesProcessed.store(0);
        std::cout << "[engine] transport seek to tick " << tick << std::endl;
    }
}

void handle_panic() {
    g_engine.playing.store(false);
#if SCORCH_ENGINE_AUDIO
    {
        std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
        for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
    }
#endif
    std::cout << "[engine] panic — all notes off" << std::endl;
}

// ─── Main ───────────────────────────────────────────────────────────────────
} // namespace

int main(int argc, char** argv) {
    int port = kDefaultPort;
    bool noAudio = false;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--version") {
            std::cout << "scorch-engine " << kEngineVersion
                      << " (protocol " << kProtocolVersion << ")" << std::endl;
            return 0;
        }
        if (arg == "--no-audio") {
            noAudio = true;
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

    // Setup JUCE audio device manager (default output). Skip on --no-audio
    // (CI has no audio device; the protocol test still works without sound).
#if SCORCH_ENGINE_AUDIO
    if (!noAudio) {
        auto audioResult = g_deviceManager.initialiseWithDefaultDevices(0, 2);
        if (audioResult.isNotEmpty()) {
            std::cerr << "[engine] audio init: " << audioResult << std::endl;
        } else {
            auto* device = g_deviceManager.getCurrentAudioDevice();
            if (device) {
                g_engine.sampleRate.store(device->getCurrentSampleRate());
                std::cout << "[engine] audio: " << device->getName().toStdString()
                          << " @ " << device->getCurrentSampleRate() << " Hz"
                          << " buffer=" << device->getCurrentBufferSizeSamples() << std::endl;
            }
            g_deviceManager.addAudioCallback(&g_audioCallback);
        }
    } else {
        std::cout << "[engine] audio disabled (--no-audio)" << std::endl;
    }
#else
    std::cout << "[engine] audio disabled (build without SCORCH_ENGINE_AUDIO)" << std::endl;
#endif

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
                } else {
                    ws.send("{\"type\":\"error\",\"code\":\"unknown\",\"echo\":\"" + escape_json(message) + "\"}");
                }
            } else if (msg->type == ix::WebSocketMessageType::Close) {
                // Panic on disconnect — no stuck notes
                g_engine.playing.store(false);
#if SCORCH_ENGINE_AUDIO
                {
                    std::lock_guard<std::mutex> lock(g_engine.voicesMutex);
                    for (auto& v : g_engine.voices) { v.releasing = false; v.active = false; v.env = 0; v.pitch = -1; }
                }
#endif
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
#if SCORCH_ENGINE_AUDIO
    g_deviceManager.removeAudioCallback(&g_audioCallback);
    g_deviceManager.closeAudioDevice();
#endif
    ix::uninitNetSystem();
    std::cout << "[engine] clean exit 0" << std::endl;
    return 0;
}
