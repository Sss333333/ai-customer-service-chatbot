/**
 * Decode incoming 16-bit signed little-endian mono PCM bytes into Float32Array waveform.
 */
  export async function decodeAudioToFloat32Mono(payload, audioFormat = "pcm24k") {
    if (!payload || payload.length === 0) {
      return new Float32Array(0);
    }

      const fmt = (audioFormat || "pcm24k").toLowerCase().trim();
      if (fmt !== "pcm" && fmt !== "pcm24k" && fmt !== "pcm16" && fmt !== "s16le") {
        throw new Error(`Unsupported audio format "${audioFormat}": only 16-bit PCM (pcm24k) is supported`);
      }

      const usable = payload.length - (payload.length % 2);
      if (usable <= 0) return new Float32Array(0);
      const numSamples = usable / 2;
      const out = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        out[i] = payload.readInt16LE(i * 2) / 32768.0;
      }
      return out;
    }

    /**
     * Linear resampling from origSr to targetSr (e.g., 24000 -> 16000).
     */
    export function resampleLinear(input, origSr, targetSr) {
      if (origSr === targetSr || input.length === 0) {
        return new Float32Array(input);
      }
      const ratio = origSr / targetSr;
      const outLen = Math.max(1, Math.round(input.length / ratio));
      const out = new Float32Array(outLen);
      const lastIdx = input.length - 1;
      for (let i = 0; i < outLen; i++) {
        const srcPos = i * ratio;
        const idx0 = Math.floor(srcPos);
        const idx1 = idx0 < lastIdx ? idx0 + 1 : lastIdx;
        const frac = srcPos - idx0;
        out[i] = input[idx0] * (1 - frac) + input[idx1] * frac;
      }
      return out;
    }

    /**
     * Compute per-frame RMS volume matching librosa.feature.rms(..., center=True).
     */
    export function computeRmsVolume(audio, sr, fps = 30) {
      const frameCount = Math.ceil((audio.length / sr) * fps);
      if (frameCount <= 0 || audio.length === 0) return new Float32Array(0);

      const hop = Math.max(1, Math.floor(sr / fps));
      const frameLen = Math.min(hop, audio.length);
      const half = Math.floor(frameLen / 2);
      const out = new Float32Array(frameCount);

      for (let f = 0; f < frameCount; f++) {
        const center = f * hop;
        let sumSq = 0;
        for (let k = 0; k < frameLen; k++) {
          const idx = center - half + k;
          if (idx >= 0 && idx < audio.length) {
            const v = audio[idx];
            sumSq += v * v;
          }
        }
        out[f] = Math.sqrt(sumSq / frameLen);
      }
      return out;
    }
