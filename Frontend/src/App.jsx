import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart } from 'ai';
import { Streamdown } from 'streamdown';
import { Volume2, VolumeX, Phone, PhoneOff, Headset, ExternalLink, Mic, MicOff } from 'lucide-react';
import { resizeImage } from './utils/image';
import { API_BASE, uploadFile, generateCaseRef } from './utils/api';
import { useHumanCall } from './hooks/useHumanCall';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { useLiveCall } from './hooks/useLiveCall';
import { useLamAvatar } from './hooks/useLamAvatar';
import { VoiceInputButton } from './components/VoiceInputButton';
import { AvatarPanel } from './components/AvatarPanel';
import { cn } from './utils/cn';
import './App.css';

const isEmbed = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('embed');

const INITIAL_GREETING = {
  id: 'assistant-greeting',
  role: 'assistant',
  parts: [
    {
      type: 'text',
      text: "Hi, I'm Nova — your 24/7 customer service agent for order status, product information, and warranty enquiries.",
    },
  ],
};

const TOOL_STATUS_LABELS = {
  getInformation: 'Searching warranty knowledge base (正在检索售后知识库)…',
  get_product_info: 'Checking product info & stock (正在查询产品与库存)…',
  check_order_status: 'Checking order status in NetSuite (正在查询订单状态)…',
  check_case_status: 'Checking support case status (正在查询工单进度)…',
  start_warranty_claim: 'Logging support case in NetSuite (正在提交售后工单)…',
};

/**
 * Strip internal system instructions (e.g. "[The customer attached...]") from user bubble display
 */
function formatUserDisplayText(text) {
  if (!text) return '';
  if (text.startsWith('[The customer attached this photo.')) return '';
  const pdfMatch = text.match(/^\[The customer uploaded a PDF document: ([^.]+)\./);
  if (pdfMatch) return `📄 PDF attached: ${pdfMatch[1]}`;
  const videoMatch = text.match(/^\[The customer uploaded a video: ([^.]+)\./);
  if (videoMatch) return `Video attached: ${videoMatch[1]}`;
  const fileMatch = text.match(/^\[The customer uploaded a file: ([^.]+)\./);
  if (fileMatch) return `File attached: ${fileMatch[1]}`;
  return text;
}

/**
 * 将消息中的裸 /guidance/ 或 /evidence/ 链接转为友好的 Markdown 链接文字
 */
function formatAssistantMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/(?<!\]\()https?:\/\/[^\s)]+/g, (url) => {
      if (url.includes('/guidance/')) return `[view guide photo](${url})`;
      if (url.includes('/evidence/')) return `[view uploaded files](${url})`;
      return url;
    })
    .replace(/(?<!\]\()\/guidance\/[^\s)]+/g, (url) => {
      return `[view guide photo](${url})`;
    });
}

/**
 * 💭 大模型思考过程折叠组件（支持流式展开与手动折叠）
 */
function ThinkingProcess({ text, isStreaming }) {
  const [isOpen, setIsOpen] = useState(true);

  if (!text) return null;

  return (
    <details
      className="mb-2.5 rounded-lg border border-[#dedad2] bg-[#f7f5f0] p-2.5 text-xs text-[#6e685f] transition-all group"
      open={isOpen}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-1.5 font-medium text-[#4a453e] hover:text-[#23453c]">
        <span className="text-sm">💭</span>
        <span>
          思考过程{' '}
          {isStreaming && (
            <span className="animate-pulse font-normal text-[#8b8478]">(思考中…)</span>
          )}
        </span>
      </summary>
      <div className="mt-2 max-h-60 overflow-y-auto whitespace-pre-wrap border-t border-[#e8e4dc] pt-2 font-mono text-[12px] leading-relaxed text-[#5c564d]">
        {text}
      </div>
    </details>
  );
}

export default function App() {
  const [input, setInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState(null);

  const logRef = useRef(null);
  const fileRef = useRef(null);
  const fieldRef = useRef(null);
  const caseRef = useRef(generateCaseRef());

  const {
    status: humanStatus,
    peerAgentName: humanAgentName,
    messages: humanMessages,
    isMuted: humanMuted,
    micLevel: humanMicLevel,
    callError: humanCallError,
    startCall: startHumanCall,
    sendText: sendHumanText,
    hangup: hangupHumanCall,
    toggleMute: toggleHumanMute,
  } = useHumanCall({
    role: 'customer',
    caseRef: caseRef.current,
    lang: 'en',
    onRejected: (msg) => setLocalError(msg),
    onBusy: (msg) => setLocalError(msg),
  });

  const humanMode =
    humanStatus === 'ringing' || humanStatus === 'connected' ? humanStatus : 'ai';

  // 语音播放与自动朗读控制 Hook（走 /ws/tts 旁路，LAM 未连接时自动兜底）
  const {
    autoSpeak,
    isPlaying,
    setAutoSpeak,
    toggleAutoSpeak,
    stop: stopAudio,
  } = useAudioPlayer({ sessionId: caseRef.current });

  const [lamChatState, setLamChatState] = useState('Idle');
  const avatar = useLamAvatar({
    sessionId: caseRef.current,
    autoConnect: !isEmbed,
    chatState: lamChatState,
  });

  const autoSpeakRef = useRef(autoSpeak);
  autoSpeakRef.current = autoSpeak;
  const avatarEnabledRef = useRef(false);
  avatarEnabledRef.current = avatar.isConnected && autoSpeak;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: `${API_BASE}/chat`,
        body: () => ({
          caseRef: caseRef.current,
          autoSpeak: autoSpeakRef.current,
          avatarEnabled: avatarEnabledRef.current,
        }),
      }),
    []
  );

  // 核心 AI 聊天状态 Hook（参考 ai-sdk-preview-rag-study/app/(preview)/page.tsx）
  const { messages, status, sendMessage, stop, regenerate, error } = useChat({
    messages: [INITIAL_GREETING],
    transport,
    onToolCall({ toolCall }) {
      console.log('🛠️ Nova 正在调用后端工具:', toolCall);
    },
    onError(err) {
      setLocalError(err?.message || "Couldn't reach the server.");
    },
  });

  const handleToggleAutoSpeak = useCallback(() => {
    stopAudio();
    avatar.interrupt();
    toggleAutoSpeak();
  }, [avatar, stopAudio, toggleAutoSpeak]);

  const effectiveIsPlaying = avatar.isConnected ? avatar.isSpeaking : isPlaying;

  // 实时语音通话（常开麦克风 + VAD 自动断句 + 开口打断 AI）
  const {
    isCallActive,
    callState,
    liveText: callLiveText,
    callError,
    startCall,
    endCall,
  } = useLiveCall({
    isAiBusy: status === 'streaming' || status === 'submitted' || effectiveIsPlaying,
    onInterrupt: () => {
      stopAudio();
      avatar.interrupt();
      if (status === 'streaming' || status === 'submitted') {
        stop();
      }
    },
    onUtterance: (text) => {
      setLocalError(null);
      avatar.unlockAudio();
      sendMessage({ text });
    },
  });

  const handleToggleCall = useCallback(async () => {
    if (isCallActive) {
      endCall();
      stopAudio();
      avatar.interrupt();
    } else {
      setAutoSpeak(true);
      avatar.unlockAudio();
      await startCall();
    }
  }, [avatar, endCall, isCallActive, setAutoSpeak, startCall, stopAudio]);

  // 计算当前正在执行中的工具名称
  const currentToolCall = useMemo(() => {
    const lastAssistant = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant');

    if (!lastAssistant || !Array.isArray(lastAssistant.parts)) return undefined;

    const pendingPart = [...lastAssistant.parts].reverse().find(
      (part) =>
        isToolUIPart(part) &&
        part.state !== 'output-available' &&
        part.state !== 'output-error'
    );

    return pendingPart ? getToolName(pendingPart) : undefined;
  }, [messages]);

  // 检测是否已完成售后登记
  const done = useMemo(() => {
    const lastAssistant = [...messages]
      .reverse()
      .find((m) => m.role === 'assistant');
    if (!lastAssistant || !Array.isArray(lastAssistant.parts)) return false;
    const fullText = lastAssistant.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join(' ')
      .toLowerCase();
    return (
      fullText.includes('intake complete') ||
      fullText.includes('team picks it up from here')
    );
  }, [messages]);

  const isAwaitingResponse =
    uploading ||
    status === 'submitted' ||
    status === 'streaming' ||
    currentToolCall != null;

  useEffect(() => {
    if (avatar.isSpeaking) {
      setLamChatState('Responding');
    } else if (isCallActive && callState === 'speaking') {
      setLamChatState('Listening');
    } else if (isAwaitingResponse) {
      setLamChatState('Thinking');
    } else {
      setLamChatState('Idle');
    }
  }, [avatar.isSpeaking, callState, isAwaitingResponse, isCallActive]);

  const [showLoading, setShowLoading] = useState(false);

  // 120ms 防抖延迟，避免加载状态快速闪烁
  useEffect(() => {
    if (isAwaitingResponse) {
      setShowLoading(true);
      return;
    }
    const timeout = setTimeout(() => setShowLoading(false), 120);
    return () => clearTimeout(timeout);
  }, [isAwaitingResponse]);

  // Auto-scroll message log to bottom
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, showLoading, localError, humanMessages, humanMode]);

  // Refocus input field when ready
  useEffect(() => {
    if (!isAwaitingResponse && !done) {
      fieldRef.current?.focus();
    }
  }, [isAwaitingResponse, done]);

  const handleToggleHumanChat = useCallback(() => {
    if (humanMode === 'ai') {
      if (isCallActive) endCall();
      stopAudio();
      avatar.interrupt();
      const historySnapshot = messages
        .map((m) => {
          const text = (Array.isArray(m.parts) ? m.parts : [])
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n')
            .replace(/<think>[\s\S]*?<\/think>/g, '')
            .trim();
          return text ? { id: m.id, role: m.role, text } : null;
        })
        .filter(Boolean);
      setLocalError(null);
      startHumanCall(historySnapshot);
    } else {
      hangupHumanCall();
    }
  }, [avatar, endCall, hangupHumanCall, humanMode, isCallActive, messages, startHumanCall, stopAudio]);

  function onSubmit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || done) return;

    if (humanMode === 'connected') {
      setLocalError(null);
      setInput('');
      sendHumanText(text);
      return;
    }

    if (humanMode === 'ringing') return;

    if (isAwaitingResponse) return;
    setLocalError(null);
    setInput('');
    avatar.unlockAudio();
    sendMessage({ text });
  }

  async function onFileChange(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || isAwaitingResponse || done) return;

    const isImage = file.type.startsWith('image/');
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isVideo = file.type.startsWith('video/');

    setLocalError(null);
    setUploading(true);

    try {
      const { fileUrl } = await uploadFile(file, caseRef.current);

      if (isImage) {
        const { dataUrl } = await resizeImage(file);
        setUploading(false);
        sendMessage({
          text: `[The customer attached this photo. S3 Evidence URL: ${fileUrl}]`,
          files: [
            {
              type: 'file',
              mediaType: 'image/jpeg',
              filename: file.name,
              url: dataUrl,
            },
          ],
        });
      } else if (isPdf) {
        setUploading(false);
        sendMessage({
          text: `[The customer uploaded a PDF document: ${file.name}. S3 Evidence URL: ${fileUrl}. It is safely stored in S3 for the claims team as proof of purchase / document. Acknowledge receipt and continue assisting the customer.]`,
        });
      } else if (isVideo) {
        setUploading(false);
        sendMessage({
          text: `[The customer uploaded a video: ${file.name}. S3 Evidence URL: ${fileUrl}. You cannot watch it — it is stored for the human assessor. Acknowledge it and carry on with the checklist.]`,
        });
      } else {
        setUploading(false);
        sendMessage({
          text: `[The customer uploaded a file: ${file.name}. S3 Evidence URL: ${fileUrl}. It is stored for the assessor. Acknowledge it and carry on with the checklist.]`,
        });
      }
    } catch (err) {
      setUploading(false);
      setLocalError(`Couldn't attach that file: ${err.message}`);
    }
  }

  const displayError = localError || humanCallError || callError || error?.message;

  return (
    <div
      className={cn(
        'flex min-h-screen justify-center text-[#211f1b]',
        isEmbed ? 'bg-[#fbfaf7]' : 'bg-[#eceae4]'
      )}
    >
      {!isEmbed && (
        <AvatarPanel
          status={avatar.status}
          loadPercent={avatar.loadPercent}
          isConnected={avatar.isConnected}
          isSpeaking={avatar.isSpeaking}
          isMuted={avatar.isMuted}
          needsAudioUnlock={avatar.needsAudioUnlock}
          error={avatar.error}
          containerRef={avatar.containerRef}
          onConnect={avatar.connect}
          onDisconnect={avatar.disconnect}
          onToggleMute={avatar.toggleMute}
          onUnlockAudio={avatar.unlockAudio}
          isAwaitingResponse={isAwaitingResponse}
          currentToolLabel={currentToolCall ? TOOL_STATUS_LABELS[currentToolCall] : null}
          isCallActive={isCallActive}
          callState={callState}
          humanMode={humanMode}
        />
      )}

      <div
        className={cn(
          'flex h-screen w-full flex-col bg-[#fbfaf7] box-border',
          isEmbed
            ? 'h-dvh max-w-none border-none'
            : 'max-w-[620px] border-x border-[#ddd8d0] max-[480px]:border-x-0'
        )}
      >
        <header
          className={cn(
            'flex items-center justify-between border-b border-[#e6e1d9] bg-[#fbfaf7] px-5 py-4',
            isEmbed && 'pr-[52px]'
          )}
        >
          <div className="flex items-center gap-3">
            <div
              className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-[#23453c] text-[18px] text-white"
              aria-hidden="true"
            >
              ◧
            </div>
            <div>
              <h1 className="m-0 text-base font-semibold tracking-[-0.01em]">Nova</h1>
              <p className="m-0 mt-px text-[12.5px] text-[#7c766e]">
                Your 24/7 customer service agent
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* 转人工客服按钮 */}
            <button
              type="button"
              onClick={handleToggleHumanChat}
              disabled={done}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer shadow-xs select-none disabled:opacity-45 disabled:cursor-default",
                humanMode === 'connected'
                  ? "bg-emerald-700 text-white border-emerald-700 hover:bg-emerald-800"
                  : humanMode === 'ringing'
                    ? "bg-amber-50 text-amber-800 border-amber-300 hover:bg-amber-100"
                    : "bg-white text-[#23453c] border-[#23453c]/40 hover:bg-[#23453c]/5"
              )}
              title={
                humanMode === 'connected'
                  ? "点击挂断人工对话并切回 AI"
                  : humanMode === 'ringing'
                    ? "正在呼叫人工客服，点击取消"
                    : "呼叫人工客服"
              }
            >
              <Headset className="size-3.5" />
              <span>
                {humanMode === 'connected'
                  ? '挂断人工'
                  : humanMode === 'ringing'
                    ? '呼叫中'
                    : '转人工'}
              </span>
            </button>

            {/* 实时语音通话开关 */}
            <button
              type="button"
              onClick={handleToggleCall}
              disabled={done}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer shadow-xs select-none disabled:opacity-45 disabled:cursor-default",
                isCallActive
                  ? "bg-[#b43728] text-white border-[#b43728] animate-pulse"
                  : "bg-white text-[#23453c] border-[#23453c]/40 hover:bg-[#23453c]/5"
              )}
              title={isCallActive ? "挂断实时通话" : "开启免按键实时语音对话"}
            >
              {isCallActive ? <PhoneOff className="size-3.5" /> : <Phone className="size-3.5" />}
              <span>{isCallActive ? "挂断" : "实时通话"}</span>
            </button>

            {/* 自动朗读开关 */}
            <button
              type="button"
              onClick={handleToggleAutoSpeak}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer shadow-xs select-none",
                autoSpeak
                  ? "bg-[#23453c] text-white border-[#23453c]"
                  : "bg-white text-[#7c766e] border-[#ddd8d0] hover:text-[#211f1b] hover:border-[#b0aaa0]"
              )}
              title={autoSpeak ? "Auto-speak enabled (Click to turn off)" : "Auto-speak disabled (Click to turn on)"}
            >
              {autoSpeak ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
              <span>Auto-speak</span>
            </button>
          </div>
        </header>

        {/* 人工对话模式顶部状态横幅 */}
        {humanMode !== 'ai' && (
          <div
            className={cn(
              'flex items-center justify-between gap-2 border-b px-5 py-2 text-xs',
              humanMode === 'connected'
                ? 'border-emerald-200 bg-emerald-50/90 text-emerald-900'
                : 'border-amber-200 bg-amber-50/90 text-amber-900'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={cn(
                  'size-2 flex-none rounded-full',
                  humanMode === 'connected'
                    ? 'bg-emerald-500'
                    : 'bg-amber-500 animate-ping'
                )}
              />
              <span className="truncate font-medium">
                {humanMode === 'connected'
                  ? `人工客服 ${humanAgentName || '专员'} 跨语言通话中（EN ⇄ 中文）`
                  : '正在呼叫人工客服，请等待接听…'}
              </span>
              {humanMode === 'connected' && (
                <div className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-emerald-200 sm:block">
                  <div
                    className="h-full bg-emerald-600 transition-all duration-75"
                    style={{ width: `${Math.round(humanMicLevel * 100)}%` }}
                  />
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-none">
              {humanMode === 'connected' && (
                <button
                  type="button"
                  onClick={toggleHumanMute}
                  className={cn(
                    'flex cursor-pointer items-center gap-1 rounded border px-2 py-0.5 text-[11px] font-medium',
                    humanMuted
                      ? 'border-amber-300 bg-amber-50 text-amber-900'
                      : 'border-emerald-300 bg-white/80 text-emerald-900 hover:bg-white'
                  )}
                >
                  {humanMuted ? <MicOff className="size-3" /> : <Mic className="size-3" />}
                  <span>{humanMuted ? '已静音' : '开麦'}</span>
                </button>
              )}
              {humanMode === 'ringing' && (
                <a
                  href="/agent"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-medium text-amber-900 no-underline hover:bg-amber-100/60"
                >
                  <span>打开值班台</span>
                  <ExternalLink className="size-3" />
                </a>
              )}
              <button
                type="button"
                onClick={handleToggleHumanChat}
                className="cursor-pointer rounded border border-current/25 bg-white/80 px-2 py-0.5 text-[11px] font-medium hover:bg-white"
              >
                {humanMode === 'connected' ? '挂断' : '取消呼叫'}
              </button>
            </div>
          </div>
        )}

        <div
          className="flex flex-1 flex-col gap-3 overflow-y-auto p-5"
          ref={logRef}
        >
          <div className="mb-0.5 self-center text-center text-xs text-[#9a938a]">
            New conversation with Nova
          </div>

          {messages.map((m) => {
            const parts = Array.isArray(m.parts) ? m.parts : [];

            if (m.role === 'user') {
              const fileParts = parts.filter((p) => p.type === 'file');
              const rawText = parts
                .filter((p) => p.type === 'text')
                .map((p) => p.text)
                .join(' ');
              const displayText = formatUserDisplayText(rawText);

              return (
                <div
                  className="msg-bubble msg-user max-w-[82%] self-end break-words rounded-[15px] rounded-br-[5px] bg-[#23453c] px-[13px] py-2.5 text-left text-[15px] leading-normal text-white [overflow-wrap:anywhere]"
                  key={m.id}
                >
                  {fileParts.map((fp, i) =>
                    fp.mediaType?.startsWith('image/') ? (
                      <img
                        key={i}
                        className="mb-1.5 block w-full max-w-[220px] rounded-[9px]"
                        src={fp.url}
                        alt={fp.filename || 'Attached'}
                      />
                    ) : null
                  )}
                  {displayText && <Streamdown>{displayText}</Streamdown>}
                </div>
              );
            }

            // 提取思考过程（AI SDK 原生 reasoning part 或模型在正文中包含的 <think> 标签）
            const reasoningParts = parts.filter(
              (p) => p.type === 'reasoning' || p.type === 'thought'
            );
            let reasoningText = reasoningParts
              .map((p) => p.text || p.reasoningText || '')
              .join('\n')
              .trim();

            let textContent = parts
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('\n');

            if (!reasoningText && textContent.includes('<think>')) {
              const match = textContent.match(/<think>([\s\S]*?)(?:<\/think>|$)/);
              if (match) {
                reasoningText = match[1].trim();
                textContent = textContent.replace(/<think>[\s\S]*?(?:<\/think>|$)/, '').trim();
              }
            } else {
              textContent = textContent.trim();
            }

            if (!textContent && !reasoningText) return null;

            return (
              <div
                className="msg-bubble msg-assistant relative max-w-[82%] self-start break-words rounded-[15px] rounded-bl-[5px] border border-[#e6e1d9] bg-[#efece6] px-[13px] py-2.5 text-left text-[15px] leading-normal [overflow-wrap:anywhere]"
                key={m.id}
              >
                <div className="flex items-center justify-between mb-1.5 border-b border-[#e2ddd5]/60 pb-1">
                  <span className="text-[11.5px] font-semibold text-[#6e685f]">Nova</span>
                </div>

                <ThinkingProcess
                  text={reasoningText}
                  isStreaming={!textContent && status === 'streaming'}
                />
                {textContent ? (
                  <Streamdown>{formatAssistantMarkdown(textContent)}</Streamdown>
                ) : null}
              </div>
            );
          })}

          {humanMode !== 'ai' &&
            humanMessages.map((hm) => {
            if (hm.sender === 'system') {
              return (
                <div key={hm.id} className="my-1 self-center text-center">
                  <span className="inline-block rounded-full bg-[#e6e1d9]/75 px-3 py-0.5 text-[11.5px] text-[#6e685f]">
                    {hm.text} · {hm.time}
                  </span>
                </div>
              );
            }

            if (hm.sender === 'customer') {
              return (
                <div
                  key={hm.id}
                  className="msg-bubble msg-user max-w-[82%] self-end break-words rounded-[15px] rounded-br-[5px] bg-[#23453c] px-[13px] py-2.5 text-left text-[15px] leading-normal text-white [overflow-wrap:anywhere]"
                >
                  {hm.kind === 'transcript' ? (
                    <div className="space-y-1">
                      {hm.sourceText && <div>{hm.sourceText}</div>}
                      {hm.translatedText && (
                        <div className="border-t border-white/20 pt-1 text-xs text-white/80">
                          译文: {hm.translatedText}
                        </div>
                      )}
                    </div>
                  ) : (
                    hm.text
                  )}
                </div>
              );
            }

            return (
              <div
                key={hm.id}
                className="msg-bubble max-w-[82%] self-start break-words rounded-[15px] rounded-bl-[5px] border border-emerald-700/25 bg-white px-[13px] py-2.5 text-left text-[15px] leading-normal text-[#211f1b] shadow-2xs [overflow-wrap:anywhere]"
              >
                <div className="mb-1.5 flex items-center gap-1.5 border-b border-emerald-700/15 pb-1">
                  <span className="size-2 rounded-full bg-emerald-500" />
                  <span className="text-[11.5px] font-semibold text-[#23453c]">
                    客服 · {hm.senderName || '专员'}
                  </span>
                  <span className="rounded bg-emerald-50 px-1.5 py-0.2 text-[10px] font-medium text-emerald-700">
                    人工
                  </span>
                  <span className="ml-auto text-[10.5px] text-[#9a938a]">{hm.time}</span>
                </div>
                {hm.kind === 'transcript' ? (
                  <div className="space-y-1">
                    {hm.translatedText && (
                      <div className="font-medium">{hm.translatedText}</div>
                    )}
                    {hm.sourceText && (
                      <div className="border-t border-[#efece6] pt-1 text-xs text-[#7c766e]">
                        原文: {hm.sourceText}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="whitespace-pre-wrap">{hm.text}</div>
                )}
              </div>
            );
          })}

          {showLoading && (
            <div className="max-w-[82%] self-start px-[13px] py-2.5 text-[13.5px] text-[#9a938a]">
              {uploading
                ? 'Uploading attachment (正在上传附件)…'
                : currentToolCall
                  ? TOOL_STATUS_LABELS[currentToolCall] || `Running ${currentToolCall}…`
                  : '…'}
            </div>
          )}

          {displayError && (
            <div className="flex max-w-full items-center gap-2.5 self-center rounded-[15px] border border-[#e4c7c0] bg-[#f6e6e2] px-[13px] py-2.5 text-center text-[13px] text-[#8a2f24]">
              <span>{displayError}</span>
              <button
                type="button"
                className="cursor-pointer rounded-lg border border-[#c9978c] bg-white px-2.5 py-0.5 text-xs font-semibold text-[#8a2f24]"
                onClick={() => {
                  setLocalError(null);
                  regenerate();
                }}
              >
                Retry
              </button>
            </div>
          )}

          {done && (
            <div className="max-w-full self-center px-[13px] py-2.5 text-center text-[13.5px] font-semibold text-[#23453c]">
              Intake complete — our support team picks it up from here.
            </div>
          )}
        </div>

        {isCallActive && (
          <div className="flex items-center justify-between gap-3 border-t border-[#e6e1d9] bg-[#f3f0ea] px-4 py-2 text-xs text-[#211f1b]">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "h-2 w-2 flex-none rounded-full",
                  callState === "speaking"
                    ? "bg-[#b43728] animate-ping"
                    : callState === "finalizing"
                      ? "bg-[#d97706]"
                      : "bg-[#23453c] animate-pulse"
                )}
              />
              <span className="truncate font-medium">
                {callState === "speaking"
                  ? callLiveText
                    ? `正在听：${callLiveText}`
                    : "正在听您说话…"
                  : callState === "finalizing"
                    ? "正在识别发送…"
                    : effectiveIsPlaying || isAwaitingResponse
                      ? "Nova 回复中（开口可随时打断）"
                      : "实时通话中 · 请直接说话"}
              </span>
            </div>
            <button
              type="button"
              onClick={handleToggleCall}
              className="flex-none cursor-pointer rounded-md bg-[#b43728] px-2.5 py-1 font-medium text-white hover:bg-[#982c1f]"
            >
              挂断
            </button>
          </div>
        )}

        <form
          className="flex gap-2 border-t border-[#e6e1d9] bg-[#fbfaf7] px-4 py-[13px]"
          onSubmit={onSubmit}
        >
          <button
            type="button"
            className="w-[44px] flex-none cursor-pointer rounded-xl border border-[#ddd8d0] bg-white text-[17px] text-[#4a463f] disabled:cursor-default disabled:opacity-45"
            title="Attach a photo, video, or PDF document"
            onClick={() => fileRef.current?.click()}
            disabled={isAwaitingResponse || done}
          >
            ⏍
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/jpeg,image/png,image/heic,image/webp,video/mp4,video/quicktime,application/pdf,.pdf"
            hidden
            onChange={onFileChange}
          />

          {/* 麦克风按住说话按钮 */}
          <VoiceInputButton
            disabled={isAwaitingResponse || done || isCallActive}
            onTranscribed={(text) => {
              const trimmed = text?.trim();
              if (trimmed) {
                setInput((prev) => (prev ? `${prev} ${trimmed}` : trimmed));
                fieldRef.current?.focus();
              }
            }}
          />

          <input
            ref={fieldRef}
            className="flex-1 rounded-xl border border-[#ddd8d0] bg-white px-3.5 py-[11px] text-[15px] text-[#211f1b] placeholder:text-[#9a938a] focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-[#23453c]"
            placeholder={
              done
                ? 'Conversation finished — refresh to restart'
                : humanMode === 'connected'
                  ? `直接说话（自动翻译），或发文字给客服 ${humanAgentName || ''}…`
                  : humanMode === 'ringing'
                    ? '正在等待人工客服接听…'
                    : 'Type your message or hold mic…'
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={done || humanMode === 'ringing'}
            autoFocus
          />
          {status === 'streaming' || status === 'submitted' ? (
            <button
              className="cursor-pointer rounded-xl border-none bg-[#23453c] px-5 py-[11px] font-semibold text-white"
              type="button"
              onClick={() => stop()}
            >
              Stop
            </button>
          ) : (
            <button
              className="cursor-pointer rounded-xl border-none bg-[#23453c] px-5 py-[11px] font-semibold text-white disabled:cursor-default disabled:opacity-45"
              type="submit"
              disabled={isAwaitingResponse || done || !input.trim()}
            >
              Send
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
