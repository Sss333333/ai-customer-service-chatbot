import React, { useCallback, useRef, useState } from "react";
import { Loader2, Mic } from "lucide-react";
import { useRealtimeAsr } from "../hooks/useRealtimeAsr";
import { cn } from "../utils/cn";

export function VoiceInputButton({
  disabled = false,
  className,
  onTranscribed,
}) {
  const [transcribeError, setTranscribeError] = useState(null);
  const isPressingRef = useRef(false);
  const pressStartTimeRef = useRef(0);
  const stopRef = useRef(null);

  const handleAutoStop = useCallback(() => {
    stopRef.current?.();
  }, []);

  const {
    isSupported,
    isRecording,
    isFinalizing,
    duration,
    liveText,
    start,
    stop,
    cancel,
  } = useRealtimeAsr({
    maxDurationSeconds: 60,
    onMaxDurationReached: handleAutoStop,
  });

  const finishAndSend = useCallback(async () => {
    const heldMs = Date.now() - pressStartTimeRef.current;
    if (heldMs < 600) {
      cancel();
      return;
    }

    try {
      const finalText = await stop();
      if (finalText) {
        await onTranscribed?.(finalText);
      }
    } catch (err) {
      console.error("[Voice] Realtime ASR error:", err);
      setTranscribeError(err?.message || "Transcription failed");
      setTimeout(() => setTranscribeError(null), 3500);
    }
  }, [cancel, onTranscribed, stop]);

  stopRef.current = () => {
    if (isPressingRef.current || isRecording) {
      isPressingRef.current = false;
      finishAndSend();
    }
  };

  const handleStartPress = useCallback(
    async (e) => {
      e.preventDefault();
      if (disabled || isFinalizing || isRecording) {
        return;
      }
      if (!isSupported) {
        alert("Realtime audio recording is not supported in this browser.");
        return;
      }

      setTranscribeError(null);
      isPressingRef.current = true;
      pressStartTimeRef.current = Date.now();

      try {
        const started = await start();
        if (!started || !isPressingRef.current) {
          isPressingRef.current = false;
          if (started) cancel();
        }
      } catch (err) {
        isPressingRef.current = false;
        alert(
          err?.name === "NotAllowedError"
            ? "Microphone permission was denied."
            : err?.message || "Could not start recording."
        );
      }
    },
    [cancel, disabled, isFinalizing, isRecording, isSupported, start]
  );

  const handleStopPress = useCallback(
    async (e) => {
      e.preventDefault();
      if (!isPressingRef.current && !isRecording) {
        return;
      }
      isPressingRef.current = false;
      await finishAndSend();
    },
    [finishAndSend, isRecording]
  );

  const handleCancelPress = useCallback(
    (e) => {
      e.preventDefault();
      if (isPressingRef.current || isRecording) {
        isPressingRef.current = false;
        cancel();
      }
    },
    [cancel, isRecording]
  );

  return (
    <div className="relative inline-flex items-center">
      {/* 录音进行中的实时字幕浮层 */}
      {(isRecording || isFinalizing) && (
        <div className="absolute bottom-[calc(100%+10px)] left-0 z-50 w-[260px] sm:w-[340px] rounded-xl border border-[#3a362f] bg-[#211f1b] px-3.5 py-2.5 text-white shadow-xl">
          <div className="flex items-center gap-2 text-[11px] font-medium text-white/80">
            <span
              className={cn(
                "size-2 rounded-full",
                isRecording ? "animate-ping bg-[#ef4444]" : "bg-emerald-400"
              )}
            />
            <span>
              {isRecording
                ? `Listening ${Math.round(duration)}s · Release to finish`
                : "Finalizing…"}
            </span>
          </div>
          <div className="mt-1.5 min-h-[20px] max-h-[84px] overflow-y-auto break-words text-sm leading-snug text-white">
            {liveText || (
              <span className="text-white/50 italic">Speak now…</span>
            )}
          </div>
        </div>
      )}

      {/* 识别失败临时提示 */}
      {transcribeError && (
        <div className="absolute -top-9 left-0 z-50 max-w-[280px] truncate rounded bg-black/80 px-2.5 py-1 text-[11px] text-white shadow">
          {transcribeError}
        </div>
      )}

      <button
        type="button"
        className={cn(
          "w-[44px] h-[44px] flex-none flex items-center justify-center cursor-pointer rounded-xl border border-[#ddd8d0] bg-white text-[#4a463f] transition-all disabled:cursor-default disabled:opacity-45 select-none touch-none",
          isRecording && "bg-[#8a2f24] text-white border-[#8a2f24] scale-105 shadow-md",
          isFinalizing && "cursor-wait opacity-80",
          className
        )}
        disabled={disabled || isFinalizing}
        onMouseDown={handleStartPress}
        onMouseUp={handleStopPress}
        onTouchStart={handleStartPress}
        onTouchEnd={handleStopPress}
        onTouchCancel={handleCancelPress}
        title={
          isRecording
            ? "Release to send voice"
            : isFinalizing
              ? "Transcribing audio…"
              : "Hold to speak"
        }
        aria-label={
          isRecording
            ? "Release to send voice"
            : isFinalizing
              ? "Transcribing audio…"
              : "Hold to speak"
        }
      >
        {isFinalizing ? (
          <Loader2 className="size-4 animate-spin text-[#23453c]" />
        ) : (
          <Mic className={cn("size-4", isRecording && "animate-pulse")} />
        )}
      </button>
    </div>
  );
}
