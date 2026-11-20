/**
 * 跨语言实时通话音频工具（参考 interpreter-node/src/client/audio/pcm.ts）
 *  - 上行：16kHz / 16-bit 单声道 PCM（开启 AEC 回声消除 + 降噪 + AGC）
 *  - 下行：24kHz / 16-bit 单声道 PCM 队列播放
 */

function calculateLevel(input) {
  if (!input || input.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] ?? 0;
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / input.length);
  return Math.min(1, rms * 8);
}

function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    output[i] = input[Math.floor(i * ratio)] ?? 0;
  }
  return output;
}

function floatTo16BitPcm(input) {
  const output = new DataView(new ArrayBuffer(input.length * 2));
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0));
    output.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Uint8Array(output.buffer);
}

function pcm16ToFloat32(input) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const sampleCount = Math.floor(input.byteLength / 2);
  const output = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    output[i] = view.getInt16(i * 2, true) / 0x8000;
  }
  return output;
}

/**
 * 启动麦克风采集并持续回调 16kHz PCM16 Uint8Array
 */
export async function startPcmRecorder(onChunk, onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const context = new AudioCtx();
  if (context.state === "suspended") {
    await context.resume();
  }

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const resampled = resample(input, context.sampleRate, 16000);
    onLevel?.(calculateLevel(input));
    onChunk(floatTo16BitPcm(resampled));
  };

  source.connect(processor);
  processor.connect(context.destination);

  return {
    stop() {
      try {
        processor.disconnect();
        processor.onaudioprocess = null;
      } catch {}
      try {
        source.disconnect();
      } catch {}
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      try {
        void context.close();
      } catch {}
    },
  };
}

/**
 * 24kHz PCM16 流式播放器（按时间轴无缝排队播放）
 */
export class PcmPlayer {
  constructor() {
    this.context = null;
    this.nextStartTime = 0;
  }

  getContext(sampleRate = 24000) {
    if (!this.context) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioCtx({ sampleRate });
    }
    return this.context;
  }

  async unlock(sampleRate = 24000) {
    const context = this.getContext(sampleRate);
    if (context.state === "suspended") {
      await context.resume();
    }
  }

  async play(chunk, sampleRate = 24000) {
    if (!chunk || chunk.byteLength < 2) return;
    const context = this.getContext(sampleRate);
    if (context.state === "suspended") {
      await context.resume();
    }

    const samples = pcm16ToFloat32(chunk);
    if (samples.length === 0) return;

    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime, this.nextStartTime || context.currentTime);
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
  }

  reset() {
    if (this.context) {
      try {
        void this.context.close();
      } catch {}
      this.context = null;
    }
    this.nextStartTime = 0;
  }
}
