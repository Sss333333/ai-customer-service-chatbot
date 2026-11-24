import assert from "node:assert/strict";
import http from "node:http";
import { WebSocketServer } from "ws";

// 1. Start a local mock Python AvatarService WS server
const received = [];
const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  received.push({ event: "connect", url: req.url });
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      received.push({ event: "binary", length: data.length });
    } else {
      received.push({ event: "json", payload: JSON.parse(data.toString()) });
    }
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
process.env.AVATAR_SERVICE_URL = `http://127.0.0.1:${port}`;

const {
  sendAvatarSpeechStart,
  sendAvatarAudioBuffer,
  sendAvatarSpeechEnd,
  sendAvatarInterrupt,
  closeAvatarBridge,
} = await import("../src/audio/avatarBridge.js");

const { handleRequest } = await import("../src/api/router.js");

const sessionId = "WEB_PHASE2_TEST";
const speechId = `${sessionId}:1`;

// Test 1: speech_start -> binary MP3 -> speech_end -> interrupt
assert.equal(await sendAvatarSpeechStart(sessionId, speechId, "mp3"), true);
assert.equal(await sendAvatarAudioBuffer(sessionId, Buffer.from([0x49, 0x44, 0x33, 0x03])), true);
assert.equal(await sendAvatarSpeechEnd(sessionId, speechId), true);
assert.equal(await sendAvatarInterrupt(sessionId), true);

// Test 2: POST /avatar/interrupt via router.js
const res = await handleRequest("POST", "/api/avatar/interrupt", {}, { caseRef: sessionId });
assert.equal(res.statusCode, 200);
assert.deepEqual(JSON.parse(res.body), { ok: true, caseRef: sessionId });

// Give WS loop a brief tick to receive messages
await new Promise((r) => setTimeout(r, 100));

assert.equal(received[0]?.event, "connect");
assert.equal(received[0]?.url, `/ws/avatar-feed/${sessionId}`);
assert.deepEqual(received[1], {
  event: "json",
  payload: { type: "speech_start", speechId, format: "mp3" },
});
assert.deepEqual(received[2], { event: "binary", length: 4 });
assert.deepEqual(received[3], {
  event: "json",
  payload: { type: "speech_end", speechId },
});
assert.deepEqual(received[4], { event: "json", payload: { type: "interrupt" } });
assert.deepEqual(received[5], { event: "json", payload: { type: "interrupt" } });

closeAvatarBridge(sessionId);
await new Promise((resolve) => wss.close(() => server.close(resolve)));

// Test 3: Graceful fallback when AvatarService is offline
process.env.AVATAR_SERVICE_URL = "http://127.0.0.1:19999";
const offlineOk = await sendAvatarSpeechStart("OFFLINE_SESSION", "OFFLINE_SESSION:1", "mp3");
assert.equal(offlineOk, false);

console.log("=== PHASE 2 BACKEND BRIDGE TESTS PASSED ===");
process.exit(0);
