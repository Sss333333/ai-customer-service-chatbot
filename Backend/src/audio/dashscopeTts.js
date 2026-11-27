import crypto from "node:crypto";
import { WebSocket } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const DASHSCOPE_WS_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export const DEFAULT_DASHSCOPE_TTS_MODEL = "qwen-audio-3.1-tts-flash";
export const DEFAULT_DASHSCOPE_TTS_VOICE = "longanhuan_v3.1";

export function isDashScopeTtsEnabled() {
  const key = (process.env.DASHSCOPE_API_KEY || "").trim();
  return Boolean(key && !key.startsWith("your-"));
}

export function getDashScopeTtsConfig() {
  return {
    model: (process.env.DASHSCOPE_TTS_MODEL || DEFAULT_DASHSCOPE_TTS_MODEL).trim(),
    voice: (process.env.DASHSCOPE_TTS_VOICE || DEFAULT_DASHSCOPE_TTS_VOICE).trim(),
  };
}

function buildWsOptions(apiKey) {
  const opts = {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "";
  if (proxyUrl) {
    try {
      opts.agent = new HttpsProxyAgent(proxyUrl);
    } catch {}
  }
  return opts;
}

/**
 * Create a bidirectional streaming DashScope TTS session (qwen-audio-3.1-tts-flash).
 * - One WebSocket per turn: push incremental text via sendText(), receive binary PCM/MP3 chunks via onAudioChunk().
 * - Call finish() when all text has been sent; call abort() to cancel immediately.
 */
export function createDashScopeTtsStream({
  format = "pcm",
  sampleRate = 24000,
  voice,
  model,
  onAudioChunk,
  onError,
} = {}) {
  const apiKey = (process.env.DASHSCOPE_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("your-")) {
    throw new Error("DASHSCOPE_API_KEY is not configured");
  }

  const cfg = getDashScopeTtsConfig();
  const useModel = model || cfg.model;
  const useVoice = voice || cfg.voice;
  const taskId = crypto.randomUUID().replace(/-/g, "");
  const ws = new WebSocket(DASHSCOPE_WS_ENDPOINT, buildWsOptions(apiKey));

  let taskStarted = false;
  let finishRequested = false;
  let closed = false;
  const pendingTexts = [];

  let resolveDone;
  let rejectDone;
  const donePromise = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });
  // Prevent unhandled rejection if caller aborts before awaiting finish()
  donePromise.catch(() => {});

  const fail = (err) => {
    if (closed) return;
    closed = true;
    const error = err instanceof Error ? err : new Error(String(err));
    try { ws.close(); } catch {}
    onError?.(error);
    rejectDone(error);
  };

  const sendContinue = (text) => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        header: {
          action: "continue-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          input: { text },
        },
      })
    );
  };

  const sendFinish = () => {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    ws.send(
      JSON.stringify({
        header: {
          action: "finish-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          input: {},
        },
      })
    );
  };

  ws.on("open", () => {
    if (closed) {
      try { ws.close(); } catch {}
      return;
    }
    ws.send(
      JSON.stringify({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "tts",
          function: "SpeechSynthesizer",
          model: useModel,
          parameters: {
            text_type: "PlainText",
            voice: useVoice,
            format,
            sample_rate: sampleRate,
            volume: 50,
            rate: 1.0,
            pitch: 1.0,
          },
          input: {},
        },
      })
    );
  });

  ws.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (buf.length > 0) {
        try {
          onAudioChunk?.(buf);
        } catch (err) {
          fail(err);
        }
      }
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString("utf-8"));
    } catch {
      return;
    }

    const evt = msg?.header?.event;
    if (evt === "task-started") {
      taskStarted = true;
      while (pendingTexts.length > 0 && !closed) {
        sendContinue(pendingTexts.shift());
      }
      if (finishRequested && !closed) {
        sendFinish();
      }
    } else if (evt === "task-finished") {
      closed = true;
      try { ws.close(1000, "done"); } catch {}
      resolveDone();
    } else if (evt === "task-failed") {
      const errMsg = msg?.header?.error_message || msg?.header?.error_code || "DashScope TTS task failed";
      fail(new Error(`DashScope TTS failed: ${errMsg}`));
    }
  });

  ws.on("error", (err) => {
    fail(err);
  });

  ws.on("close", (code, reasonBuf) => {
    if (!closed) {
      const reason = reasonBuf ? reasonBuf.toString("utf-8") : "";
      fail(new Error(`DashScope TTS WebSocket closed unexpectedly (code=${code} ${reason})`));
    }
  });

  return {
    sendText(text) {
      if (closed || finishRequested || !text) return;
      if (taskStarted) {
        sendContinue(text);
      } else {
        pendingTexts.push(text);
      }
    },

    finish() {
      if (closed) return donePromise;
      if (!finishRequested) {
        finishRequested = true;
        if (taskStarted) {
          sendFinish();
        }
      }
      return donePromise;
    },

    abort() {
      if (closed) return;
      closed = true;
      pendingTexts.length = 0;
      try { ws.close(1000, "aborted"); } catch {}
      resolveDone();
    },
  };
}

/**
 * Single-utterance streaming helper for /ws/tts MP3 fallback mode.
 */
export async function streamDashScopeTTS(text, { format = "mp3", sampleRate = 24000, voice, model } = {}, onChunk) {
  if (!text) return;
  let aborted = false;
  const stream = createDashScopeTtsStream({
    format,
    sampleRate,
    voice,
    model,
    onAudioChunk: (chunk) => {
      if (aborted) return;
      try {
        onChunk?.(chunk);
      } catch (err) {
        aborted = true;
        stream.abort();
        throw err;
      }
    },
  });
  stream.sendText(text);
  await stream.finish();
}
