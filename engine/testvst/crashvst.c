// CrashDummy VST3 — a VALID shared library that aborts the moment the host
// touches GetPluginFactory. Built in CI (cl.exe / gcc) into a real .vst3
// bundle layout. It exists to prove the engine's OUT-OF-PROCESS scan survives
// a plugin that dies during load: the scan worker child crashes, the parent
// records the failure and keeps scanning (and the engine stays alive).
#include <stdlib.h>

#if defined(_WIN32)
__declspec(dllexport) void* GetPluginFactory(void) {
    abort();
    return (void*)0;
}
#else
/* Compiled as C (no name mangling) — export the VST3 factory entry. */
__attribute__((visibility("default"))) void* GetPluginFactory(void) {
    abort();
    return (void*)0;
}
#endif
