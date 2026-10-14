cmake_minimum_required(VERSION 3.22)
project(scorch-engine VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# JUCE 8 — pinned tag. FetchContent pulls the full JUCE source; the build
# only links juce_core (no audio/graph/UI modules needed for a no-audio
# protocol skeleton). Cache via CCACHE and the FetchContent cache directory
# so CI's Swatinem/rust-cache (or a CMake-specific cache) can warm-hit.
include(FetchContent)
set(FETCHCONTENT_BASE_DIR ${CMAKE_BINARY_DIR}/_fetch CACHE PATH "FetchContent root")
FetchContent_Declare(
    JUCE
    GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
    GIT_TAG 8.0.4
    GIT_SHALLOW TRUE
)
# Disable JUCE modules we don't need to keep compile time down.
set(JUCE_MODULES juce_core)
FetchContent_MakeAvailable(JUCE)

# IXWebSocket — lightweight WebSocket server/client. Header-only-ish (one .cpp).
# True RFC 6455 WebSocket so the browser-native WebSocket client can connect.
# Disable zlib (compression) and TLS (we're ws:// on loopback only) to avoid
# system dependency issues on Windows CI.
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
# Console subsystem — visible console window during dev (spec: "fine").
if(MSVC)
    set_target_properties(scorch-engine PROPERTIES LINK_FLAGS "/SUBSYSTEM:CONSOLE")
endif()
