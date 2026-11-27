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
        setTranscribeError("Voice recording is not supported in this browser.");
        setTimeout(() => setTranscribeError(null), 3500);
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
        setTranscribeError(
          err?.name === "NotAllowedError"
            ? "Microphone access denied."
            : err?.message || "Could not start recording."
        );
        setTimeout(() => setTranscribeError(null), 3500);
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
      {/* Live transcription popover while holding */}
      {(isRecording || isFinalizing) && (
        <div className="absolute bottom-[calc(100%+14px)] right-0 z-50 w-[260px] sm:w-[320px] rounded-2xl border border-white/10 bg-[#18181B]/95 px-4 py-3 text-white shadow-xl backdrop-blur-md">
          <div className="flex items-center gap-2 text-[11.5px] font-medium text-white/70">
            <span
              className={cn(
                "size-2 rounded-full",
                isRecording ? "animate-ping bg-rose-400" : "bg-emerald-400"
              )}
            />
            <span>
              {isRecording
                ? `Listening ${Math.round(duration)}s · Release to insert`
                : "Transcribing…"}
            </span>
          </div>
          <div className="mt-1.5 min-h-[20px] max-h-[84px] overflow-y-auto break-words text-[13.5px] leading-snug text-white">
            {liveText || (
              <span className="text-white/45">Speak now…</span>
            )}
          </div>
        </div>
      )}

      {/* Temporary error toast */}
      {transcribeError && (
        <div className="absolute bottom-[calc(100%+12px)] right-0 z-50 whitespace-nowrap rounded-lg bg-[#18181B] px-3 py-1.5 text-[12px] text-white shadow-md">
          {transcribeError}
        </div>
      )}

      <button
        type="button"
        className={cn(
          "flex size-9 flex-none cursor-pointer items-center justify-center rounded-full text-[#78716C] transition-all hover:bg-[#F4F3EF] hover:text-[#18181B] disabled:cursor-default disabled:opacity-35 select-none touch-none",
          isRecording && "bg-[#18181B] text-white hover:bg-[#18181B] hover:text-white scale-105 shadow-sm",
          isFinalizing && "cursor-wait opacity-70",
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
            ? "Release to insert text"
            : isFinalizing
              ? "Transcribing audio…"
              : "Hold to speak"
        }
        aria-label={
          isRecording
            ? "Release to insert text"
            : isFinalizing
              ? "Transcribing audio…"
              : "Hold to speak"
        }
      >
        {isFinalizing ? (
          <Loader2 className="size-[18px] animate-spin text-[#18181B]" />
        ) : (
          <Mic className={cn("size-[18px] stroke-[1.75]", isRecording && "animate-pulse")} />
        )}
      </button>
    </div>
  );
}
