import { streamChatWithOpenRouter } from "../ai/openrouter.js";
import { getUploadPresignedUrl } from "./s3.js";
import { DashScopeAsrClient } from "../audio/dashscopeAsr.js";
import { parseAudioUpload } from "../audio/multipart.js";
import { interruptTtsSession } from "../audio/ttsWsServer.js";

/**
 * Handle incoming API requests
 * @param {string} method - HTTP method (GET, POST, OPTIONS, etc.)
 * @param {string} pathname - URL pathname
 * @param {object} headers - HTTP headers
 * @param {object|string|Buffer} body - Parsed JSON body or raw string or Buffer
 * @param {object} [query] - URL query parameters
 * @returns {Promise<{ statusCode: number, headers: object, body: string, webResponse?: Response }>}
 */
export async function handleRequest(method, pathname, headers = {}, body = null, query = {}) {
  // Common CORS headers
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json"
  };

  // Preflight OPTIONS
  if (method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }

  // Normalize path (support /api/upload-url as well as /upload-url, /api/audio/speak as /audio/speak)
  const normPath = pathname.replace(/^\/api/, "") || "/";

  // Parse JSON body if needed (and not Buffer)
  let payload = body;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = {};
    }
  }

  try {
    // 1. POST /chat or /api/chat
    if (method === "POST" && normPath === "/chat") {
      const messages = payload?.messages || [];
      const caseRef = payload?.caseRef || `WEB${Date.now().toString(36).toUpperCase()}`;

      if (messages.length === 0) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify({
            reply: "Hi, I'm Nova — your 24/7 customer service agent for order status, product information, and warranty enquiries.",
            toolsUsed: [],
            caseRef,
            complete: false
          })
        };
      }

      const autoSpeak = Boolean(payload?.autoSpeak);
      const avatarEnabled = Boolean(payload?.avatarEnabled);
      const webResponse = await streamChatWithOpenRouter(messages, caseRef, {
        autoSpeak,
        avatarEnabled
      });
      const resHeaders = { ...corsHeaders };
      delete resHeaders["Content-Type"];
      webResponse.headers.forEach((value, key) => {
        resHeaders[key] = value;
      });
      return {
        statusCode: webResponse.status,
        headers: resHeaders,
        body: "",
        webResponse
      };
    }

    // 2. POST /upload-url or /api/upload-url
    if (method === "POST" && normPath === "/upload-url") {
      const { caseRef, filename, contentType } = payload || {};
      if (!filename || !contentType) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "filename 和 contentType 为必填项" })
        };
      }

      const presigned = await getUploadPresignedUrl(caseRef, filename, contentType);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(presigned)
      };
    }

    // 3. POST /audio/transcribe or /api/audio/transcribe (DashScope 实时语音识别)
    if (method === "POST" && normPath === "/audio/transcribe") {
      const { fileBuffer, filename } = await parseAudioUpload(headers, body);
      const client = new DashScopeAsrClient();
      const text = await client.transcribeOnce(fileBuffer, filename);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          success: true,
          data: { text },
          text: text
        })
      };
    }

    // 4. POST /avatar/interrupt or /api/avatar/interrupt (主动打断数字人及 TTS 合成)
    if (method === "POST" && normPath === "/avatar/interrupt") {
      const caseRef = payload?.caseRef || payload?.sessionId;
      if (!caseRef) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: "caseRef is required" })
        };
      }
      interruptTtsSession(caseRef, { notifyAvatar: true });
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true, caseRef })
      };
    }

    // 404 Route Not Found
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: `Not found: ${method} ${pathname}` })
    };
  } catch (err) {
    console.error("API error handling request:", err);
    const isTimeout = err.name === "TimeoutError" || String(err.message).toLowerCase().includes("timeout") || String(err.message).toLowerCase().includes("aborted");
    const friendlyError = isTimeout
      ? "AI 服务响应超时（免费节点负载高峰排队），请点击重试或再次发送。"
      : (err.message || "Internal server error");

    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: friendlyError
      })
    };
  }
}
