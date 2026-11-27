import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../utils/api";
import { PcmPlayer, startPcmRecorder, startRingtone } from "../utils/humanPcmAudio";

function buildHumanWsUrl(params) {
  const qs = new URLSearchParams(params).toString();
  if (API_BASE && /^https?:\/\//i.test(API_BASE)) {
    const wsBase = API_BASE.replace(/^http/i, "ws").replace(/\/+$/, "");
    return `${wsBase}/ws/human?${qs}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/human?${qs}`;
}

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * 单线跨语言人工通话 Hook（直连后端 /ws/human + Gemini Live Translate）
 * @param {{
 *   role: "customer" | "agent",
 *   caseRef?: string,
 *   agentName?: string,
 *   lang?: "en" | "zh-Hans",
 *   onRejected?: (msg: string) => void,
 *   onBusy?: (msg: string) => void
 * }} options
 */
export function useHumanCall({
  role,
  caseRef = "",
  agentName = "Ron",
  lang = role === "agent" ? "zh-Hans" : "en",
  onRejected,
  onBusy,
}) {
  const [status, setStatus] = useState("idle"); // "idle" | "ringing" | "connected"
  const [wsConnected, setWsConnected] = useState(false);
  const [activeCaseRef, setActiveCaseRef] = useState(null);
  const [peerAgentName, setPeerAgentName] = useState(agentName);
  const [aiSummary, setAiSummary] = useState([]);
  const [messages, setMessages] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const [liveStatusText, setLiveStatusText] = useState("");
  const [callError, setCallError] = useState(null);

  const wsRef = useRef(null);
  const recorderRef = useRef(null);
  const playerRef = useRef(null);
  const isMutedRef = useRef(false);
  const statusRef = useRef("idle");
  const agentNameRef = useRef(agentName);
  const langRef = useRef(lang);
  const onRejectedRef = useRef(onRejected);
  const onBusyRef = useRef(onBusy);
  const reconnectTimerRef = useRef(null);

  isMutedRef.current = isMuted;
  statusRef.current = status;
  agentNameRef.current = agentName;
  langRef.current = lang;
  onRejectedRef.current = onRejected;
  onBusyRef.current = onBusy;

  const stopAudio = useCallback(() => {
    if (recorderRef.current) {
      try {
        recorderRef.current.stop();
      } catch { }
      recorderRef.current = null;
    }
    if (playerRef.current) {
      try {
        playerRef.current.reset();
      } catch { }
      playerRef.current = null;
    }
    setMicLevel(0);
  }, []);

  const ensureAudioStarted = useCallback(async () => {
    if (!playerRef.current) {
      playerRef.current = new PcmPlayer();
    }
    try {
      await playerRef.current.unlock(24000);
    } catch { }

    if (recorderRef.current) return;
    try {
      const handle = await startPcmRecorder(
        (pcmChunk) => {
          if (isMutedRef.current) return;
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN && statusRef.current === "connected") {
            ws.send(pcmChunk);
          }
        },
        (level) => {
          setMicLevel(isMutedRef.current ? 0 : level);
        }
      );
      recorderRef.current = handle;
    } catch (err) {
      const msg =
        err?.name === "NotAllowedError"
          ? "麦克风权限被拒绝，您仍可使用文字输入沟通。"
          : `麦克风启动失败：${err?.message || err}`;
      setCallError(msg);
    }
  }, []);

  const appendTranscript = useCallback((evt) => {
    setMessages((prev) => {
      const now = Date.now();
      const last = prev[prev.length - 1];
      if (
        last &&
        last.kind === "transcript" &&
        last.sender === evt.speaker &&
        now - last.updatedAt < 4500
      ) {
        const updated = {
          ...last,
          sourceText: last.sourceText + (evt.sourceText || ""),
          translatedText: last.translatedText + (evt.translatedText || ""),
          time: evt.time || last.time,
          updatedAt: now,
        };
        return [...prev.slice(0, -1), updated];
      }
      return [
        ...prev,
        {
          id: `tr-${now}-${Math.random().toString(36).slice(2, 6)}`,
          kind: "transcript",
          sender: evt.speaker,
          senderName: evt.speakerName,
          sourceText: evt.sourceText || "",
          translatedText: evt.translatedText || "",
          time: evt.time || nowTime(),
          updatedAt: now,
        },
      ];
    });
  }, []);

  const handleServerMessage = useCallback(
    (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (!playerRef.current) {
          playerRef.current = new PcmPlayer();
        }
        void playerRef.current.play(new Uint8Array(event.data), 24000);
        return;
      }

      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (msg.type) {
        case "line_state":
          setStatus(msg.status || "idle");
          setActiveCaseRef(msg.caseRef || null);
          setAiSummary(Array.isArray(msg.aiSummary) ? msg.aiSummary : []);
          if (msg.status === "idle") {
            stopAudio();
            setMessages([]);
            setLiveStatusText("");
          }
          break;

        case "ringing":
          setStatus("ringing");
          setActiveCaseRef(msg.caseRef || caseRef);
          setCallError(null);
          break;

        case "busy":
          stopAudio();
          setStatus("idle");
          setCallError(msg.message || "当前人工客服正在通话中，请稍后再试。");
          onBusyRef.current?.(msg.message || "当前人工客服正在通话中，请稍后再试。");
          break;

        case "rejected":
          stopAudio();
          setStatus("idle");
          setMessages([]);
          setLiveStatusText("");
          onRejectedRef.current?.("当前人工客服正忙，请稍后再试或继续向 AI 助手提问。");
          break;

        case "connected":
          setStatus("connected");
          setActiveCaseRef(msg.caseRef || activeCaseRef);
          if (msg.agentName) setPeerAgentName(msg.agentName);
          setCallError(null);
          setMessages([
            {
              id: `sys-${Date.now()}`,
              kind: "system",
              sender: "system",
              text: `已接通跨语言人工通话（${msg.agentName || "客服"} · 中文 ⇄ English）`,
              time: msg.time || nowTime(),
            },
          ]);
          void ensureAudioStarted();
          break;

        case "transcript":
          appendTranscript(msg);
          break;

        case "text_message":
          setMessages((prev) => [
            ...prev,
            {
              id: `txt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              kind: "text",
              sender: msg.sender,
              senderName: msg.senderName,
              text: msg.text,
              time: msg.time || nowTime(),
            },
          ]);
          break;

        case "live_status":
          setLiveStatusText(msg.message || "");
          break;

        case "error":
          setCallError(msg.message || "实时翻译异常");
          break;

        case "ended":
          stopAudio();
          setStatus("idle");
          setActiveCaseRef(null);
          setAiSummary([]);
          setMessages([]);
          setLiveStatusText("");
          break;

        default:
          break;
      }
    },
    [activeCaseRef, appendTranscript, caseRef, ensureAudioStarted, stopAudio]
  );

  // Agent 端保持长连接在线待命（断线自动重连）
  useEffect(() => {
    if (role !== "agent") return;
    let disposed = false;

    const connectAgent = () => {
      if (disposed) return;
      const ws = new WebSocket(
        buildHumanWsUrl({
          role: "agent",
          name: agentNameRef.current || "Ron",
          lang: langRef.current || "zh-Hans",
        })
      );
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        setCallError(null);
      };
      ws.onmessage = handleServerMessage;
      ws.onclose = () => {
        setWsConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        if (!disposed) {
          stopAudio();
          setStatus("idle");
          reconnectTimerRef.current = setTimeout(connectAgent, 2000);
        }
      };
      ws.onerror = () => {
        setCallError("无法连接到后端 /ws/human，请确认 NewBackend 已启动。");
      };
    };

    connectAgent();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      stopAudio();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { }
        wsRef.current = null;
      }
    };
  }, [handleServerMessage, role, stopAudio]);

  // 同步客服昵称/语言到后端
  const updateAgentProfile = useCallback((nextName, nextLang) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "update_profile", name: nextName, lang: nextLang }));
    }
  }, []);

  // 客户发起呼叫
  const startCall = useCallback(
    (aiSummaryList = []) => {
      if (role !== "customer") return;
      setCallError(null);
      setMessages([]);
      setLiveStatusText("");

      if (!playerRef.current) {
        playerRef.current = new PcmPlayer();
      }
      void playerRef.current.unlock(24000).catch(() => { });

      if (wsRef.current) {
        try { wsRef.current.close(); } catch { }
        wsRef.current = null;
      }

      const ws = new WebSocket(
        buildHumanWsUrl({
          role: "customer",
          caseRef,
          lang: langRef.current || "en",
        })
      );
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        setWsConnected(true);
        ws.send(
          JSON.stringify({
            type: "call",
            caseRef,
            lang: langRef.current || "en",
            aiSummary: aiSummaryList.slice(-4),
          })
        );
      };
      ws.onmessage = handleServerMessage;
      ws.onclose = () => {
        setWsConnected(false);
        if (wsRef.current === ws) wsRef.current = null;
        stopAudio();
        setStatus("idle");
      };
      ws.onerror = () => {
        setCallError("无法连接到人工通话服务，请确认后端已启动。");
      };
    },
    [caseRef, handleServerMessage, role, stopAudio]
  );

  const acceptCall = useCallback(
    (nameOverride) => {
      if (!playerRef.current) {
        playerRef.current = new PcmPlayer();
      }
      void playerRef.current.unlock(24000).catch(() => { });
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "accept",
            agentName: nameOverride || agentNameRef.current || "Ron",
          })
        );
      }
    },
    []
  );

  const rejectCall = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "reject" }));
    }
  }, []);

  const sendText = useCallback((text) => {
    const trimmed = String(text || "").trim();
    if (!trimmed) return;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && statusRef.current === "connected") {
      ws.send(JSON.stringify({ type: "text", text: trimmed }));
    }
  }, []);

  const hangup = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "hangup" }));
    }
    stopAudio();
    if (role === "customer" && ws) {
      try { ws.close(); } catch { }
      wsRef.current = null;
    }
    setStatus("idle");
    setMessages([]);
    setLiveStatusText("");
  }, [role, stopAudio]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => !prev);
  }, []);

  // 呼叫振铃期间自动播放铃声（客户侧：回铃音；客服侧：来电提示音），接通/挂断立即停止
  useEffect(() => {
    if (status !== "ringing") return;
    const ring = startRingtone(role === "agent" ? "incoming" : "outgoing");
    return () => ring.stop();
  }, [status, role]);

  useEffect(() => {
    return () => {
      stopAudio();
      if (wsRef.current) {
        try { wsRef.current.close(); } catch { }
        wsRef.current = null;
      }
    };
  }, [stopAudio]);

  return {
    status,
    wsConnected,
    activeCaseRef,
    peerAgentName,
    aiSummary,
    messages,
    isMuted,
    micLevel,
    liveStatusText,
    callError,
    setCallError,
    startCall,
    acceptCall,
    rejectCall,
    sendText,
    hangup,
    toggleMute,
    updateAgentProfile,
  };
}
