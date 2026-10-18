#!/usr/bin/env python3
"""M1 silence diagnosis — D2: branch-level logging inside the FETCHED JUCE copy.

Patches build/_deps/juce-src/modules/juce_audio_processors/processors/
juce_AudioProcessorGraph.cpp (the FetchContent pin, NOT our vendored core)
with [d2] receipts at the exact branches of the render-sequence exchange:

  - RenderSequenceExchange::set            (MM)     — a sequence was baked
  - RenderSequenceExchange::updateAudioThreadState (audio) — trylock/swap outcome
  - Pimpl::handleAsyncUpdate               (MM)     — applySettings result,
                                                      signature short-circuit vs build+set
  - Pimpl::processBlock                    (both)   — state ptr, guard outcome,
                                                      settings equality values
  - RenderSequence::process                (both)   — variant hit/miss

All receipts are gated on env SCORCH_D2=1 (set only on the diagnostic run)
and appended to $HOME/.config/scorch/engine.log — the same named-receipt
medium the engine uses. The patch is inert without the env var.

Idempotent: skips if the marker already exists; a re-fetch wipes the patch,
re-running this script re-applies it. Backup: <file>.pre-d2 (first apply only).
"""
import os
import sys

TARGET = ("/home/z/my-project/scorsh/engine/build/_deps/juce-src/modules/"
          "juce_audio_processors/processors/juce_AudioProcessorGraph.cpp")
MARKER = "SCORCH D2 DIAGNOSTIC PATCH"

HELPER = r"""
    // ── SCORCH D2 DIAGNOSTIC PATCH (temporary; applied by scripts/m1_d2_patch_juce.py) ──
    // Named [d2] receipts into the engine's engine.log, gated on SCORCH_D2=1.
    // Diagnostic-only: never ships (the fetched tree is wiped on re-fetch).
    static void scorchD2Log (const std::string& line)
    {
        static const bool d2Enabled = std::getenv ("SCORCH_D2") != nullptr;
        if (! d2Enabled) return;
        if (const char* d2Home = std::getenv ("HOME"))
        {
            const std::string d2Path = std::string (d2Home) + "/.config/scorch/engine.log";
            if (FILE* d2f = std::fopen (d2Path.c_str(), "a"))
            {
                std::fprintf (d2f, "[d2] %s\n", line.c_str());
                std::fclose (d2f);
            }
        }
    }

    static std::string scorchD2Settings (const std::optional<PrepareSettings>& s)
    {
        if (! s.has_value()) return "nullopt";
        return "p=" + std::to_string ((int) s->precision)
             + " sr=" + std::to_string (s->sampleRate)
             + " blk=" + std::to_string (s->blockSize);
    }
    // ── end SCORCH D2 DIAGNOSTIC PATCH ──
"""

# ── patch 1: helper right after PrepareSettings (before NodeStates — must
#      precede RenderSequence::process at ~line 1531 for ADL-free lookup) ──
P1_ANCHOR = """    bool operator== (const PrepareSettings& other) const { return tie() == other.tie(); }
    bool operator!= (const PrepareSettings& other) const { return tie() != other.tie(); }
};"""
P1_NEW = """    bool operator== (const PrepareSettings& other) const { return tie() == other.tie(); }
    bool operator!= (const PrepareSettings& other) const { return tie() != other.tie(); }
};
""" + HELPER

# ── patch 2: set() — the bake point ──
P2_ANCHOR = """        const SpinLock::ScopedLockType lock (mutex);
        mainThreadState = std::move (next);
        isNew = true;
    }"""
P2_NEW = """        const SpinLock::ScopedLockType lock (mutex);
        const auto d2Lat = next != nullptr ? next->getLatencySamples() : -1;
        const auto d2Set = next != nullptr ? next->getSettings() : std::optional<PrepareSettings> {};
        mainThreadState = std::move (next);
        isNew = true;
        scorchD2Log (std::string ("[host-core] DIAG d2 set() baked seq latency=") + std::to_string (d2Lat)
                     + " settings={" + scorchD2Settings (d2Set) + "} isNew=1");
    }"""

# ── patch 3: updateAudioThreadState — the swap outcome (gated: first 12 + changes) ──
P3_ANCHOR = """    /*  Call from the audio thread only. */
    void updateAudioThreadState()
    {
        const SpinLock::ScopedTryLockType lock (mutex);

        if (lock.isLocked() && isNew)
        {
            // Swap pointers rather than assigning to avoid calling delete here
            std::swap (mainThreadState, audioThreadState);
            isNew = false;
        }
    }"""
P3_NEW = """    /*  Call from the audio thread only. */
    void updateAudioThreadState()
    {
        const SpinLock::ScopedTryLockType lock (mutex);

        if (lock.isLocked() && isNew)
        {
            // Swap pointers rather than assigning to avoid calling delete here
            std::swap (mainThreadState, audioThreadState);
            isNew = false;
        }

        {   // SCORCH D2 DIAGNOSTIC PATCH — swap outcome (first 12 calls + transitions)
            static int d2n = 0;
            static bool d2LastHad = false;
            const bool d2Locked = lock.isLocked();
            const bool d2Had = audioThreadState != nullptr;
            if (d2n < 12 || d2Had != d2LastHad)
                scorchD2Log (std::string ("[host-core] DIAG d2 uats n=") + std::to_string (d2n)
                             + " trylock=" + (d2Locked ? "1" : "0")
                             + " isNew=" + (isNew ? "1" : "0")
                             + " audioThreadState=" + (d2Had ? "LIVE" : "null"));
            d2LastHad = d2Had;
            ++d2n;
        }
    }"""

# ── patch 4: handleAsyncUpdate — signature short-circuit vs build+set (cap 60) ──
P4_ANCHOR = """            const RenderSequenceSignature newSignature (*newSettings, nodes, connections);

            if (std::exchange (lastBuiltSequence, newSignature) != newSignature)
            {
                auto sequence = std::make_unique<RenderSequence> (*newSettings, nodes, connections);
                owner->setLatencySamples (sequence->getLatencySamples());
                renderSequenceExchange.set (std::move (sequence));
            }
        }
        else
        {
            lastBuiltSequence.reset();
            renderSequenceExchange.set (nullptr);
        }"""
P4_NEW = """            const RenderSequenceSignature newSignature (*newSettings, nodes, connections);

            {   // SCORCH D2 DIAGNOSTIC PATCH — hau enter (cap 60)
                static int d2hn = 0;
                if (d2hn++ < 60)
                    scorchD2Log (std::string ("[host-core] DIAG d2 hau applySettings={")
                                 + scorchD2Settings (newSettings) + "}");
            }
            const bool d2SigChanged = std::exchange (lastBuiltSequence, newSignature) != newSignature;
            {   // SCORCH D2 DIAGNOSTIC PATCH — signature verdict (cap 60)
                static int d2sn = 0;
                if (d2sn++ < 60)
                    scorchD2Log (std::string ("[host-core] DIAG d2 hau sigChanged=")
                                 + (d2SigChanged ? "1" : "0")
                                 + (d2SigChanged ? " -> build+set" : " -> SHORT-CIRCUIT (no set)"));
            }
            if (d2SigChanged)
            {
                auto sequence = std::make_unique<RenderSequence> (*newSettings, nodes, connections);
                const auto d2Lat = sequence->getLatencySamples();
                owner->setLatencySamples (d2Lat);
                renderSequenceExchange.set (std::move (sequence));
            }
        }
        else
        {
            lastBuiltSequence.reset();
            renderSequenceExchange.set (nullptr);
            scorchD2Log (std::string ("[host-core] DIAG d2 hau applySettings=nullopt -> set(nullptr)"));
        }"""

# ── patch 5: Pimpl::processBlock — state + guard (first 12 + transitions) ──
P5_ANCHOR = """        auto* state = renderSequenceExchange.getAudioThreadState();

        // Only process if the graph has the correct blockSize, sampleRate etc.
        if (state != nullptr && state->getSettings() == nodeStates.getLastRequestedSettings())
        {
            state->process (audio, midi, playHead);
        }
        else
        {
            audio.clear();
            midi.clear();
        }"""
P5_NEW = """        auto* state = renderSequenceExchange.getAudioThreadState();

        {   // SCORCH D2 DIAGNOSTIC PATCH — processBlock entry (first 12 + transitions)
            static int d2pn = 0;
            static bool d2LastNull = false;
            const bool d2Null = state == nullptr;
            if (d2pn < 12 || d2Null != d2LastNull)
                scorchD2Log (std::string ("[host-core] DIAG d2 pblk n=") + std::to_string (d2pn)
                             + " msgThread=" + (MessageManager::getInstance()->isThisTheMessageThread() ? "1" : "0")
                             + " state=" + (d2Null ? "null" : "LIVE")
                             + " isNRT=" + (owner->isNonRealtime() ? "1" : "0"));
            d2LastNull = d2Null;
            ++d2pn;
        }

        // Only process if the graph has the correct blockSize, sampleRate etc.
        if (state != nullptr && state->getSettings() == nodeStates.getLastRequestedSettings())
        {
            state->process (audio, midi, playHead);
        }
        else
        {
            {   // SCORCH D2 DIAGNOSTIC PATCH — guard-clear values (first 12)
                static int d2gn = 0;
                if (d2gn++ < 12)
                    scorchD2Log (std::string ("[host-core] DIAG d2 pblk GUARD-CLEAR n=") + std::to_string (d2gn - 1)
                                 + " state=" + (state == nullptr ? "null" : "LIVE")
                                 + " seqSettings={" + scorchD2Settings (state != nullptr ? std::optional<PrepareSettings> (state->getSettings()) : std::nullopt)
                                 + "} lastRequested={" + scorchD2Settings (nodeStates.getLastRequestedSettings()) + "}");
            }
            audio.clear();
            midi.clear();
        }"""

# ── patch 6: RenderSequence::process — variant verdict ──
P6_ANCHOR = """        if (auto* s = std::get_if<GraphRenderSequence<FloatType>> (&sequence.sequence))
            s->perform (audio, midi, playHead);
        else
            jassertfalse; // Not prepared for this audio format!"""
P6_NEW = """        if (auto* s = std::get_if<GraphRenderSequence<FloatType>> (&sequence.sequence))
            s->perform (audio, midi, playHead);
        else
        {
            // SCORCH D2 DIAGNOSTIC PATCH — variant miss
            scorchD2Log (std::string ("[host-core] DIAG d2 rseq VARIANT-MISS (sequence not built for this float type)"));
            jassertfalse; // Not prepared for this audio format!
        }"""

# ── patch 7: builder::build — orderedNodes + buffers + latency ──
P7_ANCHOR = """    template <typename FloatType>
    static SequenceAndLatency build (const Nodes& n, const Connections& c)
    {
        GraphRenderSequence<FloatType> sequence;
        const RenderSequenceBuilder builder (n, c, sequence);
        return { std::move (sequence), builder.totalLatency };
    }"""
P7_NEW = """    template <typename FloatType>
    static SequenceAndLatency build (const Nodes& n, const Connections& c)
    {
        GraphRenderSequence<FloatType> sequence;
        const RenderSequenceBuilder builder (n, c, sequence);
        scorchD2Log (std::string ("[host-core] DIAG d2 build orderedNodes=") + std::to_string (builder.orderedNodes.size())
                     + " audioBufs=" + std::to_string (builder.audioBuffers.size())
                     + " midiBufs=" + std::to_string (builder.midiBuffers.size())
                     + " totalLatency=" + std::to_string (builder.totalLatency));
        return { std::move (sequence), builder.totalLatency };
    }"""

# ── patch 8: addProcessOp — per-node op emission (cap 60) ──
P8_ANCHOR = """    void addProcessOp (const Node::Ptr& node,
                       const Array<int>& audioChannelsUsed,
                       int totalNumChans,
                       int midiBuffer)
    {
        auto op = [&]() -> std::unique_ptr<NodeOp>"""
P8_NEW = """    void addProcessOp (const Node::Ptr& node,
                       const Array<int>& audioChannelsUsed,
                       int totalNumChans,
                       int midiBuffer)
    {
        {   // SCORCH D2 DIAGNOSTIC PATCH — per-node op emission (cap 60)
            static int d2on = 0;
            if (d2on++ < 60)
                scorchD2Log (std::string ("[host-core] DIAG d2 addProcessOp uid=") + std::to_string (node->nodeID.uid)
                             + " ins=" + std::to_string (node->getProcessor()->getTotalNumInputChannels())
                             + " outs=" + std::to_string (node->getProcessor()->getTotalNumOutputChannels())
                             + " chUsed=" + std::to_string (audioChannelsUsed.size())
                             + " midiBuf=" + std::to_string (midiBuffer)
                             + (dynamic_cast<const AudioProcessorGraph::AudioGraphIOProcessor*> (node->getProcessor()) != nullptr ? " [IO]" : ""));
        }
        auto op = [&]() -> std::unique_ptr<NodeOp>"""

# ── patch 9: perform — op count at render time (first 4) ──
P9_ANCHOR = """            for (const auto& op : renderOps)
                op->process (context);
        }

        for (int i = 0; i < buffer.getNumChannels(); ++i)
            buffer.copyFrom (i, 0, currentAudioOutputBuffer, i, 0, numSamples);"""
P9_NEW = """            {   // SCORCH D2 DIAGNOSTIC PATCH — perform op count (first 4)
                static int d2fin = 0;
                if (d2fin++ < 4)
                    scorchD2Log (std::string ("[host-core] DIAG d2 perform renderOps=") + std::to_string (renderOps.size())
                                 + " numSamples=" + std::to_string (numSamples)
                                 + " outCh=" + std::to_string (buffer.getNumChannels()));
            }
            for (const auto& op : renderOps)
                op->process (context);
        }

        for (int i = 0; i < buffer.getNumChannels(); ++i)
            buffer.copyFrom (i, 0, currentAudioOutputBuffer, i, 0, numSamples);"""

# ── patch 10: NodeOp::process — the plugin op's execution proof (first 8) ──
P10_ANCHOR = """        void process (const Context& c) final
        {
            processor.setPlayHead (c.audioPlayHead);"""
P10_NEW = """        void process (const Context& c) final
        {
            {   // SCORCH D2 DIAGNOSTIC PATCH — node op execution proof (first 8)
                static int d2nn = 0;
                if (d2nn++ < 8)
                    scorchD2Log (std::string ("[host-core] DIAG d2 nodeOp uid=") + std::to_string (node->nodeID.uid)
                                 + " suspended=" + (processor.isSuspended() ? "1" : "0")
                                 + " chans=" + std::to_string (audioChannels.size()));
            }
            processor.setPlayHead (c.audioPlayHead);"""
P10_NEW_ANCHOR_END = None

# ── patch 11: ProcessOp::callProcess(float) — the dispatch into the plugin ──
P11_ANCHOR = """        void callProcess (bool bypass, AudioBuffer<float>& buffer, MidiBuffer& midi)
        {
            if (this->processor.isUsingDoublePrecision())
            {"""
P11_NEW = """        void callProcess (bool bypass, AudioBuffer<float>& buffer, MidiBuffer& midi)
        {
            {   // SCORCH D2 DIAGNOSTIC PATCH — callProcess(float) entry (first 8)
                static int d2cn = 0;
                if (d2cn++ < 8)
                    scorchD2Log (std::string ("[host-core] DIAG d2 callProcess uid=") + std::to_string (this->node->nodeID.uid)
                                 + " bypass=" + (bypass ? "1" : "0")
                                 + " usingDbl=" + (this->processor.isUsingDoublePrecision() ? "1" : "0")
                                 + " name=" + this->processor.getName().toStdString());
            }
            if (this->processor.isUsingDoublePrecision())
            {"""

# ── patch 12: processImpl — the final hop before AudioProcessor::processBlock ──
P12_ANCHOR = """        template <typename Value>
        static void processImpl (bool bypass, AudioProcessor& p, AudioBuffer<Value>& audio, MidiBuffer& midi)
        {
            if (bypass)
                p.processBlockBypassed (audio, midi);
            else
                p.processBlock (audio, midi);
        }"""
P12_NEW = """        template <typename Value>
        static void processImpl (bool bypass, AudioProcessor& p, AudioBuffer<Value>& audio, MidiBuffer& midi)
        {
            {   // SCORCH D2 DIAGNOSTIC PATCH — processImpl hop (first 8)
                static int d2in = 0;
                if (d2in++ < 8)
                    scorchD2Log (std::string ("[host-core] DIAG d2 processImpl name=") + p.getName().toStdString()
                                 + " bypass=" + (bypass ? "1" : "0")
                                 + " -> " + (bypass ? "processBlockBypassed" : "processBlock"));
            }
            if (bypass)
                p.processBlockBypassed (audio, midi);
            else
                p.processBlock (audio, midi);
        }"""

PATCHES = [
    ("helper", P1_ANCHOR, P1_NEW),
    ("set()", P2_ANCHOR, P2_NEW),
    ("updateAudioThreadState", P3_ANCHOR, P3_NEW),
    ("handleAsyncUpdate", P4_ANCHOR, P4_NEW),
    ("Pimpl::processBlock", P5_ANCHOR, P5_NEW),
    ("RenderSequence::process", P6_ANCHOR, P6_NEW),
    ("builder::build", P7_ANCHOR, P7_NEW),
    ("addProcessOp", P8_ANCHOR, P8_NEW),
    ("perform", P9_ANCHOR, P9_NEW),
    ("NodeOp::process", P10_ANCHOR, P10_NEW),
    ("callProcess", P11_ANCHOR, P11_NEW),
    ("processImpl", P12_ANCHOR, P12_NEW),
]

# ═══ VST3 wrapper file (juce_VST3PluginFormat.cpp) — the isActive gate + lifecycle ═══
TARGET2 = ("/home/z/my-project/scorsh/engine/build/_deps/juce-src/modules/"
           "juce_audio_processors/format_types/juce_VST3PluginFormat.cpp")

# The VST3 file is a separate TU — it needs its own (duplicated) helper.
VST3_HELPER = r"""
//==============================================================================
// ── SCORCH D2 DIAGNOSTIC PATCH (temporary; applied by scripts/m1_d2_patch_juce.py) ──
static void scorchD2Log (const std::string& line)
{
    static const bool d2Enabled = std::getenv ("SCORCH_D2") != nullptr;
    if (! d2Enabled) return;
    if (const char* d2Home = std::getenv ("HOME"))
    {
        const std::string d2Path = std::string (d2Home) + "/.config/scorch/engine.log";
        if (FILE* d2f = std::fopen (d2Path.c_str(), "a"))
        {
            std::fprintf (d2f, "[d2] %s\n", line.c_str());
            std::fclose (d2f);
        }
    }
}
// ── end SCORCH D2 DIAGNOSTIC PATCH ──
"""

V1_ANCHOR = """    void processBlock (AudioBuffer<float>& buffer, MidiBuffer& midiMessages) override
    {
        jassert (! isUsingDoublePrecision());

        const SpinLock::ScopedLockType processLock (processMutex);

        if (isActive && processor != nullptr)
            processAudio (buffer, midiMessages, Vst::kSample32, false);
    }"""
V1_NEW = """    void processBlock (AudioBuffer<float>& buffer, MidiBuffer& midiMessages) override
    {
        jassert (! isUsingDoublePrecision());

        const SpinLock::ScopedLockType processLock (processMutex);

        {   // SCORCH D2 DIAGNOSTIC PATCH — VST3 processBlock gate (first 8)
            static int d2vn = 0;
            if (d2vn++ < 8)
                scorchD2Log (std::string ("[host-core] DIAG d2 vst3 pblk entry isActive=")
                             + (isActive ? "1" : "0")
                             + " procNull=" + (processor == nullptr ? "1" : "0")
                             + " -> " + ((isActive && processor != nullptr) ? "processAudio" : "SILENT-SKIP"));
        }
        if (isActive && processor != nullptr)
            processAudio (buffer, midiMessages, Vst::kSample32, false);
    }"""

V2_ANCHOR = """        // Avoid redundantly calling things like setActive, which can be a heavy-duty call for some plugins:
        if (isActive
              && approximatelyEqual (getSampleRate(), newSampleRate)
              && getBlockSize() == estimatedSamplesPerBlock)
            return;"""
V2_NEW = """        // Avoid redundantly calling things like setActive, which can be a heavy-duty call for some plugins:
        {   // SCORCH D2 DIAGNOSTIC PATCH — VST3 prepareToPlay entry (first 12)
            static int d2pn2 = 0;
            if (d2pn2++ < 12)
                scorchD2Log (std::string ("[host-core] DIAG d2 vst3 prepareToPlay sr=")
                             + std::to_string (newSampleRate) + " blk=" + std::to_string (estimatedSamplesPerBlock)
                             + " wasActive=" + (isActive ? "1" : "0")
                             + " sameCfg=" + ((isActive && approximatelyEqual (getSampleRate(), newSampleRate)
                                               && getBlockSize() == estimatedSamplesPerBlock) ? "1" : "0"));
        }
        if (isActive
              && approximatelyEqual (getSampleRate(), newSampleRate)
              && getBlockSize() == estimatedSamplesPerBlock)
            return;"""

V3_ANCHOR = """    void deactivate()
    {
        if (! isActive)
            return;

        isActive = false;"""
V3_NEW = """    void deactivate()
    {
        if (! isActive)
            return;

        isActive = false;
        scorchD2Log (std::string ("[host-core] DIAG d2 vst3 DEACTIVATED (isActive 1->0)"));"""

VST3_PATCHES = [
    ("vst3 pblk gate", V1_ANCHOR, V1_NEW),
    ("vst3 prepareToPlay", V2_ANCHOR, V2_NEW),
    ("vst3 deactivate", V3_ANCHOR, V3_NEW),
]

# ═══ Plugin-side VST3 wrapper (the FIXTURE's TU) — the last gates before the
#     fixture's processBlock: precision mismatch, zero-flush, bypass, suspend ═══
TARGET3 = ("/home/z/my-project/scorsh/engine/build/_deps/juce-src/modules/"
           "juce_audio_plugin_client/juce_audio_plugin_client_VST3.cpp")

# Separate TU — needs its own helper (marker-gated, same engine.log medium).
CLIENT_HELPER = r"""
//==============================================================================
// ── SCORCH D2 DIAGNOSTIC PATCH (temporary; applied by scripts/m1_d2_patch_juce.py) ──
static void scorchD2Log (const std::string& line)
{
    static const bool d2Enabled = std::getenv ("SCORCH_D2") != nullptr;
    if (! d2Enabled) return;
    if (const char* d2Home = std::getenv ("HOME"))
    {
        const std::string d2Path = std::string (d2Home) + "/.config/scorch/engine.log";
        if (FILE* d2f = std::fopen (d2Path.c_str(), "a"))
        {
            std::fprintf (d2f, "[d2] %s\n", line.c_str());
            std::fclose (d2f);
        }
    }
}
// ── end SCORCH D2 DIAGNOSTIC PATCH ──
"""

W1_ANCHOR = """        if (pluginInstance == nullptr)
            return kResultFalse;

        if ((processSetup.symbolicSampleSize == Vst::kSample64) != pluginInstance->isUsingDoublePrecision())
            return kResultFalse;"""
W1_NEW = """        if (pluginInstance == nullptr)
            return kResultFalse;

        {   // SCORCH D2 DIAGNOSTIC PATCH — plugin-side process entry (first 8)
            static int d2wn = 0;
            if (d2wn++ < 8)
                scorchD2Log (std::string ("[host-core] DIAG d2 client process entry numSamples=")
                             + std::to_string ((int) data.numSamples)
                             + " numIn=" + std::to_string ((int) data.numInputs)
                             + " numOut=" + std::to_string ((int) data.numOutputs)
                             + " ss=" + std::to_string ((int) processSetup.symbolicSampleSize)
                             + " usingDbl=" + (pluginInstance->isUsingDoublePrecision() ? "1" : "0"));
        }
        if ((processSetup.symbolicSampleSize == Vst::kSample64) != pluginInstance->isUsingDoublePrecision())
        {
            // SCORCH D2 DIAGNOSTIC PATCH — precision mismatch early-out
            scorchD2Log (std::string ("[host-core] DIAG d2 client process PRECISION-MISMATCH -> kResultFalse (silent)"));
            return kResultFalse;
        }"""

W2_ANCHOR = """            if (pluginInstance->isSuspended())
            {
                buffer.clear();
            }
            else
            {
                // processBlockBypassed should only ever be called if the AudioProcessor doesn't
                // return a valid parameter from getBypassParameter
                if (pluginInstance->getBypassParameter() == nullptr && comPluginInstance->getBypassParameter()->getValue() >= 0.5f)
                    pluginInstance->processBlockBypassed (buffer, midiBuffer);
                else
                    pluginInstance->processBlock (buffer, midiBuffer);
            }"""
W2_NEW = """            if (pluginInstance->isSuspended())
            {
                // SCORCH D2 DIAGNOSTIC PATCH — plugin suspended
                scorchD2Log (std::string ("[host-core] DIAG d2 client process SUSPENDED -> buffer.clear"));
                buffer.clear();
            }
            else
            {
                // processBlockBypassed should only ever be called if the AudioProcessor doesn't
                // return a valid parameter from getBypassParameter
                {   // SCORCH D2 DIAGNOSTIC PATCH — the bypass/suspend verdict (first 8)
                    static int d2wn2 = 0;
                    if (d2wn2++ < 8)
                        scorchD2Log (std::string ("[host-core] DIAG d2 client verdict pluginBypassParam=")
                                     + (pluginInstance->getBypassParameter() == nullptr ? "null" : "set")
                                     + " wrapperBypassVal=" + std::to_string (comPluginInstance->getBypassParameter()->getValue())
                                     + " -> " + ((pluginInstance->getBypassParameter() == nullptr
                                                  && comPluginInstance->getBypassParameter()->getValue() >= 0.5f)
                                                     ? "processBlockBypassed (SILENT for this plugin)"
                                                     : "processBlock"));
                }
                if (pluginInstance->getBypassParameter() == nullptr && comPluginInstance->getBypassParameter()->getValue() >= 0.5f)
                    pluginInstance->processBlockBypassed (buffer, midiBuffer);
                else
                    pluginInstance->processBlock (buffer, midiBuffer);
            }"""

CLIENT_PATCHES = [
    ("client process entry", W1_ANCHOR, W1_NEW),
    ("client bypass verdict", W2_ANCHOR, W2_NEW),
]

CLIENT_HELPER_ANCHOR = "namespace juce\n{\n\nJUCE_BEGIN_IGNORE_WARNINGS_MSVC (4310)"

VST3_HELPER_ANCHOR = "namespace juce\n{\n\n"


def patch_file(path, patches, helper_anchor=None, helper_text=None):
    with open(path, "r", encoding="utf-8") as f:
        src = f.read()

    if MARKER in src:
        print("D2 patch already present in", path, "— nothing to do")
        return 0

    backup = path + ".pre-d2"
    if not os.path.exists(backup):
        with open(backup, "w", encoding="utf-8") as f:
            f.write(src)
        print("backup written:", backup)

    out = src
    if helper_anchor is not None and helper_text is not None:
        if out.count(helper_anchor) != 1:
            print(f"HELPER ANCHOR FAILED in {path}: found {out.count(helper_anchor)} occurrences", file=sys.stderr)
            return 1
        out = out.replace(helper_anchor, helper_anchor + helper_text)
        print(f"patched: vst3-helper")

    for name, anchor, new in patches:
        if out.count(anchor) != 1:
            print(f"ANCHOR FAILED ({name}) in {path}: found {out.count(anchor)} occurrences", file=sys.stderr)
            return 1
        out = out.replace(anchor, new)
        print(f"patched: {name}")

    with open(path, "w", encoding="utf-8") as f:
        f.write(out)
    print("D2 patch applied:", path)
    return 0


def main_unused():
    pass


if __name__ == "__main__":
    rc = patch_file(TARGET, PATCHES)
    if rc == 0:
        # Same TU as the graph file (module single-TU build, include order:
        # juce_AudioProcessorGraph.cpp @210 < juce_VST3PluginFormat.cpp @216) —
        # the graph-file helper is already visible here; no second helper.
        rc = patch_file(TARGET2, VST3_PATCHES)
    if rc == 0:
        # The FIXTURE's own TU — separate compilation unit, needs its own helper.
        rc = patch_file(TARGET3, CLIENT_PATCHES, helper_anchor=CLIENT_HELPER_ANCHOR,
                        helper_text=CLIENT_HELPER)
    sys.exit(rc)
