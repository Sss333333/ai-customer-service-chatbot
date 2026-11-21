import { ProxyAgent, setGlobalDispatcher } from "undici";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  stepCountIs,
  streamText,
  toUIMessageStream
} from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { SYSTEM_PROMPT } from "./prompt.js";
import { createAiSdkTools } from "../tools/index.js";
import { createTtsSideChannel, hasTtsClient } from "../audio/ttsWsServer.js";

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

// 仅在显式配置了代理环境变量时启用代理
const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY || "";
if (proxyUrl) {
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch (err) {
    console.warn("[OpenRouter] ProxyAgent setup skipped:", err.message);
  }
}

/**
 * 超时预算（层层嵌套，外层必须比内层长）：
 *   - AWS Lambda 环境：API Gateway HTTP API (~30s 硬上限) > Lambda Timeout (29s) > 默认 25s
 *   - 本地/常驻服务环境：默认 120s（留足推理模型思考 + 多步工具调用时间）
 */
const DEFAULT_DEADLINE_MS = isLambda ? 25000 : 120000;
const CHAT_DEADLINE_MS = Number(process.env.CHAT_DEADLINE_MS) || DEFAULT_DEADLINE_MS;
const RESPONSE_SAFETY_MS = 1000;
const MIN_REQUEST_MS = 4000;

/**
 * 将前端 UIMessage 数组或普通消息数组统一转换为 AI SDK ModelMessage 数组
 */
async function toAiSdkModelMessages(messages) {
  const isUIMessageFormat = messages.some(m => Array.isArray(m.parts));
  if (isUIMessageFormat) {
    return await convertToModelMessages(messages);
  }
  return messages.map(msg => ({
    role: msg.role === "assistant" ? "assistant" : "user",
    content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content)
  }));
}

/**
 * Vercel AI SDK 流式对话（供前端 @ai-sdk/react 的 useChat() 使用）
 * 参考 F:\Workspace\ai-sdk-preview-rag-study\app\(preview)\api\chat\route.ts
 *
 * @param {Array} messages - UIMessage[] 消息历史
 * @param {string} caseRef - 工单会话引用号
 * @returns {Promise<Response>} - AI SDK UIMessageStream Response
 */
export async function streamChatWithOpenRouter(messages, caseRef, { autoSpeak = false } = {}) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured in environment variables.");
  }

  const baseURL = process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL;
  const modelId = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free";
  const deadlineMs = Number(process.env.CHAT_DEADLINE_MS) || CHAT_DEADLINE_MS;

  const openrouter = createOpenRouter({
    baseURL,
    apiKey,
    headers: {
      "HTTP-Referer": process.env.PUBLIC_FRONTEND_URL || "https://example.com",
      "X-OpenRouter-Title": "Nova AI Customer Service"
    },
    extraBody: {
      include_reasoning: true
    }
  });

  const modelMessages = await toAiSdkModelMessages(messages);

  const result = streamText({
    model: openrouter(modelId),
    system: SYSTEM_PROMPT,
    messages: modelMessages,
    stopWhen: stepCountIs(5),
    temperature: 0.2,
    maxOutputTokens: 2048,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(Math.max(deadlineMs - RESPONSE_SAFETY_MS, MIN_REQUEST_MS)),
    tools: createAiSdkTools({
      caseRef,
      conversationMessages: messages
    })
  });

  let uiStream = toUIMessageStream({
    stream: result.stream,
    tools: result.tools
  });

  // WebSocket 旁路：开启自动朗读且前端已连上 /ws/tts 时，后端直接切句并推送音频帧
  if (autoSpeak && caseRef && hasTtsClient(caseRef)) {
    const sideChannel = createTtsSideChannel(caseRef);
    if (sideChannel) {
      uiStream = uiStream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            if (chunk?.type === "text-delta" && chunk.delta) {
              sideChannel.pushDelta(chunk.delta);
            }
            controller.enqueue(chunk);
          },
          flush() {
            sideChannel.finish();
          },
          cancel() {
            sideChannel.abort();
          }
        })
      );
    }
  }

  return createUIMessageStreamResponse({
    stream: uiStream
  });
}
