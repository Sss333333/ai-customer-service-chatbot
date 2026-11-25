import fs from "node:fs";
import path from "node:path";
import * as ort from "onnxruntime-node";
import {
  ARKIT_BLENDSHAPES,
  NUM_BLENDSHAPES,
  applyExpressionPostprocessing,
} from "./postprocess.js";
import { computeRmsVolume, resampleLinear } from "./audioDecode.js";

export const SAMPLE_RATE = 24000;
export const MODEL_SR = 16000;
export const FPS = 30;
const MAX_FRAME_LENGTH = 64;
const MODEL_INPUT_SAMPLES = Math.floor((MODEL_SR * MAX_FRAME_LENGTH) / FPS); // 34133
const NUM_IDENTITY_CLASSES = 12;

function concatFloat32(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export class LamOnnxEngine {
  constructor(onnxPath, arkitChannelsPath = null) {
    this.onnxPath = onnxPath;
    this.arkitChannelsPath = arkitChannelsPath;
    this.session = null;
    this.arkitChannels = [...ARKIT_BLENDSHAPES];
    this.device = "cpu";
    this._queue = Promise.resolve();
    this._idIdxTensor = null;
  }

  async init() {
    if (!fs.existsSync(this.onnxPath)) {
      throw new Error(`LAM ONNX model not found: ${this.onnxPath}`);
    }

    if (this.arkitChannelsPath && fs.existsSync(this.arkitChannelsPath)) {
      const lines = fs
        .readFileSync(this.arkitChannelsPath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === NUM_BLENDSHAPES) {
        this.arkitChannels = lines;
      }
    }

    const t0 = performance.now();
    this.session = await ort.InferenceSession.create(this.onnxPath, {
      executionProviders: ["cpu"],
      graphOptimizationLevel: "all",
    });

    const idArr = new Float32Array(NUM_IDENTITY_CLASSES);
    idArr[0] = 1.0; // id_idx = 0
    this._idIdxTensor = new ort.Tensor("float32", idArr, [1, NUM_IDENTITY_CLASSES]);

    // Warm up with 1 second of silence
    await this.inferChunk(new Float32Array(SAMPLE_RATE), null);
    const ms = Math.round(performance.now() - t0);
    console.log(
      `[LAM-Node] ONNX model loaded on ${this.device} and warmed up in ${ms}ms (${this.arkitChannels.length} ARKit channels)`
    );
  }

  /**
   * Serialized streaming inference matching Audio2ExpressionInfer.infer_streaming_audio().
   * Returns { frames: Float32Array (numFrames * 52), numFrames: number, nextContext: object }
   */
  inferChunk(audio24k, context) {
    const task = this._queue.then(() => this._runChunk(audio24k, context));
    // Keep queue alive even if a single chunk errors
    this._queue = task.catch(() => {});
    return task;
  }

  async _runChunk(audio24k, context) {
    const ctx = context || {
      isInitialInput: true,
      previousAudio: null,
      previousExpression: null,
      previousNumFrames: 0,
      previousVolume: null,
    };

    const volume = computeRmsVolume(audio24k, SAMPLE_RATE, FPS);
    const inAudio = resampleLinear(audio24k, SAMPLE_RATE, MODEL_SR);

    // If audio chunk is longer than window, take the last MODEL_INPUT_SAMPLES
    const usableAudio =
      inAudio.length > MODEL_INPUT_SAMPLES
        ? inAudio.subarray(inAudio.length - MODEL_INPUT_SAMPLES)
        : inAudio;

    const startFrame = Math.max(
      0,
      Math.min(
        MAX_FRAME_LENGTH - 1,
        Math.trunc(MAX_FRAME_LENGTH - (usableAudio.length / MODEL_SR) * FPS)
      )
    );

    const padLen = MODEL_INPUT_SAMPLES - usableAudio.length;
    const inputAudio = new Float32Array(MODEL_INPUT_SAMPLES);
    if (ctx.isInitialInput || !ctx.previousAudio) {
      // Zero-pad front
      inputAudio.set(usableAudio, padLen);
    } else {
      const prevStart = Math.max(0, ctx.previousAudio.length - padLen);
      const prevSlice = ctx.previousAudio.subarray(prevStart);
      inputAudio.set(prevSlice, padLen - prevSlice.length);
      inputAudio.set(usableAudio, padLen);
    }

    const audioTensor = new ort.Tensor("float32", inputAudio, [1, MODEL_INPUT_SAMPLES]);
    const results = await this.session.run({
      input_audio_array: audioTensor,
      id_idx: this._idIdxTensor,
    });

    const predData = results.pred_exp.data; // Float32Array [64 * 52]
    const newNumFrames = MAX_FRAME_LENGTH - startFrame;
    const rawNewExp = predData.slice(startFrame * NUM_BLENDSHAPES, MAX_FRAME_LENGTH * NUM_BLENDSHAPES);

    let processedNewExp;
    let nextPrevExp;
    let nextPrevNumFrames;
    let nextPrevVol;

    if (!ctx.previousExpression || ctx.previousNumFrames === 0) {
      processedNewExp = applyExpressionPostprocessing(rawNewExp, newNumFrames, 0, volume);
      nextPrevExp = new Float32Array(processedNewExp);
      nextPrevNumFrames = newNumFrames;
      nextPrevVol = new Float32Array(volume);
    } else {
      const prevLen = ctx.previousNumFrames;
      const combinedExp = concatFloat32(ctx.previousExpression, rawNewExp);
      const combinedVol = concatFloat32(ctx.previousVolume, volume);
      const totalFrames = prevLen + newNumFrames;

      const postCombined = applyExpressionPostprocessing(
        combinedExp,
        totalFrames,
        prevLen,
        combinedVol
      );
      processedNewExp = postCombined.slice(prevLen * NUM_BLENDSHAPES);

      // Retain last MAX_FRAME_LENGTH frames in context
      const mergedExp = concatFloat32(ctx.previousExpression, processedNewExp);
      const mergedFrames = prevLen + newNumFrames;
      const keepFrames = Math.min(MAX_FRAME_LENGTH, mergedFrames);
      const dropFrames = mergedFrames - keepFrames;
      nextPrevExp = mergedExp.slice(dropFrames * NUM_BLENDSHAPES);
      nextPrevNumFrames = keepFrames;

      const mergedVol = concatFloat32(ctx.previousVolume, volume);
      const keepVol = Math.min(MAX_FRAME_LENGTH, mergedVol.length);
      nextPrevVol = mergedVol.slice(mergedVol.length - keepVol);
    }

    const nextContext = {
      isInitialInput: false,
      previousAudio: inputAudio,
      previousExpression: nextPrevExp,
      previousNumFrames: nextPrevNumFrames,
      previousVolume: nextPrevVol,
    };

    return {
      frames: processedNewExp,
      numFrames: newNumFrames,
      nextContext,
    };
  }
}
