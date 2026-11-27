import React, {
  useState,
  useEffect,
  useMemo,
  useRef,
  useCallback,
  lazy,
  Suspense,
  Component,
} from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, getToolName, isToolUIPart } from 'ai';
import {
  Volume2,
  VolumeX,
  PhoneOff,
  ExternalLink,
  Mic,
  MicOff,
  Paperclip,
  ArrowUp,
  Square,
  Eye,
  HelpCircle,
  X,
  Package,
  Box,
  ShieldCheck,
  FileText,
  Headset,
  Loader2,
} from 'lucide-react';
import { resizeImage } from './utils/image';
import { API_BASE, uploadFile, generateCaseRef } from './utils/api';
import { useHumanCall } from './hooks/useHumanCall';
import { useAudioPlayer } from './hooks/useAudioPlayer';
import { useLiveCall } from './hooks/useLiveCall';
import { useLamAvatar } from './hooks/useLamAvatar';
import { VoiceInputButton } from './components/VoiceInputButton';
import { AvatarPanel, FEATURE_TIPS } from './components/AvatarPanel';
import { ToolResultCard } from './components/ToolResultCard';
import { cn } from './utils/cn';
import './App.css';

const TOOL_STATUS_LABELS = {
  getInformation: 'Searching warranty knowledge base…',
  get_product_info: 'Checking live warehouse stock…',
  check_order_status: 'Checking order & dispatch status…',
  check_case_status: 'Checking support case status…',
  start_warranty_claim: 'Logging support case in NetSuite…',
};

const QUICK_PROMPTS = [
  {
    id: 'order',
    title: 'Track an order',
    subtitle: 'Check dispatch status & StarTrack tracking',
    prompt: "I'd like to check the dispatch and tracking status of an order.",
    Icon: Package,
  },
  {
    id: 'stock',
    title: 'Product & stock lookup',
    subtitle: 'Specs, RRP & live NSW / QLD / VIC stock',
    prompt: 'Can you look up product specifications and state warehouse stock for a SKU?',
    Icon: Box,
  },
  {
    id: 'warranty',
    title: 'Start a warranty claim',
    subtitle: 'Upload photos for fast fault assessment',
    prompt: 'I need to start a warranty or transit damage claim for a product.',
    Icon: ShieldCheck,
  },
  {
    id: 'case',
    title: 'Check case status',
    subtitle: 'Follow up on an existing support case',
    prompt: "I'd like to check the status of an existing support case.",
    Icon: FileText,
  },
];

// Lazy-load Streamdown Markdown parser so initial render stays instant
const Streamdown = lazy(() =>
  import('streamdown').then((module) => ({ default: module.Streamdown }))
);

function PlainText({ text }) {
  return <div className="whitespace-pre-wrap">{text}</div>;
}

class MarkdownErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <PlainText text={this.props.text} />;
    return this.props.children;
  }
}

function MarkdownContent({ text }) {
  return (
    <MarkdownErrorBoundary text={text}>
      <Suspense fallback={<PlainText text={text} />}>
        <Streamdown>{text}</Streamdown>
      </Suspense>
    </MarkdownErrorBoundary>
  );
}

/**
 * Strip internal system instructions from user bubble display
 */
function formatUserDisplayText(text) {
  if (!text) return '';
  if (text.startsWith('[The customer attached this photo.')) return '';
  const pdfMatch = text.match(/^\[The customer uploaded a PDF document: ([^.]+)\./);
  if (pdfMatch) return `PDF attached: ${pdfMatch[1]}`;
  const videoMatch = text.match(/^\[The customer uploaded a video: ([^.]+)\./);
  if (videoMatch) return `Video attached: ${videoMatch[1]}`;
  const fileMatch = text.match(/^\[The customer uploaded a file: ([^.]+)\./);
  if (fileMatch) return `File attached: ${fileMatch[1]}`;
  return text;
}

/**
 * Format raw guidance/evidence URLs into clean Markdown links
 */
function formatAssistantMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/(?<!\]\()https?:\/\/[^\s)]+/g, (url) => {
      if (url.includes('/guidance/')) return `[View batch label guide](${url})`;
      if (url.includes('/evidence/')) return `[View uploaded files](${url})`;
      return url;
    })
    .replace(/(?<!\]\()\/guidance\/[^\s)]+/g, (url) => {
      return `[View batch label guide](${url})`;
    });
}

/**
 * Framed 3D Digital Human Avatar Thumbnail (Assistant / Nova)
 */
function NovaAvatar({ src }) {
  return (
    <div className="mt-0.5 size-9 flex-none rounded-full border border-[#D8D4CB] bg-white p-[1.5px] shadow-[0_1px_3px_rgba(0,0,0,0.06)] select-none">
      <div className="h-full w-full overflow-hidden rounded-full bg-[#EAE7E0]">
        <img
          src={src || '/nova-3d-thumb.png'}
          alt="Nova"
          className="h-full w-full object-cover object-center scale-[1.08]"
        />
      </div>
    </div>
  );
}

/**
 * Framed Specialist Avatar (Human Escalation)
 */
function SpecialistAvatar() {
  return (
    <div className="mt-0.5 size-9 flex-none rounded-full border border-emerald-600/30 bg-white p-[1.5px] shadow-[0_1px_3px_rgba(0,0,0,0.06)] select-none">
      <div className="flex h-full w-full items-center justify-center rounded-full bg-emerald-50 text-emerald-800">
        <Headset className="size-4 stroke-[1.8]" />
      </div>
    </div>
  );
}

/**
 * Bespoke Minimalist Geometric Portrait Avatar (Customer / Self)
 */
function CustomerAvatar() {
  return (
    <div className="mt-0.5 size-9 flex-none rounded-full border border-[#18181B]/15 bg-white p-[1.5px] shadow-[0_1px_3px_rgba(0,0,0,0.06)] select-none">
      <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-full bg-[#18181B]">
        <svg
          viewBox="0 0 36 36"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="h-full w-full"
          aria-hidden="true"
        >
          {/* Subtle architectural halo arc */}
          <circle cx="18" cy="18" r="14.5" stroke="#FAF9F6" strokeOpacity="0.14" strokeWidth="1" />
          {/* Sculpted head silhouette */}
          <circle cx="18" cy="13.5" r="5.2" fill="#FAF9F6" />
          {/* Minimalist tailored shoulders */}
          <path
            d="M8.5 31C9.8 25.1 13.4 22.2 18 22.2C22.6 22.2 26.2 25.1 27.5 31"
            fill="#FAF9F6"
          />
          {/* Subtle warm stone collar accent */}
          <path
            d="M14.8 22.5L18 26.2L21.2 22.5"
            stroke="#18181B"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}

/**
 * Collapsible model reasoning disclosure
 */
function ThinkingProcess({ text, isStreaming }) {
  const [isOpen, setIsOpen] = useState(false);

  if (!text) return null;

  return (
    <details
      className="rounded-xl border border-[#ECEAE4] bg-[#F8F7F4] px-3.5 py-2 text-xs text-[#78716C] transition-all"
      open={isOpen}
      onToggle={(e) => setIsOpen(e.currentTarget.open)}
    >
      <summary className="flex cursor-pointer select-none items-center gap-2 font-medium text-[#57534E] hover:text-[#18181B]">
        <span>
          Reasoning{' '}
          {isStreaming && (
            <span className="animate-pulse font-normal text-[#8C8881]">(thinking…)</span>
          )}
        </span>
      </summary>
      <div className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap border-t border-[#E7E5E4] pt-2 font-mono text-[11.5px] leading-relaxed text-[#57534E]">
        {text}
      </div>
    </details>
  );
}

export default function App() {
  const [input, setInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState(null);
  const [stageCollapsed, setStageCollapsed] = useState(false);
  const [showTipsPopover, setShowTipsPopover] = useState(false);

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
    setCallError: setHumanCallError,
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
    autoConnect: true,
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

  const { messages, setMessages, status, sendMessage, stop, regenerate, error } = useChat({
    messages: [],
    transport,
    onError(err) {
      setLocalError(err?.message || "Couldn't reach the support server.");
    },
  });

  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const handleToggleAutoSpeak = useCallback(() => {
    if (autoSpeak) {
      stopAudio();
      avatar.interrupt();
      if (!avatar.isMuted) {
        avatar.toggleMute();
      }
      setAutoSpeak(false);
    } else {
      if (avatar.isMuted) {
        avatar.toggleMute();
      }
      avatar.unlockAudio();
      setAutoSpeak(true);
    }
  }, [autoSpeak, avatar, setAutoSpeak, stopAudio]);

  const effectiveIsPlaying = avatar.isConnected ? avatar.isSpeaking : isPlaying;

  const {
    isCallActive,
    callState,
    liveText: callLiveText,
    liveToolName,
    callError,
    startCall,
    endCall,
  } = useLiveCall({
    sessionId: caseRef.current,
    getHistory: () =>
      (messagesRef.current || [])
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({
          role: m.role,
          text: (m.parts || [])
            .filter((p) => p.type === 'text' && p.text)
            .map((p) => p.text)
            .join('\n')
            .trim(),
        }))
        .filter((t) => t.text),
    onInterrupt: () => {
      stopAudio();
      avatar.interrupt();
      if (status === 'streaming' || status === 'submitted') {
        stop();
      }
    },
    onTurnComplete: ({ userText, assistantText }) => {
      const now = Date.now();
      setMessages((prev) => {
        const next = [...prev];
        if (userText) {
          next.push({
            id: `live-user-${now}`,
            role: 'user',
            parts: [{ type: 'text', text: userText }],
          });
        }
        if (assistantText) {
          next.push({
            id: `live-assistant-${now + 1}`,
            role: 'assistant',
            parts: [{ type: 'text', text: assistantText }],
          });
        }
        return next;
      });
    },
  });

  const handleToggleCall = useCallback(async () => {
    if (isCallActive) {
      endCall();
      stopAudio();
      avatar.interrupt();
    } else {
      if (humanMode !== 'ai') hangupHumanCall();
      if (avatar.isMuted) avatar.toggleMute();
      setAutoSpeak(true);
      avatar.unlockAudio();
      await startCall();
    }
  }, [avatar, endCall, hangupHumanCall, humanMode, isCallActive, setAutoSpeak, startCall, stopAudio]);

  const currentToolCall = useMemo(() => {
    if (liveToolName) return liveToolName;
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
  }, [liveToolName, messages]);

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

  useEffect(() => {
    if (isAwaitingResponse) {
      setShowLoading(true);
      return;
    }
    const timeout = setTimeout(() => setShowLoading(false), 120);
    return () => clearTimeout(timeout);
  }, [isAwaitingResponse]);

  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages, showLoading, localError, humanMessages, humanMode]);

  useEffect(() => {
    if (!isAwaitingResponse && !done) {
      fieldRef.current?.focus();
    }
  }, [isAwaitingResponse, done]);

  // Preload Streamdown chunk during idle time after first frame
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let rafId;
    let idleId;
    let fallbackId;
    const prefetch = () => {
      import('streamdown').catch(() => {});
    };
    const afterFirstFrame = () => {
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(prefetch, { timeout: 2000 });
      } else {
        fallbackId = window.setTimeout(prefetch, 0);
      }
    };
    if (typeof window.requestAnimationFrame === 'function') {
      rafId = window.requestAnimationFrame(afterFirstFrame);
    } else {
      afterFirstFrame();
    }
    return () => {
      if (rafId != null && window.cancelAnimationFrame) window.cancelAnimationFrame(rafId);
      if (idleId != null && window.cancelIdleCallback) window.cancelIdleCallback(idleId);
      if (fallbackId != null) window.clearTimeout(fallbackId);
    };
  }, []);

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

  const handleQuickPrompt = useCallback(
    (promptText) => {
      if (isAwaitingResponse || done || humanMode !== 'ai') return;
      setLocalError(null);
      avatar.unlockAudio();
      sendMessage({ text: promptText });
    },
    [avatar, done, humanMode, isAwaitingResponse, sendMessage]
  );

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
  const showWelcome = messages.length === 0 && humanMode === 'ai';

  return (
    <div className="flex h-dvh min-h-screen w-full items-center justify-center bg-[#EFEEEA] p-0 sm:p-4 md:p-6 text-[#18181B]">
      {/* Frameless Rounded Split-Pane Card */}
      <div className="flex h-full w-full max-w-[1360px] overflow-hidden bg-[#FAF9F6] sm:rounded-[28px] sm:border sm:border-[#E5E4DF] sm:shadow-[0_12px_48px_rgba(0,0,0,0.06)]">
        {/* Left: Architectural 3D Concierge Stage */}
        <AvatarPanel
          status={avatar.status}
          loadPercent={avatar.loadPercent}
          isConnected={avatar.isConnected}
          isSpeaking={avatar.isSpeaking}
          isMuted={avatar.isMuted}
          needsAudioUnlock={avatar.needsAudioUnlock}
          error={avatar.error}
          onChangeZoom={avatar.setZoom}
          containerRef={avatar.containerRef}
          onConnect={avatar.connect}
          onDisconnect={avatar.disconnect}
          onToggleMute={avatar.toggleMute}
          onUnlockAudio={avatar.unlockAudio}
          isAwaitingResponse={isAwaitingResponse}
          currentToolLabel={currentToolCall ? TOOL_STATUS_LABELS[currentToolCall] : null}
          isCallActive={isCallActive}
          callState={callState}
          collapsed={stageCollapsed}
          onToggleCollapse={() => setStageCollapsed((v) => !v)}
        />

        {/* Right: Minimalist Conversational Workspace */}
        <main className="flex h-full min-w-0 flex-1 flex-col bg-[#FAF9F6]">
          {/* Header */}
          <header className="relative flex flex-none flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-[#ECEAE4] px-6 lg:px-8 py-4">
            <div className="flex items-center gap-3 min-w-0">
              {stageCollapsed && (
                <button
                  type="button"
                  onClick={() => setStageCollapsed(false)}
                  className="hidden md:inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-[#E5E4DF] bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#44403C] transition-colors hover:border-[#18181B]/30 hover:text-[#18181B]"
                  title="Show avatar & tips panel"
                  aria-label="Show avatar & tips panel"
                >
                  <Eye className="size-3.5 stroke-[1.75]" />
                  <span>Avatar</span>
                </button>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="size-2.5 flex-none rounded-full bg-emerald-500" />
                  <h1 className="m-0 truncate text-[18px] font-semibold tracking-[-0.02em] text-[#18181B]">
                    Nova Support
                  </h1>
                </div>
                <p className="m-0 mt-0.5 truncate text-[13px] text-[#78716C]">
                  Order, Product &amp; Warranty Concierge
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Tips popover button when sidebar is hidden or on mobile */}
              <div className={cn('relative', !stageCollapsed && 'md:hidden')}>
                <button
                  type="button"
                  onClick={() => setShowTipsPopover((v) => !v)}
                  className={cn(
                    'flex size-9 cursor-pointer items-center justify-center rounded-full border transition-all select-none',
                    showTipsPopover
                      ? 'border-[#18181B] bg-[#18181B] text-white'
                      : 'border-[#E5E4DF] bg-white text-[#57534E] hover:border-[#18181B]/30 hover:text-[#18181B]'
                  )}
                  title="Features & usage tips"
                  aria-label="Features & usage tips"
                >
                  <HelpCircle className="size-4 stroke-[1.75]" />
                </button>

                {showTipsPopover && (
                  <div className="absolute right-0 top-[calc(100%+10px)] z-50 w-[300px] rounded-2xl border border-[#E5E4DF] bg-white p-4 shadow-[0_12px_36px_rgba(0,0,0,0.09)]">
                    <div className="mb-3 flex items-center justify-between">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8C8881]">
                        Features &amp; Tips
                      </span>
                      <button
                        type="button"
                        onClick={() => setShowTipsPopover(false)}
                        className="flex size-6 cursor-pointer items-center justify-center rounded-full text-[#78716C] hover:bg-[#F4F3EF] hover:text-[#18181B]"
                        aria-label="Close tips"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <div className="space-y-3">
                      {FEATURE_TIPS.map(({ id, Icon, title, desc }) => (
                        <div key={id} className="flex items-start gap-2.5">
                          <div className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-lg border border-[#ECEAE4] bg-[#FAF9F6] text-[#44403C]">
                            <Icon className="size-3.5 stroke-[1.7]" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-[12.5px] font-semibold text-[#18181B]">
                              {title}
                            </div>
                            <p className="m-0 mt-0.5 text-[11.5px] leading-relaxed text-[#78716C]">
                              {desc}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* Unified Single Voice Output Mute/Unmute Toggle */}
              <button
                type="button"
                onClick={handleToggleAutoSpeak}
                className={cn(
                  'flex size-9 cursor-pointer items-center justify-center rounded-full border transition-all select-none',
                  autoSpeak
                    ? 'border-[#D6D3CD] bg-white text-[#18181B] shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
                    : 'border-transparent bg-transparent text-[#A8A29E] hover:bg-black/[0.04] hover:text-[#57534E]'
                )}
                title={autoSpeak ? 'Audio output on (click to mute)' : 'Audio output muted (click to unmute)'}
                aria-label="Toggle audio output"
              >
                {autoSpeak ? (
                  <Volume2 className="size-4 stroke-[1.75]" />
                ) : (
                  <VolumeX className="size-4 stroke-[1.75]" />
                )}
              </button>

              {/* Voice Call Pill */}
              <button
                type="button"
                onClick={handleToggleCall}
                disabled={done}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-full border px-4 py-2 text-[13px] font-medium transition-all select-none disabled:cursor-default disabled:opacity-40',
                  isCallActive
                    ? 'border-[#9F4A4A] bg-[#FDF2F2] text-[#9F4A4A] hover:bg-[#FCE7E7]'
                    : 'border-[#18181B] bg-transparent text-[#18181B] hover:bg-[#18181B]/[0.04]'
                )}
                title={isCallActive ? 'End live voice call' : 'Start hands-free live voice call'}
              >
                {isCallActive ? (
                  <>
                    <PhoneOff className="size-3.5 stroke-[1.75]" />
                    <span>End Call</span>
                  </>
                ) : (
                  <span>Voice Call</span>
                )}
              </button>

              {/* Speak to Specialist Pill */}
              <button
                type="button"
                onClick={handleToggleHumanChat}
                disabled={done}
                className={cn(
                  'flex cursor-pointer items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-medium transition-all select-none disabled:cursor-default disabled:opacity-40',
                  humanMode === 'connected'
                    ? 'bg-emerald-700 text-white hover:bg-emerald-800'
                    : humanMode === 'ringing'
                      ? 'border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                      : 'bg-[#18181B] text-white hover:bg-[#27272A]'
                )}
                title={
                  humanMode === 'connected'
                    ? 'End specialist call and return to Nova'
                    : humanMode === 'ringing'
                      ? 'Cancel specialist call request'
                      : 'Connect with a live human specialist'
                }
              >
                <span>
                  {humanMode === 'connected'
                    ? 'End Specialist Call'
                    : humanMode === 'ringing'
                      ? 'Calling Specialist…'
                      : 'Speak to Specialist'}
                </span>
              </button>
            </div>
          </header>

          {/* Human Specialist Active Status Strip */}
          {humanMode !== 'ai' && (
            <div
              className={cn(
                'flex items-center justify-between gap-3 border-b px-6 py-2.5 text-[12.5px]',
                humanMode === 'connected'
                  ? 'border-emerald-200/80 bg-emerald-50/70 text-emerald-950'
                  : 'border-[#E7E5E4] bg-white text-[#44403C]'
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
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
                    ? `Live Voice Active with Specialist ${humanAgentName || 'Agent'}`
                    : 'Requesting an available support specialist…'}
                </span>
                {humanMode === 'connected' && (
                  <div className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-emerald-200/80 sm:block">
                    <div
                      className="h-full bg-emerald-600 transition-all duration-75"
                      style={{ width: `${Math.round(humanMicLevel * 100)}%` }}
                    />
                  </div>
                )}
              </div>

              <div className="flex flex-none items-center gap-2">
                {humanMode === 'connected' && (
                  <button
                    type="button"
                    onClick={toggleHumanMute}
                    className={cn(
                      'flex cursor-pointer items-center gap-1 rounded-full border px-3 py-1 text-[11.5px] font-medium transition-colors',
                      humanMuted
                        ? 'border-amber-300 bg-amber-50 text-amber-900'
                        : 'border-[#18181B]/25 bg-white text-[#18181B] hover:bg-[#FAF9F6]'
                    )}
                  >
                    {humanMuted ? <MicOff className="size-3" /> : <Mic className="size-3" />}
                    <span>{humanMuted ? 'Muted' : 'Mute'}</span>
                  </button>
                )}
                {humanMode === 'ringing' && (
                  <a
                    href="/agent"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 rounded-full border border-[#D6D3CD] bg-white px-3 py-1 text-[11.5px] font-medium text-[#18181B] no-underline hover:bg-[#F4F3EF]"
                  >
                    <span>Open Specialist Console</span>
                    <ExternalLink className="size-3" />
                  </a>
                )}
                <button
                  type="button"
                  onClick={handleToggleHumanChat}
                  className="cursor-pointer rounded-full border border-[#C88A8A] bg-white px-3 py-1 text-[11.5px] font-medium text-[#9F4A4A] hover:bg-[#FDF2F2]"
                >
                  {humanMode === 'connected' ? 'End Call' : 'Cancel'}
                </button>
              </div>
            </div>
          )}

          {/* Live AI Voice Call Status Strip */}
          {isCallActive && (
            <div className="flex items-center justify-between gap-3 border-b border-[#ECEAE4] bg-white px-6 py-2.5 text-[12.5px] text-[#18181B]">
              <div className="flex min-w-0 items-center gap-2.5">
                <span
                  className={cn(
                    'size-2 flex-none rounded-full',
                    callState === 'speaking'
                      ? 'bg-emerald-500 animate-ping'
                      : 'bg-emerald-500 animate-pulse'
                  )}
                />
                <span className="truncate font-medium">
                  {callState === 'connecting'
                    ? 'Connecting to live voice…'
                    : liveToolName
                      ? TOOL_STATUS_LABELS[liveToolName] || `Running ${liveToolName}…`
                      : callState === 'speaking'
                        ? callLiveText
                          ? `Listening: ${callLiveText}`
                          : 'Listening…'
                        : callLiveText
                          ? `Nova: ${callLiveText}`
                          : effectiveIsPlaying || isAwaitingResponse
                            ? 'Nova is speaking — speak anytime to interrupt'
                            : 'Live voice active — speak naturally'}
                </span>
              </div>
              <button
                type="button"
                onClick={handleToggleCall}
                className="flex-none cursor-pointer rounded-full border border-[#C88A8A] px-3 py-1 text-[11.5px] font-medium text-[#9F4A4A] hover:bg-[#FDF2F2]"
              >
                End Call
              </button>
            </div>
          )}

          {/* Main Scrollable Content: Welcome Hero OR Message Stream */}
          <div
            ref={logRef}
            className="nova-scroll flex flex-1 flex-col overflow-y-auto px-6 lg:px-8 py-6"
          >
            {showWelcome ? (
              <div className="mx-auto flex my-auto w-full max-w-[640px] flex-col items-center justify-center py-6">
                <h2 className="m-0 text-center text-[28px] sm:text-[34px] font-semibold tracking-[-0.03em] text-[#18181B]">
                  How can I help you today?
                </h2>
                <p className="m-0 mt-2.5 max-w-[460px] text-center text-[15px] leading-relaxed text-[#78716C]">
                  Instant order tracking, live warehouse stock, and guided warranty support.
                </p>

                <div className="mt-8 grid w-full grid-cols-1 gap-3.5 sm:grid-cols-2">
                  {QUICK_PROMPTS.map(({ id, title, subtitle, prompt, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => handleQuickPrompt(prompt)}
                      disabled={isAwaitingResponse || done}
                      className="group flex cursor-pointer items-start gap-3.5 rounded-2xl border border-[#E7E5E4] bg-white p-[18px] text-left shadow-[0_1px_3px_rgba(0,0,0,0.02)] transition-all hover:border-[#D6D3CD] hover:shadow-[0_4px_14px_rgba(0,0,0,0.05)] disabled:cursor-default disabled:opacity-50"
                    >
                      <div className="mt-0.5 flex size-9 flex-none items-center justify-center rounded-xl border border-[#ECEAE4] bg-[#FAF9F6] text-[#18181B] transition-colors group-hover:border-[#18181B]/20">
                        <Icon className="size-[18px] stroke-[1.6]" />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[14.5px] font-semibold tracking-[-0.01em] text-[#18181B]">
                          {title}
                        </div>
                        <div className="mt-1 text-[12.5px] leading-snug text-[#78716C]">
                          {subtitle}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex w-full flex-col gap-5">
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
                        key={m.id}
                        className="flex w-full items-start justify-end gap-3"
                      >
                        <div className="msg-bubble msg-user max-w-[76%] break-words rounded-[20px] rounded-tr-[5px] bg-[#18181B] px-4 py-3 text-left text-[14.5px] leading-[1.55] text-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] [overflow-wrap:anywhere]">
                          {fileParts.map((fp, i) =>
                            fp.mediaType?.startsWith('image/') ? (
                              <img
                                key={i}
                                className="mb-2 block w-full max-w-[240px] rounded-xl"
                                src={fp.url}
                                alt={fp.filename || 'Attached'}
                              />
                            ) : null
                          )}
                          {displayText && <MarkdownContent text={displayText} />}
                        </div>
                        <CustomerAvatar />
                      </div>
                    );
                  }

                  const toolParts = parts.filter((p) => isToolUIPart(p));

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
                      textContent = textContent
                        .replace(/<think>[\s\S]*?(?:<\/think>|$)/, '')
                        .trim();
                    }
                  } else {
                    textContent = textContent.trim();
                  }

                  if (!textContent && !reasoningText && toolParts.length === 0) {
                    return null;
                  }

                  return (
                    <div
                      key={m.id}
                      className="flex w-full items-start justify-start gap-3"
                    >
                      <NovaAvatar src={avatar.thumbnailUrl} />
                      <div className="flex min-w-0 max-w-[82%] flex-col items-start gap-2">
                        {/* Database / NetSuite ERP Tool Trace Pills & Structured Cards */}
                        {toolParts.map((tp, idx) => {
                          const tName = getToolName(tp);
                          const tInput = tp.input ?? tp.args;
                          const tOutput = tp.output ?? tp.result;
                          return (
                            <ToolResultCard
                              key={tp.toolCallId || `${m.id}-tool-${idx}`}
                              toolName={tName}
                              state={tp.state}
                              input={tInput}
                              output={tOutput}
                            />
                          );
                        })}

                        <ThinkingProcess
                          text={reasoningText}
                          isStreaming={!textContent && status === 'streaming'}
                        />

                        {textContent ? (
                          <div className="msg-bubble msg-assistant max-w-full break-words rounded-[20px] rounded-tl-[5px] border border-[#E7E5E4] bg-white px-4 py-3 text-left text-[14.5px] leading-[1.6] text-[#18181B] shadow-[0_1px_3px_rgba(0,0,0,0.02)] [overflow-wrap:anywhere]">
                            <MarkdownContent text={formatAssistantMarkdown(textContent)} />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })}

                {/* Human Specialist Transcript & Chat Stream */}
                {humanMode !== 'ai' &&
                  humanMessages.map((hm) => {
                    if (hm.sender === 'system') {
                      return (
                        <div key={hm.id} className="my-1 self-center text-center">
                          <span className="inline-block rounded-full border border-[#E5E4DF] bg-white px-3.5 py-1 text-[11.5px] text-[#78716C]">
                            {hm.text} · {hm.time}
                          </span>
                        </div>
                      );
                    }

                    if (hm.sender === 'customer') {
                      return (
                        <div
                          key={hm.id}
                          className="flex w-full items-start justify-end gap-3"
                        >
                          <div className="msg-bubble msg-user max-w-[76%] break-words rounded-[20px] rounded-tr-[5px] bg-[#18181B] px-4 py-3 text-left text-[14.5px] leading-[1.55] text-white [overflow-wrap:anywhere]">
                            {hm.kind === 'transcript' ? (
                              <div className="space-y-1.5">
                                {hm.sourceText && <div>{hm.sourceText}</div>}
                                {hm.translatedText && (
                                  <div className="border-t border-white/15 pt-1.5 text-[12px] text-white/70">
                                    Live Caption · Translated
                                  </div>
                                )}
                              </div>
                            ) : (
                              hm.text
                            )}
                          </div>
                          <CustomerAvatar />
                        </div>
                      );
                    }

                    return (
                      <div
                        key={hm.id}
                        className="flex w-full items-start justify-start gap-3"
                      >
                        <SpecialistAvatar />
                        <div className="msg-bubble max-w-[80%] break-words rounded-[20px] rounded-tl-[5px] border border-[#E5E4DF] bg-white px-4 py-3 text-left text-[14.5px] leading-[1.6] text-[#18181B] shadow-[0_1px_3px_rgba(0,0,0,0.03)] [overflow-wrap:anywhere]">
                          <div className="mb-1.5 flex items-center gap-2 text-[12px] text-[#78716C]">
                            <span className="size-1.5 rounded-full bg-emerald-500" />
                            <span className="font-semibold text-[#18181B]">
                              Specialist {hm.senderName || ''}
                            </span>
                            <span>·</span>
                            <span>{hm.time}</span>
                          </div>
                          {hm.kind === 'transcript' ? (
                            <div className="space-y-1.5">
                              {hm.translatedText && <div>{hm.translatedText}</div>}
                              {hm.sourceText && (
                                <div className="text-[12px] text-[#8C8881]">
                                  Live Caption · Translated Ready
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="whitespace-pre-wrap">{hm.text}</div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                {/* Fallback Loading Indicator (before assistant turn streams first part) */}
                {showLoading &&
                  !currentToolCall &&
                  messages[messages.length - 1]?.role !== 'assistant' && (
                    <div className="flex w-full items-center justify-start gap-3">
                      <NovaAvatar src={avatar.thumbnailUrl} />
                      <div className="inline-flex items-center gap-2 rounded-full border border-[#E7E5E4] bg-white px-3.5 py-1.5 text-[12.5px] text-[#78716C]">
                        <Loader2 className="size-3.5 animate-spin text-[#18181B]" />
                        <span>{uploading ? 'Uploading attachment…' : 'Thinking…'}</span>
                      </div>
                    </div>
                  )}

                {displayError && (
                  <div className="flex max-w-full items-center gap-3 self-center rounded-2xl border border-[#E5C9C9] bg-[#FDF5F5] px-4 py-2.5 text-center text-[13px] text-[#8F3A3A]">
                    <span>{displayError}</span>
                    {humanCallError ? (
                      <button
                        type="button"
                        className="cursor-pointer rounded-full border border-[#D8A8A8] bg-white px-3 py-0.5 text-xs font-medium text-[#8F3A3A] hover:bg-[#FCF0F0]"
                        onClick={() => setHumanCallError(null)}
                      >
                        Dismiss
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="cursor-pointer rounded-full border border-[#D8A8A8] bg-white px-3 py-0.5 text-xs font-medium text-[#8F3A3A] hover:bg-[#FCF0F0]"
                        onClick={() => {
                          setLocalError(null);
                          regenerate();
                        }}
                      >
                        Retry
                      </button>
                    )}
                  </div>
                )}

                {done && (
                  <div className="my-2 self-center rounded-full border border-[#E5E4DF] bg-white px-4 py-1.5 text-center text-[13px] font-medium text-[#18181B]">
                    Intake complete — our support team will take it from here.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Floating Rounded Pill Composer (Flush Aligned with Header & Avatars) */}
          <div className="flex-none px-6 lg:px-8 pb-6 pt-2">
            <form
              onSubmit={onSubmit}
              className="flex w-full items-center gap-1.5 rounded-full border border-[#E5E4DF] bg-white py-2 pl-5 pr-2 shadow-[0_2px_14px_rgba(0,0,0,0.04)] transition-all focus-within:border-[#18181B]/25 focus-within:shadow-[0_4px_22px_rgba(0,0,0,0.07)]"
            >
              <input
                ref={fieldRef}
                className="min-w-0 flex-1 border-none bg-transparent py-1.5 text-[15px] text-[#18181B] placeholder:text-[#8C8881] focus:outline-none disabled:opacity-50"
                placeholder={
                  done
                    ? 'Conversation complete — refresh to start a new enquiry'
                    : humanMode === 'connected'
                      ? `Speak directly or type a message to ${humanAgentName || 'Specialist'}…`
                      : humanMode === 'ringing'
                        ? 'Waiting for a specialist to answer…'
                        : 'Ask about an order, product, or warranty...'
                }
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={done || humanMode === 'ringing'}
                autoFocus
              />

              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/heic,image/webp,video/mp4,video/quicktime,application/pdf,.pdf"
                hidden
                onChange={onFileChange}
              />

              {/* Paperclip Attachment Icon */}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={isAwaitingResponse || done}
                title="Attach photo, video, or PDF"
                aria-label="Attach photo, video, or PDF"
                className="flex size-9 flex-none cursor-pointer items-center justify-center rounded-full text-[#78716C] transition-colors hover:bg-[#F4F3EF] hover:text-[#18181B] disabled:cursor-default disabled:opacity-35"
              >
                <Paperclip className="size-[18px] stroke-[1.75]" />
              </button>

              {/* Hold-to-Speak Microphone Button */}
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

              {/* Circular Obsidian Send / Stop Button */}
              {status === 'streaming' || status === 'submitted' ? (
                <button
                  type="button"
                  onClick={() => stop()}
                  title="Stop response"
                  aria-label="Stop response"
                  className="ml-0.5 flex size-9 flex-none cursor-pointer items-center justify-center rounded-full bg-[#18181B] text-white transition-colors hover:bg-[#27272A]"
                >
                  <Square className="size-3.5 fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isAwaitingResponse || done || !input.trim()}
                  title="Send message"
                  aria-label="Send message"
                  className="ml-0.5 flex size-9 flex-none cursor-pointer items-center justify-center rounded-full bg-[#18181B] text-white transition-all hover:bg-[#27272A] disabled:cursor-default disabled:opacity-25"
                >
                  <ArrowUp className="size-[18px] stroke-[2]" />
                </button>
              )}
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
