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
// No editor, no state, no RNG: same input ⇒ same output.

#pragma once

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <juce_audio_processors/juce_audio_processors.h>

class ScorchTestSynthProcessor : public juce::AudioProcessor {
public:
    ScorchTestSynthProcessor()
        : juce::AudioProcessor(juce::AudioProcessor::BusesProperties()
                                   .withOutput("Output", juce::AudioChannelSet::stereo(), true)) {
        // Stage 3c-polish F4: report a NON-ZERO latency so the CI can assert
        // the engine's compensation arithmetic end-to-end — the ledger's
        // dispatched sample positions must shift EARLIER by exactly this many
        // samples for plugin-routed events (128 samples = deterministic, well
        // inside the fixture's mute-window margins).
        setLatencySamples(128);
    }

    void prepareToPlay(double newSampleRate, int /*maxBlockSize*/) override {
        sampleRate = newSampleRate > 0 ? newSampleRate : 44100.0;
    }
    void releaseResources() override {}

    bool isBusesLayoutSupported(const BusesLayout& layouts) const override {
        return layouts.getMainOutputChannelSet() == juce::AudioChannelSet::stereo() &&
               layouts.getMainInputChannelSet().isDisabled();
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
                const float out = std::sin(v.phase) * v.amp * v.env * cc7Scale * cc11Scale;
                buffer.setSample(0, s, buffer.getSample(0, s) + out);
                if (buffer.getNumChannels() > 1)
                    buffer.setSample(1, s, buffer.getSample(1, s) + out);
                v.phase += v.phaseInc;
                if (v.phase > 6.283185307179586) v.phase -= 6.283185307179586;
            }
            if (v.releasing && v.env <= 0.0f) v.active = false;
        }
    }

    // ── Boilerplate (no editor, no state, no tail) ─────────────────────────
    const juce::String getName() const override { return "Scorch Test Synth"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return "Default"; }
    void changeProgramName(int, const juce::String&) override {}
    void getStateInformation(juce::MemoryBlock& dest) override { dest.setSize(0, true); }
    void setStateInformation(const void*, int) override {}
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }

private:
    static constexpr int kMaxVoices = 32;

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
        std::fprintf(stdout, "[testvst] s=%lld ch=%d k=%s d1=%d d2=%d\n",
                     static_cast<long long>(blockStart + samplePos), m.getChannel(), kind, d1, d2);
        std::fflush(stdout);
    }

    Voice voices[kMaxVoices];
    int cc7[17] = {};   // [1..16]; 0 until received (MIDI fader default = silent)
    int cc11[17] = {};  // [1..16]
    double sampleRate = 44100.0;
    long long blockStart = 0;
};
