/**
 * In-process LAM (3D Gaussian Splatting) Audio2Expression Avatar Service.
 *
 * Mounted directly on the Backend HTTP/WebSocket server:
 *   - GET  /readiness
 *   - GET  /lam/initconfig
 *   - GET  /lam/asset/:fileName
 *   - GET  /avatar-feed/sessions
 *   - WS   /ws/lam-client/:sessionId    (browser receives speech_chunk JSON + 24kHz int16 PCM)
 *   - WS   /ws/avatar-feed/:sessionId   (optional external feed compatibility)
 *   - In-process API for ttsWsServer.js:
 *       sendAvatarSpeechStart / sendAvatarAudioBuffer / sendAvatarSpeechEnd / sendAvatarInterrupt
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { decodeAudioToFloat32Mono } from "./audioDecode.js";
import { FPS, LamOnnxEngine, SAMPLE_RATE } from "./lamEngine.js";
import { ARKIT_BLENDSHAPES, NUM_BLENDSHAPES } from "./postprocess.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_ROOT = path.resolve(__dirname, "../..");
const LAM_ASSETS_DIR = path.join(BACKEND_ROOT, "assets", "lam");

function getAssetName() {
  return (process.env.LAM_ASSET_NAME || "status.zip").trim() || "status.zip";
}

function getModelPath() {
  const envPath = (process.env.LAM_MODEL_PATH || "").trim();
  if (!envPath) {
    return path.join(LAM_ASSETS_DIR, "lam_audio2exp.onnx");
  }
  return path.isAbsolute(envPath) ? envPath : path.resolve(BACKEND_ROOT, envPath);
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
    console.warn("[LAM] sendJson failed:", err?.message || err);
    return false;
  }
}

/** @type {LamOnnxEngine | null} */
let engine = null;
/** @type {Promise<LamOnnxEngine | null> | null} */
let engineInitPromise = null;
/** @type {string | null} */
let engineInitError = null;

/** @type {Map<string, any>} */
const sessions = new Map();

export function initLamService() {
  if (engine) return Promise.resolve(engine);
  if (engineInitPromise) return engineInitPromise;

  const modelPath = getModelPath();
  engineInitPromise = (async () => {
    try {
      const instance = new LamOnnxEngine(modelPath);
      await instance.init();
      engine = instance;
      engineInitError = null;
      return engine;
    } catch (err) {
      engineInitError = err?.message || String(err);
      console.error("[LAM] Failed to initialize ONNX engine:", engineInitError);
      return null;
    }
  })();

  return engineInitPromise;
}

async function getReadyEngine() {
  if (engine) return engine;
  return initLamService();
}

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
    console.warn(`[LAM] Failed to send chunk to ${session.sessionId}:`, err?.message || err);
    return false;
  }
}

async function processAndEmit(session, audio1d, isFinal, expectedTurn) {
  const readyEngine = await getReadyEngine();
  if (!readyEngine) return false;
  if (session.turnId !== expectedTurn) return true;

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
    if (session.turnId !== expectedTurn) return true;
    const t0 = performance.now();
    const { frames, numFrames, nextContext } = await readyEngine.inferChunk(seg, session.inferContext);
    if (session.turnId !== expectedTurn) return true;
    session.inferContext = nextContext;
    const durMs = Math.round(performance.now() - t0);
    console.log(
      `[LAM] session=${session.sessionId} inferred ${numFrames} frames ` +
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
  return true;
}

/**
 * Handle LAM HTTP endpoints directly on the Backend HTTP server.
 * Returns true if the request was handled, false to pass through to API router.
 */
export function handleLamHttpRequest(req, res, pathname) {
  const isLamRoute =
    pathname === "/readiness" ||
    pathname === "/lam/initconfig" ||
    pathname === "/avatar-feed/sessions" ||
    pathname.startsWith("/lam/asset/");

  if (!isLamRoute) return false;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  const assetName = getAssetName();

  if (req.method === "GET" && pathname === "/readiness") {
    const ready = Boolean(engine);
    res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: ready ? "ok" : "initializing",
        mode: "lam",
        runtime: "nodejs-onnx",
        device: engine?.device || "cpu",
        asset: assetName,
        activeSessions: sessions.size,
        ...(engineInitError ? { error: engineInitError } : {}),
      })
    );
    return true;
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
        arkitChannels: engine?.arkitChannels || ARKIT_BLENDSHAPES,
      })
    );
    return true;
  }

  if (req.method === "GET" && pathname === "/avatar-feed/sessions") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ sessions: Array.from(sessions.keys()), count: sessions.size }));
    return true;
  }

  if (req.method === "GET" && pathname.startsWith("/lam/asset/")) {
    const fileName = decodeURIComponent(pathname.slice("/lam/asset/".length));
    if (!/^[a-zA-Z0-9._-]+$/.test(fileName)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid file name" }));
      return true;
    }
    const resolvedRoot = path.resolve(LAM_ASSETS_DIR);
    const filePath = path.resolve(LAM_ASSETS_DIR, fileName);
    if (!filePath.startsWith(resolvedRoot) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Asset not found" }));
      return true;
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
    return true;
  }

  return false;
}

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
    audioFormat: "mp3",
    inferContext: null,
    pendingAudio: new Float32Array(0),
  };
  sessions.set(sessionId, session);
  console.log(`[LAM] Browser client connected: session_id=${sessionId} (total=${sessions.size})`);

  sendJson(ws, {
    type: "ready",
    sessionId,
    fps: FPS,
    sampleRate: SAMPLE_RATE,
    arkitChannels: engine?.arkitChannels || ARKIT_BLENDSHAPES,
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
    console.log(`[LAM] Browser client disconnected: session_id=${sessionId}`);
    if (sessions.get(sessionId) === session) {
      session.turnId += 1;
      sessions.delete(sessionId);
    }
  });

  ws.on("error", (err) => {
    console.warn(`[LAM] Browser WS error (${sessionId}):`, err?.message || err);
  });
}

function handleAvatarFeed(ws, sessionId) {
  console.log(`[LAM-Feed] External feed connected: session_id=${sessionId}`);
  let currentFormat = "mp3";
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
            session.audioFormat = currentFormat;
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
    console.log(`[LAM-Feed] External feed disconnected: session_id=${sessionId}`);
  });

  ws.on("error", (err) => {
    console.warn(`[LAM-Feed] WS error (${sessionId}):`, err?.message || err);
  });
}

/**
 * Attach LAM WebSocket routes (/ws/lam-client/:sessionId and /ws/avatar-feed/:sessionId)
 * onto the shared Backend HTTP server.
 */
export function attachLamWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let urlObj;
    try {
      urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    } catch {
      return;
    }
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
    }
  });
}

// ---------------------------------------------------------------------------
// Direct in-process feed API used by Backend/src/audio/ttsWsServer.js
// ---------------------------------------------------------------------------

export function hasLamClient(sessionId) {
  const session = sessions.get(sessionId);
  return Boolean(session?.clientWs && session.clientWs.readyState === WebSocket.OPEN);
}

export async function sendAvatarSpeechStart(sessionId, speechId, format = "mp3") {
  if (!hasLamClient(sessionId)) return false;
  const readyEngine = await getReadyEngine();
  if (!readyEngine) return false;

  const session = sessions.get(sessionId);
  if (!session) return false;

  session.turnId += 1;
  session.activeSpeechId = speechId || `${sessionId}:${session.turnId}`;
  session.audioFormat = format || "mp3";
  session.inferContext = null;
  session.pendingAudio = new Float32Array(0);
  return true;
}

export async function sendAvatarAudioBuffer(sessionId, audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) return true;
  if (!hasLamClient(sessionId)) return false;

  const session = sessions.get(sessionId);
  if (!session) return false;

  try {
    const expectedTurn = session.turnId;
    const rawBuf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    const audio1d = await decodeAudioToFloat32Mono(rawBuf, session.audioFormat || "mp3", SAMPLE_RATE);
    return await processAndEmit(session, audio1d, false, expectedTurn);
  } catch (err) {
    console.error(`[LAM] Failed to process in-process audio (${sessionId}):`, err);
    return false;
  }
}

export async function sendAvatarSpeechEnd(sessionId, speechId) {
  if (!hasLamClient(sessionId)) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (speechId && session.activeSpeechId && session.activeSpeechId !== speechId) {
    return true;
  }
  const expectedTurn = session.turnId;
  return await processAndEmit(session, new Float32Array(0), true, expectedTurn);
}

export async function sendAvatarInterrupt(sessionId) {
  if (!sessionId) return false;
  const session = sessions.get(sessionId);
  if (!session) return false;

  session.turnId += 1;
  session.inferContext = null;
  session.pendingAudio = new Float32Array(0);
  sendJson(session.clientWs, { type: "interrupt" });
  return true;
}
