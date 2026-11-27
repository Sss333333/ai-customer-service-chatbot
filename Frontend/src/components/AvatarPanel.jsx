import React, { useEffect } from 'react';
import {
  EyeOff,
  Sparkles,
  Volume2,
  Phone,
  Package,
  Paperclip,
  Headset,
  RefreshCw,
} from 'lucide-react';
import { cn } from '../utils/cn';

const WAVE_HEIGHTS = [8, 14, 20, 24, 20, 14, 8];

export const FEATURE_TIPS = [
  {
    id: 'erp',
    Icon: Package,
    title: 'Live Order & Stock Lookup',
    desc: 'Enter an order (SO-…), product SKU, or CASE number for live dispatch & state stock cards.',
  },
  {
    id: 'voice',
    Icon: Phone,
    title: 'Hands-free Voice & Barge-in',
    desc: 'Use Voice Call for real-time conversation — speak anytime to interrupt — or hold Mic to dictate.',
  },
  {
    id: 'media',
    Icon: Paperclip,
    title: 'Photo, Video & PDF Claims',
    desc: 'Attach defect photos, videos, or invoices for guided warranty & 72h transit checks.',
  },
  {
    id: 'human',
    Icon: Headset,
    title: 'Live Specialist Handoff',
    desc: 'Switch to a human specialist anytime with real-time voice translation.',
  },
];

/**
 * Balanced Left Sidebar: Compact 3D WebGL Avatar Card + Feature Tips Panel
 */
export function AvatarPanel({
  status,
  loadPercent,
  isConnected,
  isSpeaking,
  isMuted,
  needsAudioUnlock,
  error,
  onChangeZoom,
  containerRef,
  onConnect,
  onDisconnect,
  onUnlockAudio,
  isAwaitingResponse,
  currentToolLabel,
  isCallActive,
  callState,
  humanMode,
  collapsed = false,
  onToggleCollapse,
}) {
  // Notify WebGL renderer to recalculate aspect ratio when panel visibility changes
  useEffect(() => {
    if (!collapsed) {
      const id = setTimeout(() => {
        window.dispatchEvent(new Event('resize'));
      }, 320);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [collapsed]);

  const isAudioAnimating =
    humanMode === 'ai' &&
    (isSpeaking || (isCallActive && callState === 'speaking'));

  const statusText = (() => {
    if (humanMode === 'connected') return 'Specialist call active';
    if (humanMode === 'ringing') return 'Calling specialist…';
    if (status === 'loading') return `Loading 3D (${loadPercent}%)…`;
    if (isSpeaking) return 'Speaking…';
    if (isCallActive && callState === 'speaking') return 'Listening…';
    if (isCallActive) return 'Listening…';
    if (currentToolLabel) return currentToolLabel;
    if (isAwaitingResponse) return 'Thinking…';
    return isConnected ? 'Ready to assist' : 'Audio-only mode';
  })();

  const showReadyDot =
    humanMode === 'ai' &&
    isConnected &&
    status !== 'loading' &&
    !isSpeaking &&
    !isCallActive &&
    !isAwaitingResponse;

  return (
    <aside
      className={cn(
        'flex-none overflow-hidden border-[#ECEAE4] bg-[#F4F3EF] transition-all duration-300 ease-out select-none',
        collapsed
          ? 'w-0 border-r-0 p-0 opacity-0 pointer-events-none'
          : 'hidden md:flex h-full min-h-0 w-[284px] lg:w-[312px] flex-col gap-3.5 border-r p-3.5 lg:p-4'
      )}
    >
      {/* Top Card: Compact Framed 3D Avatar Stage */}
      <div
        onWheel={(e) => {
          if (!isConnected || !onChangeZoom) return;
          e.preventDefault();
          const delta = e.deltaY < 0 ? 0.1 : -0.1;
          onChangeZoom((prev) => prev + delta);
        }}
        title={isConnected ? 'Scroll to adjust 3D zoom' : undefined}
        className="relative h-[304px] lg:h-[336px] w-full flex-none overflow-hidden rounded-[22px] border border-[#E5E4DF] bg-[#EAE7E0] shadow-[0_2px_10px_rgba(0,0,0,0.02)]"
      >
        {/* Live WebGL 3D Gaussian Splatting Canvas Mount */}
        <div
          ref={containerRef}
          className={cn(
            'absolute inset-0 h-full w-full transition-opacity duration-500 [&_canvas]:block [&_canvas]:!h-full [&_canvas]:!w-full',
            isConnected ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
        />

        {/* Minimalist Non-Photo Standby Surface (when 3D WebGL is off or loading) */}
        {!isConnected && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-[#F5F4F0] to-[#EAE7E0] px-6 text-center">
            <div className="mb-3 flex size-14 items-center justify-center rounded-full border border-[#DFDCD4] bg-white shadow-[0_2px_8px_rgba(0,0,0,0.03)]">
              <Sparkles className="size-5 stroke-[1.6] text-[#18181B]" />
            </div>
            <p className="m-0 text-[13.5px] font-semibold text-[#18181B]">
              {status === 'loading'
                ? `Loading 3D Avatar (${loadPercent}%)`
                : '3D Avatar Paused'}
            </p>
            <p className="m-0 mt-1 max-w-[210px] text-[12px] leading-relaxed text-[#78716C]">
              {status === 'loading'
                ? 'Initializing local WebGL Gaussian Splatting stage…'
                : error || 'Voice & chat remain active. Enable 3D anytime.'}
            </p>

            {status === 'loading' ? (
              <div className="mt-3.5 h-1 w-32 overflow-hidden rounded-full bg-[#DDD9D0]">
                <div
                  className="h-full bg-[#18181B] transition-all duration-200"
                  style={{ width: `${Math.max(8, loadPercent)}%` }}
                />
              </div>
            ) : (
              <button
                type="button"
                onClick={onConnect}
                className="mt-3.5 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-[#18181B] px-4 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-[#27272A]"
              >
                <RefreshCw className="size-3" />
                <span>Enable 3D Avatar</span>
              </button>
            )}
          </div>
        )}

        {/* Top-Left: Single Eye Icon to Hide Avatar Panel */}
        {onToggleCollapse && (
          <div className="absolute top-3 left-3 z-20">
            <button
              type="button"
              onClick={onToggleCollapse}
              className={cn(
                'flex size-8 cursor-pointer items-center justify-center rounded-full border backdrop-blur-md transition-colors',
                isConnected
                  ? 'border-white/25 bg-black/25 text-white hover:bg-black/40'
                  : 'border-[#E2DFD7] bg-white/85 text-[#57534E] hover:bg-white hover:text-[#18181B]'
              )}
              title="Hide side panel"
              aria-label="Hide side panel"
            >
              <EyeOff className="size-4 stroke-[1.75]" />
            </button>
          </div>
        )}

        {/* Top-Right: Discreet 3D Live Toggle (only needed when connected) */}
        {isConnected && (
          <div className="absolute top-3 right-3 z-20">
            <button
              type="button"
              onClick={onDisconnect}
              className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-white/25 bg-black/25 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur-md transition-all hover:bg-black/40"
              title="Pause 3D avatar (switch to audio-only)"
            >
              <Sparkles className="size-3" />
              <span>3D Live</span>
            </button>
          </div>
        )}

        {/* Browser Audio Autoplay Unlock Prompt */}
        {isConnected && needsAudioUnlock && !isMuted && (
          <button
            type="button"
            onClick={onUnlockAudio}
            className="absolute top-14 left-1/2 z-20 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-white/20 bg-[#18181B]/85 px-3 py-1 text-[11px] font-medium text-white shadow-md backdrop-blur-md hover:bg-[#18181B]"
          >
            <Volume2 className="size-3" />
            <span>Tap to enable audio</span>
          </button>
        )}

        {/* Human Specialist Call Dimmer */}
        {humanMode !== 'ai' && (
          <div className="absolute inset-0 z-10 bg-black/20 backdrop-blur-[2px] transition-opacity" />
        )}

        {/* Bottom Compact Waveform Pill (shown when 3D is active or audio is active) */}
        {(isConnected || isSpeaking || isCallActive) && (
          <div className="absolute inset-x-3.5 bottom-3.5 z-20 flex justify-center">
            <div className="flex max-w-full items-center gap-2.5 rounded-full border border-white/15 bg-[#3A3530]/72 px-4 py-2 text-white shadow-[0_6px_20px_rgba(0,0,0,0.16)] backdrop-blur-md">
              <div className="flex h-4 flex-none items-center gap-[2.5px]">
                {WAVE_HEIGHTS.map((h, idx) => (
                  <span
                    key={idx}
                    className={cn(
                      'w-[2px] rounded-full bg-white/90 transition-all duration-300',
                      isAudioAnimating && 'nova-wave-bar',
                      !isAudioAnimating && idx % 2 === 1 && 'bg-white/55'
                    )}
                    style={{
                      height: `${isAudioAnimating ? Math.max(8, Math.round(h * 0.7)) : Math.round(h * 0.5)}px`,
                      animationDelay: isAudioAnimating ? `${idx * 0.09}s` : undefined,
                    }}
                  />
                ))}
              </div>

              <span className="truncate text-[12px] font-medium tracking-[-0.01em] text-white/95">
                {statusText}
              </span>
              {showReadyDot && (
                <span className="size-1.5 flex-none rounded-full bg-emerald-400" />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom Card: Persistent Feature Tips & Capabilities Guide */}
      <div className="nova-scroll flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[20px] border border-[#E7E5E4] bg-white/80 p-4 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[#8C8881]">
            Features &amp; Tips
          </span>
        </div>

        <div className="space-y-3">
          {FEATURE_TIPS.map(({ id, Icon, title, desc }) => (
            <div key={id} className="flex items-start gap-2.5">
              <div className="mt-0.5 flex size-6 flex-none items-center justify-center rounded-lg border border-[#ECEAE4] bg-[#FAF9F6] text-[#44403C]">
                <Icon className="size-3.5 stroke-[1.7]" />
              </div>
              <div className="min-w-0">
                <div className="text-[12.5px] font-semibold leading-snug text-[#18181B]">
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
    </aside>
  );
}
