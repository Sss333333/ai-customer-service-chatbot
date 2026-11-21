import { WebSocket } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const LIVE_TRANSLATE_MODEL =
  process.env.GEMINI_LIVE_TRANSLATE_MODEL || "gemini-3.5-live-translate-preview";
const LIVE_WEBSOCKET_BASE_URL =
  process.env.GEMINI_LIVE_WEBSOCKET_BASE_URL ||
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const LIVE_CONNECT_TIMEOUT_MS =
  Number(process.env.GEMINI_LIVE_CONNECT_TIMEOUT_MS) || 10000;
const LIVE_DRAIN_MIN_MS = Number(process.env.GEMINI_LIVE_DRAIN_MIN_MS) || 600;
const LIVE_DRAIN_IDLE_MS = Number(process.env.GEMINI_LIVE_DRAIN_IDLE_MS) || 500;
const LIVE_DRAIN_MAX_MS = Number(process.env.GEMINI_LIVE_DRAIN_MAX_MS) || 2500;

function getProxyAgent() {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    "";
  if (!proxyUrl) return undefined;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (err) {
    console.warn("[gemini-live] ProxyAgent init skipped:", err?.message || err);
    return undefined;
  }
}

function buildGeminiWsUrl(apiKey) {
  const base = LIVE_WEBSOCKET_BASE_URL.replace(/\/+$/, "");
  return `${base}?key=${encodeURIComponent(apiKey)}`;
}

function buildSetupMessage(targetLanguage) {
  return {
    setup: {
      model: `models/${LIVE_TRANSLATE_MODEL}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        translationConfig: {
          targetLanguageCode: targetLanguage,
          echoTargetLanguage: true,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDrain(getLastMessageAt) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < LIVE_DRAIN_MAX_MS) {
    const elapsed = Date.now() - startedAt;
    const idle = Date.now() - getLastMessageAt();
    if (elapsed >= LIVE_DRAIN_MIN_MS && idle >= LIVE_DRAIN_IDLE_MS) {
      return;
    }
    await delay(Math.min(100, Math.max(20, LIVE_DRAIN_IDLE_MS - idle)));
  }
}

/**
 * 创建一条单向 Gemini Live Translate 会话（参考 interpreter-node/src/server/gemini-live.ts）
 * @param {{
 *   targetLanguage: "zh-Hans" | "en",
 *   onTranscript?: (evt: { sourceText?: string, translatedText?: string, targetLanguage: string }) => void,
 *   onAudio?: (evt: { audio: Buffer, targetLanguage: string }) => void,
 *   onError?: (err: Error) => void
 * }} options
 * @returns {Promise<{ sendAudio: (pcm16: Buffer | Uint8Array) => void, close: () => Promise<void> }>}
 */
export async function createGeminiLiveTranslateSession({
  targetLanguage,
  onTranscript,
  onAudio,
  onError,
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 GEMINI_API_KEY，请在 NewBackend/.env 中添加后再使用跨语言语音翻译");
  }

  const url = buildGeminiWsUrl(apiKey);
  const agent = getProxyAgent();
  const ws = new WebSocket(url, agent ? { agent } : undefined);

  let lastServerMessageAt = Date.now();
  let closed = false;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`Gemini Live 连接超时 (${LIVE_CONNECT_TIMEOUT_MS}ms)`));
    }, LIVE_CONNECT_TIMEOUT_MS);

    let setupDone = false;

    ws.on("open", () => {
      console.log(`[gemini-live] opened target=${targetLanguage} model=${LIVE_TRANSLATE_MODEL}`);
      ws.send(JSON.stringify(buildSetupMessage(targetLanguage)));
    });

    ws.on("message", (raw) => {
      lastServerMessageAt = Date.now();
      let message;
      try {
        message = JSON.parse(raw.toString("utf-8"));
      } catch {
        return;
      }

      if (message.setupComplete && !setupDone) {
        setupDone = true;
        clearTimeout(timer);
        console.log(`[gemini-live] setupComplete target=${targetLanguage}`);
        resolve();
      }

      const content = message.serverContent;
      if (!content) return;

      const sourceText = content.inputTranscription?.text;
      const translatedText = content.outputTranscription?.text;
      if (sourceText || translatedText) {
        onTranscript?.({
          sourceText,
          translatedText,
          targetLanguage,
        });
      }

      for (const part of content.modelTurn?.parts || []) {
        const b64 = part.inlineData?.data;
        if (!b64) continue;
        onAudio?.({
          audio: Buffer.from(b64, "base64"),
          targetLanguage,
        });
      }
    });

    ws.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[gemini-live] error target=${targetLanguage}:`, error.message);
      if (!setupDone) {
        clearTimeout(timer);
        reject(error);
      } else if (!closed) {
        onError?.(error);
      }
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf-8") : "";
      console.log(`[gemini-live] closed target=${targetLanguage} code=${code} reason=${reason}`);
      if (!setupDone) {
        clearTimeout(timer);
        reject(new Error(`Gemini Live 在握手完成前关闭 (code=${code} ${reason})`));
      } else if (!closed && code !== 1000) {
        onError?.(new Error(`Gemini Live 连接断开 (code=${code} ${reason})`));
      }
    });
  });

  return {
    sendAudio(pcm16) {
      if (closed || ws.readyState !== WebSocket.OPEN || !pcm16 || pcm16.byteLength === 0) {
        return;
      }
      ws.send(
        JSON.stringify({
          realtimeInput: {
            audio: {
              data: Buffer.from(pcm16).toString("base64"),
              mimeType: "audio/pcm;rate=16000",
            },
          },
        })
      );
    },

    async close() {
      if (closed) return;
      closed = true;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
          await waitForDrain(() => lastServerMessageAt);
        }
      } catch {
        // ignore drain errors
      }
      try {
        ws.close(1000, "session_closed");
      } catch {}
    },
  };
}
