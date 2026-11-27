import { WebSocketServer, WebSocket } from "ws";
import { DashScopeAsrClient } from "./dashscopeAsr.js";

/**
 * 挂载实时语音识别 WebSocket 桥接服务（/ws/asr 或 /api/ws/asr）
 * 浏览器推送 16kHz 16-bit 单声道 PCM 二进制帧，后端实时转发给百炼并回传字幕。
 * @param {import("http").Server} server
 */
export function attachAsrWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "/";
    try {
      pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== "/ws/asr" && pathname !== "/api/ws/asr") {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (clientWs) => {
    let session = null;

    const sendJson = (payload) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    try {
      const client = new DashScopeAsrClient();
      session = client.createRealtimeSession({
        onStarted: () => {
          sendJson({ type: "started" });
        },
        onTranscript: ({ text }) => {
          sendJson({ type: "transcript", text, isFinal: false });
        },
        onFinished: ({ text }) => {
          sendJson({ type: "transcript", text, isFinal: true });
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1000, "completed");
          }
        },
        onError: (err) => {
          sendJson({ type: "error", message: err?.message || "ASR error" });
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, "asr_error");
          }
        }
      });
    } catch (err) {
      sendJson({ type: "error", message: err?.message || "Failed to initialize ASR session" });
      clientWs.close(1011, "init_failed");
      return;
    }

    clientWs.on("message", (data, isBinary) => {
      if (!session) return;
      if (isBinary) {
        session.sendAudio(data);
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (msg?.action === "stop") {
          session.finish();
        } else if (msg?.action === "cancel") {
          session.close();
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1000, "cancelled");
          }
        }
      } catch {
        // ignore malformed control messages
      }
    });

    clientWs.on("close", () => {
      session?.close();
      session = null;
    });

    clientWs.on("error", () => {
      session?.close();
      session = null;
    });
  });

  return wss;
}
