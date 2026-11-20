import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const BUCKET = process.env.S3_BUCKET_NAME || "your-s3-bucket-name";

const s3Client = new S3Client({ region: REGION });

/**
 * Generate a pre-signed S3 URL for customer attachment upload
 * @param {string} [caseRef] - Unique case reference ID (optional)
 * @param {string} filename - Attachment filename
 * @param {string} contentType - MIME type (e.g. image/jpeg, video/mp4)
 * @returns {Promise<{ uploadUrl: string, key: string, s3Key: string, fileUrl: string }>}
 */
export async function getUploadPresignedUrl(caseRef, filename, contentType) {
  const safeFilename = pathSanitize(filename || "attachment.jpg");
  const ext = safeFilename.includes(".") ? safeFilename.split(".").pop() : "jpg";
  const uuid = randomUUID();

  // If caseRef provided, group under uploads/{caseRef}/, otherwise uploads/{uuid}.{ext}
  const key = caseRef
    ? `uploads/${caseRef}/${Date.now()}_${uuid.slice(0, 8)}_${safeFilename}`
    : `uploads/${uuid}.${ext}`;

  const fileUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType || "application/octet-stream"
  });

  // Pre-signed URL valid for 15 minutes (900 seconds)
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });

  return {
    uploadUrl,
    key,
    s3Key: key,
    fileUrl
  };
}

/**
 * Generate a pre-signed S3 URL for secure file download/viewing
 * @param {string} key - S3 object key
 * @param {number} [expiresIn=3600] - Expiration in seconds
 * @returns {Promise<{ downloadUrl: string, key: string }>}
 */
export async function getDownloadPresignedUrl(key, expiresIn = 3600) {
  if (!key) {
    throw new Error("key 为必填项");
  }

  const command = new GetObjectCommand({
    Bucket: BUCKET,
    Key: key
  });

  const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn });

  return {
    downloadUrl,
    key
  };
}

function pathSanitize(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
