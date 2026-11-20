import busboy from "busboy";
import { Readable } from "stream";

/**
 * 从 multipart/form-data 中提取上传的音频文件 Buffer 与文件名
 * @param {object} headers 
 * @param {Buffer|string} bodyBuffer 
 * @returns {Promise<{ fileBuffer: Buffer, filename: string }>}
 */
export async function parseAudioUpload(headers, bodyBuffer) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = busboy({ headers });
    } catch (err) {
      return reject(new Error(`Invalid multipart request: ${err.message}`));
    }

    let fileBuffer = null;
    let filename = "audio.wav";

    bb.on("file", (name, file, info) => {
      filename = info.filename || "audio.wav";
      const chunks = [];
      file.on("data", (chunk) => chunks.push(chunk));
      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("close", () => {
      if (!fileBuffer || fileBuffer.length === 0) {
        return reject(new Error("未收到有效音频文件（'file' 字段为空）"));
      }
      resolve({ fileBuffer, filename });
    });

    bb.on("error", (err) => {
      reject(err);
    });

    const stream = Readable.from(Buffer.isBuffer(bodyBuffer) ? bodyBuffer : Buffer.from(bodyBuffer));
    stream.pipe(bb);
  });
}
