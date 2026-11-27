import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../utils/api";
import { PcmPlayer, startPcmRecorder } from "../utils/humanPcmAudio";

function getLiveAiWebSocketUrl(sessionId) {
  const qs = `sessionId=${encodeURIComponent(sessionId || "default")}`;
  if (API_BASE && /^https?:\/\//i.test(API_BASE)) {
    const wsBase = API_BASE.replace(/^http/i, "ws").replace(/\/+$/, "");
    return `${wsBase}/ws/live-ai?${qs}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/live-ai?${qs}`;
}

/**
 * Gemini 3 Flash Live 端到端实时语音通话旁路 Hook（直连后端 /ws/live-ai）
 *
 * - 仅在点击「实时通话」时启用，不影响基础文字 /chat、按住说话 /ws/asr、DashScope TTS /ws/tts。
 * - 上行：16kHz 16-bit 单声道 PCM（开启 AEC 回声消除 + 降噪 + AGC）持续推给 Gemini Live。
 * - 下行：若已连 LAM 数字人，由后端进程内直推 24kHz PCM 音画同步；否则本 Hook 通过 PcmPlayer 播放兜底。
 * - 状态流转：off -> connecting -> listening <-> speaking -> off
 */
export function useLiveCall({
  sessionId = "",
  getHistory,
  onInterrupt,
  onTurnComplete,
} = {}) {
  const [isCallActive, setIsCallActive] = useState(false);
  const [callState, setCallState] = useState("off"); // "off" | "connecting" | "listening" | "speaking" | "finalizing"
  const [liveText, setLiveText] = useState("");
  const [liveToolName, setLiveToolName] = useState(null);
  const [error, setError] = useState(null);

  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const getHistoryRef = useRef(getHistory);
  getHistoryRef.current = getHistory;
  const onInterruptRef = useRef(onInterrupt);
  onInterruptRef.current = onInterrupt;
  const onTurnCompleteRef = useRef(onTurnComplete);
  onTurnCompleteRef.current = onTurnComplete;

  const activeRef = useRef(false);
  const wsRef = useRef(null);
  const recorderRef = useRef(null);
  const playerRef = useRef(null);
  const userTranscriptRef = useRef("");
  const assistantTranscriptRef = useRef("");

  const stopResources = useCallback(() => {
    if (recorderRef.current) {
      try {
        recorderRef.current.stop();
      } catch {}
      recorderRef.current = null;
    }
    if (playerRef.current) {
      try {
        playerRef.current.reset();
      } catch {}
      playerRef.current = null;
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close(1000, "call_ended");
      } catch {}
    }
  }, []);

  const endCall = useCallback(() => {
    activeRef.current = false;
    userTranscriptRef.current = "";
    assistantTranscriptRef.current = "";
    setIsCallActive(false);
    setCallState("off");
    setLiveText("");
    setLiveToolName(null);
    stopResources();
  }, [stopResources]);

  const startCall = useCallback(async () => {
    if (activeRef.current) return true;
    setError(null);
    setLiveText("");
    setLiveToolName(null);
    userTranscriptRef.current = "";
    assistantTranscriptRef.current = "";

    activeRef.current = true;
    setIsCallActive(true);
    setCallState("connecting");

    try {
      // 1. Pre-unlock fallback 24kHz PCM player inside user gesture
      playerRef.current = new PcmPlayer();
      try {
        await playerRef.current.unlock(24000);
      } catch {}

      // 2. Open /ws/live-ai WebSocket to Backend -> Gemini 3.1 Flash Live
      const ws = new WebSocket(getLiveAiWebSocketUrl(sessionIdRef.current));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Gemini Live 实时通话连接超时"));
        }, 15000);

        ws.onopen = () => {
          // Inject recent chat history so Gemini Live continues seamlessly
          try {
            const history = getHistoryRef.current?.() || [];
            if (history.length > 0) {
              ws.send(JSON.stringify({ type: "init", history }));
            }
          } catch {}
        };

        ws.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            // Pure audio fallback when LAM Avatar is offline
            if (playerRef.current) {
              void playerRef.current.play(new Uint8Array(event.data), 24000);
            }
            return;
          }

          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }

          if (msg.type === "ready") {
            clearTimeout(timeout);
            if (activeRef.current) {
              setCallState("listening");
            }
            resolve();
            return;
          }

          if (msg.type === "user_transcript" && msg.text) {
            userTranscriptRef.current += msg.text;
            setCallState("speaking");
            setLiveText(userTranscriptRef.current);
          } else if (msg.type === "assistant_transcript" && msg.text) {
            assistantTranscriptRef.current += msg.text;
            setCallState("listening");
            setLiveText(assistantTranscriptRef.current);
          } else if (msg.type === "tool_status") {
            setLiveToolName(msg.status === "running" ? msg.toolName : null);
          } else if (msg.type === "interrupted") {
            playerRef.current?.reset();
            onInterruptRef.current?.();
            setCallState("speaking");
          } else if (msg.type === "turn_complete") {
            const uText = (msg.userText || userTranscriptRef.current || "").trim();
            const aText = (msg.assistantText || assistantTranscriptRef.current || "").trim();
            userTranscriptRef.current = "";
            assistantTranscriptRef.current = "";
            setLiveText("");
            setLiveToolName(null);
            if (activeRef.current) {
              setCallState("listening");
            }
            if (uText || aText) {
              onTurnCompleteRef.current?.({ userText: uText, assistantText: aText });
            }
          } else if (msg.type === "error") {
            const errMsg = msg.message || "Gemini Live 实时通话异常";
            clearTimeout(timeout);
            setError(errMsg);
            reject(new Error(errMsg));
          }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          reject(new Error("无法连接到实时通话服务 (/ws/live-ai)"));
        };

        ws.onclose = (ev) => {
          clearTimeout(timeout);
          if (wsRef.current === ws && activeRef.current) {
            if (ev.code !== 1000) {
              setError(ev.reason || "实时通话连接已断开");
            }
            endCall();
          }
          reject(new Error(ev.reason || "实时通话连接已关闭"));
        };
      });

      if (!activeRef.current) return false;

      // 3. Start 16kHz PCM microphone streaming to /ws/live-ai
      const recorder = await startPcmRecorder((pcmChunk) => {
        if (!activeRef.current) return;
        const sock = wsRef.current;
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(pcmChunk);
        }
      });

      if (!activeRef.current) {
        recorder.stop();
        return false;
      }
      recorderRef.current = recorder;
      return true;
    } catch (err) {
      const msg =
        err?.name === "NotAllowedError"
          ? "麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问。"
          : err?.message || "无法开启实时通话";
      setError(msg);
      endCall();
      return false;
    }
  }, [endCall]);

  useEffect(() => {
    return () => endCall();
  }, [endCall]);

  return {
    isCallActive,
    callState,
    liveText,
    liveToolName,
    callError: error,
    startCall,
    endCall,
  };
}
