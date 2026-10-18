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
//
// What is deliberately NOT ported (Milestone 1 deferrals — see the task and
// docs/ASSUMPTIONS.md): multi-instance routing (the graph model supports N
// nodes; the engine hosts exactly one in this milestone), per-bus output
// routing (aux buses stay unconnected — only the main stereo bus drives the
// master), the output gain/safety stage, and any new pre-roll work (the
// existing 3k pre-roll lives in the dispatch layer and is untouched).
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

// The single-plugin host graph. One instance lives in the graph at a time
// (Milestone 1); the graph object itself is created once on first use and
// lives until process exit (the engine's established leak-at-exit policy for
// audio-owned objects — the audio callback may hold the raw pointer in its
// last buffer).
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

    // Audio thread / any thread: is a plugin node currently live? Set true
    // at the END of the commit job (after addNode), false at the START of
    // the retire job (before the plugin is touched). The dispatch layer
    // gates plugin rendering and MIDI routing on this flag.
    bool live() const { return live_.load (std::memory_order_acquire); }

    // Message thread: the node id of the live plugin (valid only when live()).
    juce::AudioProcessorGraph::NodeID liveNodeID() const { return liveNodeID_; }

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

    // Add the plugin node (the vendor's addPluginCallback shape, minus the
    // demo UI): the instance arrives with its buses already settled by the
    // engine's receipted negotiation (setPlayConfigDetails 0-in/2-out +
    // enable-all-output-buses — the engine's own empirical ordering, kept).
    // Wiring: the plugin's main bus drives the master stereo (L←ch0, R←ch1;
    // a mono main bus is duplicated to both). Aux buses stay UNCONNECTED —
    // per-bus routing is a deferred milestone. Returns the node (nullptr if
    // the graph refused — no output node / duplicate processor).
    // On success the node is IN the table and the graph's inline rebuild has
    // prepared it at the graph's current settings (addNode defaults to
    // UpdateKind::sync on the message thread → latency is already real).
    juce::AudioProcessorGraph::Node::Ptr addPluginNode (
        std::unique_ptr<juce::AudioPluginInstance> instance)
    {
        ensureGraph();

        if (instance == nullptr || outputNode == nullptr)
            return nullptr;

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

        // MIDI input node → plugin (the vendor's MidiInOp path — see
        // ensureGraph). Without this connection the plugin's sequence MIDI
        // buffer is a fresh clear op and the instrument never receives a
        // note. Wired only for midi-accepting processors.
        if (midiInputNode != nullptr && node->getProcessor() != nullptr
            && node->getProcessor()->acceptsMidi())
        {
            graphOwned->addConnection (
                { { midiInputNode->nodeID, juce::AudioProcessorGraph::midiChannelIndex },
                  { node->nodeID,      juce::AudioProcessorGraph::midiChannelIndex } });
        }

        liveNodeID_ = node->nodeID;
        live_.store (true, std::memory_order_release);
        return node;
    }

    // Remove the live plugin node. live_ goes false FIRST (the dispatch
    // layer stops feeding MIDI from the next buffer on), then the vendor
    // path: removeNode disconnects its connections, drops it from the table
    // and (message thread, sync) rebuilds — the new render sequence excludes
    // the plugin, and the OLD sequence (still holding the instance) is freed
    // by the vendor's exchange timer up to 500 ms later. The returned Ptr
    // keeps the node (and its processor) alive for the caller's post-remove
    // needs; drop it to let the vendor schedule destruction.
    juce::AudioProcessorGraph::Node::Ptr removeLiveNode()
    {
        live_.store (false, std::memory_order_release);
        if (graphOwned == nullptr)
            return nullptr;

        auto node = graphOwned->getNodeForId (liveNodeID_);
        if (node == nullptr)
            return nullptr;

        auto removed = graphOwned->removeNode (liveNodeID_);
        liveNodeID_ = {};
        return removed;
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
    // (e.g. isConnected(liveNodeID(), outputNodeID()) on the message thread).
    juce::AudioProcessorGraph::NodeID outputNodeID() const
    {
        return outputNode != nullptr ? outputNode->nodeID
                                     : juce::AudioProcessorGraph::NodeID{};
    }

    // Message thread: the MIDI input IO node's id — receipts/queries.
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
    juce::AudioProcessorGraph::NodeID liveNodeID_ {};        // message thread only
    std::atomic<bool> live_ { false };
};

} // namespace scorchhost
