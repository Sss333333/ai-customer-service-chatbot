import { WebSocket } from "ws";

const DEFAULT_AVATAR_SERVICE_URL = "http://127.0.0.1:8282";
const CONNECT_TIMEOUT_MS = 1500;
const IDLE_TTL_MS = 15 * 60 * 1000;

/**
 * sessionId (caseRef) -> { ws: WebSocket | null, connecting: Promise<WebSocket | null> | null, lastUsedAt: number }
 */
const bridges = new Map();

export function getAvatarServiceBaseUrl() {
  const raw = (process.env.AVATAR_SERVICE_URL ?? DEFAULT_AVATAR_SERVICE_URL).trim();
  return raw.replace(/\/+$/, "");
}

function buildFeedWsUrl(sessionId) {
  const base = getAvatarServiceBaseUrl();
  if (!base) return null;
  const wsBase = base.replace(/^http/i, "ws");
  return `${wsBase}/ws/avatar-feed/${encodeURIComponent(sessionId)}`;
}

function cleanupIdleBridges() {
  const now = Date.now();
  for (const [sessionId, entry] of bridges.entries()) {
    if (now - entry.lastUsedAt > IDLE_TTL_MS && !entry.connecting) {
      try {
        entry.ws?.close();
      } catch {}
      bridges.delete(sessionId);
    }
  }
}

/**
 * 确保与 Python AvatarService 的 /ws/avatar-feed/{sessionId} 连接就绪。
 * 连接失败或超时返回 null（不抛异常），便于上游平滑降级到原 /ws/tts。
 */
export async function ensureAvatarConnected(sessionId, timeoutMs = CONNECT_TIMEOUT_MS) {
  if (!sessionId) return null;
  const url = buildFeedWsUrl(sessionId);
  if (!url) return null;

  cleanupIdleBridges();

  let entry = bridges.get(sessionId);
  if (entry?.ws && entry.ws.readyState === WebSocket.OPEN) {
    entry.lastUsedAt = Date.now();
    return entry.ws;
  }
  if (entry?.connecting) {
    return entry.connecting;
  }

  entry = { ws: null, connecting: null, lastUsedAt: Date.now() };
  bridges.set(sessionId, entry);

  entry.connecting = new Promise((resolve) => {
    let settled = false;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn(`[AvatarBridge] Failed to construct WebSocket (${url}):`, err?.message || err);
      bridges.delete(sessionId);
      resolve(null);
      return;
    }

    const finish = (socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      entry.connecting = null;
      if (socket) {
        entry.ws = socket;
        entry.lastUsedAt = Date.now();
      } else if (bridges.get(sessionId) === entry) {
        bridges.delete(sessionId);
      }
      resolve(socket);
    };

    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {}
      console.warn(`[AvatarBridge] Connect timeout (${timeoutMs}ms): ${url}`);
      finish(null);
    }, timeoutMs);

    ws.on("open", () => {
      finish(ws);
    });

    ws.on("message", (data) => {
      // 仅记录服务端错误响应，避免静默失败
      try {
        const msg = JSON.parse(data.toString());
        if (msg?.type === "error") {
          console.warn(`[AvatarBridge] Server error (${sessionId}):`, msg.code || msg.message);
        }
      } catch {
        // ignore non-JSON messages
      }
    });

    ws.on("close", () => {
      if (bridges.get(sessionId) === entry && entry.ws === ws) {
        entry.ws = null;
        bridges.delete(sessionId);
      }
      if (!settled) finish(null);
    });

    ws.on("error", (err) => {
      if (!settled) {
        console.warn(`[AvatarBridge] Connect error (${url}):`, err?.message || err);
        finish(null);
      } else {
        console.warn(`[AvatarBridge] Socket error (${sessionId}):`, err?.message || err);
      }
    });
  });

  return entry.connecting;
}

function sendJsonOnSocket(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (err) {
    console.warn("[AvatarBridge] sendJson failed:", err?.message || err);
    return false;
  }
}

export async function sendAvatarSpeechStart(sessionId, speechId, format = "mp3") {
  const ws = await ensureAvatarConnected(sessionId);
  if (!ws) return false;
  return sendJsonOnSocket(ws, { type: "speech_start", speechId, format });
}

export async function sendAvatarAudioBuffer(sessionId, audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) return true;
  const ws = await ensureAvatarConnected(sessionId);
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(audioBuffer);
    const entry = bridges.get(sessionId);
    if (entry) entry.lastUsedAt = Date.now();
    return true;
  } catch (err) {
    console.warn(`[AvatarBridge] sendAudioBuffer failed (${sessionId}):`, err?.message || err);
    return false;
  }
}

export async function sendAvatarSpeechEnd(sessionId, speechId) {
  const ws = await ensureAvatarConnected(sessionId);
  if (!ws) return false;
  return sendJsonOnSocket(ws, { type: "speech_end", speechId });
}

export async function sendAvatarInterrupt(sessionId) {
  if (!sessionId) return false;
  const entry = bridges.get(sessionId);
  const ws =
    entry?.ws && entry.ws.readyState === WebSocket.OPEN
      ? entry.ws
      : await ensureAvatarConnected(sessionId, 500);
  if (!ws) return false;
  return sendJsonOnSocket(ws, { type: "interrupt" });
}

export function closeAvatarBridge(sessionId) {
  const entry = bridges.get(sessionId);
  if (!entry) return;
  bridges.delete(sessionId);
  try {
    entry.ws?.close();
  } catch {}
}
