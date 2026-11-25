import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_PATH = path.resolve(__dirname, "../assets/lam/lam_audio2exp.onnx");
const MODEL_URL =
  process.env.LAM_MODEL_URL ||
  "https://github.com/Sss333333/ai-customer-service-chatbot/releases/download/models-v1/lam_audio2exp.onnx";

  if (fs.existsSync(MODEL_PATH) && fs.statSync(MODEL_PATH).size > 0) {
    console.log(`[LAM] Model already exists: ${MODEL_PATH}`);
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(MODEL_PATH), { recursive: true });
  console.log(`[LAM] Downloading ${MODEL_URL} ...`);

    const res = await fetch(MODEL_URL, { redirect: "follow" });
    if (!res.ok || !res.body) {
      throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
    }

    const tmpPath = `${MODEL_PATH}.part`;
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, MODEL_PATH);
    console.log(`[LAM] Saved to ${MODEL_PATH}`);
