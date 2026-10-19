# Scorch Test Synth — free stand-in VST3 host target (Stage 3c).
# CI cannot host commercial libraries (BBCSO), so the hosting path is proven
# against this plugin. Built as part of the engine CMake project so it shares
# the JUCE FetchContent (and the CI cache keyed on engine/CMakeLists.txt).
#
# Fixtures (built in CI, never committed as binaries):
#   * scorch-test-synth.vst3          → the valid host target (scan + hosting)
#   * scorch-test-synth-b.vst3        → Milestone 2: the SAME source under a
#                                       DIFFERENT scan identity (name/uid) —
#                                       the diff-replace counterpart (a
#                                       "changed" instance must swap a REAL
#                                       binary, not a phantom)
#   * scorch-test-synth-m.vst3        → M3 PR2: the MONO-OUTPUT identity (main
#                                       bus only, 2-out) — the R3 layout-guard
#                                       fixture: a strip wired for [2,3] exceeds
#                                       its genuinely narrower live node
#   * CrashDummy.vst3                 → crashvst.c compiled to a real module
#                                       that aborts in GetPluginFactory
#   * CorruptDummy.vst3               → garbage bytes (graceful load failure)

juce_add_plugin(scorch-test-synth
    COMPANY_NAME "Scorch Audio"
    PLUGIN_MANUFACTURER_CODE Scrc
    PLUGIN_CODE ScTs
    FORMATS VST3
    PRODUCT_NAME "Scorch Test Synth"
    NAME "Scorch Test Synth"
    DESCRIPTION "Scorch CI stand-in host target (deterministic sine synth)"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Instrument Synth
)

target_sources(scorch-test-synth PRIVATE
    ScorchTestSynth.cpp
)

target_compile_definitions(scorch-test-synth PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
)

target_link_libraries(scorch-test-synth
    PRIVATE
        juce_audio_utils
        juce_audio_processors
        juce_audio_devices
        juce_audio_basics
        juce_core
    PUBLIC
        juce_audio_processors
)

# Milestone 2 — the SECOND identity of the SAME source: a different plugin
# name (and therefore uid), so a diff "changed" entry swaps a real binary in
# CI. Everything else (voices, editor, state format, knobs) is identical.
juce_add_plugin(scorch-test-synth-b
    COMPANY_NAME "Scorch Audio"
    PLUGIN_MANUFACTURER_CODE Scrc
    PLUGIN_CODE ScTb
    FORMATS VST3
    PRODUCT_NAME "Scorch Test Synth B"
    NAME "Scorch Test Synth B"
    DESCRIPTION "Scorch CI stand-in host target (diff-replace identity)"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Instrument Synth
)

target_sources(scorch-test-synth-b PRIVATE
    ScorchTestSynth.cpp
)

target_compile_definitions(scorch-test-synth-b PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    # CMake emits -DSCORCH_TESTVST_NAME="\"Scorch Test Synth B\"" (its own
    # escaping layer — the same shape as JucePlugin_Name): valid on MSVC and
    # GCC alike. (The earlier local "expected unqualified-id" was a macro
    # expanded inside a qualified name in the fixture source, not this def.)
    SCORCH_TESTVST_NAME="Scorch Test Synth B"
)

target_link_libraries(scorch-test-synth-b
    PRIVATE
        juce_audio_utils
        juce_audio_processors
        juce_audio_devices
        juce_audio_basics
        juce_core
    PUBLIC
        juce_audio_processors
)

# M3 PR2 — the MONO-OUTPUT identity of the SAME source: main bus only, so the
# live node is genuinely 2-out. The R3 layout-guard CI swaps a strip-wired
# instance to this identity (the M2 "changed" diff class via the different
# uid) and the engine's commit-time audit unwires the pair the narrower node
# can no longer feed. (A plugin-side layout REFUSAL cannot produce this: the
# JUCE VST3 wrapper acknowledges activateBus for any declared bus, so the
# host's enable-all always lands — a narrower DECLARED surface is the honest
# narrowed-output simulation. See the fixture header + ASSUMPTIONS.)
juce_add_plugin(scorch-test-synth-m
    COMPANY_NAME "Scorch Audio"
    PLUGIN_MANUFACTURER_CODE Scrc
    PLUGIN_CODE ScTm
    FORMATS VST3
    PRODUCT_NAME "Scorch Test Synth M"
    NAME "Scorch Test Synth M"
    DESCRIPTION "Scorch CI stand-in host target (mono-output R3 identity)"
    IS_SYNTH TRUE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    EDITOR_WANTS_KEYBOARD_FOCUS FALSE
    COPY_PLUGIN_AFTER_BUILD FALSE
    VST3_CATEGORIES Instrument Synth
)

target_sources(scorch-test-synth-m PRIVATE
    ScorchTestSynth.cpp
)

target_compile_definitions(scorch-test-synth-m PUBLIC
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    SCORCH_TESTVST_NAME="Scorch Test Synth M"
    SCORCH_TESTVST_AUX_DISABLED=1
)

target_link_libraries(scorch-test-synth-m
    PRIVATE
        juce_audio_utils
        juce_audio_processors
        juce_audio_devices
        juce_audio_basics
        juce_core
    PUBLIC
        juce_audio_processors
)
