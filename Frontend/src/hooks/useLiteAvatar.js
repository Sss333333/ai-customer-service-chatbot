import { useCallback, useEffect, useRef, useState } from 'react';
import { AVATAR_BASE, interruptAvatar } from '../utils/api';

function waitIceGathering(pc, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, timeoutMs);
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

function makeUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * LiteAvatar WebRTC Hook
 * - 连接精简版 OpenAvatarChat (/openavatarchat/initconfig + /webrtc/offer)
 * - 使用 webrtc_id = sessionId (caseRef) 与 Node 后端 /ws/avatar-feed/{caseRef} 自动对齐
 * - 通过 DataChannel 监听 client_playback 信号实时维护 isSpeaking
 */
export function useLiteAvatar({ sessionId, autoConnect = false } = {}) {
  // 'idle' | 'connecting' | 'connected' | 'offline' | 'error'
  const [status, setStatus] = useState('idle');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [needsAudioUnlock, setNeedsAudioUnlock] = useState(false);
  const [error, setError] = useState(null);

  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const dummyResourcesRef = useRef({ audioCtx: null, tracks: [] });
  const isMutedRef = useRef(isMuted);
  isMutedRef.current = isMuted;
  const connectSeqRef = useRef(0);

  const cleanup = useCallback(() => {
    connectSeqRef.current += 1;

    if (dcRef.current) {
      try {
        dcRef.current.onmessage = null;
        dcRef.current.close();
      } catch {}
      dcRef.current = null;
    }

    if (pcRef.current) {
      try {
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {}
      pcRef.current = null;
    }

    const { audioCtx, tracks } = dummyResourcesRef.current;
    tracks.forEach((t) => {
      try {
        t.stop();
      } catch {}
    });
    if (audioCtx) {
      audioCtx.close().catch(() => {});
    }
    dummyResourcesRef.current = { audioCtx: null, tracks: [] };
    remoteStreamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsSpeaking(false);
    setNeedsAudioUnlock(false);
  }, []);

  const unlockAudio = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    if (!isMutedRef.current) {
      videoEl.muted = false;
    }
    videoEl
      .play()
      .then(() => {
        setNeedsAudioUnlock(false);
      })
      .catch(() => {});
  }, []);

  const connect = useCallback(async () => {
    if (!sessionId || typeof RTCPeerConnection === 'undefined') return;

    cleanup();
    const mySeq = ++connectSeqRef.current;
    setStatus('connecting');
    setError(null);

    try {
      // 1. 探测 initconfig（短超时，确保 AvatarService 未启动时迅速降级）
      const controller = new AbortController();
      const probeTimer = setTimeout(() => controller.abort(), 2000);
      let rtcConfig = {};
      try {
        const cfgRes = await fetch(`${AVATAR_BASE}/openavatarchat/initconfig`, {
          signal: controller.signal,
        });
        clearTimeout(probeTimer);
        if (!cfgRes.ok) {
          throw new Error(`Avatar service unavailable (${cfgRes.status})`);
        }
        const cfg = await cfgRes.json();
        if (cfg?.rtc_configuration) {
          rtcConfig = cfg.rtc_configuration;
        }
      } catch (err) {
        clearTimeout(probeTimer);
        if (mySeq !== connectSeqRef.current) return;
        setStatus('offline');
        setError('数字人服务未连接，已自动使用纯语音模式');
        return;
      }

      if (mySeq !== connectSeqRef.current) return;

      const pc = new RTCPeerConnection(rtcConfig);
      pcRef.current = pc;

      const remoteStream = new MediaStream();
      remoteStreamRef.current = remoteStream;
      if (videoRef.current) {
        videoRef.current.srcObject = remoteStream;
      }

      pc.ontrack = (ev) => {
        if (mySeq !== connectSeqRef.current) return;
        remoteStream.addTrack(ev.track);
        const videoEl = videoRef.current;
        if (videoEl) {
          if (videoEl.srcObject !== remoteStream) {
            videoEl.srcObject = remoteStream;
          }
          videoEl.muted = isMutedRef.current;
          videoEl.play().catch(() => {
            // 浏览器阻止带声音自动播放时，先静音播画面并提示一键解锁声音
            videoEl.muted = true;
            setNeedsAudioUnlock(true);
            videoEl.play().catch(() => {});
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (mySeq !== connectSeqRef.current) return;
        if (pc.connectionState === 'connected') {
          setStatus('connected');
          setError(null);
        } else if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'disconnected' ||
          pc.connectionState === 'closed'
        ) {
          setIsSpeaking(false);
          setStatus('offline');
        }
      };

      const dc = pc.createDataChannel('text');
      dcRef.current = dc;
      dc.onmessage = (ev) => {
        if (mySeq !== connectSeqRef.current) return;
        try {
          const msg = JSON.parse(ev.data);
          if (
            msg?.header?.name === 'ChatSignal' &&
            msg?.payload?.stream_type === 'client_playback'
          ) {
            const sig = msg.payload.type;
            if (sig === 'stream_begin') {
              setIsSpeaking(true);
            } else if (sig === 'stream_end' || sig === 'stream_cancel') {
              setIsSpeaking(false);
            }
          }
        } catch {}
      };

      // fastrtc send-receive 模式需要客户端附带空音视频轨触发会话启动（无需麦克风/摄像头权限）
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const audioCtx = new AudioCtx();
      const silentDst = audioCtx.createMediaStreamDestination();
      const dummyTracks = [];
      silentDst.stream.getAudioTracks().forEach((t) => {
        pc.addTrack(t, silentDst.stream);
        dummyTracks.push(t);
      });
      const blankCanvas = document.createElement('canvas');
      blankCanvas.width = 16;
      blankCanvas.height = 16;
      const blankStream = blankCanvas.captureStream(1);
      blankStream.getVideoTracks().forEach((t) => {
        pc.addTrack(t, blankStream);
        dummyTracks.push(t);
      });
      dummyResourcesRef.current = { audioCtx, tracks: dummyTracks };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitIceGathering(pc);

      if (mySeq !== connectSeqRef.current) return;

      const offerRes = await fetch(`${AVATAR_BASE}/webrtc/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription.sdp,
          type: pc.localDescription.type,
          webrtc_id: sessionId,
        }),
      });

      if (!offerRes.ok) {
        throw new Error(`WebRTC offer failed (${offerRes.status})`);
      }

      const answer = await offerRes.json();
      if (mySeq !== connectSeqRef.current) return;
      await pc.setRemoteDescription(answer);
    } catch (err) {
      if (mySeq !== connectSeqRef.current) return;
      cleanup();
      setStatus('error');
      setError(err?.message || '数字人连接失败');
    }
  }, [cleanup, sessionId]);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('idle');
    setError(null);
  }, [cleanup]);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      if (videoRef.current) {
        videoRef.current.muted = next;
        if (!next) {
          videoRef.current.play().catch(() => {});
          setNeedsAudioUnlock(false);
        }
      }
      return next;
    });
  }, []);

  const interrupt = useCallback(() => {
    setIsSpeaking(false);
    const dc = dcRef.current;
    if (dc && dc.readyState === 'open') {
      try {
        dc.send(
          JSON.stringify({
            header: { name: 'Interrupt', request_id: makeUuid() },
            payload: {},
          })
        );
      } catch {}
    }
    interruptAvatar(sessionId);
  }, [sessionId]);

  // 自动连接（桌面端非 embed 模式下尝试连接，失败则静默降级为 offline）
  useEffect(() => {
    if (!autoConnect || !sessionId) return;
    connect();
    return () => {
      cleanup();
    };
  }, [autoConnect, sessionId, connect, cleanup]);

  return {
    status,
    isConnected: status === 'connected',
    isSpeaking,
    isMuted,
    needsAudioUnlock,
    error,
    videoRef,
    connect,
    disconnect,
    toggleMute,
    unlockAudio,
    interrupt,
  };
}
