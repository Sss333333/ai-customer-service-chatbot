import { useCallback, useEffect, useRef, useState } from 'react';
import { AVATAR_BASE, interruptAvatar } from '../utils/api';

// 渲染器构造函数缓存，动态加载后填充
let RendererCtor = null;

function isWebGLSupported() {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function getLamWebSocketUrl(sessionId) {
  const qs = encodeURIComponent(sessionId);
  if (AVATAR_BASE && /^https?:\/\//i.test(AVATAR_BASE)) {
    const wsBase = AVATAR_BASE.replace(/^http/i, 'ws').replace(/\/+$/, '');
    return `${wsBase}/ws/lam-client/${qs}`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/lam-client/${qs}`;
}

/**
 * LAM 3D Gaussian Splatting Avatar Hook
 * - 纯 WebSocket 接收 (52 维 ARKit 表情帧 @ 30fps + 24kHz PCM 音频)
 * - 浏览器端 WebGL 实时渲染 (gaussian-splat-renderer-for-lam)
 * - Web Audio 硬件时钟精确同步口型与语音，打断毫秒级清空队列
 */
export function useLamAvatar({
  sessionId,
  autoConnect = false,
  chatState = 'Idle',
} = {}) {
  // 'idle' | 'loading' | 'connected' | 'offline' | 'error'
  const [status, setStatus] = useState('idle');
  const [loadPercent, setLoadPercent] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [error, setError] = useState(null);

  const containerRef = useRef(null);
  const rendererRef = useRef(null);
  const wsRef = useRef(null);
  const audioCtxRef = useRef(null);
  const gainNodeRef = useRef(null);
  const activeSourcesRef = useRef(new Set());
  const timelineRef = useRef([]);
  const nextPlayTimeRef = useRef(0);
  const pendingChunkMetaRef = useRef(null);
  const arkitChannelsRef = useRef([]);
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const chatStateRef = useRef(chatState);
  chatStateRef.current = chatState;
  const isSpeakingRef = useRef(isSpeaking);
  isSpeakingRef.current = isSpeaking;
  const connectSeqRef = useRef(0);

  const ensureAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const ctx = new AudioCtx({ sampleRate: 24000 });
      const gain = ctx.createGain();
      gain.gain.value = isMutedRef.current ? 0 : 1;
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;
      if (ctx.state === 'suspended') {
        setNeedsAudioUnlock(true);
      }
    }
    return audioCtxRef.current;
  }, []);

  const stopPlayback = useCallback(() => {
    for (const src of activeSourcesRef.current) {
      try {
        src.onended = null;
        src.stop();
      } catch {}
    }
    activeSourcesRef.current.clear();
    timelineRef.current = [];
    pendingChunkMetaRef.current = null;
    nextPlayTimeRef.current = 0;
    setIsSpeaking(false);
  }, []);

  const cleanup = useCallback(() => {
    connectSeqRef.current += 1;
    stopPlayback();

    if (wsRef.current) {
      try {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      } catch {}
      wsRef.current = null;
    }

    if (rendererRef.current) {
      try {
        rendererRef.current.dispose?.();
      } catch {}
      rendererRef.current = null;
      // Clear singleton reference so reconnect can recreate cleanly
      if (RendererCtor?.instance) {
        RendererCtor.instance = undefined;
      }
    }
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }
  }, [stopPlayback]);

  const unlockAudio = useCallback(() => {
    const ctx = ensureAudioContext();
    if (ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => setNeedsAudioUnlock(false))
        .catch(() => {});
    } else {
      setNeedsAudioUnlock(false);
    }
  }, [ensureAudioContext]);

  const scheduleChunk = useCallback(
    (meta, pcmBuffer) => {
      const ctx = ensureAudioContext();
      if (ctx.state === 'suspended') {
        ctx
          .resume()
          .then(() => setNeedsAudioUnlock(false))
          .catch(() => setNeedsAudioUnlock(true));
      }

      const sr = meta.sampleRate || 24000;
      const fps = meta.fps || 30;
      const int16 = new Int16Array(pcmBuffer);
      if (int16.length === 0) return;

      const audioBuffer = ctx.createBuffer(1, int16.length, sr);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < int16.length; i++) {
        channelData[i] = int16[i] / 32768.0;
      }

      const now = ctx.currentTime;
      const startTime = Math.max(now + 0.04, nextPlayTimeRef.current);
      const duration = int16.length / sr;
      const endTime = startTime + duration;
      nextPlayTimeRef.current = endTime;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(gainNodeRef.current || ctx.destination);
      activeSourcesRef.current.add(source);

      timelineRef.current.push({
        startTime,
        endTime,
        fps,
        frames: meta.frames || [],
      });

      setIsSpeaking(true);

      source.onended = () => {
        activeSourcesRef.current.delete(source);
        // Prune expired timeline entries
        const cur = ctx.currentTime;
        timelineRef.current = timelineRef.current.filter((item) => item.endTime > cur - 0.1);
        if (activeSourcesRef.current.size === 0) {
          setIsSpeaking(false);
        }
      };

      source.start(startTime);
    },
    [ensureAudioContext]
  );

  // Per-frame ARKit expression callback polled by GaussianSplatRenderer
  const getExpressionData = useCallback(() => {
    const ctx = audioCtxRef.current;
    const timeline = timelineRef.current;
    const channels = arkitChannelsRef.current;
    if (!ctx || timeline.length === 0 || channels.length === 0) {
      return {};
    }
    const now = ctx.currentTime;
    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      if (now >= item.startTime && now <= item.endTime) {
        const frameIdx = Math.min(
          item.frames.length - 1,
          Math.max(0, Math.floor((now - item.startTime) * item.fps))
        );
        const frame = item.frames[frameIdx];
        if (!frame) return {};
        const map = {};
        const len = Math.min(channels.length, frame.length);
        for (let j = 0; j < len; j++) {
          map[channels[j]] = frame[j];
        }
        return map;
      }
    }
    return {};
  }, []);

  const getChatState = useCallback(() => {
    if (isSpeakingRef.current) return 'Responding';
    return chatStateRef.current || 'Idle';
  }, []);

  const connect = useCallback(async () => {
    if (!sessionId) return;
    if (!isWebGLSupported()) {
      setStatus('offline');
      setError('当前浏览器不支持 WebGL，已自动切回纯语音模式');
      return;
    }

    cleanup();
    const mySeq = ++connectSeqRef.current;
    setStatus('loading');
    setLoadPercent(0);
    setError(null);

    try {
      // 1. Fetch LAM initconfig with short timeout
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      let cfg;
      try {
        const res = await fetch(`${AVATAR_BASE}/lam/initconfig`, {
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`LAM service unavailable (${res.status})`);
        cfg = await res.json();
      } catch {
        clearTimeout(timer);
        if (mySeq !== connectSeqRef.current) return;
        setStatus('offline');
        setError('LAM 数字人服务未启动，已自动使用纯语音模式');
        return;
      }

      if (mySeq !== connectSeqRef.current) return;

      if (Array.isArray(cfg.arkitChannels)) {
        arkitChannelsRef.current = cfg.arkitChannels;
      }

      const container = containerRef.current;
      if (!container) {
        throw new Error('3D 渲染容器未挂载');
      }

      // 2. 动态加载 3D Gaussian Splatting 渲染器（首次加载后缓存）
      if (!RendererCtor) {
        const module = await import('gaussian-splat-renderer-for-lam');
        RendererCtor = module.GaussianSplatRenderer;
      }

      if (mySeq !== connectSeqRef.current) return;

      // 3. Load 3D Gaussian Splatting asset into WebGL
      const assetUrl = AVATAR_BASE ? `${AVATAR_BASE}${cfg.assetUrl}` : cfg.assetUrl;
      const renderer = await RendererCtor.getInstance(container, assetUrl, {
        backgroundColor: '0xf4f1eb',
        downloadProgress: (p) => {
          if (mySeq === connectSeqRef.current) {
            setLoadPercent(Math.round(p * 70));
          }
        },
        loadProgress: (p) => {
          if (mySeq === connectSeqRef.current) {
            setLoadPercent(70 + Math.round(p * 30));
          }
        },
        getChatState,
        getExpressionData,
      });

      if (mySeq !== connectSeqRef.current) {
        try {
          renderer.dispose?.();
          if (RendererCtor?.instance) {
            RendererCtor.instance = undefined;
          }
        } catch {}
        return;
      }

      // Ensure callbacks point to latest refs even if singleton reused
      renderer.getChatState = getChatState;
      renderer.getExpressionData = getExpressionData;
      rendererRef.current = renderer;
      setLoadPercent(100);

      // 3. Connect pure WebSocket for synchronized expression + audio stream
      const ws = new WebSocket(getLamWebSocketUrl(sessionId));
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        if (mySeq !== connectSeqRef.current) return;
        setStatus('connected');
        setError(null);
      };

      ws.onmessage = (ev) => {
        if (mySeq !== connectSeqRef.current) return;
        if (typeof ev.data === 'string') {
          let msg;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }
          if (msg.type === 'ready' && Array.isArray(msg.arkitChannels)) {
            arkitChannelsRef.current = msg.arkitChannels;
          } else if (msg.type === 'speech_chunk') {
            pendingChunkMetaRef.current = msg;
          } else if (msg.type === 'interrupt') {
            stopPlayback();
          }
          return;
        }

        // Binary frame: 24kHz int16 PCM paired with preceding speech_chunk meta
        const meta = pendingChunkMetaRef.current;
        pendingChunkMetaRef.current = null;
        if (meta && ev.data instanceof ArrayBuffer) {
          scheduleChunk(meta, ev.data);
        }
      };

      ws.onclose = () => {
        if (mySeq !== connectSeqRef.current) return;
        stopPlayback();
        setStatus('offline');
      };

      ws.onerror = () => {
        if (mySeq !== connectSeqRef.current) return;
        stopPlayback();
        setStatus('offline');
        setError('LAM WebSocket 连接断开');
      };
    } catch (err) {
      if (mySeq !== connectSeqRef.current) return;
      cleanup();
      setStatus('error');
      setError(err?.message || 'LAM 3D 数字人加载失败');
    }
  }, [cleanup, getChatState, getExpressionData, scheduleChunk, sessionId, stopPlayback]);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('idle');
    setError(null);
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (gainNodeRef.current) {
        gainNodeRef.current.gain.value = next ? 0 : 1;
      }
      if (!next) {
        unlockAudio();
      }
      return next;
    });
  }, [unlockAudio]);

  const interrupt = useCallback(() => {
    stopPlayback();
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'interrupt' }));
      } catch {}
    }
    interruptAvatar(sessionId);
  }, [sessionId, stopPlayback]);

  useEffect(() => {
    if (!autoConnect || !sessionId) return;
    connect();
    return () => {
      cleanup();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
        audioCtxRef.current = null;
      }
    };
  }, [autoConnect, sessionId, connect, cleanup]);

  return {
    status,
    loadPercent,
    isConnected: status === 'connected',
    isSpeaking,
    isMuted,
    needsAudioUnlock,
    error,
    containerRef,
    connect,
    disconnect,
    toggleMute,
    unlockAudio,
    interrupt,
  };
}
