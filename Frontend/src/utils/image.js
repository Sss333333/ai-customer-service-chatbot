const IMAGE_MAX_EDGE = 960;
const JPEG_QUALITY = 0.65;

/**
 * Scale and compress customer image before base64 inline sending.
 * @param {File} file
 * @returns {Promise<{ base64: string, dataUrl: string }>}
 */
export async function resizeImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return {
    base64: dataUrl.split(',')[1],
    dataUrl,
  };
}
