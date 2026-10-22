cmake_minimum_required(VERSION 3.22)
project(scorch-engine VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JUCE 8 — pinned tag. juce_audio_basics + juce_audio_devices are ALWAYS
# linked (Stage 3b-fix removed the SCORCH_ENGINE_AUDIO compile gate: it
# shipped mute installers by construction). Headless safety is handled at
# RUNTIME instead — lazy device init on first transport play + --null-audio
# for CI (see engine/src/main.cpp header comment and docs/ASSUMPTIONS.md).

include(FetchContent)
set(FETCHCONTENT_BASE_DIR ${CMAKE_BINARY_DIR}/_fetch CACHE PATH "FetchContent root")
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.4
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(JUCE)

# IXWebSocket — lightweight WebSocket server/client. True RFC 6455 WebSocket.
# Disable zlib (compression) and TLS (we're ws:// on loopback only).
set(USE_ZLIB OFF CACHE BOOL "" FORCE)
set(USE_OPEN_SSL OFF CACHE BOOL "" FORCE)
set(USE_MBED_TLS OFF CACHE BOOL "" FORCE)
set(USE_SECURE_WEBSOCKETS OFF CACHE BOOL "" FORCE)
FetchContent_Declare(
    IXWebSocket
    GIT_REPOSITORY https://github.com/machinezone/IXWebSocket.git
    GIT_TAG v11.4.5
    GIT_SHALLOW TRUE
)
FetchContent_MakeAvailable(IXWebSocket)

add_executable(scorch-engine src/main.cpp)
target_link_libraries(scorch-engine PRIVATE
    juce_core
    juce_audio_basics
    juce_audio_devices
    juce_audio_processors
    ixwebsocket
)
# Stage 3c: VST3 HOSTING + SCAN. JUCE_PLUGINHOST_VST3 compiles in the VST3
# hosting format (AudioPluginInstance / VST3PluginFormat); the VST3 SDK ships
# inside juce_audio_processors — no external SDK download. juce_gui_basics is
# pulled in transitively (AudioProcessorEditor is a Component) — the engine
# never creates editors, and JUCE_WEB_BROWSER=0 keeps the webview stack out.
# D12 receipt-provenance: pin the exact commit this binary was built at. The
# engine carries it in --version, the hello payload, and the [engine] start
# receipt — every bench/receipt record names the build that produced it.
# CI checkouts are clean → no suffix; a dirty local tree appends "-dirty"; a
# non-git configure (plain source zip) falls back to "unknown".
set(SCORCH_ENGINE_COMMIT "unknown")
find_package(Git QUIET)
if(Git_FOUND)
    execute_process(
        COMMAND "${GIT_EXECUTABLE}" rev-parse --short=12 HEAD
        WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
        OUTPUT_VARIABLE _scorch_commit
        OUTPUT_STRIP_TRAILING_WHITESPACE
        ERROR_QUIET
    )
    if(_scorch_commit)
        set(SCORCH_ENGINE_COMMIT "${_scorch_commit}")
        execute_process(
            COMMAND "${GIT_EXECUTABLE}" diff --quiet
            WORKING_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}"
            RESULT_VARIABLE _scorch_commit_dirty
            ERROR_QUIET
        )
        if(NOT _scorch_commit_dirty EQUAL 0)
            string(APPEND SCORCH_ENGINE_COMMIT "-dirty")
        endif()
    endif()
endif()
target_compile_definitions(scorch-engine PRIVATE
    SCORCH_ENGINE_COMMIT="${SCORCH_ENGINE_COMMIT}"
)
target_compile_definitions(scorch-engine PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
)
# Stage 3c-1: the free stand-in host target (CI fixture for scan + hosting
# tests — commercial libraries like BBCSO cannot run in CI).
add_subdirectory(testvst)
# MSVC /EHa: audio init failures on device-less machines can surface as SEH
# access violations (0xC0000005). /EHa makes catch(...) catch them, so the
# lazy init in ensureAudioReady() converts every failure into a clean
# no_audio_device protocol error instead of crashing the process.
# (The --scan-worker path deliberately has NO catch(...) around module loads:
# a crashing plugin must actually kill its worker child — crash isolation.)
if(MSVC)
    target_compile_options(scorch-engine PRIVATE /EHa)
    # TASK F (2026-10-21): /MAP emits scorch-engine.map beside the exe —
    # function start/end RVAs + names for EVERY crash offset, so the next
    # red run's minidump symbolizes (engine+0x120E70-class addresses -> the
    # enclosing function, offline, no PDB upload needed). Linker-side
    # bookkeeping only: the image bytes are unchanged; no codegen impact.
    set_target_properties(scorch-engine PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE /MAP")
endif()
