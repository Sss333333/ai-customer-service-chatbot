import { WebSocketServer, WebSocket } from "ws";
import { createGeminiLiveTranslateSession } from "./geminiLiveTranslate.js";
import {
  hasLamClient,
  sendAvatarAudioBuffer,
  sendAvatarInterrupt,
  sendAvatarSpeechEnd,
  sendAvatarSpeechStart,
} from "../avatar/lamService.js";

const SESSION_MAX_AGE_MS = 90_000;
const ROTATION_IDLE_MS = 1_200;
const HUMAN_AVATAR_FLUSH_IDLE_MS = 550;

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sendJson(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendBinary(ws, buf) {
  if (ws && ws.readyState === WebSocket.OPEN && buf && buf.byteLength > 0) {
    ws.send(buf);
  }
}

/**
 * 单线跨语言人工通话 WebSocket 服务（/ws/human 或 /api/ws/human）
 *
 * 架构（参考 interpreter-node）：
 *  - 全局维护唯一一条通话线路（idle -> ringing -> connected）
 *  - 客户默认语言 en，客服默认语言 zh-Hans（可通过 query 参数覆盖）
 *  - 接通后为双方各自维护独立的单向 Gemini Live Translate 会话：
 *      customer 说话 -> 翻译为 agent.lang -> 译文音频【仅发给 agent.ws】
 *      agent    说话 -> 翻译为 customer.lang -> 译文音频【仅发给 customer.ws】
 *    从路由层 100% 保证不会把自己的译文语音传给自己。
 *
 * @param {import("http").Server} server
 */
export function attachHumanCallWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  const room = {
    status: "idle", // "idle" | "ringing" | "connected"
    agent: null, // { ws, name, lang }
    customer: null, // { ws, caseRef, lang, aiSummary }
    sessions: {
      customer: null, // { targetLanguage, createdAt, lastAudioAt, promise }
      agent: null,
    },
  };

  // 人工客服译文音频 -> 客户侧 LAM 3D 数字人状态管理
  const customerAvatar = {
    turnCounter: 0,
    active: false,
    speechId: null,
    caseRef: null,
    initPromise: null,
    idleTimer: null,
    audioChain: Promise.resolve(),
  };

  function clearCustomerAvatarTimer() {
    if (customerAvatar.idleTimer) {
      clearTimeout(customerAvatar.idleTimer);
      customerAvatar.idleTimer = null;
    }
  }

  async function flushCustomerAvatarTurn() {
    clearCustomerAvatarTimer();
    if (customerAvatar.initPromise) {
      await customerAvatar.initPromise.catch(() => { });
    }
    if (customerAvatar.active && customerAvatar.caseRef && customerAvatar.speechId) {
      const sid = customerAvatar.speechId;
      const cid = customerAvatar.caseRef;
      customerAvatar.active = false;
      customerAvatar.speechId = null;
      customerAvatar.caseRef = null;
      await sendAvatarSpeechEnd(cid, sid).catch(() => { });
    }
  }

  function interruptCustomerAvatar(caseRef) {
    clearCustomerAvatarTimer();
    const targetCaseRef = caseRef || customerAvatar.caseRef;
    customerAvatar.active = false;
    customerAvatar.speechId = null;
    customerAvatar.caseRef = null;
    customerAvatar.initPromise = null;
    if (targetCaseRef) {
      sendAvatarInterrupt(targetCaseRef).catch(() => { });
    }
  }

  function forwardAgentAudioToCustomer(listener, audio) {
    const caseRef = listener?.caseRef;
    if (!caseRef || !hasLamClient(caseRef)) {
      sendBinary(listener?.ws, audio);
      return;
    }

    customerAvatar.audioChain = customerAvatar.audioChain
      .then(async () => {
        if (room.status !== "connected" || room.customer?.caseRef !== caseRef) return;

        if (!customerAvatar.active || customerAvatar.caseRef !== caseRef) {
          if (!customerAvatar.initPromise) {
            const speechId = `${caseRef}:human:${++customerAvatar.turnCounter}`;
            customerAvatar.initPromise = sendAvatarSpeechStart(caseRef, speechId, "pcm24k", {
              sliceMs: 400,
            })
              .then((ok) => {
                customerAvatar.initPromise = null;
                if (ok) {
                  customerAvatar.active = true;
                  customerAvatar.speechId = speechId;
                  customerAvatar.caseRef = caseRef;
                }
                return ok;
              })
              .catch(() => {
                customerAvatar.initPromise = null;
                return false;
              });
          }
          const ok = await customerAvatar.initPromise;
          if (!ok) {
            sendBinary(listener?.ws, audio);
            return;
          }
        }

        const pushed = await sendAvatarAudioBuffer(caseRef, audio);
        if (!pushed) {
          customerAvatar.active = false;
          customerAvatar.speechId = null;
          customerAvatar.caseRef = null;
          sendBinary(listener?.ws, audio);
          return;
        }

        // 空闲 550ms 无新译文音频分片则刷出尾音，让数字人自然闭嘴待机
        clearCustomerAvatarTimer();
        customerAvatar.idleTimer = setTimeout(() => {
          customerAvatar.audioChain = customerAvatar.audioChain
            .then(() => flushCustomerAvatarTurn())
            .catch(() => { });
        }, HUMAN_AVATAR_FLUSH_IDLE_MS);
      })
      .catch((err) => {
        console.warn("[human-call] LAM avatar forward error:", err?.message || err);
        sendBinary(listener?.ws, audio);
      });
  }

  function closeTranslateSession(speakerRole) {
    const entry = room.sessions[speakerRole];
    if (!entry) return;
    room.sessions[speakerRole] = null;
    if (speakerRole === "agent") {
      customerAvatar.audioChain = customerAvatar.audioChain
        .then(() => flushCustomerAvatarTurn())
        .catch(() => { });
    }
    entry.promise
      .then((session) => session.close())
      .catch(() => { });
  }

  function closeAllTranslateSessions() {
    closeTranslateSession("customer");
    closeTranslateSession("agent");
  }

  function getPeer(speakerRole) {
    return speakerRole === "customer" ? room.agent : room.customer;
  }

  function broadcastBoth(payload) {
    sendJson(room.customer?.ws, payload);
    sendJson(room.agent?.ws, payload);
  }

  function sendAgentLineState() {
    if (!room.agent) return;
    sendJson(room.agent.ws, {
      type: "line_state",
      status: room.status,
      caseRef: room.customer?.caseRef || null,
      customerLang: room.customer?.lang || "en",
      agentLang: room.agent.lang,
      agentName: room.agent.name,
      aiSummary: room.customer?.aiSummary || [],
    });
  }

  async function getOrCreateTranslateSession(speakerRole) {
    const peer = getPeer(speakerRole);
    if (!peer || room.status !== "connected") return null;

    const targetLanguage = peer.lang;
    const existing = room.sessions[speakerRole];
    const now = Date.now();

    if (existing) {
      const expired =
        existing.targetLanguage !== targetLanguage ||
        (now - existing.createdAt >= SESSION_MAX_AGE_MS &&
          existing.lastAudioAt &&
          now - existing.lastAudioAt >= ROTATION_IDLE_MS);

      if (!expired) {
        existing.lastAudioAt = now;
        return await existing.promise;
      }
      closeTranslateSession(speakerRole);
    }

    const speakerName =
      speakerRole === "agent" ? room.agent?.name || "Ron" : "客户";

    broadcastBoth({
      type: "live_status",
      speaker: speakerRole,
      code: "starting",
      message: `正在连接实时翻译通道 (${targetLanguage})…`,
    });

    const promise = createGeminiLiveTranslateSession({
      targetLanguage,
      onTranscript({ sourceText, translatedText }) {
        broadcastBoth({
          type: "transcript",
          speaker: speakerRole,
          speakerName,
          sourceText: sourceText || "",
          translatedText: translatedText || "",
          targetLanguage,
          time: nowTime(),
        });
      },
      onAudio({ audio }) {
        // 关键隔离：译文音频只发给对方，绝不回传给说话人
        const listener = getPeer(speakerRole);
        if (speakerRole === "agent") {
          // 人工客服译文音频优先直推客户侧 LAM 3D 数字人（音画同步，无重音；未连数字人时自动降级回 /ws/human）
          forwardAgentAudioToCustomer(listener, audio);
        } else {
          sendBinary(listener?.ws, audio);
        }
      },
      onError(err) {
        broadcastBoth({
          type: "error",
          message: err?.message || "实时翻译通道异常",
        });
        if (room.sessions[speakerRole]?.promise === promise) {
          room.sessions[speakerRole] = null;
        }
      },
    })
      .then((session) => {
        broadcastBoth({
          type: "live_status",
          speaker: speakerRole,
          code: "ready",
          message: `实时翻译通道已就绪 (${targetLanguage})`,
        });
        return session;
      })
      .catch((err) => {
        if (room.sessions[speakerRole]?.promise === promise) {
          room.sessions[speakerRole] = null;
        }
        broadcastBoth({
          type: "error",
          message: err?.message || "无法连接 Gemini Live Translate",
        });
        throw err;
      });

    room.sessions[speakerRole] = {
      targetLanguage,
      createdAt: now,
      lastAudioAt: now,
      promise,
    };

    return await promise;
  }

  function resetCall(reasonType, notifyPeerRole) {
    closeAllTranslateSessions();
    const prevCustomer = room.customer;
    interruptCustomerAvatar(prevCustomer?.caseRef);
    room.customer = null;
    room.status = "idle";

    if (notifyPeerRole === "customer" && prevCustomer?.ws) {
      sendJson(prevCustomer.ws, { type: reasonType });
      try { prevCustomer.ws.close(1000, reasonType); } catch { }
    } else if (notifyPeerRole === "agent" && room.agent?.ws) {
      sendJson(room.agent.ws, { type: reasonType });
      sendAgentLineState();
    } else if (notifyPeerRole === "both") {
      if (prevCustomer?.ws) {
        sendJson(prevCustomer.ws, { type: reasonType });
        try { prevCustomer.ws.close(1000, reasonType); } catch { }
      }
      if (room.agent?.ws) {
        sendJson(room.agent.ws, { type: reasonType });
        sendAgentLineState();
      }
    }
  }

  server.on("upgrade", (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      return;
    }

    if (url.pathname !== "/ws/human" && url.pathname !== "/api/ws/human") {
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, url);
    });
  });

  wss.on("connection", (ws, url) => {
    const role = url.searchParams.get("role") === "agent" ? "agent" : "customer";

    if (role === "agent") {
      const name = (url.searchParams.get("name") || "Ron").trim() || "Ron";
      const lang = url.searchParams.get("lang") || "zh-Hans";

      // 新的值班页替换旧的空闲值班连接
      if (room.agent && room.agent.ws !== ws) {
        try { room.agent.ws.close(1000, "replaced_by_new_agent"); } catch { }
      }
      room.agent = { ws, name, lang };
      console.log(`[human-call] agent connected name=${name} lang=${lang}`);
      sendAgentLineState();

      ws.on("message", async (data, isBinary) => {
        if (isBinary) {
          if (room.status !== "connected") return;
          try {
            const session = await getOrCreateTranslateSession("agent");
            session?.sendAudio(data);
          } catch {
            // error already notified
          }
          return;
        }

        let msg;
        try {
          msg = JSON.parse(data.toString("utf-8"));
        } catch {
          return;
        }

        if (msg.type === "update_profile") {
          if (room.agent) {
            if (msg.name) room.agent.name = String(msg.name).trim() || room.agent.name;
            if (msg.lang) room.agent.lang = msg.lang;
          }
          return;
        }

        if (msg.type === "accept") {
          if (room.status !== "ringing" || !room.customer) return;
          if (msg.agentName && room.agent) {
            room.agent.name = String(msg.agentName).trim() || room.agent.name;
          }
          room.status = "connected";
          broadcastBoth({
            type: "connected",
            caseRef: room.customer.caseRef,
            agentName: room.agent.name,
            customerLang: room.customer.lang,
            agentLang: room.agent.lang,
            time: nowTime(),
          });
          console.log(`[human-call] connected caseRef=${room.customer.caseRef} agent=${room.agent.name}`);
          return;
        }

        if (msg.type === "reject") {
          if (room.status !== "ringing") return;
          resetCall("rejected", "both");
          return;
        }

        if (msg.type === "text" && room.status === "connected") {
          const text = String(msg.text || "").trim();
          if (!text) return;
          broadcastBoth({
            type: "text_message",
            sender: "agent",
            senderName: room.agent?.name || "Ron",
            text,
            time: nowTime(),
          });
          return;
        }

        if (msg.type === "hangup") {
          resetCall("ended", "both");
        }
      });

      ws.on("close", () => {
        if (room.agent?.ws === ws) {
          room.agent = null;
          console.log("[human-call] agent disconnected");
          if (room.status === "connected") {
            resetCall("ended", "customer");
          }
        }
      });

      return;
    }

    // Customer role
    const caseRef = url.searchParams.get("caseRef") || `WEB${Date.now().toString(36).toUpperCase()}`;
    const lang = url.searchParams.get("lang") || "en";

    if (room.status !== "idle" && room.customer?.ws !== ws) {
      sendJson(ws, {
        type: "busy",
        message: "当前人工客服正在通话中，请稍后再试。",
      });
      try { ws.close(1000, "busy"); } catch { }
      return;
    }

    room.customer = { ws, caseRef, lang, aiSummary: [] };
    room.status = "ringing";
    console.log(`[human-call] customer calling caseRef=${caseRef} lang=${lang}`);

    sendJson(ws, {
      type: "ringing",
      caseRef,
      agentOnline: Boolean(room.agent),
    });

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        if (room.status !== "connected") return;
        try {
          const session = await getOrCreateTranslateSession("customer");
          session?.sendAudio(data);
        } catch {
          // error already notified
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data.toString("utf-8"));
      } catch {
        return;
      }

      if (msg.type === "call") {
        if (room.customer) {
          room.customer.aiSummary = Array.isArray(msg.aiSummary) ? msg.aiSummary.slice(-4) : [];
          if (msg.lang) room.customer.lang = msg.lang;
        }
        sendAgentLineState();
        return;
      }

      if (msg.type === "text" && room.status === "connected") {
        const text = String(msg.text || "").trim();
        if (!text) return;
        broadcastBoth({
          type: "text_message",
          sender: "customer",
          senderName: "客户",
          text,
          time: nowTime(),
        });
        return;
      }

      if (msg.type === "hangup" || msg.type === "cancel") {
        resetCall("ended", "both");
      }
    });

    ws.on("close", () => {
      if (room.customer?.ws === ws) {
        console.log(`[human-call] customer disconnected caseRef=${caseRef}`);
        resetCall("ended", "agent");
      }
    });
  });

  return wss;
}
