// scorch-engine — Stage 3a skeleton (no audio, no VST, no MIDI).
// Protocol v1 (4 message types, all versioned from message one):
//   server -> client: {"type":"hello","engineVersion":"0.1.0","protocol":1}
//   client -> server: {"type":"ping"}                    -> server replies {"type":"pong","t":<ms>}
//   client -> server: {"type":"shutdown"}                -> server exits 0
//   client -> server: <anything else>                    -> server replies {"type":"error","code":"unknown","echo":<original>}
// Loopback ONLY (127.0.0.1). CLI: --port <N> (default 9377), --version.
// No randomness anywhere. Logs to stdout for debuggability.
//
// IXWebSocket v11 note: the server's OnClientMessageCallback receives
// (shared_ptr<ConnectionState>, WebSocketMessagePtr). ConnectionState does NOT
// expose .ws in v11; to send, use server.broadcast() (the frontend is the only
// client, so broadcast = unicast for our purposes).

#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <string>
#include <thread>

#include <juce_core/juce_core.h>

#include <ixwebsocket/IXNetSystem.h>
#include <ixwebsocket/IXWebSocket.h>
#include <ixwebsocket/IXWebSocketServer.h>

namespace {

constexpr const char* kEngineVersion = "0.1.0";
constexpr int kProtocolVersion = 1;
constexpr int kDefaultPort = 9377;

std::atomic<bool> g_should_exit{false};

int64_t monotonic_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

std::string escape_json(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (static_cast<unsigned char>(c) < 0x20) {
                    char buf[8];
                    std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += c;
                }
        }
    }
    return out;
}

// The reply string + whether to broadcast it.
struct Reply { std::string json; bool broadcast; };

Reply handle_message(const std::string& message) {
    std::string type;
    auto pos = message.find("\"type\"");
    if (pos != std::string::npos) {
        pos = message.find(':', pos + 6);
        if (pos != std::string::npos) {
            ++pos;
            while (pos < message.size() && (message[pos] == ' ' || message[pos] == '\t')) ++pos;
            if (pos < message.size() && message[pos] == '"') {
                ++pos;
                auto end = message.find('"', pos);
                if (end != std::string::npos) type = message.substr(pos, end - pos);
            }
        }
    }

    if (type == "ping") {
        std::cout << "[engine] ping -> pong" << std::endl;
        return {"{\"type\":\"pong\",\"t\":" + std::to_string(monotonic_ms()) + "}", true};
    }
    if (type == "shutdown") {
        std::cout << "[engine] shutdown received, exiting 0" << std::endl;
        g_should_exit.store(true);
        return {"", false};
    }
    std::cout << "[engine] unknown message: " << message << std::endl;
    return {"{\"type\":\"error\",\"code\":\"unknown\",\"echo\":\"" + escape_json(message) + "\"}", true};
}

} // namespace

int main(int argc, char** argv) {
    int port = kDefaultPort;
    for (int i = 1; i < argc; ++i) {
        std::string arg = argv[i];
        if (arg == "--version") {
            std::cout << "scorch-engine " << kEngineVersion
                      << " (protocol " << kProtocolVersion << ")" << std::endl;
            return 0;
        }
        if (arg == "--port" && i + 1 < argc) {
            port = std::atoi(argv[++i]);
            if (port <= 0 || port > 65535) {
                std::cerr << "[engine] invalid port: " << argv[i] << std::endl;
                return 1;
            }
        }
    }

    ix::initNetSystem();

    ix::WebSocketServer server(port, "127.0.0.1");

    server.setOnClientMessageCallback(
        [](std::shared_ptr<ix::ConnectionState> /*state*/,
           ix::WebSocket& ws,
           const ix::WebSocketMessagePtr& msg) {
            if (msg->type == ix::WebSocketMessageType::Open) {
                std::cout << "[engine] client connected" << std::endl;
                std::string hello = "{\"type\":\"hello\",\"engineVersion\":\"" +
                                    std::string(kEngineVersion) +
                                    "\",\"protocol\":" + std::to_string(kProtocolVersion) + "}";
                ws.send(hello);
            } else if (msg->type == ix::WebSocketMessageType::Message) {
                auto reply = handle_message(msg->str);
                if (reply.broadcast && !reply.json.empty()) {
                    ws.send(reply.json);
                }
                if (g_should_exit.load()) {
                    ws.close();
                }
            } else if (msg->type == ix::WebSocketMessageType::Close) {
                std::cout << "[engine] client disconnected" << std::endl;
            }
        });

    std::cout << "[engine] scorch-engine " << kEngineVersion
              << " listening on 127.0.0.1:" << port << std::endl;

    auto res = server.listen();
    if (!res.first) {
        std::cerr << "[engine] failed to bind 127.0.0.1:" << port
                  << " — " << res.second << std::endl;
        return 1;
    }

    server.start();
    while (!g_should_exit.load()) {
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    server.stop();
    ix::uninitNetSystem();
    std::cout << "[engine] clean exit 0" << std::endl;
    return 0;
}
