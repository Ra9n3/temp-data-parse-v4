cmake_minimum_required(VERSION 3.22)
project(scorch-engine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JUCE 8 — pinned tag. Stage 3b adds juce_audio_basics + juce_audio_devices
# for the test synth. SCORCH_ENGINE_AUDIO=OFF (default for CI) skips the audio
# modules to avoid static-init crashes on headless runners.
option(SCORCH_ENGINE_AUDIO "Link JUCE audio modules (test synth)" ON)

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
    ixwebsocket
)
if(SCORCH_ENGINE_AUDIO)
    target_link_libraries(scorch-engine PRIVATE
        juce_audio_basics
        juce_audio_devices
    )
    target_compile_definitions(scorch-engine PRIVATE SCORCH_ENGINE_AUDIO=1)
else()
    target_compile_definitions(scorch-engine PRIVATE SCORCH_ENGINE_AUDIO=0)
endif()
# Console subsystem — visible console window during dev (spec: "fine").
if(MSVC)
    set_target_properties(scorch-engine PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE")
endif()
