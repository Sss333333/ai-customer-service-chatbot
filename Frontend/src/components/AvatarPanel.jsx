import React from 'react';
import { Volume2, VolumeX, RefreshCw, Power, PowerOff, Sparkles } from 'lucide-react';
import { cn } from '../utils/cn';

/**
 * 网页左侧 3D 数字人展示面板（LAM 3D Gaussian Splatting WebGL）
 */
export function AvatarPanel({
  status,
  loadPercent,
  isConnected,
  isSpeaking,
  isMuted,
  needsAudioUnlock,
  error,
  containerRef,
  onConnect,
  onDisconnect,
  onToggleMute,
  onUnlockAudio,
  isAwaitingResponse,
  currentToolLabel,
  isCallActive,
  callState,
  humanMode,
}) {
  const activityLabel = (() => {
    if (humanMode === 'connected') return '人工客服通话中（数字人已暂停）';
    if (humanMode === 'ringing') return '正在呼叫人工客服…';
    if (!isConnected) {
      if (status === 'loading') return `正在加载 3D 形象 (${loadPercent}%)…`;
      return '纯语音降级模式';
    }
    if (isSpeaking) return 'Nova 正在说话…';
    if (isCallActive && callState === 'speaking') return '正在倾听您说话…';
    if (currentToolLabel) return currentToolLabel;
    if (isAwaitingResponse) return 'Nova 正在思考…';
    return '3D 待机中 · 随时为您服务';
  })();

  const dotClass = (() => {
    if (humanMode === 'connected') return 'bg-emerald-500';
    if (!isConnected) return status === 'loading' ? 'bg-amber-400 animate-pulse' : 'bg-[#b0aaa0]';
    if (isSpeaking) return 'bg-emerald-500 animate-pulse';
    if (isCallActive && callState === 'speaking') return 'bg-[#b43728] animate-ping';
    if (isAwaitingResponse) return 'bg-amber-500 animate-pulse';
    return 'bg-[#23453c]';
  })();

  return (
    <aside className="hidden md:flex h-screen w-[340px] lg:w-[380px] flex-none flex-col border-l border-[#ddd8d0] bg-[#fbfaf7] box-border">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between border-b border-[#e6e1d9] px-4 py-3.5">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="size-4 flex-none text-[#23453c]" />
          <span className="truncate text-sm font-semibold text-[#211f1b]">Nova 3D 数字人</span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] font-medium',
              isConnected
                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                : status === 'loading'
                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                  : 'bg-[#efece6] text-[#7c766e] border border-[#ddd8d0]'
            )}
          >
            {isConnected ? 'LAM 在线' : status === 'loading' ? `${loadPercent}%` : '未连接'}
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-none">
          {isConnected && (
            <button
              type="button"
              onClick={onToggleMute}
              className="flex size-7 cursor-pointer items-center justify-center rounded-full border border-[#ddd8d0] bg-white text-[#4a463f] hover:border-[#23453c] hover:text-[#23453c]"
              title={isMuted ? '取消静音' : '静音数字人'}
            >
              {isMuted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
            </button>
          )}
          <button
            type="button"
            onClick={isConnected || status === 'loading' ? onDisconnect : onConnect}
            className={cn(
              'flex size-7 cursor-pointer items-center justify-center rounded-full border transition-colors',
              isConnected
                ? 'border-[#ddd8d0] bg-white text-[#7c766e] hover:border-[#b43728] hover:text-[#b43728]'
                : 'border-[#23453c]/40 bg-white text-[#23453c] hover:bg-[#23453c]/5'
            )}
            title={isConnected ? '关闭 3D 数字人（切回纯语音）' : '开启 3D 数字人'}
          >
            {isConnected ? <PowerOff className="size-3.5" /> : <Power className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* 主 3D 渲染区 */}
      <div className="flex flex-1 flex-col p-4 min-h-0">
        <div className="relative flex-1 min-h-0 w-full overflow-hidden rounded-2xl border border-[#e6e1d9] bg-[#f4f1eb]">
          {/* WebGL 挂载容器 */}
          <div
            ref={containerRef}
            className={cn(
              'h-full w-full transition-opacity duration-300',
              isConnected ? 'opacity-100' : 'opacity-0'
            )}
          />

          {/* 未连接 / 加载中占位 */}
          {!isConnected && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center bg-[#f4f1eb]">
              <div className="grid size-16 place-items-center rounded-2xl bg-[#23453c]/10 text-2xl text-[#23453c]">
                ◧
              </div>
              <div className="space-y-1">
                <p className="m-0 text-sm font-semibold text-[#211f1b]">
                  {status === 'loading' ? `正在加载 3D 真人形象 (${loadPercent}%)` : 'Nova 3D 数字人未开启'}
                </p>
                <p className="m-0 text-xs leading-relaxed text-[#7c766e]">
                  {error || '浏览器本地 WebGL 实时渲染，待机零服务器消耗；未连接时自动使用原有语音播报。'}
                </p>
              </div>
              {status === 'loading' && (
                <div className="h-1.5 w-40 overflow-hidden rounded-full bg-[#e2ddd5]">
                  <div
                    className="h-full bg-[#23453c] transition-all duration-200"
                    style={{ width: `${Math.max(8, loadPercent)}%` }}
                  />
                </div>
              )}
              {status !== 'loading' && (
                <button
                  type="button"
                  onClick={onConnect}
                  className="mt-1 flex cursor-pointer items-center gap-1.5 rounded-full bg-[#23453c] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#1b3730]"
                >
                  <RefreshCw className="size-3.5" />
                  <span>{status === 'offline' || status === 'error' ? '重试连接' : '开启 3D 数字人'}</span>
                </button>
              )}
            </div>
          )}

          {/* 浏览器自动播放解锁声音提示 */}
          {isConnected && needsAudioUnlock && !isMuted && (
            <button
              type="button"
              onClick={onUnlockAudio}
              className="absolute top-3 left-1/2 -translate-x-1/2 flex cursor-pointer items-center gap-1.5 rounded-full bg-[#23453c]/90 px-3.5 py-1.5 text-xs font-medium text-white shadow-md hover:bg-[#23453c]"
            >
              <Volume2 className="size-3.5" />
              <span>点击开启数字人声音</span>
            </button>
          )}

          {/* 转人工覆盖提示 */}
          {isConnected && humanMode !== 'ai' && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/35 backdrop-blur-[2px]">
              <div className="rounded-xl bg-white/95 px-4 py-2.5 text-xs font-medium text-[#211f1b] shadow-sm">
                {humanMode === 'connected' ? '已转接人工客服，数字人暂停中' : '正在呼叫人工客服…'}
              </div>
            </div>
          )}

          {/* 底部状态条 */}
          <div className="absolute inset-x-3 bottom-3 flex items-center gap-2 rounded-xl bg-black/55 px-3 py-2 text-xs text-white backdrop-blur-xs">
            <span className={cn('size-2 flex-none rounded-full', dotClass)} />
            <span className="truncate">{activityLabel}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
