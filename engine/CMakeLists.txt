cmake_minimum_required(VERSION 3.22)
project(scorch-engine VERSION 0.1.0 LANGUAGES CXX)

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
    ixwebsocket
)
# MSVC /EHa: audio init failures on device-less machines can surface as SEH
# access violations (0xC0000005). /EHa makes catch(...) catch them, so the
# lazy init in ensureAudioReady() converts every failure into a clean
# no_audio_device protocol error instead of crashing the process.
if(MSVC)
    target_compile_options(scorch-engine PRIVATE /EHa)
    set_target_properties(scorch-engine PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE")
endif()
