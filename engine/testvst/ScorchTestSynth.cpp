// Scorch Test Synth — plugin entry point (JUCE factory hook).
#include "ScorchTestSynth.h"

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter() {
    return new ScorchTestSynthProcessor();
}
