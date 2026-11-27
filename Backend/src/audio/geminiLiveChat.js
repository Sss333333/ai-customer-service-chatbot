import { WebSocket } from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SYSTEM_PROMPT } from "../ai/prompt.js";
import { executeTool } from "../erp/tools/index.js";
import * as getProductInfo from "../erp/tools/getProductInfo.js";
import * as startWarranty from "../erp/tools/startWarranty.js";
import * as checkOrder from "../erp/tools/checkOrder.js";
import * as getInformation from "../erp/tools/getInformation.js";

export const DEFAULT_GEMINI_LIVE_CHAT_MODEL =
  process.env.GEMINI_LIVE_CHAT_MODEL || "gemini-3.1-flash-live-preview";

const LIVE_WEBSOCKET_BASE_URL =
  process.env.GEMINI_LIVE_WEBSOCKET_BASE_URL ||
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const LIVE_CONNECT_TIMEOUT_MS =
  Number(process.env.GEMINI_LIVE_CONNECT_TIMEOUT_MS) || 12000;

const LIVE_VOICE_NAME = process.env.GEMINI_LIVE_VOICE || "Aoede";

const VOICE_CALL_ADDENDUM = `
LIVE VOICE CALL MODE RULES:
- You are currently in a real-time voice phone call with the customer.
- Speak naturally, warmly, and concisely (1 to 3 short spoken sentences per turn).
- Do NOT read raw Markdown syntax, bullet symbols, or long raw URLs aloud.
- When calling a tool (knowledge base, NetSuite product/order/case lookup), summarize the result clearly in spoken language.
- If creating a NetSuite support case requires the customer's email address or photos, politely ask them to type their email or upload photos in the chat box so there are no spelling mistakes.
`;

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
    console.warn("[gemini-live-chat] ProxyAgent init skipped:", err?.message || err);
    return undefined;
  }
}

function buildGeminiWsUrl(apiKey) {
  const base = LIVE_WEBSOCKET_BASE_URL.replace(/\/+$/, "");
  return `${base}?key=${encodeURIComponent(apiKey)}`;
}

function buildFunctionDeclarations() {
  const defs = [
    getInformation.schema,
    getProductInfo.schema,
    checkOrder.schema,
    startWarranty.checkCaseStatusSchema,
    startWarranty.schema,
  ];

  return defs
    .filter(Boolean)
    .map((s) => ({
      name: s.name,
      description: s.description,
      parameters: s.input_schema,
    }));
}

function buildSetupMessage(modelName) {
  const normalizedModel = modelName.startsWith("models/")
    ? modelName
    : `models/${modelName}`;

  return {
    setup: {
      model: normalizedModel,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: LIVE_VOICE_NAME,
            },
          },
        },
      },
      systemInstruction: {
        parts: [{ text: `${SYSTEM_PROMPT}\n${VOICE_CALL_ADDENDUM}` }],
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [
        {
          functionDeclarations: buildFunctionDeclarations(),
        },
      ],
    },
  };
}

/**
 * Create a bidirectional Gemini Live AI voice chat session (default: gemini-3.1-flash-live-preview).
 * Supports 16kHz PCM input -> 24kHz PCM output + transcriptions + business tool calls.
 */
export async function createGeminiLiveChatSession({
  caseRef = "",
  conversationMessages = [],
  model = DEFAULT_GEMINI_LIVE_CHAT_MODEL,
  onUserTranscript,
  onAssistantTranscript,
  onAudio,
  onInterrupted,
  onTurnComplete,
  onToolStatus,
  onError,
}) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey || apiKey.startsWith("your-")) {
    throw new Error("未配置 GEMINI_API_KEY，请在 Backend/.env 中配置后再使用实时语音通话");
  }

  const url = buildGeminiWsUrl(apiKey);
  const agent = getProxyAgent();
  const ws = new WebSocket(url, agent ? { agent } : undefined);

  let closed = false;
  const cancelledCallIds = new Set();
  const historyRef = Array.isArray(conversationMessages) ? [...conversationMessages] : [];

  async function handleToolCalls(functionCalls) {
    const functionResponses = [];

    for (const call of functionCalls) {
      const name = call.name;
      const id = call.id;
      const args = call.args || {};

      if (cancelledCallIds.has(id)) {
        cancelledCallIds.delete(id);
        continue;
      }

      console.log(`[gemini-live-chat] toolCall name=${name} id=${id}`);
      onToolStatus?.({ toolName: name, status: "running" });

      let result;
      try {
        const execArgs =
          name === "start_warranty_claim"
            ? { ...args, caseRef, conversationMessages: historyRef }
            : args;
        result = await executeTool(name, execArgs);
      } catch (err) {
        console.error(`[gemini-live-chat] tool error (${name}):`, err?.message || err);
        result = { error: err?.message || String(err) };
      }

      onToolStatus?.({ toolName: name, status: "done" });

      if (cancelledCallIds.has(id)) {
        cancelledCallIds.delete(id);
        continue;
      }

      functionResponses.push({
        id,
        name,
        response:
          typeof result === "object" && result !== null
            ? { result }
            : { result: String(result ?? "") },
      });
    }

    if (!closed && ws.readyState === WebSocket.OPEN && functionResponses.length > 0) {
      ws.send(JSON.stringify({ toolResponse: { functionResponses } }));
    }
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`Gemini Live 连接超时 (${LIVE_CONNECT_TIMEOUT_MS}ms)`));
    }, LIVE_CONNECT_TIMEOUT_MS);

    let setupDone = false;

    ws.on("open", () => {
      console.log(`[gemini-live-chat] opened model=${model} voice=${LIVE_VOICE_NAME}`);
      ws.send(JSON.stringify(buildSetupMessage(model)));
    });

    ws.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf-8"));
      } catch {
        return;
      }

      if (message.setupComplete && !setupDone) {
        setupDone = true;
        clearTimeout(timer);
        console.log(`[gemini-live-chat] setupComplete model=${model}`);
        resolve();
        return;
      }

      if (message.toolCallCancellation?.ids?.length) {
        for (const id of message.toolCallCancellation.ids) {
          cancelledCallIds.add(id);
        }
      }

      if (message.toolCall?.functionCalls?.length) {
        handleToolCalls(message.toolCall.functionCalls).catch((err) => {
          console.error("[gemini-live-chat] handleToolCalls failed:", err);
        });
      }

      const content = message.serverContent;
      if (!content) return;

      if (content.interrupted) {
        onInterrupted?.();
      }

      const userText = content.inputTranscription?.text;
      if (userText) {
        onUserTranscript?.(userText);
      }

      const assistantText = content.outputTranscription?.text;
      if (assistantText) {
        onAssistantTranscript?.(assistantText);
      }

      for (const part of content.modelTurn?.parts || []) {
        const b64 = part.inlineData?.data;
        if (!b64) continue;
        onAudio?.(Buffer.from(b64, "base64"));
      }

      if (content.turnComplete) {
        onTurnComplete?.();
      }
    });

    ws.on("error", (err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[gemini-live-chat] ws error:", error.message);
      if (!setupDone) {
        clearTimeout(timer);
        reject(error);
      } else if (!closed) {
        onError?.(error);
      }
    });

    ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString("utf-8") : "";
      console.log(`[gemini-live-chat] closed code=${code} reason=${reason}`);
      if (!setupDone) {
        clearTimeout(timer);
        reject(new Error(`Gemini Live 握手失败 (code=${code} ${reason})`));
      } else if (!closed && code !== 1000) {
        onError?.(new Error(`Gemini Live 连接断开 (code=${code} ${reason})`));
      }
    });
  });

  return {
    model,

    sendHistory(turns) {
      if (closed || ws.readyState !== WebSocket.OPEN || !Array.isArray(turns) || turns.length === 0) {
        return;
      }
      const formatted = turns
        .filter((t) => t?.text && (t.role === "user" || t.role === "assistant"))
        .slice(-12)
        .map((t) => ({
          role: t.role === "assistant" ? "model" : "user",
          parts: [{ text: String(t.text).slice(0, 1000) }],
        }));

      if (formatted.length === 0) return;

      for (const t of turns) {
        if (t?.text) historyRef.push({ role: t.role, content: t.text });
      }

      ws.send(
        JSON.stringify({
          clientContent: {
            turns: formatted,
            turnComplete: false,
          },
        })
      );
    },

    appendTranscriptToHistory(role, text) {
      if (text) historyRef.push({ role, content: text });
    },

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

    close() {
      if (closed) return;
      closed = true;
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
        }
      } catch {}
      try {
        ws.close(1000, "client_closed");
      } catch {}
    },
  };
}
