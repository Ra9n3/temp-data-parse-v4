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
