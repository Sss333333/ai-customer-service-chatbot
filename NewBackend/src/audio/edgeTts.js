import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { HttpsProxyAgent } from "https-proxy-agent";

const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";
const OUTPUT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

/**
 * 获取代理 Agent（若存在 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY 则启用）
 */
function getProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (proxyUrl) {
    try {
      return new HttpsProxyAgent(proxyUrl);
    } catch (e) {
      console.warn("[TTS] Failed to initialize proxy agent:", e.message);
    }
  }
  return undefined;
}

/**
 * 全局唯一的 Edge-TTS 客户端 —— 所有请求复用同一条 WebSocket
 *
 * - 连接只在第一次请求时建立（setMetadata 只调用一次）
 * - 多个句子可并发合成：库内部按 X-RequestId 把音频分发到各自的流
 * - 被微软服务器回收（空闲断开）后，下一次发送时库会自动重连
 * - 音色写在每次请求的 SSML 里，而不是 setMetadata，
 *   因此切换音色也不需要重建连接
 */
let client = null;
let clientReady = null;

function getClient() {
  if (!clientReady) {
    client = new MsEdgeTTS({ agent: getProxyAgent() });
    clientReady = client
      .setMetadata(DEFAULT_VOICE, OUTPUT)
      .then(() => client)
      .catch((err) => {
        // 首次建连失败：重置，下次请求重新尝试
        try { client?.close(); } catch {}
        client = null;
        clientReady = null;
        throw err;
      });
  }
  return clientReady;
}

/** 文本放进 SSML 前做 XML 转义，避免 & < > 导致合成失败 */
function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSSML(text, voice) {
  const lang = /\b[a-z]{2,}-[A-Z]{2}\b/.exec(voice)?.[0] || "zh-CN";
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
}

/**
 * 预热连接（可在服务启动时调用，让第一句也不用等握手）
 */
export function warmupEdgeTTS() {
  return getClient().then(
    () => console.log("[TTS] Edge-TTS WebSocket connected"),
    (err) => console.warn("[TTS] Edge-TTS warmup failed:", err?.message || err)
  );
}

/**
 * 流式调用微软 Edge-TTS 合成 MP3 语音切片（复用全局 WebSocket）
 * @param {string} text - 待合成文本
 * @param {string} [voice] - 发音人音色，默认 zh-CN-XiaoxiaoNeural
 * @param {(chunk: Buffer) => Promise<void>|void} onChunk - 收到音频切片的回调
 * @returns {Promise<void>}
 */
export async function streamEdgeTTS(text, voice = DEFAULT_VOICE, onChunk) {
  const tts = await getClient();
  const { audioStream } = tts.rawToStream(buildSSML(text, voice));

  return new Promise((resolve, reject) => {
    audioStream.on("data", async (chunk) => {
      try {
        await onChunk(chunk);
      } catch (err) {
        // 客户端断开：只销毁本次请求的流，共享连接保持不动
        audioStream.destroy();
        resolve();
      }
    });

    audioStream.on("end", () => {
      resolve();
    });

    audioStream.on("error", (err) => {
      reject(err);
    });
  });
}
