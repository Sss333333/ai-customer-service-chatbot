/**
 * Convert any browser-recorded Audio Blob (WebM, OGG, MP4, etc.)
 * to standard 16kHz 16-bit Mono PCM WAV Blob suitable for ASR models like DashScope Paraformer.
 * @param {Blob} blob 
 * @returns {Promise<Blob>}
 */
export async function convertBlobTo16kWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioContextClass =
    window.AudioContext ||
    window.webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("Web Audio API is not supported in this browser.");
  }

  const audioContext = new AudioContextClass();
  let decodedBuffer;
  try {
    decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    try {
      await audioContext.close();
    } catch {
      // ignore
    }
  }

  const targetSampleRate = 16000;
  const duration = decodedBuffer.duration;
  const targetLength = Math.max(1, Math.ceil(duration * targetSampleRate));

  const offlineContext = new OfflineAudioContext(1, targetLength, targetSampleRate);
  const source = offlineContext.createBufferSource();
  source.buffer = decodedBuffer;
  source.connect(offlineContext.destination);
  source.start(0);

  const resampledBuffer = await offlineContext.startRendering();
  return encodeAudioBufferToWav(resampledBuffer);
}

/**
 * Encode an AudioBuffer into standard 16-bit PCM WAV Blob
 * @param {AudioBuffer} audioBuffer 
 * @returns {Blob}
 */
export function encodeAudioBufferToWav(audioBuffer) {
  const numChannels = 1;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const channelData = audioBuffer.getChannelData(0);
  const numSamples = channelData.length;
  const dataSize = numSamples * (bitDepth / 8);
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  /* RIFF identifier */
  writeString(view, 0, "RIFF");
  /* RIFF chunk length */
  view.setUint32(4, 36 + dataSize, true);
  /* RIFF type */
  writeString(view, 8, "WAVE");
  /* format chunk identifier */
  writeString(view, 12, "fmt ");
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, format, true);
  /* channel count */
  view.setUint16(22, numChannels, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * numChannels * (bitDepth / 8), true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, numChannels * (bitDepth / 8), true);
  /* bits per sample */
  view.setUint16(34, bitDepth, true);
  /* data chunk identifier */
  writeString(view, 36, "data");
  /* data chunk length */
  view.setUint32(40, dataSize, true);

  // Write PCM samples (float32 to int16 with clipping)
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
