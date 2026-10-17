// Scorch Test Synth — the free stand-in VST3 host target (Stage 3c).
//
// Purpose: CI cannot host commercial libraries (BBCSO), so the hosting path is
// proven against THIS plugin: a minimal, deterministic, license-free JUCE synth
// that responds to NoteOn/NoteOff/CC on ALL 16 MIDI channels and outputs a
// stereo sine sum. It is the "free test VST3" the Stage 3c brief pins for
// mute/solo gating + channel-routing assertions.
//
// Behavior contract (asserted by .github/scripts/test-engine-protocol.mjs):
//   * NoteOn(ch, note, vel)  → sine voice, amp = (vel/127) * 0.5
//   * NoteOff / CC120 / CC123 per channel → voice released (short 128-sample
//     fade, then silence)
//   * CC7 / CC11 per channel scale the voice amplitude (fader/expression path)
//   * SCORCH_TESTVST_LOG=1 (CI/test only) → every received MIDI event is
//     logged to stdout as "[testvst] s=<abs sample> ch=<n> k=<kind> d1=.. d2=.."
//     — the end-to-end proof that the ENGINE routed events to the plugin on
//     the expected channels.
// Stage 3e-2: the fixture also probes the HOST's playhead every block and
//     logs (same env gate; throttled — the first block + ~1/s while playing):
//     "[testvst] playhead s=<timeInSamples> bpm=<x> ppq=<y> bar=<z> ts=<n>/<d>
//     playing=<0|1>" — CI asserts bpm == the project bpm and ppq INCREASES
//     while playing (the engine's AudioPlayHead contract, end to end).
// Stage 3d-1: the fixture SHIPS an editor (deterministic 360x120) so CI can
// prove the openEditor/closeEditor contract on a free plugin. No state yet
// (3d-3), no RNG: same input ⇒ same output.
// Stage 3e-3: the fixture ships TWO stereo output buses ("Output" main +
// "Aux Out"). The aux bus emits a DISTINCT CONSTANT 0.25 while armed
// (CC#22 > 0 — score-driven, deterministic) AND a note is sounding; default
// silent so every earlier CI peak is byte-identical. CC#22 = 0 disarms.
// Stage 3f-6: SCORCH_TESTVST_SLOWSTATE_FILE (engine-process env) names a
// marker file; while it exists, getStateInformation of any PREPARED instance
// sleeps 10 s first (the publish-safe CI proof — a being-created instance is
// never prepared yet, so JUCE's creation-time state handshake stays fast).

// Stage 3f-7: SCORCH_TESTVST_INFTAIL=1 (engine-process env, inherited by
// probe-worker children) makes getTailLengthSeconds return INFINITY — the
// non-finite-number CI fixture: the probe receipt must still be outcome=ok
// and every capability JSON must stay parseable (tailSeconds serialized as
// null = "infinite").

// Stage 3i (CI fixture for runtime-latency tracking): real libraries cannot
// be scripted in CI, so the RESERVED CC#23 drives this fixture's reported
// latency AT RUNTIME — the same right a VST3 convolver/sampler exercises when
// its IR loads or its look-ahead changes. Deterministic command table
// (value → effect; every change is logged as "[testvst] latency n=<samples>
// notified=<0|1> mode=<mode>" under SCORCH_TESTVST_LOG=1):
//   0  → setLatencySamples(0)    + updateHostDisplay(latencyChanged)  (NOTIFIED)
//   1  → setLatencySamples(1024) + updateHostDisplay(latencyChanged)  (NOTIFIED)
//   2  → setLatencySamples(2048) + updateHostDisplay(latencyChanged)  (NOTIFIED)
//   10 → setLatencySamples(2048) with NO notification — the engine's 2000 ms
//        message-thread safety-net timer must detect it (2-identical-reads
//        debounce) — the silent-change CI proof
//   20 → NOTIFIED FLICKER: 40 toggles 0↔1024, one every 4 blocks (~46 ms at
//        44100/512 ≈ 1.9 s total), each one notified (updateHostDisplay from
//        INSIDE processBlock — the realtime-notification shape a real plugin
//        can produce), then SETTLES at 1024. Exercises the engine's rate
//        limit (≤ one republish per instance per second) + final-state
//        convergence. Block-counted in processBlock: no timers, no RNG.

#pragma once

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <chrono>
#include <thread>
#include <juce_audio_processors/juce_audio_processors.h>

class ScorchTestSynthProcessor : public juce::AudioProcessor {
public:
    ScorchTestSynthProcessor()
        // Stage 3e-3: TWO stereo output buses — main "Output" and aux
        // "Aux Out". The aux bus emits a DISTINCT CONSTANT 0.25 per sample
        // only when ARMED (CC#22 > 0) and a note is sounding; default OFF,
        // so every pre-3e-3 CI peak stays byte-identical (the arm lives in
        // the SCORE, not in state — deterministic per load).
        : juce::AudioProcessor(juce::AudioProcessor::BusesProperties()
                                   .withOutput("Output", juce::AudioChannelSet::stereo(), true)
                                   .withOutput("Aux Out", juce::AudioChannelSet::stereo(), true)) {
        // Stage 3c-polish F4: report a NON-ZERO latency so the CI can assert
        // the engine's compensation arithmetic end-to-end — the ledger's
        // dispatched sample positions must shift EARLIER by exactly this many
        // samples for plugin-routed events (128 samples = deterministic, well
        // inside the fixture's mute-window margins).
        setLatencySamples(128);
    }

    void prepareToPlay(double newSampleRate, int /*maxBlockSize*/) override {
        sampleRate = newSampleRate > 0 ? newSampleRate : 44100.0;
        // Stage 3f-6: marks the instance as RETIRE-CAPTURE-eligible (see
        // getStateInformation) — creation-time getStateInformation (JUCE's
        // VST3 component→controller state handshake, which runs INSIDE
        // createPluginInstance on the message thread) happens BEFORE this, so
        // the slow-capture hook can never stall the instance's own creation.
        preparedOnce.store(true);
    }
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override {
        if (layouts.getMainOutputChannelSet() != juce::AudioChannelSet::stereo()) return false;
        if (!layouts.getMainInputChannelSet().isDisabled()) return false;
        // Stage 3e-3: the aux bus (bus 1) must be stereo or disabled.
        const auto aux = layouts.getChannelSet(false, 1);
        if (!aux.isDisabled() && !(aux == juce::AudioChannelSet::stereo())) return false;
        return true;
    }

    void processBlock(juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override {
        juce::ScopedNoDenormals noDenormals;
        const int numSamples = buffer.getNumSamples();
        for (int ch = 0; ch < buffer.getNumChannels(); ++ch)
            buffer.clear(ch, 0, numSamples);
        blockStart += numSamples;

        for (const auto& meta : midi) {
            const auto msg = meta.getMessage();
            logMidi(static_cast<int>(meta.samplePosition), msg);
            handleMidi(msg);
        }

        // Render voices (mono sum → stereo).
        for (auto& v : voices) {
            if (!v.active && !v.releasing) continue;
            const float cc7Scale = static_cast<float>(cc7[v.channel]) / 127.0f;
            const float cc11Scale = static_cast<float>(cc11[v.channel]) / 127.0f;
            for (int s = 0; s < numSamples; ++s) {
                if (v.releasing) {
                    v.env -= 1.0f / 128.0f;
                    if (v.env <= 0.0f) { v.env = 0.0f; v.releasing = false; break; }
                }
                const float out = std::sin(v.phase) * v.amp * v.env * cc7Scale * cc11Scale
                                  * masterScale.load();
                buffer.setSample(0, s, buffer.getSample(0, s) + out);
                if (buffer.getNumChannels() > 1)
                    buffer.setSample(1, s, buffer.getSample(1, s) + out);
                v.phase += v.phaseInc;
                if (v.phase > 6.283185307179586) v.phase -= 6.283185307179586;
            }
            if (v.releasing && v.env <= 0.0f) v.active = false;
        }

        // Stage 3i — CC#23 v=20 flicker stepper (block-counted, deterministic).
        // Every 4 blocks (~46 ms at 44100/512): toggle the latency and notify
        // FROM the process context — the exact realtime-notification shape the
        // engine's listener must survive allocation-free. After 40 toggles the
        // value SETTLES at 1024 (one last notified change).
        if (flickerLeft > 0 && ++flickerBlocks >= 4) {
            flickerBlocks = 0;
            --flickerLeft;
            flickerValue = flickerValue == 0 ? 1024 : 0;
            setLatencySamples(flickerValue);
            updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withLatencyChanged(true));
            logLatency("flicker", flickerValue, 1);
            if (flickerLeft == 0) {
                setLatencySamples(1024);
                updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withLatencyChanged(true));
                logLatency("settle", 1024, 1);
            }
        }

        // Stage 3e-3 — AUX BUS OUTPUT: a DISTINCT CONSTANT 0.25 per sample on
        // the aux bus's stereo pair (buffer channels after the main bus's)
        // while ARMED (CC#22 > 0) and a note is sounding. Silent otherwise —
        // the pre-3e-3 CI peaks stay byte-identical. The aux level is
        // deliberately independent of velocity/masterScale: it is a routing
        // probe, not music.
        if (auxArmed > 0 && buffer.getNumChannels() >= 4) {
            bool anySounding = false;
            for (const auto& v : voices)
                if (v.active || v.releasing) { anySounding = true; break; }
            if (anySounding)
                for (int ch = 2; ch < juce::jmin(4, buffer.getNumChannels()); ++ch)
                    for (int s = 0; s < numSamples; ++s)
                        buffer.setSample(ch, s, buffer.getSample(ch, s) + kAuxLevel);
        }

        // Stage 3e-2 — playhead observability: read the host's PositionInfo
        // and log it, throttled to the FIRST block + ~1/s while playing
        // (block-count arithmetic — deterministic, no RNG, no allocation).
        maybeLogPlayhead();
    }

    void maybeLogPlayhead() {
        static const bool enabled = std::getenv("SCORCH_TESTVST_LOG") != nullptr;
        if (!enabled) return;
        auto* ph = getPlayHead();
        if (ph == nullptr) {
            if (blockStart == 0) {
                std::fprintf(stdout, "[testvst] playhead none (host supplied no AudioPlayHead)\n");
                std::fflush(stdout);
            }
            return;
        }
        const auto pos = ph->getPosition();
        if (!pos.hasValue()) {
            if (blockStart == 0) {
                std::fprintf(stdout, "[testvst] playhead absent (host returned nullopt)\n");
                std::fflush(stdout);
            }
            return;
        }
        const bool playingNow = pos->getIsPlaying();
        const bool timeToLog = blockStart == 0
            || (playingNow && blockStart - lastPlayheadLogAt >= static_cast<long long>(sampleRate));
        if (!timeToLog) return;
        lastPlayheadLogAt = blockStart;
        const double bpm = pos->getBpm().orFallback(-1.0);
        const double ppq = pos->getPpqPosition().orFallback(-1.0);
        const double bar = pos->getPpqPositionOfLastBarStart().orFallback(-1.0);
        int tsNum = 0, tsDen = 0;
        if (const auto sig = pos->getTimeSignature()) { tsNum = sig->numerator; tsDen = sig->denominator; }
        const long long tis = pos->getTimeInSamples().orFallback(-1);
        std::fprintf(stdout, "[testvst] playhead s=%lld bpm=%.2f ppq=%.3f bar=%.3f ts=%d/%d playing=%d\n",
                     static_cast<long long>(tis), bpm, ppq, bar, tsNum, tsDen, playingNow ? 1 : 0);
        std::fflush(stdout);
    }

    // ── Boilerplate (editor since 3d-1; state arrives in 3d-3; no tail) ────
    const juce::String getName() const override { return "Scorch Test Synth"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return "Default"; }
    void changeProgramName(int, const juce::String&) override {}
    double getTailLengthSeconds() const override {
        // Stage 3f-7: the non-finite-number fixture (see the header note).
        static const bool infTail = std::getenv("SCORCH_TESTVST_INFTAIL") != nullptr;
        if (infTail) return std::numeric_limits<double>::infinity();
        return 0.0;
    }
    void getStateInformation(juce::MemoryBlock& dest) override {
        // Stage 3f-6: publish-safe CI hook. While the marker file named by the
        // ENGINE's SCORCH_TESTVST_SLOWSTATE_FILE env var exists, state capture
        // stalls 10 s BEFORE producing the (unchanged, valid) state — the
        // stand-in for the real Falcon/BBCSO symptom (a slow/hung
        // getStateInformation on a RETIRED instance wedged the init worker's
        // publish section forever). GATED ON preparedOnce: JUCE's VST3
        // creation path calls getStateInformation on the NEW instance too
        // (the component→controller state handshake inside
        // createPluginInstance), and that call must stay fast so the new set
        // publishes immediately — only already-prepared (retireable)
        // instances stall. The env var names the file, the TEST creates and
        // removes it mid-session, so the same binary stays fast for every
        // other phase and no second fixture is needed. The stall is logged
        // (SCORCH_TESTVST_LOG=1) so CI proves the path was taken.
        static const char* const slowStateFile = std::getenv("SCORCH_TESTVST_SLOWSTATE_FILE");
        if (slowStateFile != nullptr && preparedOnce.load()) {
            if (FILE* marker = std::fopen(slowStateFile, "rb")) {
                std::fclose(marker);
                std::fprintf(stdout, "[testvst] slow state capture: marker present — sleeping 10000 ms in getStateInformation\n");
                std::fflush(stdout);
                std::this_thread::sleep_for(std::chrono::milliseconds(10000));
            }
        }
        // Stage 3d-3: REAL state. The CI-observable master scale (multiplies
        // every voice), serialized as ONE raw little-endian float32 — a
        // format the CI can construct and assert byte-exactly (no XML
        // dependency). 4 bytes: b64("AADAPw==") == 1.0f.
        dest.setSize(sizeof(masterScale), true);
        const float v = masterScale.load();
        std::memcpy(dest.getData(), &v, sizeof(v));
    }
    void setStateInformation(const void* data, int sizeInBytes) override {
        if (data == nullptr || sizeInBytes != static_cast<int>(sizeof(float))) return;
        float v = 1.0f;
        std::memcpy(&v, data, sizeof(v));
        if (v < 0.0f || v > 4.0f) v = 1.0f;   // sane range; never a garbage scale
        masterScale.store(v);
    }

    // Stage 3d-1: the fixture SHIPS an editor. The 3d-1 acceptance proves
    // editors are UNIVERSAL — the CI contract (openEditor → editorOpened with
    // real geometry → closeEditor → editorClosed) needs a free, in-repo,
    // editor-carrying plugin, because CI cannot host commercial libraries.
    // Deterministic fixed size (no layout logic, no RNG).
    class TinyEditor : public juce::AudioProcessorEditor {
    public:
        explicit TinyEditor(ScorchTestSynthProcessor& p) : juce::AudioProcessorEditor(p) {
            setSize(360, 120);
        }
        void paint(juce::Graphics& g) override {
            g.fillAll(juce::Colour(0xff14161f));
            g.setColour(juce::Colour(0xfff5f5f4));
            g.setFont(14.0f);
            g.drawText("Scorch Test Synth — editor", getLocalBounds(),
                       juce::Justification::centred);
        }
    };
    juce::AudioProcessorEditor* createEditor() override { return new TinyEditor(*this); }
    bool hasEditor() const override { return true; }

private:
    static constexpr int kMaxVoices = 32;
    // Stage 3d-3 — state-persistence observability: scales every rendered
    // voice. Default 1.0; ALSO settable via CC#21 (value/127) so the CI can
    // DIVERGE the state through the score (a hosted VST3's state comes back
    // through the JUCE wrapper container — opaque to the test, so the test
    // cannot hand-construct a blob). Proof chain: capture → diverge via CC →
    // capture (must differ) → re-host WITH the captured blob → peak proves
    // the restored state APPLIED → capture again (must be byte-identical).
    std::atomic<float> masterScale{1.0f};
    // Stage 3f-6: set by prepareToPlay — the slow-capture gate (see
    // getStateInformation). A creation-time capture (pre-prepare) never stalls.
    std::atomic<bool> preparedOnce{false};

    struct Voice {
        bool active = false;
        bool releasing = false;
        int channel = 1;
        int pitch = -1;
        double phase = 0.0;
        double phaseInc = 0.0;
        float amp = 0.0f;
        float env = 1.0f;
    };

    void handleMidi(const juce::MidiMessage& m) {
        const int ch = juce::jlimit(1, 16, m.getChannel());
        if (m.isNoteOn()) {
            for (auto& v : voices) {
                if (v.active || v.releasing) continue;
                v.active = true;
                v.releasing = false;
                v.env = 1.0f;
                v.channel = ch;
                v.pitch = m.getNoteNumber();
                v.phase = 0.0;
                const double freq = 440.0 * std::pow(2.0, (m.getNoteNumber() - 69) / 12.0);
                v.phaseInc = 2.0 * juce::MathConstants<double>::pi * freq / sampleRate;
                v.amp = 0.5f * (static_cast<float>(m.getVelocity()) / 127.0f);
                return;
            }
        } else if (m.isNoteOff()) {
            for (auto& v : voices) {
                if ((v.active || v.releasing) && v.channel == ch && v.pitch == m.getNoteNumber()) {
                    v.releasing = true;
                    v.active = false;
                }
            }
        } else if (m.isController()) {
            const int num = m.getControllerNumber();
            const int val = m.getControllerValue();
            if (num == 7) cc7[ch] = val;
            else if (num == 11) cc11[ch] = val;
            else if (num == 21) masterScale.store(juce::jlimit(0.0f, 4.0f, static_cast<float>(val) / 127.0f));
            else if (num == 22) auxArmed = val > 0 ? 1 : 0;   // 3e-3: aux-bus arm (deterministic, score-driven)
            else if (num == 23) {   // 3i: RESERVED runtime-latency control (see header)
                if (val == 0 || val == 1 || val == 2) {
                    const int target = (val == 0) ? 0 : (val == 1 ? 1024 : 2048);
                    setLatencySamples(target);
                    updateHostDisplay(juce::AudioProcessorListener::ChangeDetails().withLatencyChanged(true));
                    logLatency("cc", target, 1);
                } else if (val == 10) {
                    // SILENT change: no updateHostDisplay — only the engine's
                    // 2000 ms safety-net timer can detect this one.
                    setLatencySamples(2048);
                    logLatency("silent", 2048, 0);
                } else if (val == 20) {
                    flickerLeft = 40;   // 40 toggles @ 4 blocks, settles at 1024 (see processBlock)
                    flickerValue = 0;
                    flickerBlocks = 0;
                }
            }
            else if (num == 120 || num == 123) {
                for (auto& v : voices) {
                    if (v.channel == ch) { v.releasing = true; v.active = false; }
                }
            }
        }
    }

    void logMidi(int samplePos, const juce::MidiMessage& m) {
        static const bool enabled = std::getenv("SCORCH_TESTVST_LOG") != nullptr;
        if (!enabled) return;
        const char* kind = "OTHER";
        int d1 = 0, d2 = 0;
        if (m.isNoteOn()) { kind = "NOTE_ON"; d1 = m.getNoteNumber(); d2 = m.getVelocity(); }
        else if (m.isNoteOff()) { kind = "NOTE_OFF"; d1 = m.getNoteNumber(); d2 = 0; }
        else if (m.isController()) { kind = "CC"; d1 = m.getControllerNumber(); d2 = m.getControllerValue(); }
        else if (m.isPitchWheel()) { kind = "PITCH_BEND"; d1 = 0; d2 = m.getPitchWheelValue(); }
        std::fprintf(stdout, "[testvst] s=%lld ch=%d k=%s d1=%d d2=%d ms=%.3f\n",
                     static_cast<long long>(blockStart + samplePos), m.getChannel(), kind, d1, d2,
                     masterScale.load());
        std::fflush(stdout);
    }

    // Stage 3i: latency-command observability (SCORCH_TESTVST_LOG=1) — proves
    // the fixture TOOK each commanded change and whether it notified, so CI
    // can cross-check fixture notifications against the engine's republish
    // receipts (rate-limit math).
    void logLatency(const char* mode, int samples, int notified) {
        static const bool enabled = std::getenv("SCORCH_TESTVST_LOG") != nullptr;
        if (!enabled) return;
        std::fprintf(stdout, "[testvst] latency n=%d notified=%d mode=%s blocks=%lld\n",
                     samples, notified, mode, static_cast<long long>(blockStart));
        std::fflush(stdout);
    }

    Voice voices[kMaxVoices];
    int cc7[17] = {};   // [1..16]; 0 until received (MIDI fader default = silent)
    int cc11[17] = {};  // [1..16]
    int auxArmed = 0;   // 3e-3: CC#22 arms the aux bus (default OFF — CI peaks byte-identical)
    // Stage 3i: CC#23 runtime-latency control state (see the header table).
    int flickerLeft = 0;      // remaining toggles (0 = idle)
    int flickerValue = 0;     // current flicker latency target
    int flickerBlocks = 0;    // block counter toward the next toggle
    static constexpr float kAuxLevel = 0.25f;   // the aux bus's distinct constant level
    double sampleRate = 44100.0;
    long long blockStart = 0;
    long long lastPlayheadLogAt = -(1LL << 40);  // 3e-2 throttle (first playing block logs immediately)
};
