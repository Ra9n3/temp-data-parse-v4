// ─── Milestone 1: vendored AudioPluginHost core ─────────────────────────────
// The minimal core of JUCE 8's extras/AudioPluginHost, ported into the engine:
// the graph/filter model, the plugin node ownership, the editor creation
// discipline, and the state save/restore call ordering. The vendor files this
// ports are (JUCE 8.0.4, the exact version the engine FetchContent-pins):
//
//   extras/AudioPluginHost/Source/Plugins/PluginGraph.{h,cpp}
//       - AudioProcessorGraph ownership: plugins live as graph NODES; the
//         graph owns the AudioPluginInstance from addNode() on; nodes are
//         added/removed on the message thread (the Nodes table is an
//         unlocked ReferenceCountedArray — ALL topology mutation and reads
//         are serialized onto the message thread, exactly like the host does
//         via its async creation callback).
//       - the creation order: create (AudioPluginFormatManager) → buses
//         settled → addNode → connections.
//       - the restore order: create → bus layout → addNode → setState.
//         (The engine keeps its own documented instantiate → state →
//         prepare → commit order, which lands on the same states — see
//         docs/ASSUMPTIONS.md "Milestone 1".)
//   extras/AudioPluginHost/Source/UI/PluginWindow.h
//       - the editor lifetime discipline: createEditorIfNeeded() (never a
//         bare createEditor — the vendor's one-editor-per-processor rule),
//         setContentOwned(editor, true), destructor clearContentComponent().
//   juce::AudioProcessorGraph itself (the maintained plumbing):
//       - RenderSequenceExchange: the audio thread reads the render sequence
//         through a lock-free try-lock swap; a topology rebuild swaps a new
//         sequence in and the OLD sequence (with the OLD plugin instances it
//         still references) is freed up to 500 ms later on the message
//         thread. The audio thread NEVER deletes, NEVER blocks. This is the
//         vendor's proven replacement for the engine's hand-rolled
//         retire-list + grace timer + audio-proof janitor: the same
//         guarantee (a retired instance is freed only after the audio thread
//         provably stopped touching it), implemented once by JUCE and
//         maintained by the framework.
//       - nodes that acceptsMidi() receive the graph's incoming MidiBuffer
//         automatically (MidiInOp) — no MIDI connections needed; the engine's
//         score dispatch fills the buffer it passes to graph->processBlock.
//         (Milestone 2 revision: plugins are wired from their per-instance
//         InstanceMidiSelector instead — see that class; the shared MidiInOp
//         path would leak every instance's notes into every plugin.)
//
// What arrived with Milestone 2 (see docs/ASSUMPTIONS.md "Milestone 2"):
// multi-instance hosting (N plugin nodes in ONE graph, diff-based reuse) and
// per-instance MIDI routing via per-instance InstanceMidiSelector nodes (see
// that class). Still deliberately deferred: per-bus output routing (aux buses
// stay unconnected — only the main stereo bus drives the master) and the
// output gain/safety stage (M2 ships the TEMPORARY output guard instead:
// unity gain + clip counter + per-render peak receipts).
//
// Licence: these ports carry the SAME JUCE 8 dual licence (AGPLv3 / JUCE 8
// commercial) as the framework the engine already FetchContent-builds — the
// AudioPluginHost sources live in the same repository under the same
// LICENSE.md and per-file headers. No new licence surface.
//
// Receipt/logging culture: the core is receipt-FREE by design — every
// vendor step's receipt is emitted by main.cpp around the calls, keeping the
// engine.log discipline (every phase named) in one place. Structured results
// come back as return values.

#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <atomic>
#include <memory>

namespace scorchhost {

// ─── Milestone 2: the instance count (moved here — host-core level config) ──
// Each hosted plugin owns a private 16-channel MIDI namespace indexed by its
// slot (main.cpp keeps the wide-channel fabric: wide = slot*16 + ch). Eight
// slots: the graph model itself has no such cap, but the per-slot audio
// structures (MidiBuffers, held-note ledger, latency mirrors) are fixed
// arrays — a compile-time constant keeps them lock-free.
constexpr int kMaxInstances = 8;

// The per-slot MIDI buffers the audio callback fills, read by the selectors.
// Defined in main.cpp (the callback owns the buffers); the pointers are
// STABLE for the process (members of the namespace-level callback object),
// so main() fills this table ONCE at startup and nothing ever clears it.
// The selector reads its slot's pointer inside graph->processBlock — the
// same audio thread that just filled the buffer (the hand-off ordering is
// the callback's own sequencing: fill → processBlock). Atomic only for
// definition clarity, not for cross-thread publication.
extern std::atomic<juce::MidiBuffer*> g_selectorMidiSource[kMaxInstances];
// Milestone 2 DIAGNOSTIC: per-selector emission counters (events copied out
// per slot). Audio-thread incremented (relaxed), worker-reported — the
// per-slot MIDI hand-off truth without any audio-thread logging.
extern std::atomic<uint64_t> g_selectorEmitCount[kMaxInstances];
// Per-selector last-emitted note pitch (-1 = none yet) — worker-reported.
extern std::atomic<int> g_selectorLastD1[kMaxInstances];
// Per-selector PROCESS-BLOCK count — "ran but empty" vs "never ran".
extern std::atomic<uint64_t> g_selectorBlockCount[kMaxInstances];

// ─── Milestone 2: the per-instance MIDI selector node ────────────────────
// THE MECHANISM CHOICE (documented + limited in ASSUMPTIONS.md "Milestone 2"):
// per-node selector/merge nodes, NOT channel assignment on the graph's
// single incoming buffer. Why: the graph's processBlock takes ONE MidiBuffer
// and distributes it through the midiInputNode's MidiInOp to every connected
// node — two instances legally share real channel numbers (each owns a
// private 1..16 namespace), and one shared buffer cannot represent that.
// The selector is engine-owned glue (NOT vendored core): a tiny bus-less
// AudioProcessor placed between the graph and each plugin node. Its
// processBlock copies its slot's per-instance buffer (filled by the engine's
// dispatch walk — the wide-channel fabric, ledger, articulation state and
// mute-flush machinery are UNCHANGED) into its output MIDI buffer, which the
// vendor's render sequence delivers down the selector→plugin MIDI connection
// (a node's output MIDI buffer is published only when producesMidi() is
// true — verified in the pinned juce_AudioProcessorGraph.cpp). The graph's
// incoming buffer stays EMPTY and the midiInputNode is created (vendor IO
// shape) but stays UNWIRED to plugins — wiring both would MERGE the shared
// buffer into every plugin (the cross-instance leak the selectors replace).
class InstanceMidiSelector final : public juce::AudioProcessor
{
public:
    explicit InstanceMidiSelector (int slotArg) : slot (slotArg) {}

    // The vendor's render sequence hands each node its working MIDI buffer
    // (in/out semantics); we overwrite it with our slot's dispatched events.
    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer& midi) override
    {
        g_selectorBlockCount[slot].fetch_add (1, std::memory_order_relaxed);
        midi.clear();
        if (auto* src = g_selectorMidiSource[slot].load (std::memory_order_acquire))
        {
            midi.addEvents (*src, 0, -1, 0);
            g_selectorEmitCount[slot].fetch_add ((uint64_t) src->getNumEvents(),
                                                 std::memory_order_relaxed);
            if (src->getNumEvents() > 0)
                g_selectorLastD1[slot].store (-2, std::memory_order_relaxed);   // "emitted something"
        }
    }

    // Bus-less: no audio in or out (the vendor's builder assigns no audio
    // buffers for such nodes and applySettings never negotiates layouts —
    // it only calls setRateAndBufferSizeDetails + prepareToPlay).
    const juce::String getName() const override
    { return "Scorch Instance MIDI Selector " + juce::String (slot); }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }   // REQUIRED: publishes our buffer downstream
    bool isMidiEffect() const override { return false; }
    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "Default"; }
    void changeProgramName (int, const juce::String&) override {}
    double getTailLengthSeconds() const override { return 0.0; }
    void prepareToPlay (double, int) override {}
    void releaseResources() override {}
    // Pure in JUCE 8's AudioProcessor — a stateless glue node has nothing to
    // serialize (and nothing ever calls it: the engine's capture/restore
    // paths only ever touch AudioPluginInstances).
    void getStateInformation (juce::MemoryBlock&) override {}
    void setStateInformation (const void*, int) override {}
    bool isBusesLayoutSupported (const BusesLayout&) const override { return false; }   // no audio layout, ever
    juce::AudioProcessorEditor* createEditor() override { return nullptr; }
    bool hasEditor() const override { return false; }

    const int slot;
};

// The multi-instance host graph (Milestone 2): N plugin nodes live in the
// graph at once, each behind its own selector. The graph object is created
// once on first use and lives until process exit (the engine's established
// leak-at-exit policy for audio-owned objects — the audio callback may hold
// the raw pointer in its last buffer). Node identity per instance is carried
// by the meta (HostedPlugin::nodeID); HostCore itself stays stateless about
// WHICH instances are live — the published InstanceSet (main.cpp) is the
// audio-thread truth, the graph's node table is the message-thread truth.
class HostCore final
{
public:
    HostCore() = default;
    ~HostCore() = default;

    HostCore (const HostCore&) = delete;
    HostCore& operator= (const HostCore&) = delete;

    //======================================================================
    // Audio thread: one relaxed acquire of the raw graph pointer. Null until
    // the first commit created the graph on the message thread; never
    // nullified afterwards (process exit reclaims).
    juce::AudioProcessorGraph* graph() const
    {
        return graphRaw.load (std::memory_order_acquire);
    }

    // Audio thread / any thread: is ANY plugin node currently live? One
    // relaxed counter, incremented at the END of each commit job and
    // decremented at the START of each retire job — the legacy single-flag
    // gate generalized to N (the per-instance gating uses the published
    // InstanceSet's per-slot rawInstance pointers; this counter only answers
    // "is there anything at all").
    bool live() const { return liveCount_.load (std::memory_order_acquire) > 0; }

    // Message thread: how many plugin nodes are live (receipts/diagnostics).
    int liveCount() const { return liveCount_.load (std::memory_order_acquire); }

    //======================================================================
    // ── Message-thread operations (call ONLY on the message thread) ──

    // Create the graph + the master output IO node + the MIDI input IO node,
    // idempotently, prepared at the engine's nominal config (44100/512 —
    // audioDeviceAboutToStart reconfigures for the real device, same as the
    // pre-graph engine).
    //
    // ── The MIDI input node (Milestone 1 silence root cause, fixed) ──
    // JUCE 8.0.4's AudioProcessorGraph distributes the graph's INCOMING
    // MidiBuffer to nodes ONLY through a MidiInOp, and the builder emits a
    // MidiInOp ONLY for a midiInputNode IO processor; every other node gets
    // whatever its MIDI CONNECTIONS feed it (a node with no MIDI connections
    // gets a freshly CLEARED buffer — RenderSequenceBuilder::
    // findBufferForInputMidiChannel). The stock AudioPluginHost exposes the
    // IO processors as internal plugins the user wires in the UI; this
    // headless port wires the equivalent programmatically: one midiInputNode
    // at graph creation, connected to each hosted plugin that acceptsMidi()
    // (see addPluginNode). Without it the hosted instrument receives no
    // notes at all — the silence defect, diagnosed 2026-10-18 via the D1
    // MM-forced probe + the D2 fetched-source branch receipts.
    void ensureGraph()
    {
        if (graphOwned != nullptr)
            return;

        graphOwned = std::make_unique<juce::AudioProcessorGraph>();
        // 0-in / 2-out, nominal until the real device starts. The IO output
        // node's channel count tracks the graph via setParentGraph (called
        // by addNode below).
        graphOwned->setPlayConfigDetails (0, 2, 44100.0, 512);
        graphOwned->prepareToPlay (44100.0, 512);

        outputNode = graphOwned->addNode (
            std::make_unique<juce::AudioProcessorGraph::AudioGraphIOProcessor> (
                juce::AudioProcessorGraph::AudioGraphIOProcessor::audioOutputNode));

        midiInputNode = graphOwned->addNode (
            std::make_unique<juce::AudioProcessorGraph::AudioGraphIOProcessor> (
                juce::AudioProcessorGraph::AudioGraphIOProcessor::midiInputNode));

        // Publish the raw pointer for the audio thread. Never published
        // again, never cleared (leak-at-exit policy).
        graphRaw.store (graphOwned.get(), std::memory_order_release);
    }

    // Message thread: hand the graph its playhead. The graph forwards
    // getPlayHead() to EVERY node at EVERY processBlock (NodeOp::process
    // calls processor.setPlayHead with the graph's playhead), overwriting
    // any per-node setPlayHead — so the per-instance hand-off alone is not
    // enough once a processor lives in the graph. Called at commit (before
    // the device starts) and re-asserted in reconfigureForDevice. The
    // engine's playhead address is stable for the process (Stage 3e-2), so
    // one store is final.
    void setPlayhead (juce::AudioPlayHead* playHead)
    {
        if (graphOwned != nullptr)
            graphOwned->setPlayHead (playHead);
    }

    // Add a plugin node for ONE instance (the vendor's addPluginCallback
    // shape, plus the M2 selector bridge): the instance arrives with its
    // buses already settled by the engine's receipted negotiation
    // (setPlayConfigDetails 0-in/2-out + enable-all-output-buses). Wiring:
    //   selector(slot) → plugin (MIDI — the per-instance routed events),
    //   plugin main bus → master stereo (L←ch0, R←ch1; a mono main bus is
    //   duplicated to both). Aux buses stay UNCONNECTED — per-bus routing is
    //   the deferred feature. Returns the plugin node (nullptr if the graph
    //   refused — no output node / duplicate processor). On success the node
    //   is IN the table and the graph's inline rebuild has prepared it at the
    //   graph's current settings (addNode defaults to UpdateKind::sync on the
    //   message thread → latency is already real). liveCount_++ at the end.
    juce::AudioProcessorGraph::Node::Ptr addPluginNode (
        std::unique_ptr<juce::AudioPluginInstance> instance, int slot,
        juce::AudioProcessorGraph::NodeID* selectorIDOut = nullptr)
    {
        ensureGraph();

        if (instance == nullptr || outputNode == nullptr)
            return nullptr;

        // The selector is created FIRST so its node exists for the MIDI
        // wiring; a bus-less processor (no audio channels, producesMidi).
        auto selectorNode = graphOwned->addNode (
            std::make_unique<InstanceMidiSelector> (slot));
        if (selectorNode == nullptr)
            return nullptr;
        if (selectorIDOut != nullptr) *selectorIDOut = selectorNode->nodeID;

        auto node = graphOwned->addNode (std::move (instance));
        if (node == nullptr)
            return nullptr;

        // Main bus → master stereo wiring (the vendor connects channels the
        // same way; the fold rules for aux buses are the deferred feature).
        const int outs = node->getProcessor() != nullptr
            ? node->getProcessor()->getMainBusNumOutputChannels() : 0;
        if (outs > 0)
        {
            graphOwned->addConnection ({ { node->nodeID, 0 }, { outputNode->nodeID, 0 } });
            graphOwned->addConnection ({ { node->nodeID, outs == 1 ? 0 : 1 },
                                         { outputNode->nodeID, 1 } });
        }

        // Selector → plugin (the M2 MIDI path — see InstanceMidiSelector).
        // Wired only for midi-accepting processors (an effect with no MIDI
        // input gets no selector feed; its audio path is unaffected).
        if (node->getProcessor() != nullptr
            && node->getProcessor()->acceptsMidi())
        {
            graphOwned->addConnection (
                { { selectorNode->nodeID, juce::AudioProcessorGraph::midiChannelIndex },
                  { node->nodeID,         juce::AudioProcessorGraph::midiChannelIndex } });
        }

        liveCount_.fetch_add (1, std::memory_order_acq_rel);
        return node;
    }

    // Remove ONE plugin node (M2 diff semantics — survivors untouched). The
    // vendor path: removeNode disconnects its connections (the selector feed
    // + the audio out), drops both nodes from the table and (message thread,
    // sync) rebuilds — the new render sequence excludes the plugin, and the
    // OLD sequence (still holding the instance) is freed by the vendor's
    // exchange timer up to 500 ms later. The returned Ptr keeps the node (and
    // its processor) alive for the caller's post-remove needs; drop it to let
    // the vendor schedule destruction. liveCount_-- BEFORE the removal (the
    // per-instance gating reads the published InstanceSet, not this counter —
    // the counter only answers "anything at all").
    juce::AudioProcessorGraph::Node::Ptr removeNodeByID (
        juce::AudioProcessorGraph::NodeID nodeID)
    {
        if (graphOwned == nullptr || nodeID.uid == 0)
            return nullptr;
        liveCount_.fetch_sub (1, std::memory_order_acq_rel);
        return graphOwned->removeNode (nodeID);
    }

    // Reconfigure the graph (and every non-IO node) for the REAL device:
    // the pre-graph engine's audioDeviceAboutToStart contract, walked
    // through the vendor's node table. Playhead re-asserted, bus layout
    // re-negotiated (0-in/2-out) + output buses re-enabled (the negotiation
    // disables non-main buses — the engine's own ordering), then the graph's
    // prepareToPlay re-prepares every node at the device settings (sync —
    // this runs on the message thread). The vendor's settings guard keeps
    // the audio thread honest in between: a buffer rendered while the
    // requested settings differ from the built sequence outputs silence
    // rather than a wrong-config render.
    void reconfigureForDevice (double sampleRate, int bufferSize,
                               juce::AudioPlayHead* playHead)
    {
        if (graphOwned == nullptr)
            return;

        for (auto* n : graphOwned->getNodes())
        {
            // .get(): a raw Node* vs a Node::Ptr == is ambiguous on MSVC
            // (C2666 — JUCE's templated operator== vs the built-in pointer
            // ==); the explicit raw-pointer comparison compiles everywhere.
            if (n == outputNode.get() || n == midiInputNode.get() || n->getProcessor() == nullptr)
                continue;

            auto* p = n->getProcessor();
            // Milestone 2: SKIP bus-less glue nodes (the InstanceMidiSelector
            // — no audio buses to negotiate; its layout support is "none" by
            // design and a setPlayConfigDetails attempt would fail noisily).
            // The playhead re-assert still applies (harmless, and the graph
            // forwards its own pointer every block regardless).
            if (p->getBusCount (false) == 0)
            {
                if (playHead != nullptr)
                    p->setPlayHead (playHead);
                continue;
            }

            if (playHead != nullptr)
                p->setPlayHead (playHead);
            p->setPlayConfigDetails (0, 2, sampleRate, bufferSize);
            for (int b = 0; b < p->getBusCount (false); ++b)
                if (auto* bus = p->getBus (false, b))
                    bus->enable (true);
        }

        // The graph forwards ITS playhead to every node at every block
        // (NodeOp::process) — the graph-level pointer is the one that
        // survives (see setPlayhead).
        graphOwned->setPlayHead (playHead);

        graphOwned->prepareToPlay (sampleRate, bufferSize);
    }

    // Message thread: the output (master IO) node's id — diagnostics/queries
    // (e.g. isConnected(pluginNodeID, outputNodeID()) on the message thread).
    juce::AudioProcessorGraph::NodeID outputNodeID() const
    {
        return outputNode != nullptr ? outputNode->nodeID
                                     : juce::AudioProcessorGraph::NodeID{};
    }

    // Message thread: the MIDI input IO node's id — receipts/queries. NOTE
    // (Milestone 2): the node EXISTS (vendor IO shape) but is deliberately
    // UNWIRED to plugins — the per-instance selectors are the MIDI path; the
    // shared MidiInOp would merge every instance's notes into every plugin.
    juce::AudioProcessorGraph::NodeID midiInputNodeID() const
    {
        return midiInputNode != nullptr ? midiInputNode->nodeID
                                        : juce::AudioProcessorGraph::NodeID{};
    }

    // The graph's current prepared settings (receipts / AboutToStart logging).
    double sampleRate() const
    {
        return graphOwned != nullptr ? graphOwned->getSampleRate() : 44100.0;
    }
    int blockSize() const
    {
        return graphOwned != nullptr ? graphOwned->getBlockSize() : 512;
    }

private:
    std::unique_ptr<juce::AudioProcessorGraph> graphOwned;   // message thread only
    std::atomic<juce::AudioProcessorGraph*> graphRaw { nullptr };
    juce::AudioProcessorGraph::Node::Ptr outputNode;         // message thread only
    juce::AudioProcessorGraph::Node::Ptr midiInputNode;      // message thread only
    std::atomic<int> liveCount_ { 0 };                       // any-thread: N live plugin nodes
};

} // namespace scorchhost
