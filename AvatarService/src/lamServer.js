#!/usr/bin/env node
/**
 * Node.js LAM (3D Gaussian Splatting) Audio2Expression Avatar Service.
 *
 * 100% protocol-compatible replacement for AvatarService/src/lam_server.py:
 *   - GET  /readiness
 *   - GET  /lam/initconfig
 *   - GET  /lam/asset/:fileName
 *   - GET  /avatar-feed/sessions
 *   - WS   /ws/lam-client/:sessionId    (browser receives speech_chunk JSON + 24kHz int16 PCM)
 *   - WS   /ws/avatar-feed/:sessionId   (Node.js Backend pushes speech_start + MP3/PCM + speech_end / interrupt)
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { decodeAudioToFloat32Mono } from "./audioDecode.js";
import { FPS, LamOnnxEngine, SAMPLE_RATE } from "./lamEngine.js";
import { NUM_BLENDSHAPES } from "./postprocess.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVICE_ROOT = path.resolve(__dirname, "..");
const LAM_SAMPLES_DIR = path.join(
  __dirname,
  "handlers",
  "client",
  "ws_lam_client",
  "lam_samples"
);
const ARKIT_CHANNELS_PATH = path.join(
  __dirname,
  "handlers",
  "avatar",
  "lam",
  "assets",
  "arkit_face_channels.txt"
);

function parseArgs(argv) {
  const opts = {
    host: "0.0.0.0",
    port: 8282,
    asset: "status.zip",
    model: path.join(SERVICE_ROOT, "models", "lam_audio2exp.onnx"),
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host" && argv[i + 1]) opts.host = argv[++i];
    else if (arg === "--port" && argv[i + 1]) opts.port = Number(argv[++i]) || 8282;
    else if (arg === "--asset" && argv[i + 1]) opts.asset = argv[++i];
    else if (arg === "--model" && argv[i + 1]) {
      const p = argv[++i];
      opts.model = path.isAbsolute(p) ? p : path.resolve(SERVICE_ROOT, p);
    }
  }
  return opts;
}

function concatFloat32(a, b) {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function framesToNestedRounded(flatFrames, numFrames) {
  const result = new Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const row = new Array(NUM_BLENDSHAPES);
    const base = f * NUM_BLENDSHAPES;
    for (let c = 0; c < NUM_BLENDSHAPES; c++) {
      row[c] = Math.round(flatFrames[base + c] * 10000) / 10000;
    }
    result[f] = row;
  }
  return result;
}

function float32ToInt16Buffer(audio) {
  const buf = Buffer.allocUnsafe(audio.length * 2);
  for (let i = 0; i < audio.length; i++) {
    let s = Math.round(audio[i] * 32767.0);
    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    buf.writeInt16LE(s, i * 2);
  }
  return buf;
}

function sendJson(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("[LAM-Node] sendJson failed:", err?.message || err);
    return false;
  }
}

export function createLamServer(engine, { assetName = "status.zip" } = {}) {
  /** @type {Map<string, any>} */
  const sessions = new Map();

  function safeSendChunk(session, speechId, flatFrames, numFrames, audio1d) {
    const ws = session.clientWs;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const pcmBuf = float32ToInt16Buffer(audio1d);
    const meta = {
      type: "speech_chunk",
      speechId,
      fps: FPS,
      sampleRate: SAMPLE_RATE,
      audioSamples: audio1d.length,
      frames: framesToNestedRounded(flatFrames, numFrames),
    };
    try {
      ws.send(JSON.stringify(meta));
      ws.send(pcmBuf);
      return true;
    } catch (err) {
      console.warn(`[LAM-Node] Failed to send chunk to ${session.sessionId}:`, err?.message || err);
      return false;
    }
  }

  async function processAndEmit(session, audio1d, isFinal, expectedTurn) {
    if (session.turnId !== expectedTurn) return;
    if (audio1d.length > 0) {
      session.pendingAudio = concatFloat32(session.pendingAudio, audio1d);
    }

    const sliceSamples = SAMPLE_RATE; // 1.0s slices
    const segments = [];
    while (session.pendingAudio.length >= sliceSamples) {
      segments.push(session.pendingAudio.slice(0, sliceSamples));
      session.pendingAudio = session.pendingAudio.slice(sliceSamples);
    }

    if (isFinal && session.pendingAudio.length > 0) {
      segments.push(session.pendingAudio);
      session.pendingAudio = new Float32Array(0);
    }

    for (const seg of segments) {
      if (session.turnId !== expectedTurn) return;
      const t0 = performance.now();
      const { frames, numFrames, nextContext } = await engine.inferChunk(seg, session.inferContext);
      if (session.turnId !== expectedTurn) return;
      session.inferContext = nextContext;
      const durMs = Math.round(performance.now() - t0);
      console.log(
        `[LAM-Node] session=${session.sessionId} inferred ${numFrames} frames ` +
          `for ${(seg.length / SAMPLE_RATE).toFixed(2)}s audio in ${durMs}ms`
      );
      safeSendChunk(
        session,
        session.activeSpeechId || `${session.sessionId}:${expectedTurn}`,
        frames,
        numFrames,
        seg
      );
    }

    if (isFinal && session.turnId === expectedTurn) {
      session.inferContext = null;
      sendJson(session.clientWs, {
        type: "speech_end",
        speechId: session.activeSpeechId,
      });
    }
  }

  const server = http.createServer((req, res) => {
    // CORS headers matching FastAPI CORSMiddleware
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = urlObj.pathname;

    if (req.method === "GET" && pathname === "/readiness") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          mode: "lam",
          runtime: "nodejs-onnx",
          device: engine.device,
          asset: assetName,
          activeSessions: sessions.size,
        })
      );
      return;
    }

    if (req.method === "GET" && pathname === "/lam/initconfig") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          mode: "lam",
          assetUrl: `/lam/asset/${assetName}`,
          wsPath: "/ws/lam-client",
          fps: FPS,
          sampleRate: SAMPLE_RATE,
          arkitChannels: engine.arkitChannels,
        })
      );
      return;
    }

    if (req.method === "GET" && pathname === "/avatar-feed/sessions") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: Array.from(sessions.keys()), count: sessions.size }));
      return;
    }

    if (req.method === "GET" && pathname.startsWith("/lam/asset/")) {
      const fileName = decodeURIComponent(pathname.slice("/lam/asset/".length));
      if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid file name" }));
        return;
      }
      const resolvedRoot = path.resolve(LAM_SAMPLES_DIR);
      const filePath = path.resolve(LAM_SAMPLES_DIR, fileName);
      if (!filePath.startsWith(resolvedRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Asset not found" }));
        return;
      }
      const stat = fs.statSync(filePath);
      const ext = path.extname(fileName).toLowerCase();
      const contentType =
        ext === ".zip"
          ? "application/zip"
          : ext === ".jpg" || ext === ".jpeg"
            ? "image/jpeg"
            : ext === ".png"
              ? "image/png"
              : "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Cache-Control": "public, max-age=86400",
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = urlObj.pathname;

    const clientMatch = pathname.match(/^\/ws\/lam-client\/(.+)$/);
    if (clientMatch) {
      const sessionId = decodeURIComponent(clientMatch[1]);
      wss.handleUpgrade(req, socket, head, (ws) => handleLamClient(ws, sessionId));
      return;
    }

    const feedMatch = pathname.match(/^\/ws\/avatar-feed\/(.+)$/);
    if (feedMatch) {
      const sessionId = decodeURIComponent(feedMatch[1]);
      wss.handleUpgrade(req, socket, head, (ws) => handleAvatarFeed(ws, sessionId));
      return;
    }

    socket.destroy();
  });

  function handleLamClient(ws, sessionId) {
    const prev = sessions.get(sessionId);
    if (prev) {
      prev.turnId += 1;
      try {
        prev.clientWs.close(1000, "Replaced by newer connection");
      } catch {}
    }

    const session = {
      sessionId,
      clientWs: ws,
      turnId: 0,
      activeSpeechId: null,
      inferContext: null,
      pendingAudio: new Float32Array(0),
      workChain: Promise.resolve(),
    };
    sessions.set(sessionId, session);
    console.log(`[LAM-Node] Browser client connected: session_id=${sessionId} (total=${sessions.size})`);

    sendJson(ws, {
      type: "ready",
      sessionId,
      fps: FPS,
      sampleRate: SAMPLE_RATE,
      arkitChannels: engine.arkitChannels,
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (msg?.type === "ping") {
        sendJson(ws, { type: "pong" });
      } else if (msg?.type === "interrupt") {
        session.turnId += 1;
        session.inferContext = null;
        session.pendingAudio = new Float32Array(0);
        sendJson(ws, { type: "interrupt" });
      }
    });

    ws.on("close", () => {
      console.log(`[LAM-Node] Browser client disconnected: session_id=${sessionId}`);
      if (sessions.get(sessionId) === session) {
        session.turnId += 1;
        sessions.delete(sessionId);
      }
    });

    ws.on("error", (err) => {
      console.warn(`[LAM-Node] Browser WS error (${sessionId}):`, err?.message || err);
    });
  }

  function handleAvatarFeed(ws, sessionId) {
    console.log(`[LAM-Feed] Node bridge connected: session_id=${sessionId}`);
    let currentFormat = "mp3";
    // Serialize incoming WS messages per feed connection to preserve order of speech_start -> audio -> speech_end
    let msgChain = Promise.resolve();

    ws.on("message", (data, isBinary) => {
      msgChain = msgChain
        .then(async () => {
          if (!isBinary) {
            let payload;
            try {
              payload = JSON.parse(data.toString("utf8"));
            } catch {
              sendJson(ws, { type: "error", message: "Invalid JSON" });
              return;
            }

            const evt = payload?.type;
            if (evt === "ping") {
              sendJson(ws, {
                type: "pong",
                sessionId,
                sessionActive: sessions.has(sessionId),
              });
              return;
            }

            const session = sessions.get(sessionId);
            if (!session) {
              sendJson(ws, {
                type: "error",
                code: "session_not_found",
                message: `No active LAM browser session for session_id=${sessionId}`,
              });
              return;
            }

            if (evt === "speech_start") {
              session.turnId += 1;
              session.activeSpeechId = payload.speechId || `${sessionId}:${session.turnId}`;
              session.inferContext = null;
              session.pendingAudio = new Float32Array(0);
              currentFormat = payload.format || "mp3";
              sendJson(ws, {
                type: "ack",
                event: "speech_start",
                speechId: session.activeSpeechId,
                format: currentFormat,
              });
            } else if (evt === "speech_end") {
              const expectedTurn = session.turnId;
              await processAndEmit(session, new Float32Array(0), true, expectedTurn);
              sendJson(ws, {
                type: "ack",
                event: "speech_end",
                speechId: payload.speechId,
              });
            } else if (evt === "interrupt") {
              session.turnId += 1;
              session.inferContext = null;
              session.pendingAudio = new Float32Array(0);
              sendJson(session.clientWs, { type: "interrupt" });
              sendJson(ws, {
                type: "ack",
                event: "interrupt",
                sessionId,
              });
            } else {
              sendJson(ws, { type: "error", message: `Unknown event: ${evt}` });
            }
            return;
          }

          // Binary audio frame
          const session = sessions.get(sessionId);
          if (!session) {
            sendJson(ws, {
              type: "error",
              code: "session_not_found",
              message: `No active LAM browser session for session_id=${sessionId}`,
            });
            return;
          }

          try {
            const expectedTurn = session.turnId;
            const rawBuf = Buffer.isBuffer(data) ? data : Buffer.from(data);
            const audio1d = await decodeAudioToFloat32Mono(rawBuf, currentFormat, SAMPLE_RATE);
            await processAndEmit(session, audio1d, false, expectedTurn);
            sendJson(ws, {
              type: "ack",
              event: "audio",
              samples: audio1d.length,
              durationSec: Math.round((audio1d.length / SAMPLE_RATE) * 1000) / 1000,
            });
          } catch (err) {
            console.error(`[LAM-Feed] Failed to process audio (${sessionId}):`, err);
            sendJson(ws, {
              type: "error",
              code: "decode_failed",
              message: err?.message || String(err),
            });
          }
        })
        .catch((err) => {
          console.error(`[LAM-Feed] Unexpected error (${sessionId}):`, err);
        });
    });

    ws.on("close", () => {
      console.log(`[LAM-Feed] Node bridge disconnected: session_id=${sessionId}`);
    });

    ws.on("error", (err) => {
      console.warn(`[LAM-Feed] WS error (${sessionId}):`, err?.message || err);
    });
  }

  return server;
}

async function main() {
  const opts = parseArgs(process.argv);
  const engine = new LamOnnxEngine(opts.model, ARKIT_CHANNELS_PATH);
  await engine.init();

  const server = createLamServer(engine, { assetName: opts.asset });
  server.listen(opts.port, opts.host, () => {
    console.log(`[LAM-Node] Listening on http://${opts.host}:${opts.port} (asset=${opts.asset})`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch((err) => {
    console.error("[LAM-Node] Fatal startup error:", err);
    process.exit(1);
  });
}
