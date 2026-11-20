import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../utils/api";

const AUTO_SPEAK_STORAGE_KEY = "ai_chat_auto_speak";

function getTtsWebSocketUrl(sessionId) {
  const qs = `sessionId=${encodeURIComponent(sessionId)}`;
  if (API_BASE && /^https?:\/\//i.test(API_BASE)) {
    const wsBase = API_BASE.replace(/^http/i, "ws").replace(/\/+$/, "");
    return `${wsBase}/ws/tts?${qs}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/tts?${qs}`;
}

/**
 * 语音播放 Hook（仅保留 /ws/tts 旁路自动朗读 + MediaSource 即收即播）
 */
export function useAudioPlayer({ sessionId } = {}) {
  const [autoSpeak, setAutoSpeakState] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);

  const wsRef = useRef(null);
  const wsTurnRef = useRef(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(AUTO_SPEAK_STORAGE_KEY);
      if (stored !== null) {
        setAutoSpeakState(stored === "true");
      }
    } catch {}
  }, []);

  const setAutoSpeak = useCallback((enabled) => {
    setAutoSpeakState(enabled);
    try {
      localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, String(enabled));
    } catch {}
  }, []);

  const toggleAutoSpeak = useCallback(() => {
    setAutoSpeakState((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, String(next));
      } catch {}
      return next;
    });
  }, []);

  const cleanupWsTurn = useCallback((notifyServer = true) => {
    const t = wsTurnRef.current;
    wsTurnRef.current = null;
    if (notifyServer && wsRef.current?.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: "stop" }));
      } catch {}
    }
    if (!t) return;
    t.aborted = true;
    setIsPlaying(false);
    if (t.audio) {
      t.audio.onended = null;
      t.audio.onerror = null;
      t.audio.pause();
      t.audio = null;
    }
    if (t.objectUrl) {
      URL.revokeObjectURL(t.objectUrl);
      t.objectUrl = null;
    }
  }, []);

  const stop = useCallback(() => {
    cleanupWsTurn(true);
  }, [cleanupWsTurn]);

  const startWsTurn = useCallback(
    (turnId) => {
      cleanupWsTurn(false);

      const ms = new MediaSource();
      const url = URL.createObjectURL(ms);
      const audio = new Audio(url);

      const t = {
        turnId,
        aborted: false,
        ended: false,
        audio,
        objectUrl: url,
        ms,
        sb: null,
        mseQueue: [],
        playStarted: false,
      };
      wsTurnRef.current = t;

      const flushMse = () => {
        if (t.aborted || !t.sb || t.sb.updating) return;
        if (t.mseQueue.length > 0) {
          const next = t.mseQueue.shift();
          try {
            t.sb.appendBuffer(next);
          } catch (e) {
            console.warn("[TTS-WS] appendBuffer error:", e);
          }
        } else if (t.ended && ms.readyState === "open") {
          try {
            ms.endOfStream();
          } catch {}
        }
      };
      t.flushMse = flushMse;

      ms.addEventListener(
        "sourceopen",
        () => {
          if (t.aborted || ms.readyState !== "open") return;
          try {
            const sb = ms.addSourceBuffer("audio/mpeg");
            t.sb = sb;
            sb.addEventListener("updateend", () => {
              if (!t.aborted && !t.playStarted && t.sb.buffered.length > 0) {
                t.playStarted = true;
                audio.play().catch((err) => {
                  if (err?.name !== "AbortError") {
                    console.warn("[TTS-WS] play blocked:", err);
                    cleanupWsTurn(false);
                  }
                });
              }
              flushMse();
            });
            flushMse();
          } catch (e) {
            console.warn("[TTS-WS] addSourceBuffer failed:", e);
          }
        },
        { once: true }
      );

      const onFinish = () => {
        if (wsTurnRef.current === t) {
          cleanupWsTurn(false);
        }
      };
      audio.onplaying = () => {
        if (!t.aborted && wsTurnRef.current === t) setIsPlaying(true);
      };
      audio.onended = onFinish;
      audio.onerror = onFinish;

      return t;
    },
    [cleanupWsTurn]
  );

  /** 自动开启/关闭 /ws/tts 旁路长连接 */
  useEffect(() => {
    if (!autoSpeak || !sessionId || typeof WebSocket === "undefined") {
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
      return;
    }

    let closedByEffect = false;
    let reconnectTimer = null;

    const connect = () => {
      if (closedByEffect) return;
      const ws = new WebSocket(getTtsWebSocketUrl(sessionId));
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          let msg;
          try {
            msg = JSON.parse(event.data);
          } catch {
            return;
          }

          if (msg.type === "tts_start") {
            startWsTurn(msg.turnId);
            return;
          }

          const t = wsTurnRef.current;
          if (!t || t.turnId !== msg.turnId) return;

          if (msg.type === "tts_end") {
            t.ended = true;
            t.flushMse?.();
          }
          return;
        }

        const t = wsTurnRef.current;
        if (!t || t.aborted) return;
        t.mseQueue.push(event.data);
        t.flushMse?.();
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (!closedByEffect) {
          reconnectTimer = setTimeout(connect, 1500);
        }
      };
    };

    connect();

    return () => {
      closedByEffect = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (wsRef.current) {
        try { wsRef.current.close(); } catch {}
        wsRef.current = null;
      }
    };
  }, [autoSpeak, sessionId, startWsTurn]);

  useEffect(() => () => cleanupWsTurn(true), [cleanupWsTurn]);

  return {
    autoSpeak,
    isPlaying,
    setAutoSpeak,
    toggleAutoSpeak,
    stop,
  };
}
