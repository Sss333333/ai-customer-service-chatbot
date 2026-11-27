import crypto from "crypto";
import { WebSocket } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const DASHSCOPE_WS_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export const DEFAULT_DASHSCOPE_ASR_MODEL = "qwen-audio-3.1-asr-flash-streaming";
export const MODEL_PARAFORMER_REALTIME_V2 = DEFAULT_DASHSCOPE_ASR_MODEL;

/**
 * 规范化并校验音频格式
 * @param {string} filenameOrFormat 
 * @returns {string}
 */
export function normalizeAudioFormat(filenameOrFormat) {
  if (!filenameOrFormat) return "wav";
  const lower = filenameOrFormat.toLowerCase();
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mp3")) return "mp3";
  if (lower.includes("pcm") || lower.includes("raw")) return "pcm";
  if (lower.includes("opus") || lower.includes("ogg") || lower.includes("webm")) return "opus";
  if (lower.includes("m4a") || lower.includes("aac")) return "aac";
  return "wav";
}

function getAudioSampleRate(audioBuffer, format) {
  if (format === "wav" && audioBuffer.length >= 28 && audioBuffer.toString("ascii", 0, 4) === "RIFF") {
    return audioBuffer.readUInt32LE(24);
  }
  if (format === "mp3") {
    return 24000;
  }
  return 16000;
}

export class ParaformerClient {
  constructor(apiKey, model) {
    this.apiKey = apiKey || process.env.DASHSCOPE_API_KEY || "";
    this.model = model || process.env.DASHSCOPE_ASR_MODEL || DEFAULT_DASHSCOPE_ASR_MODEL;
    this.endpoint = DASHSCOPE_WS_ENDPOINT;
    this.sampleRate = 16000;
  }

  _buildWsOptions() {
    const wsOptions = {
      headers: {
        Authorization: `Bearer ${this.apiKey}`
      }
    };

    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    if (proxyUrl) {
      try {
        wsOptions.agent = new HttpsProxyAgent(proxyUrl);
      } catch {}
    }

    return wsOptions;
  }

  /**
   * 创建实时双向流式转写会话（用于前端按住说话实时出字幕）
   * @param {{
   *   onStarted?: () => void,
   *   onTranscript?: (payload: { text: string, isFinal: boolean }) => void,
   *   onFinished?: (payload: { text: string }) => void,
   *   onError?: (err: Error) => void
   * }} handlers
   */
  createRealtimeSession(handlers = {}) {
    if (!this.apiKey) {
      throw new Error("DASHSCOPE_API_KEY is not configured in environment");
    }

    const { onStarted, onTranscript, onFinished, onError } = handlers;
    const taskId = crypto.randomUUID().replace(/-/g, "");
    const ws = new WebSocket(this.endpoint, this._buildWsOptions());

    let fullText = "";
    let lastSentence = "";
    let taskStarted = false;
    let finishRequested = false;
    let isEnded = false;
    const pendingChunks = [];

    const safeError = (err) => {
      if (isEnded) return;
      isEnded = true;
      try { ws.close(); } catch {}
      onError?.(err instanceof Error ? err : new Error(String(err)));
    };

    const sendFinishTask = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        header: {
          action: "finish-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          input: {}
        }
      }));
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: this.model,
          parameters: {
            format: "pcm",
            sample_rate: this.sampleRate,
            semantic_punctuation_enabled: true
          },
          input: {}
        }
      }));
    });

    ws.on("message", (data) => {
      let resp;
      try {
        resp = JSON.parse(data.toString());
      } catch {
        return;
      }

      const header = resp?.header || {};
      const event = header.event;

      if (event === "task-started") {
        taskStarted = true;
        while (pendingChunks.length > 0 && ws.readyState === WebSocket.OPEN) {
          ws.send(pendingChunks.shift());
        }
        onStarted?.();
        if (finishRequested) {
          sendFinishTask();
        }
        return;
      }

      if (event === "task-failed" || header.error_message) {
        if (header.error_code === "NO_VALID_AUDIO_ERROR") {
          return safeError(new Error("未检测到有效语音输入，请靠近麦克风重新说话"));
        }
        return safeError(new Error(`百炼 ASR 错误 [${header.error_code || "FAIL"}]: ${header.error_message}`));
      }

      if (event === "result-generated") {
        const sentence = resp?.payload?.output?.sentence;
        if (sentence) {
          if (sentence.sentence_end) {
            if (sentence.text) {
              fullText += sentence.text;
            }
            lastSentence = "";
          } else {
            lastSentence = sentence.text || "";
          }
          onTranscript?.({
            text: (fullText + lastSentence).trim(),
            isFinal: false
          });
        }
        return;
      }

      if (event === "task-finished") {
        if (!isEnded) {
          isEnded = true;
          try { ws.close(); } catch {}
          if (lastSentence) {
            fullText += lastSentence;
            lastSentence = "";
          }
          onFinished?.({ text: fullText.trim() });
        }
      }
    });

    ws.on("error", (err) => {
      safeError(new Error(`WebSocket error: ${err.message}`));
    });

    ws.on("close", () => {
      if (!isEnded) {
        const combined = (fullText + lastSentence).trim();
        if (combined) {
          isEnded = true;
          onFinished?.({ text: combined });
        } else {
          safeError(new Error("Connection closed before transcription completed"));
        }
      }
    });

    return {
      sendAudio(chunk) {
        if (isEnded || finishRequested || !chunk || chunk.length === 0) return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!taskStarted) {
          // 缓存握手期间的前几帧音频，避免开头吞字（上限约 5 秒）
          if (pendingChunks.length < 50) {
            pendingChunks.push(buf);
          }
          return;
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(buf);
        }
      },
      finish() {
        if (isEnded || finishRequested) return;
        finishRequested = true;
        if (taskStarted) {
          sendFinishTask();
        }
      },
      close() {
        if (!isEnded) {
          isEnded = true;
          try { ws.close(); } catch {}
        }
      }
    };
  }

  /**
   * 一次性录音转写
   * @param {Buffer} audioBuffer - 音频二进制数据
   * @param {string} [filenameOrFormat] - 原始文件名或格式
   * @returns {Promise<string>}
   */
  async transcribeOnce(audioBuffer, filenameOrFormat = "audio.wav") {
    if (!this.apiKey) {
      throw new Error("DASHSCOPE_API_KEY is not configured in environment");
    }

    const format = normalizeAudioFormat(filenameOrFormat);
    const sampleRate = getAudioSampleRate(audioBuffer, format);
    const taskId = crypto.randomUUID().replace(/-/g, "");
    const wsOptions = this._buildWsOptions();

    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(this.endpoint, wsOptions);
      } catch (err) {
        return reject(new Error(`Failed to initialize WebSocket: ${err.message}`));
      }

      let fullText = "";
      let lastSentence = "";
      let taskStarted = false;
      let isEnded = false;

      const timeout = setTimeout(() => {
        if (!isEnded) {
          isEnded = true;
          try { ws.close(); } catch {}
          reject(new Error("Timeout waiting for transcription response"));
        }
      }, 20000);

      ws.on("open", () => {
        // 1. 发送 run-task 指令
        const runMsg = {
          header: {
            action: "run-task",
            task_id: taskId,
            streaming: "duplex"
          },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: this.model,
            parameters: {
              format: format,
              sample_rate: sampleRate,
              semantic_punctuation_enabled: true
            },
            input: {}
          }
        };
        ws.send(JSON.stringify(runMsg));
      });

      ws.on("message", async (data) => {
        let resp;
        try {
          resp = JSON.parse(data.toString());
        } catch {
          return;
        }

        const header = resp?.header || {};
        const event = header.event;

        if (event === "task-started") {
          taskStarted = true;
          // 服务端已就绪，按 100ms 帧长分块推流 (16k 16bit 单声道 3200 字节)
          const chunkSize = 3200;
          for (let offset = 0; offset < audioBuffer.length; offset += chunkSize) {
            const chunk = audioBuffer.subarray(offset, Math.min(offset + chunkSize, audioBuffer.length));
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
              // 轻微让出事件循环，模拟真实音频流
              await new Promise((r) => setTimeout(r, 8));
            }
          }

          // 发送 finish-task 指令
          if (ws.readyState === WebSocket.OPEN) {
            const finishMsg = {
              header: {
                action: "finish-task",
                task_id: taskId,
                streaming: "duplex"
              },
              payload: {
                input: {}
              }
            };
            ws.send(JSON.stringify(finishMsg));
          }
        }

        if (event === "task-failed" || header.error_message) {
          if (!isEnded) {
            isEnded = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            if (header.error_code === "NO_VALID_AUDIO_ERROR") {
              return reject(new Error("未检测到有效语音输入（音频为空或无清晰人声），请靠近麦克风重新说话"));
            }
            return reject(new Error(`百炼 ASR 错误 [${header.error_code || "FAIL"}]: ${header.error_message}`));
          }
        }

        if (event === "result-generated") {
          const sentence = resp?.payload?.output?.sentence;
          if (sentence) {
            if (sentence.sentence_end) {
              if (sentence.text) {
                fullText += sentence.text;
              }
              lastSentence = "";
            } else {
              lastSentence = sentence.text || "";
            }
          }
        }

        if (event === "task-finished") {
          if (!isEnded) {
            isEnded = true;
            clearTimeout(timeout);
            try { ws.close(); } catch {}
            if (lastSentence) {
              fullText += lastSentence;
            }
            const finalText = fullText.trim();
            if (!finalText) {
              return reject(new Error("未识别到有效文字，请重试"));
            }
            return resolve(finalText);
          }
        }
      });

      ws.on("error", (err) => {
        if (!isEnded) {
          isEnded = true;
          clearTimeout(timeout);
          reject(new Error(`WebSocket error: ${err.message}`));
        }
      });

      ws.on("close", () => {
        if (!isEnded) {
          isEnded = true;
          clearTimeout(timeout);
          if (fullText.trim()) {
            resolve(fullText.trim());
          } else {
            reject(new Error("Connection closed before transcription completed"));
          }
        }
      });
    });
  }
}
