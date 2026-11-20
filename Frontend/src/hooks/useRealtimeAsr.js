import { useCallback, useEffect, useRef, useState } from "react";
import { API_BASE } from "../utils/api";

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms @ 16kHz (3200 bytes)

function getAsrWebSocketUrl() {
  if (API_BASE && /^https?:\/\//i.test(API_BASE)) {
    const wsBase = API_BASE.replace(/^http/i, "ws").replace(/\/+$/, "");
    return `${wsBase}/ws/asr`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/asr`;
}

/**
 * 线性重采样并转为 16-bit signed PCM (Int16Array)
 */
function downsampleToInt16(float32Data, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    const out = new Int16Array(float32Data.length);
    for (let i = 0; i < float32Data.length; i++) {
      const s = Math.max(-1, Math.min(1, float32Data[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = inputSampleRate / outputSampleRate;
  const newLength = Math.max(1, Math.floor(float32Data.length / ratio));
  const out = new Int16Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const s0 = float32Data[idx] ?? 0;
    const s1 = float32Data[Math.min(idx + 1, float32Data.length - 1)] ?? s0;
    const sample = Math.max(-1, Math.min(1, s0 + (s1 - s0) * frac));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

export function useRealtimeAsr({ maxDurationSeconds = 60, onMaxDurationReached } = {}) {
  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [duration, setDuration] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [isSupported] = useState(
    () =>
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof WebSocket !== "undefined" &&
      typeof (window.AudioContext || window.webkitAudioContext) !== "undefined"
  );

  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const streamRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const timerRef = useRef(null);
  const startTimeRef = useRef(0);
  const liveTextRef = useRef("");
  const pcmQueueRef = useRef([]);
  const pcmSampleCountRef = useRef(0);
  const finishResolverRef = useRef(null);
  const onMaxDurationReachedRef = useRef(onMaxDurationReached);

  useEffect(() => {
    onMaxDurationReachedRef.current = onMaxDurationReached;
  }, [onMaxDurationReached]);

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const cleanupAudio = useCallback(() => {
    stopTimer();
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
        processorRef.current.onaudioprocess = null;
      } catch {}
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {}
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      try {
        audioCtxRef.current.close();
      } catch {}
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
      streamRef.current = null;
    }
    pcmQueueRef.current = [];
    pcmSampleCountRef.current = 0;
  }, [stopTimer]);

  const flushPcmBuffer = useCallback((force = false) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (pcmSampleCountRef.current === 0) return;
    if (!force && pcmSampleCountRef.current < CHUNK_SAMPLES) return;

    const merged = new Int16Array(pcmSampleCountRef.current);
    let offset = 0;
    for (const chunk of pcmQueueRef.current) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    pcmQueueRef.current = [];
    pcmSampleCountRef.current = 0;
    ws.send(merged.buffer);
  }, []);

  const cancel = useCallback(() => {
    cleanupAudio();
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "cancel" }));
        }
        ws.close();
      } catch {}
    }
    if (finishResolverRef.current) {
      finishResolverRef.current.resolve("");
      finishResolverRef.current = null;
    }
    liveTextRef.current = "";
    setLiveText("");
    setIsRecording(false);
    setIsFinalizing(false);
    setDuration(0);
  }, [cleanupAudio]);

  const start = useCallback(async () => {
    if (!isSupported) return false;
    cancel();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    streamRef.current = stream;

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let audioCtx;
    try {
      audioCtx = new AudioCtx({ sampleRate: TARGET_SAMPLE_RATE });
    } catch {
      audioCtx = new AudioCtx();
    }
    audioCtxRef.current = audioCtx;
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    const ws = new WebSocket(getAsrWebSocketUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === "transcript") {
        const text = msg.text || "";
        liveTextRef.current = text;
        setLiveText(text);
        if (msg.isFinal && finishResolverRef.current) {
          const { resolve, timer } = finishResolverRef.current;
          clearTimeout(timer);
          finishResolverRef.current = null;
          resolve(text);
        }
      } else if (msg.type === "error") {
        const err = new Error(msg.message || "ASR error");
        if (finishResolverRef.current) {
          const { reject, timer } = finishResolverRef.current;
          clearTimeout(timer);
          finishResolverRef.current = null;
          reject(err);
        }
      }
    };

    ws.onopen = () => {
      flushPcmBuffer();
    };

    ws.onclose = () => {
      if (finishResolverRef.current) {
        const { resolve, timer } = finishResolverRef.current;
        clearTimeout(timer);
        finishResolverRef.current = null;
        resolve(liveTextRef.current);
      }
    };

    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    sourceRef.current = source;
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const pcm16 = downsampleToInt16(input, audioCtx.sampleRate, TARGET_SAMPLE_RATE);
      pcmQueueRef.current.push(pcm16);
      pcmSampleCountRef.current += pcm16.length;
      flushPcmBuffer(false);
    };

    source.connect(processor);
    processor.connect(audioCtx.destination);

    liveTextRef.current = "";
    setLiveText("");
    setIsRecording(true);
    setIsFinalizing(false);
    startTimeRef.current = Date.now();
    setDuration(0);

    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startTimeRef.current) / 1000;
      setDuration(elapsed);
      if (elapsed >= maxDurationSeconds) {
        stopTimer();
        onMaxDurationReachedRef.current?.();
      }
    }, 200);

    return true;
  }, [cancel, flushPcmBuffer, isSupported, maxDurationSeconds, stopTimer]);

  const stop = useCallback(async () => {
    flushPcmBuffer(true);
    cleanupAudio();
    setIsRecording(false);
    setDuration(0);

    const ws = wsRef.current;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      wsRef.current = null;
      return liveTextRef.current.trim();
    }

    setIsFinalizing(true);
    try {
      const finalText = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          finishResolverRef.current = null;
          resolve(liveTextRef.current);
        }, 5000);

        finishResolverRef.current = { resolve, reject, timer };

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action: "stop" }));
        } else if (ws.readyState === WebSocket.CONNECTING) {
          ws.addEventListener(
            "open",
            () => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ action: "stop" }));
              }
            },
            { once: true }
          );
        }
      });
      return (finalText || "").trim();
    } finally {
      wsRef.current = null;
      try {
        ws.close();
      } catch {}
      setIsFinalizing(false);
    }
  }, [cleanupAudio, flushPcmBuffer]);

  useEffect(() => {
    return () => {
      cancel();
    };
  }, [cancel]);

  return {
    isSupported,
    isRecording,
    isFinalizing,
    duration,
    liveText,
    start,
    stop,
    cancel,
  };
}
