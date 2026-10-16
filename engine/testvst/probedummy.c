// ProbeDummy VST3 fixtures — Stage 3f-2 "scanner must not lose plugins".
//
// These plugins DESCRIBE successfully (findAllTypesForFile returns rows
// WITHOUT loading the binary — the bundle carries a valid
// Contents/Resources/moduleinfo.json, which JUCE's fast description path
// parses on every platform) but FAIL during PROBE, when the host actually
// loads the binary and calls GetPluginFactory:
//
//   ProbeCrashDummy — abort()s in GetPluginFactory: the --probe-worker child
//                     dies mid-probe; the row must SURVIVE in the list with
//                     a capabilitiesError (probe-crash isolation proof).
//   ProbeHangDummy  — sleeps forever in GetPluginFactory: the parent's 90 s
//                     probe timeout kills the child; the row must still be
//                     in the list (probe-timeout proof).
//
// Built in CI (cl /LD) and locally (gcc -shared) into real .vst3 bundle
// layouts alongside the moduleinfo.json. One source, two flavours, selected
// with -DPROBE_HANG=1; the CID constants differ so the two rows carry
// distinct classIds (a shared classId would be deduped away — 3f-2 keeps
// the first by path order). The CID hex strings live ONLY in each bundle's
// moduleinfo.json (the describe path's source of truth); they are echoed
// here as comments for traceability:
//   ProbeCrashDummy CID: 5C0C1A7B00004F0B9E1D2C3A4B5D6E7F
//   ProbeHangDummy  CID: 6F1F2B8C00004F0B9E1D2C3A4B5D6E8F

#ifndef PROBE_HANG
#define PROBE_HANG 0
#endif

#if defined(_WIN32)
#include <windows.h>
#else
#include <unistd.h>
#endif
#include <stdlib.h>

#if defined(_WIN32)
__declspec(dllexport) void* GetPluginFactory(void) {
#if PROBE_HANG
    for (;;) Sleep(1000);   /* the 90 s probe timeout is the only way out */
#else
    abort();                /* crash-isolation: the probe child dies HERE */
#endif
    return (void*)0;
}
#else
/* Compiled as C (no name mangling) — export the VST3 factory entry. */
__attribute__((visibility("default"))) void* GetPluginFactory(void) {
#if PROBE_HANG
    for (;;) sleep(3600);   /* the 90 s probe timeout is the only way out */
#else
    abort();                /* crash-isolation: the probe child dies HERE */
#endif
    return (void*)0;
}
#endif
