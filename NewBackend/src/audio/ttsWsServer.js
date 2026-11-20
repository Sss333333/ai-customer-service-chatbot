import { WebSocketServer, WebSocket } from "ws";
import { streamEdgeTTS } from "./edgeTts.js";
import { sanitizeTextForTTS } from "./sanitizer.js";
import { extractSentences } from "./sentenceSplitter.js";

const DEFAULT_VOICE = process.env.DEFAULT_TTS_VOICE || "zh-CN-XiaoxiaoNeural";

/**
 * sessionId -> { ws: WebSocket, turnId: number }
 * 每个前端会话（caseRef）对应一条下行 TTS WebSocket。
 */
const sessions = new Map();

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
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
    if (prev && prev.ws !== ws) {
      prev.turnId++;
      try { prev.ws.close(1000, "Replaced by newer connection"); } catch {}
    }

    const entry = { ws, turnId: prev ? prev.turnId + 1 : 1 };
    sessions.set(sessionId, entry);

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === "stop") {
          // 递增 turnId 即可立即使正在进行的合成与推帧失效
          entry.turnId++;
        }
      } catch {
        // ignore malformed control messages
      }
    });

    ws.on("close", () => {
      if (sessions.get(sessionId)?.ws === ws) {
        entry.turnId++;
        sessions.delete(sessionId);
      }
    });

    ws.on("error", () => {
      if (sessions.get(sessionId)?.ws === ws) {
        entry.turnId++;
        sessions.delete(sessionId);
      }
    });
  });
}

export function hasTtsClient(sessionId) {
  const entry = sessions.get(sessionId);
  return Boolean(entry && entry.ws.readyState === WebSocket.OPEN);
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
 * 接收 LLM 文本增量 -> 后端切句 -> 复用 Edge-TTS WebSocket 合成 -> 实时推 MP3 帧给前端
 */
export function createTtsSideChannel(sessionId, { voice = DEFAULT_VOICE } = {}) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.ws.readyState !== WebSocket.OPEN) {
    return null;
  }

  const turnId = ++entry.turnId;
  const ws = entry.ws;
  const isActive = () => sessions.get(sessionId)?.turnId === turnId && ws.readyState === WebSocket.OPEN;

  let rawBuffer = "";
  let offset = 0;
  let emitted = 0;
  let sentenceIndex = 0;
  let started = false;
  let finished = false;

  // 串行发送队列：前一句正在推流时，后一句的 Promise 已经并发开始合成（零句间停顿）
  let sendChain = Promise.resolve();

  const enqueueSentence = (sentenceText) => {
    const clean = sanitizeTextForTTS(sentenceText);
    if (!clean || !isActive()) return;

    const idx = sentenceIndex++;
    if (!started) {
      started = true;
      sendJson(ws, { type: "tts_start", turnId });
    }

    // 立即启动 Edge-TTS 合成；若轮到自己时直接透传，否则先暂存缓冲
    let isCurrent = false;
    let buffered = [];
    let synthDone = false;
    let synthErr = null;
    let notifyFlush = null;

    const synthPromise = streamEdgeTTS(clean, voice, (chunk) => {
      if (!isActive()) {
        throw new Error("TTS turn aborted");
      }
      if (isCurrent) {
        ws.send(chunk);
      } else {
        buffered.push(chunk);
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

      sendJson(ws, { type: "sentence_start", turnId, index: idx });
      isCurrent = true;

      for (const c of buffered) {
        if (!isActive()) return;
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
      if (isActive()) {
        sendJson(ws, { type: "sentence_end", turnId, index: idx });
      }
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
      sendChain = sendChain.then(() => {
        if (started && isActive()) {
          sendJson(ws, { type: "tts_end", turnId });
        }
      });
    },
    abort() {
      finished = true;
      if (sessions.get(sessionId)?.turnId === turnId) {
        entry.turnId++;
      }
    },
  };
}
