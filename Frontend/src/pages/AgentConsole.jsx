import React, { useEffect, useRef, useState } from 'react';
import {
  Headset,
  PhoneCall,
  PhoneOff,
  Send,
  ExternalLink,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Mic,
  MicOff,
  Languages,
} from 'lucide-react';
import { useHumanCall } from '../hooks/useHumanCall';
import { cn } from '../utils/cn';
import '../App.css';

export default function AgentConsole() {
  const [agentName, setAgentName] = useState('Ron');
  const [replyText, setReplyText] = useState('');
  const [showContext, setShowContext] = useState(false);

  const endRef = useRef(null);
  const inputRef = useRef(null);

  const {
    status,
    wsConnected,
    activeCaseRef,
    aiSummary,
    messages,
    isMuted,
    micLevel,
    liveStatusText,
    callError,
    acceptCall,
    rejectCall,
    sendText,
    hangup,
    toggleMute,
    updateAgentProfile,
  } = useHumanCall({
    role: 'agent',
    agentName,
    lang: 'zh-Hans',
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, status]);

  useEffect(() => {
    if (status === 'connected') {
      inputRef.current?.focus();
    }
  }, [status]);

  function handleSend(e) {
    e?.preventDefault();
    const text = replyText.trim();
    if (!text || status !== 'connected') return;
    sendText(text);
    setReplyText('');
    inputRef.current?.focus();
  }

  return (
    <div className="flex min-h-screen justify-center bg-[#eceae4] text-[#211f1b]">
      <div className="flex h-screen w-full max-w-[620px] flex-col border-x border-[#ddd8d0] bg-[#fbfaf7] max-[480px]:border-x-0">
        {/* 顶栏 */}
        <header className="flex items-center justify-between border-b border-[#e6e1d9] bg-[#fbfaf7] px-5 py-3.5">
          <div className="flex items-center gap-3">
            <div className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[9px] bg-[#23453c] text-white">
              <Headset className="size-4" />
            </div>
            <div>
              <h1 className="m-0 text-base font-semibold">Nova 人工值班台</h1>
              <p className="m-0 flex items-center gap-1.5 text-xs text-[#7c766e]">
                <Languages className="size-3 text-[#23453c]" />
                <span>
                  {status === 'connected'
                    ? `通话中 · 中文 ⇄ EN · ${activeCaseRef || ''}`
                    : status === 'ringing'
                      ? `新呼叫接入 · ${activeCaseRef || ''}`
                      : '跨语言单线模式（客服说中文 ⇄ 客户听英文）'}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {status === 'connected' ? (
              <>
                <button
                  type="button"
                  onClick={toggleMute}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    isMuted
                      ? 'border-amber-300 bg-amber-50 text-amber-800'
                      : 'border-[#23453c]/30 bg-white text-[#23453c]'
                  )}
                  title={isMuted ? '取消静音' : '静音麦克风'}
                >
                  {isMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                  <span>{isMuted ? '已静音' : '开麦中'}</span>
                </button>
                <button
                  type="button"
                  onClick={hangup}
                  className="flex cursor-pointer items-center gap-1.5 rounded-full border-none bg-[#b43728] px-3.5 py-1.5 text-xs font-medium text-white hover:bg-[#982c1f]"
                >
                  <PhoneOff className="size-3.5" />
                  <span>挂断</span>
                </button>
              </>
            ) : (
              <>
                <div className="flex items-center gap-1.5 rounded-full border border-[#ddd8d0] bg-white px-2.5 py-1 text-xs">
                  <span
                    className={cn(
                      'size-2 rounded-full',
                      wsConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
                    )}
                  />
                  <input
                    value={agentName}
                    onChange={(e) => {
                      setAgentName(e.target.value);
                      updateAgentProfile(e.target.value, 'zh-Hans');
                    }}
                    className="w-14 border-none bg-transparent font-medium text-[#211f1b] focus:outline-none"
                    aria-label="Agent name"
                  />
                </div>
                <a
                  href="/"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1 rounded-full border border-[#23453c]/35 bg-white px-3 py-1 text-xs font-medium text-[#23453c] no-underline hover:bg-[#23453c]/5"
                >
                  <span>客户端</span>
                  <ExternalLink className="size-3" />
                </a>
              </>
            )}
          </div>
        </header>

        {/* 通话中麦克风音量 & 翻译通道状态条 */}
        {status === 'connected' && (
          <div className="flex items-center justify-between border-b border-emerald-200 bg-emerald-50/80 px-5 py-1.5 text-[11.5px] text-emerald-900">
            <div className="flex items-center gap-2">
              <span className="font-medium">
                {isMuted ? '麦克风已静音' : '直接说中文，客户将实时听到英文译音'}
              </span>
              <div className="h-1.5 w-16 overflow-hidden rounded-full bg-emerald-200">
                <div
                  className="h-full bg-emerald-600 transition-all duration-75"
                  style={{ width: `${Math.round(micLevel * 100)}%` }}
                />
              </div>
            </div>
            {liveStatusText && (
              <span className="truncate text-[11px] text-emerald-700/80">
                {liveStatusText}
              </span>
            )}
          </div>
        )}

        {callError && (
          <div className="border-b border-[#b43728]/20 bg-[#b43728]/10 px-5 py-2 text-xs text-[#982c1f]">
            {callError}
          </div>
        )}

        {/* 状态 1：空闲待命 */}
        {status === 'idle' && (
          <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-[#23453c]/10 text-[#23453c]">
              <Headset className="size-8" />
            </div>
            <div
              className={cn(
                'inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium',
                wsConnected
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-amber-50 text-amber-800'
              )}
            >
              <span
                className={cn(
                  'size-2 rounded-full animate-pulse',
                  wsConnected ? 'bg-emerald-500' : 'bg-amber-500'
                )}
              />
              <span>{wsConnected ? 'WebSocket 已连接 · 在线待命' : '正在连接后端 /ws/human…'}</span>
            </div>
            <h2 className="mt-3 mb-1 text-base font-semibold text-[#211f1b]">
              等待客户发起跨语言人工通话…
            </h2>
            <p className="max-w-xs text-xs leading-relaxed text-[#7c766e]">
              接听后直接说中文，系统通过 Gemini Live Translate 实时翻成英文语音播放给客户；客户说英文时你会实时听到中文语音并看到双语字幕。
            </p>
          </div>
        )}

        {/* 状态 2：响铃呼叫中 */}
        {status === 'ringing' && (
          <div className="flex flex-1 flex-col items-center justify-center px-6">
            <div className="w-full max-w-md rounded-2xl border border-amber-300 bg-white p-6 shadow-md">
              <div className="flex items-center justify-center">
                <div className="grid h-14 w-14 place-items-center rounded-full bg-amber-100 text-amber-700 animate-bounce">
                  <PhoneCall className="size-7" />
                </div>
              </div>
              <h2 className="mt-4 mb-1 text-center text-base font-semibold">
                有客户请求跨语言人工对话
              </h2>
              <p className="mb-4 text-center font-mono text-xs text-[#7c766e]">
                会话编号：{activeCaseRef} · 语言：English ⇄ 中文
              </p>

              {aiSummary.length > 0 && (
                <div className="mb-5 rounded-xl border border-[#e6e1d9] bg-[#fbfaf7] p-3">
                  <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium text-[#6e685f]">
                    <Sparkles className="size-3 text-[#23453c]" />
                    <span>转接前最近对话</span>
                  </div>
                  <div className="max-h-36 space-y-1.5 overflow-y-auto text-xs leading-relaxed">
                    {aiSummary.map((item, idx) => (
                      <div key={item.id || idx}>
                        <span
                          className={cn(
                            'mr-1.5 font-semibold',
                            item.role === 'user' ? 'text-[#23453c]' : 'text-[#8c857c]'
                          )}
                        >
                          {item.role === 'user' ? '客户:' : 'AI:'}
                        </span>
                        <span className="text-[#4a463f]">{item.text}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={rejectCall}
                  className="cursor-pointer rounded-xl border border-[#ddd8d0] bg-white py-2.5 text-sm font-medium text-[#6e685f] hover:bg-[#f3f1eb]"
                >
                  拒接（正忙）
                </button>
                <button
                  type="button"
                  onClick={() => acceptCall(agentName)}
                  className="cursor-pointer rounded-xl border-none bg-[#23453c] py-2.5 text-sm font-semibold text-white hover:bg-[#1a342d]"
                >
                  立即接听
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 状态 3：1 对 1 跨语言实时通话中 */}
        {status === 'connected' && (
          <>
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
              {aiSummary.length > 0 && (
                <div className="rounded-xl border border-[#e6e1d9] bg-white p-3">
                  <button
                    type="button"
                    onClick={() => setShowContext((v) => !v)}
                    className="flex w-full cursor-pointer items-center justify-between border-none bg-transparent p-0 text-xs font-medium text-[#6e685f]"
                  >
                    <span className="flex items-center gap-1.5">
                      <Sparkles className="size-3.5 text-[#23453c]" />
                      <span>查看转接前 AI 对话（{aiSummary.length} 条）</span>
                    </span>
                    {showContext ? (
                      <ChevronDown className="size-4" />
                    ) : (
                      <ChevronRight className="size-4" />
                    )}
                  </button>
                  {showContext && (
                    <div className="mt-2 space-y-1.5 border-t border-[#efece6] pt-2 text-xs leading-relaxed">
                      {aiSummary.map((item, idx) => (
                        <div key={item.id || idx}>
                          <span className="mr-1.5 font-semibold text-[#23453c]">
                            {item.role === 'user' ? '客户:' : 'AI:'}
                          </span>
                          <span className="text-[#4a463f]">{item.text}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {messages.map((m) => {
                if (m.sender === 'system') {
                  return (
                    <div key={m.id} className="my-1 self-center text-center">
                      <span className="rounded-full bg-[#e6e1d9]/75 px-3 py-0.5 text-[11px] text-[#6e685f]">
                        {m.text} · {m.time}
                      </span>
                    </div>
                  );
                }

                const isAgent = m.sender === 'agent';
                return (
                  <div
                    key={m.id}
                    className={cn(
                      'flex flex-col',
                      isAgent ? 'items-end' : 'items-start'
                    )}
                  >
                    <span className="mb-1 px-1 text-[11px] text-[#9a938a]">
                      {isAgent ? m.senderName || agentName : '客户'} · {m.time}
                    </span>
                    <div
                      className={cn(
                        'max-w-[82%] break-words rounded-[15px] px-[13px] py-2.5 text-[15px] leading-normal [overflow-wrap:anywhere]',
                        isAgent
                          ? 'rounded-br-[5px] bg-[#23453c] text-white'
                          : 'rounded-bl-[5px] border border-[#e6e1d9] bg-white text-[#211f1b]'
                      )}
                    >
                      {m.kind === 'transcript' ? (
                        <div className="space-y-1">
                          {isAgent ? (
                            <>
                              {m.sourceText && <div>{m.sourceText}</div>}
                              {m.translatedText && (
                                <div className="border-t border-white/20 pt-1 text-xs text-white/80">
                                  EN: {m.translatedText}
                                </div>
                              )}
                            </>
                          ) : (
                            <>
                              {m.translatedText && (
                                <div className="font-medium">{m.translatedText}</div>
                              )}
                              {m.sourceText && (
                                <div className="border-t border-[#efece6] pt-1 text-xs text-[#7c766e]">
                                  原文: {m.sourceText}
                                </div>
                              )}
                            </>
                          )}
                        </div>
                      ) : (
                        <div>{m.text}</div>
                      )}
                    </div>
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>

            <form
              onSubmit={handleSend}
              className="flex gap-2 border-t border-[#e6e1d9] bg-[#fbfaf7] px-4 py-[13px]"
            >
              <input
                ref={inputRef}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="可直接说话，或在此发送单号/型号文字…"
                className="flex-1 rounded-xl border border-[#ddd8d0] bg-white px-3.5 py-[11px] text-[15px] text-[#211f1b] placeholder:text-[#9a938a] focus:outline focus:outline-2 focus:-outline-offset-1 focus:outline-[#23453c]"
              />
              <button
                type="submit"
                disabled={!replyText.trim()}
                className="flex cursor-pointer items-center gap-1.5 rounded-xl border-none bg-[#23453c] px-5 py-[11px] font-semibold text-white disabled:cursor-default disabled:opacity-45"
              >
                <Send className="size-4" />
                <span>发送</span>
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
