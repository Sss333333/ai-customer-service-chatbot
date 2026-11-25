import http from "http";
import "dotenv/config";
import { handleRequest } from "./api/router.js";
import { listNetSuiteMcpTools } from "./erp/netsuite.js";
import { attachAsrWebSocketServer } from "./audio/asrWsServer.js";
import { attachTtsWebSocketServer } from "./audio/ttsWsServer.js";
import { attachHumanCallWebSocketServer } from "./audio/humanCallWsServer.js";
import { warmupEdgeTTS } from "./audio/edgeTts.js";
import {
  attachLamWebSocketServer,
  handleLamHttpRequest,
  initLamService,
} from "./avatar/lamService.js";

const PORT = process.env.PORT || 8080;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const method = req.method;
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());

  if (handleLamHttpRequest(req, res, pathname)) {
    return;
  }

  let chunks = [];
  req.on("data", chunk => chunks.push(chunk));
  req.on("end", async () => {
    const rawBuffer = Buffer.concat(chunks);
    const contentType = req.headers["content-type"] || "";
    const rawBody = contentType.includes("multipart") ? rawBuffer : rawBuffer.toString("utf-8");
    const result = await handleRequest(method, pathname, req.headers, rawBody, query);

    res.writeHead(result.statusCode, result.headers);
    if (result.webResponse && result.webResponse.body) {
      const reader = result.webResponse.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done || res.writableEnded || res.destroyed) break;
          res.write(value);
        }
      } catch (err) {
        console.warn("[Stream] Interrupted:", err?.message || err);
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
        if (!res.writableEnded && !res.destroyed) {
          res.end();
        }
      }
    } else {
      res.end(result.body);
    }
  });
});

attachAsrWebSocketServer(server);
attachTtsWebSocketServer(server);
attachHumanCallWebSocketServer(server);
attachLamWebSocketServer(server);
warmupEdgeTTS();
initLamService();

server.listen(PORT, () => {
  const mcpTools = listNetSuiteMcpTools();
  console.log(`\n========================================`);
  console.log(`  Nova AI Customer Service Backend (netsuite-mcp + LAM ONNX)`);
  console.log(`  Local server listening on http://localhost:${PORT}`);
  console.log(`  S3 Bucket:      ${process.env.S3_BUCKET_NAME || "your-s3-bucket-name"}`);
  console.log(`  LLM Provider:   OpenRouter (REST API)`);
  console.log(`  Model ID:       ${process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free"}`);
  console.log(`  API Key:        ${process.env.OPENROUTER_API_KEY ? "Configured (***" + process.env.OPENROUTER_API_KEY.slice(-4) + ")" : "NOT SET (set OPENROUTER_API_KEY in .env)"}`);
  console.log(`  NetSuite ERP:   ${process.env.NETSUITE_ACCOUNT_ID ? "Enabled via netsuite-mcp (Account " + process.env.NETSUITE_ACCOUNT_ID + ")" : "Disabled"}`);
  console.log(`  MCP Foundation: ${mcpTools.length} tools mounted (${mcpTools.join(", ")})`);
  console.log(`  Endpoints:`);
  console.log(`    POST /chat (or /api/chat)`);
  console.log(`    POST /upload-url (or /api/upload-url)`);
  console.log(`    GET  /lam/initconfig, /lam/asset/:fileName, /readiness`);
  console.log(`    WS   /ws/lam-client/:sessionId, /ws/tts, /ws/asr`);
  console.log(`========================================\n`);
});
