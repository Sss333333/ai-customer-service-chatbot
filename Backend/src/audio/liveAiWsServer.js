import { WebSocketServer, WebSocket } from "ws";
import { createGeminiLiveChatSession } from "./geminiLiveChat.js";
import {
  hasLamClient,
  sendAvatarAudioBuffer,
  sendAvatarInterrupt,
  sendAvatarSpeechEnd,
  sendAvatarSpeechStart,
} from "../avatar/lamService.js";

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * 挂载 Gemini 3 Flash Live 端到端实时语音对话旁路 WebSocket（/ws/live-ai 或 /api/ws/live-ai）
 * - 仅在前端点击「实时通话」时触发，保留基础文字 /chat、按住说话 /ws/asr、DashScope TTS /ws/tts 逻辑。
 * - 下行 24kHz PCM 音频：
 *     若当前 sessionId 已连接 LAM 3D 数字人 -> 进程内直推 lamService（0.4s 切片，免 ffmpeg，音画同步）
 *     否则 -> 直接通过本 WS 二进制帧发给浏览器 PcmPlayer 兜底播放
 */
export function attachLiveAiWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      return;
    }

    if (url.pathname !== "/ws/live-ai" && url.pathname !== "/api/ws/live-ai") {
      return;
    }

    const sessionId = url.searchParams.get("sessionId") || `LIVE-${Date.now().toString(36)}`;
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, sessionId);
    });
  });

  wss.on("connection", (clientWs, sessionId) => {
    console.log(`[live-ai] Browser connected: sessionId=${sessionId}`);

    let geminiSession = null;
    let closed = false;
    let turnCounter = 0;
    let avatarTurnActive = false;
    let activeSpeechId = null;
    let avatarInitPromise = null;
    let pendingHistory = null;
    let turnUserText = "";
    let turnAssistantText = "";

    const startAvatarTurnIfNeeded = async () => {
      if (!hasLamClient(sessionId)) return false;
      if (avatarTurnActive) return true;
      if (avatarInitPromise) return await avatarInitPromise;

      const speechId = `${sessionId}:live:${++turnCounter}`;
      avatarInitPromise = sendAvatarSpeechStart(sessionId, speechId, "pcm24k", { sliceMs: 400 })
        .then((ok) => {
          avatarInitPromise = null;
          if (ok) {
            avatarTurnActive = true;
            activeSpeechId = speechId;
          }
          return ok;
        })
        .catch(() => {
          avatarInitPromise = null;
          return false;
        });

      return await avatarInitPromise;
    };

    const endAvatarTurn = async () => {
      if (avatarInitPromise) {
        await avatarInitPromise;
      }
      if (avatarTurnActive && activeSpeechId) {
        const sid = activeSpeechId;
        avatarTurnActive = false;
        activeSpeechId = null;
        await sendAvatarSpeechEnd(sessionId, sid).catch(() => {});
      }
    };

    const interruptAvatarTurn = () => {
      avatarTurnActive = false;
      activeSpeechId = null;
      avatarInitPromise = null;
      sendAvatarInterrupt(sessionId).catch(() => {});
    };

    let audioChain = Promise.resolve();

    createGeminiLiveChatSession({
      caseRef: sessionId,
      onUserTranscript(text) {
        turnUserText += text;
        sendJson(clientWs, { type: "user_transcript", text });
      },
      onAssistantTranscript(text) {
        turnAssistantText += text;
        sendJson(clientWs, { type: "assistant_transcript", text });
      },
      onAudio(pcmBuf) {
        if (closed || !pcmBuf || pcmBuf.length === 0) return;
        audioChain = audioChain
          .then(async () => {
            if (closed) return;
            const useAvatar = await startAvatarTurnIfNeeded();
            if (useAvatar) {
              const ok = await sendAvatarAudioBuffer(sessionId, pcmBuf);
              if (ok) return;
              avatarTurnActive = false;
              activeSpeechId = null;
            }
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(pcmBuf);
            }
          })
          .catch((err) => {
            console.warn(`[live-ai] audio forward error (${sessionId}):`, err?.message || err);
          });
      },
      onInterrupted() {
        interruptAvatarTurn();
        sendJson(clientWs, { type: "interrupted" });
      },
      onTurnComplete() {
        const finalUser = turnUserText.trim();
        const finalAssistant = turnAssistantText.trim();
        if (finalUser) geminiSession?.appendTranscriptToHistory("user", finalUser);
        if (finalAssistant) geminiSession?.appendTranscriptToHistory("assistant", finalAssistant);
        turnUserText = "";
        turnAssistantText = "";

        audioChain = audioChain
          .then(() => endAvatarTurn())
          .catch(() => {});

        sendJson(clientWs, {
          type: "turn_complete",
          userText: finalUser,
          assistantText: finalAssistant,
        });
      },
      onToolStatus({ toolName, status }) {
        sendJson(clientWs, { type: "tool_status", toolName, status });
      },
      onError(err) {
        interruptAvatarTurn();
        sendJson(clientWs, {
          type: "error",
          message: err?.message || "Gemini Live 实时通话异常",
        });
      },
    })
      .then((session) => {
        if (closed) {
          session.close();
          return;
        }
        geminiSession = session;
        if (pendingHistory) {
          geminiSession.sendHistory(pendingHistory);
          pendingHistory = null;
        }
        sendJson(clientWs, {
          type: "ready",
          model: session.model,
          avatarAttached: hasLamClient(sessionId),
        });
      })
      .catch((err) => {
        console.error(`[live-ai] Failed to start Gemini Live (${sessionId}):`, err?.message || err);
        sendJson(clientWs, {
          type: "error",
          message: err?.message || "无法连接 Gemini Live 实时通话",
        });
        try {
          clientWs.close(1011, "live_init_failed");
        } catch {}
      });

    clientWs.on("message", (data, isBinary) => {
      if (closed) return;
      if (isBinary) {
        geminiSession?.sendAudio(data);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString("utf-8"));
      } catch {
        return;
      }

      if (msg?.type === "init" && Array.isArray(msg.history)) {
        if (geminiSession) {
          geminiSession.sendHistory(msg.history);
        } else {
          pendingHistory = msg.history;
        }
      } else if (msg?.type === "interrupt") {
        interruptAvatarTurn();
      }
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      interruptAvatarTurn();
      try {
        geminiSession?.close();
      } catch {}
      geminiSession = null;
      console.log(`[live-ai] Browser disconnected: sessionId=${sessionId}`);
    };

    clientWs.on("close", cleanup);
    clientWs.on("error", cleanup);
  });
}
