/**
 * 1:1 JavaScript port of LAM_Audio2Expression/models/utils.py postprocessing pipeline:
 *   1. smoothMouthMovements
 *   2. applyFrameBlending
 *   3. applySavitzkyGolaySmoothing (window=5, polyorder=2, mirror mode)
 *   4. symmetrizeBlendshapes
 *   5. applyRandomEyeBlinksContext
 */

export const ARKIT_BLENDSHAPES = [
  "browDownLeft",
  "browDownRight",
  "browInnerUp",
  "browOuterUpLeft",
  "browOuterUpRight",
  "cheekPuff",
  "cheekSquintLeft",
  "cheekSquintRight",
  "eyeBlinkLeft",
  "eyeBlinkRight",
  "eyeLookDownLeft",
  "eyeLookDownRight",
  "eyeLookInLeft",
  "eyeLookInRight",
  "eyeLookOutLeft",
  "eyeLookOutRight",
  "eyeLookUpLeft",
  "eyeLookUpRight",
  "eyeSquintLeft",
  "eyeSquintRight",
  "eyeWideLeft",
  "eyeWideRight",
  "jawForward",
  "jawLeft",
  "jawOpen",
  "jawRight",
  "mouthClose",
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthFunnel",
  "mouthLeft",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthPucker",
  "mouthRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "noseSneerLeft",
  "noseSneerRight",
  "tongueOut",
];

export const NUM_BLENDSHAPES = 52;

const NAME_TO_IDX = new Map(ARKIT_BLENDSHAPES.map((name, i) => [name, i]));

const SYMMETRIC_PAIRS = [
  ["jawLeft", "jawRight"],
  ["mouthLeft", "mouthRight"],
  ["mouthSmileLeft", "mouthSmileRight"],
  ["mouthFrownLeft", "mouthFrownRight"],
  ["mouthDimpleLeft", "mouthDimpleRight"],
  ["mouthStretchLeft", "mouthStretchRight"],
  ["mouthPressLeft", "mouthPressRight"],
  ["mouthLowerDownLeft", "mouthLowerDownRight"],
  ["mouthUpperUpLeft", "mouthUpperUpRight"],
  ["cheekSquintLeft", "cheekSquintRight"],
  ["noseSneerLeft", "noseSneerRight"],
  ["browDownLeft", "browDownRight"],
  ["browOuterUpLeft", "browOuterUpRight"],
  ["eyeBlinkLeft", "eyeBlinkRight"],
  ["eyeLookDownLeft", "eyeLookDownRight"],
  ["eyeLookInLeft", "eyeLookInRight"],
  ["eyeLookOutLeft", "eyeLookOutRight"],
  ["eyeLookUpLeft", "eyeLookUpRight"],
  ["eyeSquintLeft", "eyeSquintRight"],
  ["eyeWideLeft", "eyeWideRight"],
].map(([l, r]) => [NAME_TO_IDX.get(l), NAME_TO_IDX.get(r)]);

const MOUTH_INDICES = [
  "mouthDimpleLeft",
  "mouthDimpleRight",
  "mouthFrownLeft",
  "mouthFrownRight",
  "mouthFunnel",
  "mouthLeft",
  "mouthLowerDownLeft",
  "mouthLowerDownRight",
  "mouthPressLeft",
  "mouthPressRight",
  "mouthPucker",
  "mouthRight",
  "mouthRollLower",
  "mouthRollUpper",
  "mouthShrugLower",
  "mouthShrugUpper",
  "mouthSmileLeft",
  "mouthSmileRight",
  "mouthStretchLeft",
  "mouthStretchRight",
  "mouthUpperUpLeft",
  "mouthUpperUpRight",
  "jawForward",
  "jawLeft",
  "jawOpen",
  "jawRight",
  "noseSneerLeft",
  "noseSneerRight",
  "cheekPuff",
].map((name) => NAME_TO_IDX.get(name));

const BLINK_PATTERNS = [
  [0.365, 0.95, 0.956, 0.917, 0.367, 0.119, 0.025],
  [0.235, 0.91, 0.945, 0.778, 0.191, 0.235, 0.089],
  [0.87, 0.95, 0.949, 0.696, 0.191, 0.073, 0.007],
  [0.0, 0.557, 0.953, 0.942, 0.426, 0.148, 0.018],
];

// Exact Savitzky-Golay coefficients for window_length=5, polyorder=2
const SAVGOL_5_2 = [-3 / 35, 12 / 35, 17 / 35, 12 / 35, -3 / 35];

function randInt(minInclusive, maxExclusive) {
  return minInclusive + Math.floor(Math.random() * (maxExclusive - minInclusive));
}

function randUniform(min, max) {
  return min + Math.random() * (max - min);
}

function findLowValueRegions(signal, threshold, minRegionLength = 5) {
  const lowIndices = [];
  for (let i = 0; i < signal.length; i++) {
    if (signal[i] < threshold) lowIndices.push(i);
  }
  const regions = [];
  let currentLen = 0;
  let startIdx = 0;

  for (let i = 1; i < lowIndices.length; i++) {
    if (lowIndices[i] !== lowIndices[i - 1] + 1) {
      if (currentLen >= minRegionLength) {
        regions.push(lowIndices.slice(startIdx, i));
      }
      startIdx = i;
      currentLen = 0;
    }
    currentLen += 1;
  }
  if (currentLen >= minRegionLength) {
    regions.push(lowIndices.slice(startIdx));
  }
  return regions;
}

/**
 * Helper: access frame `f`, channel `c` in flat Float32Array [numFrames * 52].
 */
export function smoothMouthMovements(
  frames,
  numFrames,
  processedFrames,
  volume,
  silenceThreshold = 0.001,
  minSilenceDuration = 7,
  blendWindow = 3
) {
  if (!volume || volume.length === 0) return frames;

  const silentRegions = findLowValueRegions(volume, silenceThreshold, minSilenceDuration);
  for (const region of silentRegions) {
    for (const f of region) {
      if (f < 0 || f >= numFrames) continue;
      const base = f * NUM_BLENDSHAPES;
      for (const idx of MOUTH_INDICES) {
        frames[base + idx] *= 0.1;
      }
    }

    // Blend region start
    const rStart = region[0];
    const startBlendLen = Math.min(blendWindow, rStart - processedFrames);
    if (startBlendLen > 0 && rStart - 1 >= 0) {
      const preBase = (rStart - 1) * NUM_BLENDSHAPES;
      for (let i = 0; i < startBlendLen; i++) {
        const targetFrame = rStart + i;
        if (targetFrame >= numFrames) break;
        const w = (i + 1) / (startBlendLen + 1);
        const dstBase = targetFrame * NUM_BLENDSHAPES;
        for (let c = 0; c < NUM_BLENDSHAPES; c++) {
          frames[dstBase + c] = frames[preBase + c] * (1 - w) + frames[dstBase + c] * w;
        }
      }
    }

    // Blend region end
    const rEnd = region[region.length - 1];
    const endBlendLen = Math.min(blendWindow, numFrames - rEnd - 1);
    if (endBlendLen > 0 && rEnd + 1 < numFrames) {
      const postBase = (rEnd + 1) * NUM_BLENDSHAPES;
      for (let i = 0; i < endBlendLen; i++) {
        const targetFrame = rEnd - i;
        if (targetFrame < 0) break;
        const w = (i + 1) / (endBlendLen + 1);
        const dstBase = targetFrame * NUM_BLENDSHAPES;
        for (let c = 0; c < NUM_BLENDSHAPES; c++) {
          frames[dstBase + c] = frames[postBase + c] * (1 - w) + frames[dstBase + c] * w;
        }
      }
    }
  }

  return frames;
}

export function applyFrameBlending(
  frames,
  numFrames,
  processedFrames,
  initialBlendWindow = 3,
  subsequentBlendWindow = 5
) {
  if (numFrames === 0) return frames;

  let transitionStart = 0;
  let blendWindow = initialBlendWindow;
  let refFrame = null;

  if (processedFrames > 0) {
    transitionStart = processedFrames;
    blendWindow = subsequentBlendWindow;
    const refBase = (processedFrames - 1) * NUM_BLENDSHAPES;
    refFrame = frames.slice(refBase, refBase + NUM_BLENDSHAPES);
  } else {
    refFrame = new Float32Array(NUM_BLENDSHAPES);
  }

  const actualLen = Math.min(blendWindow, numFrames - transitionStart);
  for (let offset = 0; offset < actualLen; offset++) {
    const f = transitionStart + offset;
    const w = (offset + 1) / (actualLen + 1);
    const base = f * NUM_BLENDSHAPES;
    for (let c = 0; c < NUM_BLENDSHAPES; c++) {
      frames[base + c] = refFrame[c] * (1 - w) + frames[base + c] * w;
    }
  }

  return frames;
}

function mirrorIndex(idx, n) {
  if (n <= 1) return 0;
  let i = idx;
  while (i < 0 || i >= n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * (n - 1) - i;
  }
  return i;
}

export function applySavitzkyGolaySmoothing(frames, numFrames) {
  if (numFrames < 3) return frames;
  const out = new Float32Array(frames.length);

  for (let f = 0; f < numFrames; f++) {
    const idx0 = mirrorIndex(f - 2, numFrames) * NUM_BLENDSHAPES;
    const idx1 = mirrorIndex(f - 1, numFrames) * NUM_BLENDSHAPES;
    const idx2 = f * NUM_BLENDSHAPES;
    const idx3 = mirrorIndex(f + 1, numFrames) * NUM_BLENDSHAPES;
    const idx4 = mirrorIndex(f + 2, numFrames) * NUM_BLENDSHAPES;

    for (let c = 0; c < NUM_BLENDSHAPES; c++) {
      const val =
        SAVGOL_5_2[0] * frames[idx0 + c] +
        SAVGOL_5_2[1] * frames[idx1 + c] +
        SAVGOL_5_2[2] * frames[idx2 + c] +
        SAVGOL_5_2[3] * frames[idx3 + c] +
        SAVGOL_5_2[4] * frames[idx4 + c];
      out[idx2 + c] = val < 0 ? 0 : val > 1 ? 1 : val;
    }
  }

  return out;
}

export function symmetrizeBlendshapes(frames, numFrames) {
  for (let f = 0; f < numFrames; f++) {
    const base = f * NUM_BLENDSHAPES;
    for (const [lIdx, rIdx] of SYMMETRIC_PAIRS) {
      const avg = 0.5 * (frames[base + lIdx] + frames[base + rIdx]);
      frames[base + lIdx] = avg;
      frames[base + rIdx] = avg;
    }
  }
  return frames;
}

export function applyRandomEyeBlinksContext(
  frames,
  numFrames,
  processedFrames = 0,
  minIntensity = 0.8,
  maxIntensity = 1.0
) {
  const remainingFrames = numFrames - processedFrames;
  if (remainingFrames <= 7) return frames;

  const minBlinkInterval = 40;
  const maxBlinkInterval = 100;

  let lastBlinkIdx = -1;
  for (let f = 0; f < processedFrames; f++) {
    if (frames[f * NUM_BLENDSHAPES + 8] > 0.5) {
      lastBlinkIdx = f;
    }
  }
  const lastProcessedBlink = lastBlinkIdx >= 0 ? lastBlinkIdx - 7 : processedFrames;

  const blinkInterval = randInt(minBlinkInterval, maxBlinkInterval);
  const firstBlinkStart = Math.max(0, blinkInterval - lastProcessedBlink);

  if (firstBlinkStart <= remainingFrames - 7) {
    const pattern = BLINK_PATTERNS[randInt(0, BLINK_PATTERNS.length)];
    const intensity = randUniform(minIntensity, maxIntensity);
    const blinkStart = processedFrames + firstBlinkStart;
    const blinkEnd = blinkStart + 7;

    for (let k = 0; k < 7; k++) {
      const val = pattern[k] * intensity;
      const base = (blinkStart + k) * NUM_BLENDSHAPES;
      frames[base + 8] = val;
      frames[base + 9] = val;
    }

    const remainingAfter = numFrames - blinkEnd;
    if (remainingAfter > minBlinkInterval) {
      const secondIntensity = randUniform(minIntensity, maxIntensity);
      const secondInterval = randInt(minBlinkInterval, maxBlinkInterval);
      if (remainingAfter - 7 > secondInterval) {
        const secondPattern = BLINK_PATTERNS[randInt(0, BLINK_PATTERNS.length)];
        const secondStart = blinkEnd + secondInterval;
        for (let k = 0; k < 7; k++) {
          const val = secondPattern[k] * secondIntensity;
          const base = (secondStart + k) * NUM_BLENDSHAPES;
          frames[base + 8] = val;
          frames[base + 9] = val;
        }
      }
    }
  }

  return frames;
}

export function applyExpressionPostprocessing(
  frames,
  numFrames,
  processedFrames = 0,
  audioVolume = null
) {
  let out = new Float32Array(frames);
  out = smoothMouthMovements(out, numFrames, processedFrames, audioVolume);
  out = applyFrameBlending(out, numFrames, processedFrames);
  out = applySavitzkyGolaySmoothing(out, numFrames);
  out = symmetrizeBlendshapes(out, numFrames);
  out = applyRandomEyeBlinksContext(out, numFrames, processedFrames);
  return out;
}
