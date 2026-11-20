const STORAGE_KEY = 'ai_single_line_human_chat_v1';
const CHANNEL_NAME = 'ai-single-line-human-chat';

const channel =
  typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel(CHANNEL_NAME)
    : null;

const INITIAL_STATE = {
  status: 'idle', // 'idle' | 'ringing' | 'connected'
  caseRef: null,
  agentName: 'Ron',
  aiSummary: [],
  messages: [],
  lastEvent: null, // { type: 'rejected' | 'ended', caseRef, at }
};

function nowTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function readState() {
  if (typeof window === 'undefined') return { ...INITIAL_STATE };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...INITIAL_STATE };
    return { ...INITIAL_STATE, ...JSON.parse(raw) };
  } catch {
    return { ...INITIAL_STATE };
  }
}

const listeners = new Set();

function notifyAll() {
  const snapshot = readState();
  listeners.forEach((cb) => cb(snapshot));
}

function writeState(next) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch { }
  notifyAll();
  try {
    channel?.postMessage({ type: 'sync', ts: Date.now() });
  } catch { }
}

if (typeof window !== 'undefined') {
  channel?.addEventListener('message', () => notifyAll());
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY) notifyAll();
  });
}

export function getLineState() {
  return readState();
}

export function subscribeLineState(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** 客户发起人工呼叫（单线：占线则直接返回 busy） */
export function callHumanAgent(caseRef, aiSummary = []) {
  const cur = readState();
  if (cur.status !== 'idle' && cur.caseRef !== caseRef) {
    return { ok: false, reason: 'busy' };
  }
  writeState({
    ...INITIAL_STATE,
    status: 'ringing',
    caseRef,
    agentName: cur.agentName || 'Ron',
    aiSummary: aiSummary.slice(-4),
    messages: [],
    lastEvent: null,
  });
  return { ok: true };
}

/** 客户取消呼叫 */
export function cancelHumanCall(caseRef) {
  const cur = readState();
  if (cur.caseRef !== caseRef) return;
  writeState({
    ...INITIAL_STATE,
    agentName: cur.agentName || 'Ron',
  });
}

/** 客服接听 */
export function acceptHumanCall(agentName = 'Ron') {
  const cur = readState();
  if (cur.status !== 'ringing') return;
  writeState({
    ...cur,
    status: 'connected',
    agentName: agentName.trim() || 'Ron',
    messages: [
      {
        id: `sys-${Date.now()}`,
        sender: 'system',
        text: `人工客服 ${agentName.trim() || 'Ron'} 已接听`,
        time: nowTime(),
      },
    ],
  });
}

/** 客服拒接 */
export function rejectHumanCall() {
  const cur = readState();
  if (cur.status !== 'ringing') return;
  writeState({
    ...INITIAL_STATE,
    agentName: cur.agentName || 'Ron',
    lastEvent: { type: 'rejected', caseRef: cur.caseRef, at: Date.now() },
  });
}

/** 通话中发送消息 */
export function sendLineMessage({ sender, senderName, text }) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const cur = readState();
  if (cur.status !== 'connected') return;
  writeState({
    ...cur,
    messages: [
      ...cur.messages,
      {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sender,
        senderName,
        text: trimmed,
        time: nowTime(),
      },
    ],
  });
}

/** 任一方挂断，立刻清空临时通话恢复空闲 */
export function hangupHumanCall() {
  const cur = readState();
  writeState({
    ...INITIAL_STATE,
    agentName: cur.agentName || 'Ron',
    lastEvent: cur.caseRef
      ? { type: 'ended', caseRef: cur.caseRef, at: Date.now() }
      : null,
  });
}
