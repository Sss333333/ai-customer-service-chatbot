import { WebSocketServer, WebSocket } from "ws";
import { streamEdgeTTS } from "./edgeTts.js";
import { sanitizeTextForTTS } from "./sanitizer.js";
import { extractSentences } from "./sentenceSplitter.js";
import {
  sendAvatarAudioBuffer,
  sendAvatarInterrupt,
  sendAvatarSpeechEnd,
  sendAvatarSpeechStart,
} from "./avatarBridge.js";

const DEFAULT_VOICE = process.env.DEFAULT_TTS_VOICE || "zh-CN-XiaoxiaoNeural";

/**
 * sessionId -> { ws: WebSocket | null, turnId: number }
 * 每个前端会话（caseRef）共享一个递增 turnId，兼容 /ws/tts 与 AvatarService 旁路。
 */
const sessions = new Map();

function getOrCreateSession(sessionId) {
  let entry = sessions.get(sessionId);
  if (!entry) {
    entry = { ws: null, turnId: 0 };
    sessions.set(sessionId, entry);
  }
  return entry;
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

/**
 * 主动打断某个会话当前轮次的语音合成与数字人播报
 */
export function interruptTtsSession(sessionId, { notifyAvatar = true } = {}) {
  if (!sessionId) return;
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.turnId++;
  }
  if (notifyAvatar) {
    sendAvatarInterrupt(sessionId).catch(() => {});
  }
}

/**
 * 挂载语音合成下行 WebSocket 服务（/ws/tts 或 /api/ws/tts?sessionId=xxx）
 * 协议：
 *   后端 -> 前端：
 *     JSON  { type: "tts_start", turnId }
 *     JSON  { type: "sentence_start", turnId, index }
 *     Binary MP3 分片（紧随 sentence_start）
 *     JSON  { type: "sentence_end", turnId, index }
 *     JSON  { type: "tts_end", turnId }
 *   前端 -> 后端：
 *     JSON  { type: "stop" }  立即中止当前轮次语音推送（不影响 /chat 文本流）
 * @param {import("http").Server} server
 */
export function attachTtsWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      return;
    }

    if (url.pathname !== "/ws/tts" && url.pathname !== "/api/ws/tts") {
      return;
    }

    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, sessionId);
    });
  });

  wss.on("connection", (ws, sessionId) => {
    const prev = sessions.get(sessionId);
    if (prev?.ws && prev.ws !== ws) {
      prev.turnId++;
      try {
        prev.ws.close(1000, "Replaced by newer connection");
      } catch {}
    }

    const entry = { ws, turnId: prev ? prev.turnId + 1 : 1 };
    sessions.set(sessionId, entry);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === "stop") {
          interruptTtsSession(sessionId, { notifyAvatar: true });
        }
      } catch {
        // ignore malformed control messages
      }
    });

    ws.on("close", () => {
      const cur = sessions.get(sessionId);
      if (cur?.ws === ws) {
        cur.turnId++;
        cur.ws = null;
      }
    });

    ws.on("error", () => {
      const cur = sessions.get(sessionId);
      if (cur?.ws === ws) {
        cur.turnId++;
        cur.ws = null;
      }
    });
  });
}

export function hasTtsClient(sessionId) {
  const entry = sessions.get(sessionId);
  return Boolean(entry?.ws && entry.ws.readyState === WebSocket.OPEN);
}

/** 从流式累积文本中剥离 <think> 思考过程，避免误读 */
function stripThinkTags(raw, isFinal) {
  let text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  const openThink = text.indexOf("<think>");
  if (openThink !== -1) text = text.slice(0, openThink);
  if (!isFinal) {
    const lt = text.lastIndexOf("<");
    if (lt !== -1 && text.indexOf(">", lt) === -1) text = text.slice(0, lt);
  }
  return text;
}

/**
 * 为一次 /chat 回复创建 TTS 旁路通道：
 * 接收 LLM 文本增量 -> 后端切句 -> 复用 Edge-TTS 合成
 * - useAvatar=true 时：按句将完整 MP3 推送到 Python AvatarService（失败时自动降级回 /ws/tts）
 * - useAvatar=false 时：原样流式推送 MP3 分片给前端 /ws/tts
 */
export function createTtsSideChannel(
  sessionId,
  { voice = DEFAULT_VOICE, useAvatar = false } = {}
) {
  if (!sessionId) return null;
  const hasWs = hasTtsClient(sessionId);
  if (!useAvatar && !hasWs) {
    return null;
  }

  const entry = getOrCreateSession(sessionId);
  const turnId = ++entry.turnId;
  const speechId = `${sessionId}:${turnId}`;

  let avatarActive = Boolean(useAvatar);
  let avatarStarted = false;
  let wsStarted = false;

  const getOpenWs = () => {
    const cur = sessions.get(sessionId);
    return cur?.ws && cur.ws.readyState === WebSocket.OPEN ? cur.ws : null;
  };

  const isActive = () => {
    const cur = sessions.get(sessionId);
    if (!cur || cur.turnId !== turnId) return false;
    return avatarActive || Boolean(getOpenWs());
  };

  let rawBuffer = "";
  let offset = 0;
  let emitted = 0;
  let sentenceIndex = 0;
  let finished = false;

  // 串行发送队列：前一句正在推流时，后一句的 Promise 已经并发开始合成（零句间停顿）
  let sendChain = Promise.resolve();

  const sendSentenceViaWs = (idx, chunks) => {
    const ws = getOpenWs();
    if (!ws || !isActive()) return;
    if (!wsStarted) {
      wsStarted = true;
      sendJson(ws, { type: "tts_start", turnId });
    }
    sendJson(ws, { type: "sentence_start", turnId, index: idx });
    for (const c of chunks) {
      if (!isActive() || ws.readyState !== WebSocket.OPEN) return;
      ws.send(c);
    }
    if (isActive() && ws.readyState === WebSocket.OPEN) {
      sendJson(ws, { type: "sentence_end", turnId, index: idx });
    }
  };

  const enqueueSentence = (sentenceText) => {
    const clean = sanitizeTextForTTS(sentenceText);
    if (!clean || !isActive()) return;

    const idx = sentenceIndex++;

    // 数字人模式：每句收集完整 MP3 字节流后一次性发给 Python PyAV 解码（避免半帧报错）
    // 纯 /ws/tts 模式：保持原有即收即发低延迟透传
    let isCurrent = false;
    let buffered = [];
    let synthDone = false;
    let synthErr = null;
    let notifyFlush = null;

    const synthPromise = streamEdgeTTS(clean, voice, (chunk) => {
      if (!isActive()) {
        throw new Error("TTS turn aborted");
      }
      if (!avatarActive && isCurrent) {
        const ws = getOpenWs();
        if (ws) ws.send(chunk);
      } else {
        buffered.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    }).then(
      () => {
        synthDone = true;
        notifyFlush?.();
      },
      (err) => {
        synthErr = err;
        synthDone = true;
        notifyFlush?.();
      }
    );

    sendChain = sendChain.then(async () => {
      if (!isActive()) return;

      if (avatarActive) {
        // 等待本句合成完成，拿到完整 MP3 Buffer
        if (!synthDone) {
          await new Promise((resolve) => {
            notifyFlush = resolve;
          });
        }
        await synthPromise.catch(() => {});

        if (!isActive()) return;
        if (synthErr) {
          console.warn(`[TTS-Avatar] Sentence ${idx} synth failed:`, synthErr?.message || synthErr);
          return;
        }
        const fullMp3 = buffered.length > 0 ? Buffer.concat(buffered) : Buffer.alloc(0);
        if (fullMp3.length === 0) return;

        let ok = true;
        if (!avatarStarted) {
          ok = await sendAvatarSpeechStart(sessionId, speechId, "mp3");
          if (ok) avatarStarted = true;
        }
        if (ok) {
          ok = await sendAvatarAudioBuffer(sessionId, fullMp3);
        }

        if (!ok) {
          // AvatarService 不可用：平滑降级回原 /ws/tts 推送
          console.warn(`[TTS-Avatar] AvatarBridge unavailable for ${sessionId}, falling back to /ws/tts`);
          avatarActive = false;
          sendSentenceViaWs(idx, [fullMp3]);
        }
        buffered = null;
        return;
      }

      // 原 /ws/tts 模式
      const ws = getOpenWs();
      if (!ws) return;
      if (!wsStarted) {
        wsStarted = true;
        sendJson(ws, { type: "tts_start", turnId });
      }

      sendJson(ws, { type: "sentence_start", turnId, index: idx });
      isCurrent = true;

      for (const c of buffered) {
        if (!isActive() || ws.readyState !== WebSocket.OPEN) return;
        ws.send(c);
      }
      buffered = null;

      if (!synthDone) {
        await new Promise((resolve) => {
          notifyFlush = resolve;
        });
      }
      await synthPromise.catch(() => {});

      if (synthErr && isActive()) {
        console.warn(`[TTS-WS] Sentence ${idx} failed:`, synthErr?.message || synthErr);
      }
      if (isActive() && ws.readyState === WebSocket.OPEN) {
        sendJson(ws, { type: "sentence_end", turnId, index: idx });
      }
    }).catch((err) => {
      console.warn(`[TTS] sendChain error (${sessionId}):`, err?.message || err);
    });
  };

  const processText = (isFinal) => {
    if (!isActive()) return;
    const speakable = stripThinkTags(rawBuffer, isFinal);
    const { sentences, nextOffset } = extractSentences(speakable, offset, {
      final: isFinal,
      firstChunk: emitted === 0,
    });
    offset = nextOffset;
    emitted += sentences.length;
    for (const s of sentences) {
      enqueueSentence(s);
    }
  };

  return {
    pushDelta(delta) {
      if (finished || !delta || !isActive()) return;
      rawBuffer += delta;
      processText(false);
    },
    finish() {
      if (finished) return;
      finished = true;
      processText(true);
      sendChain = sendChain.then(async () => {
        if (!isActive()) return;
        if (avatarActive && avatarStarted) {
          await sendAvatarSpeechEnd(sessionId, speechId);
        } else if (wsStarted) {
          const ws = getOpenWs();
          if (ws) sendJson(ws, { type: "tts_end", turnId });
        }
      }).catch((err) => {
        console.warn(`[TTS] finish error (${sessionId}):`, err?.message || err);
      });
    },
    abort() {
      finished = true;
      if (sessions.get(sessionId)?.turnId === turnId) {
        interruptTtsSession(sessionId, { notifyAvatar: avatarActive || avatarStarted });
      }
    },
  };
}
