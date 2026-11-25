import { spawn } from "node:child_process";
import fs from "node:fs";
import ffmpegStatic from "ffmpeg-static";

function resolveFfmpegBin() {
  const candidates = [process.env.FFMPEG_PATH, ffmpegStatic].filter(Boolean);
  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {}
  }
  return "ffmpeg";
}

/**
 * Decode incoming MP3/WAV/OGG/PCM bytes into 1D Float32Array mono waveform at targetSr.
 * Matches Python decode_audio_to_float32_mono() in lam_server.py.
 */
export async function decodeAudioToFloat32Mono(payload, audioFormat = "mp3", targetSr = 24000) {
  if (!payload || payload.length === 0) {
    return new Float32Array(0);
  }

  const fmt = (audioFormat || "mp3").toLowerCase().trim();
  if (fmt === "pcm" || fmt === "pcm24k" || fmt === "pcm16" || fmt === "s16le") {
    const usable = payload.length - (payload.length % 2);
    if (usable <= 0) return new Float32Array(0);
    const numSamples = usable / 2;
    const out = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      out[i] = payload.readInt16LE(i * 2) / 32768.0;
    }
    return out;
  }

  const ffmpegBin = resolveFfmpegBin();
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-ac",
    "1",
    "-ar",
    String(targetSr),
    "-f",
    "f32le",
    "pipe:1",
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    const outChunks = [];
    const errChunks = [];

    proc.stdout.on("data", (chunk) => outChunks.push(chunk));
    proc.stderr.on("data", (chunk) => errChunks.push(chunk));

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn ffmpeg (${ffmpegBin}): ${err.message}`));
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf8").trim();
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr || "unknown error"}`));
        return;
      }
      const buf = Buffer.concat(outChunks);
      const usable = buf.length - (buf.length % 4);
      if (usable <= 0) {
        resolve(new Float32Array(0));
        return;
      }
      // Copy into aligned Float32Array
      const out = new Float32Array(usable / 4);
      for (let i = 0; i < out.length; i++) {
        out[i] = buf.readFloatLE(i * 4);
      }
      resolve(out);
    });

    proc.stdin.on("error", () => {});
    proc.stdin.end(payload);
  });
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
