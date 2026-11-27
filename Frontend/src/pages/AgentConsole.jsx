import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PhoneCall,
  ArrowUp,
  ExternalLink,
  Mic,
  MicOff,
} from 'lucide-react';
import { useHumanCall } from '../hooks/useHumanCall';
import { cn } from '../utils/cn';
import '../App.css';

const QUICK_RESPONSES = [
  {
    label: 'Confirm customer email',
    text: 'Could you please confirm your personal email address here so I can log the support case?',
  },
  {
    label: 'Request batch label photo',
    text: 'Could you share a clear photo of the batch number label on the product or outer carton?',
  },
  {
    label: '72-hour transit policy',
    text: 'Please note transit damage claims must be reported within 72 hours of delivery with photos of the carton.',
  },
];

const MINI_WAVE = [6, 12, 18, 10, 20, 14, 22, 12, 16, 8, 14, 8];

function formatDuration(seconds) {
  const m = String(Math.floor(seconds / 60)).padStart(2, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export default function AgentConsole() {
  const [agentName, setAgentName] = useState('Ron');
  const [replyText, setReplyText] = useState('');
  const [callSeconds, setCallSeconds] = useState(0);

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

  // Live call duration timer
  useEffect(() => {
    if (status !== 'connected') {
      setCallSeconds(0);
      return undefined;
    }
    const id = setInterval(() => {
      setCallSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [status]);

  function handleSend(e) {
    e?.preventDefault();
    const text = replyText.trim();
    if (!text || status !== 'connected') return;
    sendText(text);
    setReplyText('');
    inputRef.current?.focus();
  }

  function handleQuickResponse(text) {
    if (status === 'connected') {
      sendText(text);
    } else {
      setReplyText(text);
      inputRef.current?.focus();
    }
  }

  // Extract Order IDs, SKUs, and Case Numbers from AI Handoff Summary & live transcript
  const extractedContext = useMemo(() => {
    const corpus = [
      ...aiSummary.map((s) => s.text || ''),
      ...messages.map((m) => `${m.text || ''} ${m.sourceText || ''} ${m.translatedText || ''}`),
    ].join(' ');

    const orders = Array.from(
      new Set((corpus.match(/\b(?:SO|PO)-?[A-Z0-9]{3,12}\b/gi) || []).map((s) => s.toUpperCase()))
    );
    const skus = Array.from(
      new Set((corpus.match(/\bSKU-?[A-Z0-9]{3,12}\b/gi) || []).map((s) => s.toUpperCase()))
    );
    const cases = Array.from(
      new Set((corpus.match(/\bCASE\d{1,10}\b/gi) || []).map((s) => s.toUpperCase()))
    );

    return { orders, skus, cases };
  }, [aiSummary, messages]);

  return (
    <div className="flex h-dvh min-h-screen w-full bg-[#F4F3EF] text-[#18181B]">
      {/* ==================== LEFT COLUMN: INCOMING & QUICK RESPONSES ==================== */}
      <aside className="hidden md:flex w-[270px] lg:w-[300px] flex-none flex-col justify-between border-r border-[#E5E4DF] bg-[#F4F3EF] p-6">
        <div className="space-y-7">
          {/* Brand & Specialist Identity */}
          <div className="flex items-start justify-between gap-2">
            <div>
              <h1 className="m-0 text-[26px] font-semibold leading-none tracking-[-0.03em] text-[#18181B]">
                Nova
              </h1>
              <p className="m-0 mt-1.5 text-[13.5px] text-[#78716C]">
                Specialist Workspace
              </p>
            </div>
            <a
              href="/"
              target="_blank"
              rel="noreferrer"
              title="Open Customer Portal"
              className="inline-flex items-center gap-1 rounded-full border border-[#D6D3CD] bg-white/80 px-2.5 py-1 text-[11.5px] font-medium text-[#57534E] no-underline transition-colors hover:bg-white hover:text-[#18181B]"
            >
              <span>Portal</span>
              <ExternalLink className="size-3" />
            </a>
          </div>

          {/* Specialist Profile & WS Connection Pill */}
          <div className="flex items-center justify-between rounded-xl border border-[#E5E4DF] bg-white/75 px-3.5 py-2 text-[12.5px]">
            <div className="flex items-center gap-2">
              <span
                className={cn(
                  'size-2 rounded-full',
                  wsConnected ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
                )}
              />
              <span className="text-[#78716C]">Specialist:</span>
              <input
                value={agentName}
                onChange={(e) => {
                  setAgentName(e.target.value);
                  updateAgentProfile(e.target.value, 'zh-Hans');
                }}
                disabled={status === 'connected'}
                className="w-20 border-none bg-transparent font-semibold text-[#18181B] focus:outline-none"
                aria-label="Specialist name"
              />
            </div>
            <span className="text-[11px] font-medium text-[#8C8881]">
              {wsConnected ? 'Online' : 'Connecting…'}
            </span>
          </div>

          {/* Incoming & Active Sessions */}
          <div className="space-y-3">
            <h2 className="m-0 text-[13px] font-semibold tracking-[-0.01em] text-[#18181B]">
              Incoming &amp; Active
            </h2>

            {status === 'connected' && (
              <div className="rounded-2xl border-[1.5px] border-[#18181B] bg-white p-4 shadow-[0_2px_10px_rgba(0,0,0,0.04)]">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-[#18181B]">
                    #{activeCaseRef || 'LIVE'} · Live Voice
                  </span>
                  <span className="size-2.5 flex-none rounded-full bg-emerald-500" />
                </div>

                {/* Live Audio Waveform Meter */}
                <div className="my-3 flex h-5 items-center gap-1">
                  {MINI_WAVE.map((baseH, idx) => {
                    const dynamicBoost = Math.round(micLevel * 18);
                    const h = isMuted ? 4 : Math.min(22, Math.max(4, Math.round(baseH * 0.55) + dynamicBoost));
                    return (
                      <span
                        key={idx}
                        className="w-[2.5px] rounded-full bg-[#A8A29E] transition-all duration-75"
                        style={{ height: `${h}px` }}
                      />
                    );
                  })}
                </div>

                <div className="truncate text-[12.5px] text-[#57534E]">
                  {extractedContext.orders[0]
                    ? `Order ${extractedContext.orders[0]}`
                    : extractedContext.skus[0] || 'Live Voice Translation'}
                </div>
              </div>
            )}

            {status === 'ringing' && (
              <div className="rounded-2xl border-[1.5px] border-[#18181B] bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[13.5px] font-semibold text-[#18181B]">
                    #{activeCaseRef || 'CALL'} · Ringing
                  </span>
                  <span className="size-2.5 flex-none animate-ping rounded-full bg-amber-500" />
                </div>
                <p className="m-0 mt-1.5 text-[12px] text-[#78716C]">
                  Customer requesting live specialist voice support
                </p>
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={rejectCall}
                    className="cursor-pointer rounded-full border border-[#D6D3CD] bg-white py-1.5 text-[12px] font-medium text-[#57534E] hover:bg-[#FAF9F6]"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    onClick={() => acceptCall(agentName)}
                    className="cursor-pointer rounded-full bg-[#18181B] py-1.5 text-[12px] font-medium text-white hover:bg-[#27272A]"
                  >
                    Answer
                  </button>
                </div>
              </div>
            )}

            {status === 'idle' && (
              <div className="rounded-2xl border border-[#E5E4DF] bg-white/60 p-4 text-[13px] text-[#78716C]">
                No active calls. Standing by for customer escalations.
              </div>
            )}
          </div>
        </div>

        {/* Quick Responses */}
        <div className="space-y-2.5 pt-4">
          <h2 className="m-0 text-[13px] font-semibold tracking-[-0.01em] text-[#18181B]">
            Quick Responses
          </h2>
          <div className="flex flex-col gap-2">
            {QUICK_RESPONSES.map((qr) => (
              <button
                key={qr.label}
                type="button"
                onClick={() => handleQuickResponse(qr.text)}
                className="w-full cursor-pointer truncate rounded-full border border-[#18181B]/30 bg-transparent px-4 py-2 text-center text-[12.5px] font-medium text-[#18181B] transition-colors hover:border-[#18181B] hover:bg-white"
                title={qr.text}
              >
                {qr.label}
              </button>
            ))}
          </div>
        </div>
      </aside>

      {/* ==================== CENTER COLUMN: LIVE VOICE & TRANSCRIPT ==================== */}
      <main className="flex min-w-0 flex-1 flex-col bg-[#F4F3EF] px-4 py-4 sm:px-8 sm:py-6">
        <div className="mx-auto flex h-full w-full max-w-[780px] flex-col">
          {/* Top Call Control Card */}
          <header className="flex flex-none items-center justify-between gap-3 rounded-2xl border border-[#E7E5E4] bg-[#FAF9F6] px-5 py-3.5 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  'size-2.5 flex-none rounded-full',
                  status === 'connected'
                    ? 'bg-emerald-500'
                    : status === 'ringing'
                      ? 'bg-amber-500 animate-ping'
                      : wsConnected
                        ? 'bg-emerald-500/50'
                        : 'bg-amber-400'
                )}
              />
              <span className="truncate text-[14.5px] font-semibold tracking-[-0.01em] text-[#18181B]">
                {status === 'connected' ? (
                  <>
                    Live Voice Active{' '}
                    <span className="font-normal text-[#57534E]">
                      · {formatDuration(callSeconds)}
                    </span>
                  </>
                ) : status === 'ringing' ? (
                  `Incoming Call · #${activeCaseRef || ''}`
                ) : (
                  'Standby · Ready for Calls'
                )}
              </span>
              {status === 'connected' && liveStatusText && (
                <span className="hidden truncate text-[12px] text-[#8C8881] lg:inline">
                  · {liveStatusText}
                </span>
              )}
            </div>

            {status === 'connected' && (
              <div className="flex flex-none items-center gap-2">
                <button
                  type="button"
                  onClick={toggleMute}
                  className={cn(
                    'flex cursor-pointer items-center gap-1.5 rounded-full border px-4 py-1.5 text-[13px] font-medium transition-colors',
                    isMuted
                      ? 'border-amber-400 bg-amber-50 text-amber-900'
                      : 'border-[#18181B] bg-white text-[#18181B] hover:bg-[#F4F3EF]'
                  )}
                >
                  {isMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                  <span>{isMuted ? 'Unmute' : 'Mute'}</span>
                </button>
                <button
                  type="button"
                  onClick={hangup}
                  className="cursor-pointer rounded-full border border-[#C88A8A] bg-white px-4 py-1.5 text-[13px] font-medium text-[#9E4747] transition-colors hover:bg-[#FDF2F2]"
                >
                  End Call
                </button>
              </div>
            )}
          </header>

          {callError && (
            <div className="mt-3 rounded-xl border border-[#E5C9C9] bg-[#FDF5F5] px-4 py-2.5 text-[12.5px] text-[#8F3A3A]">
              {callError}
            </div>
          )}

          {/* Center Stream */}
          <div className="nova-scroll flex flex-1 flex-col gap-4 overflow-y-auto py-6">
            {status === 'idle' && (
              <div className="m-auto max-w-sm text-center">
                <p className="m-0 text-[15px] font-semibold text-[#18181B]">
                  Waiting for incoming specialist calls
                </p>
                <p className="m-0 mt-1.5 text-[13px] leading-relaxed text-[#78716C]">
                  Real-time bidirectional voice translation and live captions will appear here automatically once a call is answered.
                </p>
              </div>
            )}

            {status === 'ringing' && (
              <div className="m-auto w-full max-w-md rounded-3xl border border-[#E5E4DF] bg-white p-6 text-center shadow-[0_8px_30px_rgba(0,0,0,0.05)]">
                <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-[#F4F3EF] text-[#18181B]">
                  <PhoneCall className="size-5 animate-pulse" />
                </div>
                <h2 className="m-0 text-[17px] font-semibold text-[#18181B]">
                  Incoming Customer Call
                </h2>
                <p className="m-0 mt-1 font-mono text-[12.5px] text-[#78716C]">
                  Session #{activeCaseRef} · Real-time Voice Translation
                </p>

                <div className="mt-6 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={rejectCall}
                    className="cursor-pointer rounded-full border border-[#D6D3CD] bg-white py-2.5 text-[13.5px] font-medium text-[#57534E] hover:bg-[#FAF9F6]"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    onClick={() => acceptCall(agentName)}
                    className="cursor-pointer rounded-full bg-[#18181B] py-2.5 text-[13.5px] font-medium text-white hover:bg-[#27272A]"
                  >
                    Answer Call
                  </button>
                </div>
              </div>
            )}

            {status === 'connected' &&
              messages.map((m) => {
                if (m.sender === 'system') {
                  return (
                    <div key={m.id} className="my-1 self-center text-center">
                      <span className="inline-block rounded-full border border-[#E5E4DF] bg-white/80 px-3.5 py-1 text-[11.5px] text-[#78716C]">
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
                      'w-full max-w-[80%] rounded-2xl border border-[#ECEAE4] bg-white p-4 shadow-[0_1px_4px_rgba(0,0,0,0.03)]',
                      isAgent ? 'self-end' : 'self-start'
                    )}
                  >
                    <div className="mb-1.5 text-[13px] text-[#57534E]">
                      <strong className="font-semibold text-[#18181B]">
                        {isAgent ? 'Specialist' : 'Customer'}
                      </strong>{' '}
                      · {m.time}
                    </div>

                    {m.kind === 'transcript' ? (
                      <div className="space-y-1.5">
                        {isAgent ? (
                          <>
                            <div className="text-[15px] leading-relaxed text-[#18181B]">
                              {m.translatedText || m.sourceText}
                            </div>
                            <div className="text-[12.5px] text-[#8C8881]">
                              Live Caption · Translated Ready
                              {m.sourceText && m.translatedText ? ` (${m.sourceText})` : ''}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="text-[15px] leading-relaxed text-[#18181B]">
                              {m.sourceText || m.translatedText}
                            </div>
                            <div className="text-[12.5px] text-[#8C8881]">
                              Live Caption · EN-AU
                              {m.translatedText && m.sourceText ? ` (${m.translatedText})` : ''}
                            </div>
                          </>
                        )}
                      </div>
                    ) : (
                      <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-[#18181B]">
                        {m.text}
                      </div>
                    )}
                  </div>
                );
              })}

            <div ref={endRef} />
          </div>

          {/* Floating Pill Reply Composer */}
          <form
            onSubmit={handleSend}
            className="flex flex-none items-center gap-2 rounded-full border border-[#E5E4DF] bg-white py-2 pl-5 pr-2 shadow-[0_2px_14px_rgba(0,0,0,0.04)] focus-within:border-[#18181B]/25"
          >
            <input
              ref={inputRef}
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              disabled={status !== 'connected'}
              placeholder={
                status === 'connected'
                  ? 'Type a reply...'
                  : 'Answer a call to send live replies...'
              }
              className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-[14.5px] text-[#18181B] placeholder:text-[#8C8881] focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={status !== 'connected' || !replyText.trim()}
              aria-label="Send reply"
              className="flex size-9 flex-none cursor-pointer items-center justify-center rounded-full bg-[#18181B] text-white transition-all hover:bg-[#27272A] disabled:cursor-default disabled:opacity-25"
            >
              <ArrowUp className="size-[18px] stroke-[2]" />
            </button>
          </form>
        </div>
      </main>

      {/* ==================== RIGHT COLUMN: AI HANDOFF SUMMARY & CASE CONTEXT ==================== */}
      <aside className="nova-scroll hidden lg:flex w-[310px] xl:w-[340px] flex-none flex-col overflow-y-auto border-l border-[#E5E4DF] bg-[#F8F7F4] p-6">
        {/* AI Handoff Summary */}
        <div>
          <h2 className="m-0 text-[14px] font-semibold tracking-[-0.01em] text-[#18181B]">
            AI Handoff Summary
          </h2>
          {aiSummary.length > 0 ? (
            <ul className="m-0 mt-3.5 list-disc space-y-2.5 pl-4 text-[13.5px] leading-relaxed text-[#27272A]">
              {aiSummary.map((item, idx) => (
                <li key={item.id || idx}>
                  <span className="font-medium text-[#18181B]">
                    {item.role === 'user' ? 'Customer: ' : 'Nova: '}
                  </span>
                  <span className="text-[#44403C]">{item.text}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="m-0 mt-3 text-[13px] leading-relaxed text-[#78716C]">
              Prior AI conversation context will populate here when a customer escalates to a specialist.
            </p>
          )}
        </div>

        <hr className="my-6 border-0 border-t border-[#E5E4DF]" />

        {/* Case Context Cards */}
        <div className="space-y-3">
          <h2 className="m-0 text-[14px] font-semibold tracking-[-0.01em] text-[#18181B]">
            Case Context
          </h2>

          {activeCaseRef ? (
            <div className="rounded-2xl border border-[#18181B]/35 bg-white p-4">
              <div className="text-[13.5px] font-semibold text-[#18181B]">
                Session #{activeCaseRef}
              </div>
              <div className="mt-1 text-[12.5px] text-[#57534E]">
                {status === 'connected' ? 'Live Voice Active · EN ⇄ Audio' : 'Ringing · Pending Answer'}
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-[#E5E4DF] bg-white/70 p-4 text-[13px] text-[#78716C]">
              No active session selected.
            </div>
          )}

          {extractedContext.orders.map((ord) => (
            <div key={ord} className="rounded-2xl border border-[#18181B]/35 bg-white p-4">
              <div className="text-[13.5px] font-semibold text-[#18181B]">
                Order #{ord}
              </div>
              <div className="mt-1 text-[12.5px] text-[#57534E]">
                Referenced in customer conversation
              </div>
            </div>
          ))}

          {extractedContext.skus.map((sku) => (
            <div key={sku} className="rounded-2xl border border-[#18181B]/35 bg-white p-4">
              <div className="text-[13.5px] font-semibold text-[#18181B]">{sku}</div>
              <div className="mt-1 text-[12.5px] text-[#57534E]">
                Product enquiry / warranty item
              </div>
            </div>
          ))}

          {extractedContext.cases.map((cs) => (
            <div key={cs} className="rounded-2xl border border-[#18181B]/35 bg-white p-4">
              <div className="text-[13.5px] font-semibold text-[#18181B]">{cs}</div>
              <div className="mt-1 text-[12.5px] text-[#57534E]">
                NetSuite Support Case
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
