export const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * Generate a unique case reference ID (e.g. WEB1ABC2XYZ)
 */
export function generateCaseRef() {
  return `WEB${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * Upload an attachment (photo/video/PDF) via S3 pre-signed URL
 * @param {File} file
 * @param {string} caseRef
 */
export async function uploadFile(file, caseRef) {
  const res = await fetch(`${API_BASE}/upload-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      caseRef,
      filename: file.name,
      contentType: file.type,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? 'Upload was refused.');
  }

  const data = await res.json();
  const { uploadUrl, key, s3Key, fileUrl } = data;

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!put.ok) {
    throw new Error('Upload failed.');
  }

  return {
    key: key || s3Key,
    s3Key: s3Key || key,
    fileUrl,
    uploadUrl,
  };
}

/**
 * Transcribe recorded audio file to text
 * @param {Blob} file 
 * @param {string} [filename] 
 * @returns {Promise<{ text: string }>}
 */
export async function transcribeAudio(file, filename = "voice_input.wav") {
  const formData = new FormData();
  formData.append("file", file, filename);
  const res = await fetch(`${API_BASE}/api/audio/transcribe`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || body.message || `Audio transcription failed (${res.status})`);
  }
  const result = await res.json();
  const text = result?.data?.text || result?.text || "";
  return { text };
}
