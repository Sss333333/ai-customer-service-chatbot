import { useCallback, useEffect, useRef, useState } from "react";

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 1600; // 100ms @ 16kHz
const PRE_ROLL_CHUNKS = 3; // 保留最近 ~300ms 音频，避免开口第一个字被切掉
const SILENCE_COMMIT_MS = 850; // 停顿超过 850ms 视为一句话说完
const MIN_SPEECH_MS = 350;
const VAD_THRESHOLD_IDLE = 0.022;
const VAD_THRESHOLD_BARGE_IN = 0.055; // AI 说话期间提高门槛，减少外放串音误触

function getAsrWebSocketUrl() {
  const apiBase = import.meta.env.VITE_API_BASE || "";
  if (apiBase && /^https?:\/\//i.test(apiBase)) {
    const wsBase = apiBase.replace(/^http/i, "ws").replace(/\/+$/, "");
    return `${wsBase}/ws/asr`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/asr`;
}

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
  const outLength = Math.max(1, Math.round(float32Data.length / ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(float32Data.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) {
      sum += float32Data[j];
      count++;
    }
    const sample = count > 0 ? sum / count : float32Data[start] || 0;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

function calcRms(float32Data) {
  let sum = 0;
  for (let i = 0; i < float32Data.length; i++) {
    sum += float32Data[i] * float32Data[i];
  }
  return Math.sqrt(sum / float32Data.length);
}

/**
 * 实时语音通话 Hook（常开麦克风 + 能量 VAD 自动断句 + 开口打断 AI）
 *
 * 状态流转：off -> listening -> speaking -> finalizing -> listening
 */
export function useLiveCall({
  isAiBusy = false,
  onInterrupt,
  onUtterance,
} = {}) {
  const [isCallActive, setIsCallActive] = useState(false);
  const [callState, setCallState] = useState("off"); // "off" | "listening" | "speaking" | "finalizing"
  const [liveText, setLiveText] = useState("");
  const [error, setError] = useState(null);

  const isAiBusyRef = useRef(isAiBusy);
  isAiBusyRef.current = isAiBusy;
  const onInterruptRef = useRef(onInterrupt);
  onInterruptRef.current = onInterrupt;
  const onUtteranceRef = useRef(onUtterance);
  onUtteranceRef.current = onUtterance;

  const activeRef = useRef(false);
  const phaseRef = useRef("off"); // "off" | "listening" | "speaking" | "finalizing"
  const streamRef = useRef(null);
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);

  const preRollRef = useRef([]);
  const pcmQueueRef = useRef([]);
  const pcmSampleCountRef = useRef(0);
  const wsRef = useRef(null);
  const liveTextRef = useRef("");
  const speechStartAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const hitCountRef = useRef(0);

  const flushPcm = useCallback((force = false) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (
      pcmSampleCountRef.current >= CHUNK_SAMPLES ||
      (force && pcmSampleCountRef.current > 0)
    ) {
      const targetLen = force ? Math.min(CHUNK_SAMPLES, pcmSampleCountRef.current) : CHUNK_SAMPLES;
      const merged = new Int16Array(targetLen);
      let written = 0;
      while (written < targetLen && pcmQueueRef.current.length > 0) {
        const head = pcmQueueRef.current[0];
        const needed = targetLen - written;
        if (head.length <= needed) {
          merged.set(head, written);
          written += head.length;
          pcmQueueRef.current.shift();
        } else {
          merged.set(head.subarray(0, needed), written);
          pcmQueueRef.current[0] = head.subarray(needed);
          written += needed;
        }
      }
      pcmSampleCountRef.current -= written;
      ws.send(merged.buffer);
    }
  }, []);

  const closeAsrWs = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: "cancel" }));
        ws.close();
      } catch {}
    }
    pcmQueueRef.current = [];
    pcmSampleCountRef.current = 0;
  }, []);

  const endCall = useCallback(() => {
    activeRef.current = false;
    phaseRef.current = "off";
    setIsCallActive(false);
    setCallState("off");
    setLiveText("");
    liveTextRef.current = "";
    closeAsrWs();
    preRollRef.current = [];

    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      try { processorRef.current.disconnect(); } catch {}
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try { sourceRef.current.disconnect(); } catch {}
      sourceRef.current = null;
    }
    if (audioCtxRef.current) {
      try { audioCtxRef.current.close(); } catch {}
      audioCtxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }, [closeAsrWs]);

  /** 本句话说完：收尾 ASR 并自动发送 */
  const commitUtterance = useCallback(() => {
    if (phaseRef.current !== "speaking") return;
    phaseRef.current = "finalizing";
    setCallState("finalizing");
    flushPcm(true);

    const ws = wsRef.current;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      wsRef.current = null;
      const fallback = liveTextRef.current.trim();
      liveTextRef.current = "";
      setLiveText("");
      if (activeRef.current) {
        phaseRef.current = "listening";
        setCallState("listening");
      }
      if (fallback) onUtteranceRef.current?.(fallback);
      return;
    }

    let settled = false;
    const finish = (finalText) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (wsRef.current === ws) wsRef.current = null;
      try { ws.close(); } catch {}
      liveTextRef.current = "";
      setLiveText("");
      if (activeRef.current) {
        phaseRef.current = "listening";
        setCallState("listening");
      }
      const clean = (finalText || "").trim();
      if (clean) onUtteranceRef.current?.(clean);
    };

    const timer = setTimeout(() => finish(liveTextRef.current), 4000);

    ws.addEventListener(
      "message",
      (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "transcript" && msg.isFinal) {
            finish(msg.text || liveTextRef.current);
          }
        } catch {}
      }
    );
    ws.addEventListener("close", () => finish(liveTextRef.current), { once: true });

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: "stop" }));
    } else if (ws.readyState === WebSocket.CONNECTING) {
      ws.addEventListener(
        "open",
        () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ action: "stop" }));
        },
        { once: true }
      );
    }
  }, [flushPcm]);

  /** 检测到人声：打断 AI + 打开 /ws/asr */
  const beginUtterance = useCallback(() => {
    if (!activeRef.current || phaseRef.current !== "listening") return;
    phaseRef.current = "speaking";
    setCallState("speaking");
    speechStartAtRef.current = Date.now();
    lastVoiceAtRef.current = Date.now();
    liveTextRef.current = "";
    setLiveText("");

    // 开口即打断 AI 当前播放/生成
    onInterruptRef.current?.();

    closeAsrWs();
    for (const chunk of preRollRef.current) {
      pcmQueueRef.current.push(chunk);
      pcmSampleCountRef.current += chunk.length;
    }
    preRollRef.current = [];

    const ws = new WebSocket(getAsrWebSocketUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => flushPcm(false);
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "transcript" && phaseRef.current === "speaking") {
          liveTextRef.current = msg.text || "";
          setLiveText(liveTextRef.current);
        }
      } catch {}
    };
    ws.onerror = () => {
      if (phaseRef.current === "speaking") {
        closeAsrWs();
        phaseRef.current = "listening";
        setCallState("listening");
      }
    };
  }, [closeAsrWs, flushPcm]);

  const startCall = useCallback(async () => {
    if (activeRef.current) return true;
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
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
      if (audioCtx.state === "suspended") await audioCtx.resume();

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      sourceRef.current = source;
      processorRef.current = processor;

      activeRef.current = true;
      phaseRef.current = "listening";
      setIsCallActive(true);
      setCallState("listening");

      processor.onaudioprocess = (e) => {
        if (!activeRef.current) return;
        const input = e.inputBuffer.getChannelData(0);
        const rms = calcRms(input);
        const pcm16 = downsampleToInt16(input, audioCtx.sampleRate, TARGET_SAMPLE_RATE);

        const threshold = isAiBusyRef.current ? VAD_THRESHOLD_BARGE_IN : VAD_THRESHOLD_IDLE;
        const now = Date.now();

        if (phaseRef.current === "listening") {
          preRollRef.current.push(pcm16);
          if (preRollRef.current.length > PRE_ROLL_CHUNKS) preRollRef.current.shift();

          if (rms >= threshold) {
            hitCountRef.current += 1;
            if (hitCountRef.current >= 2) {
              hitCountRef.current = 0;
              beginUtterance();
            }
          } else {
            hitCountRef.current = 0;
          }
          return;
        }

        if (phaseRef.current === "speaking") {
          pcmQueueRef.current.push(pcm16);
          pcmSampleCountRef.current += pcm16.length;
          flushPcm(false);

          if (rms >= VAD_THRESHOLD_IDLE) {
            lastVoiceAtRef.current = now;
          } else if (
            now - lastVoiceAtRef.current >= SILENCE_COMMIT_MS &&
            now - speechStartAtRef.current >= MIN_SPEECH_MS
          ) {
            commitUtterance();
          }
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);
      return true;
    } catch (err) {
      endCall();
      setError(
        err?.name === "NotAllowedError"
          ? "麦克风权限被拒绝，无法开启实时通话"
          : err?.message || "无法启动实时通话"
      );
      return false;
    }
  }, [beginUtterance, commitUtterance, endCall, flushPcm]);

  const toggleCall = useCallback(() => {
    if (activeRef.current) {
      endCall();
    } else {
      startCall();
    }
  }, [endCall, startCall]);

  useEffect(() => endCall, [endCall]);

  return {
    isCallActive,
    callState,
    liveText,
    callError: error,
    startCall,
    endCall,
    toggleCall,
  };
}
