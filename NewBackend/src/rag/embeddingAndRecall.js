import { ProxyAgent, setGlobalDispatcher } from "undici";
import { embed, embedMany } from "ai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { cosineDistance, desc, gt, sql } from "drizzle-orm";
import { embeddings } from "./schema/embeddingsSchema.js";
import { getDb } from "./index.js";

const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const isLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || (!isLambda ? "http://127.0.0.1:7890" : "");
if (proxyUrl) {
  try {
    setGlobalDispatcher(new ProxyAgent(proxyUrl));
  } catch {
    // ignore
  }
}

/**
 * 获取向量嵌入模型实例
 * 支持 OpenRouter Embedding 模型（默认 nvidia/nemotron-3.5-embed-1b:free, 2048 维）或 AI Gateway 模型字符串
 */
function getEmbeddingModel() {
  const modelId = process.env.OPENROUTER_EMBEDDING_MODEL || "nvidia/nemotron-3.5-embed-1b:free";
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey && !process.env.USE_AI_GATEWAY_EMBEDDING) {
    const openrouter = createOpenRouter({
      baseURL: process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
      apiKey,
      headers: {
        "HTTP-Referer": process.env.PUBLIC_FRONTEND_URL || "https://example.com",
        "X-OpenRouter-Title": "Nova AI Customer Service"
      }
    });
    return openrouter.textEmbeddingModel(modelId);
  }
  return process.env.EMBEDDING_MODEL || "voyage/voyage-code-2";
}

/**
 * ✂️ 文本分块函数（参考 ai-sdk-preview-rag-study/lib/ai/embedding.ts）
 * 支持按双换行（完整知识条目/段落）或句号切分
 */
export const generateChunks = (input) => {
  const trimmed = String(input || "").trim();
  if (!trimmed) return [];

  // 如果包含按双换行分隔的完整 SOP 知识块，优先按段落切分以保留完整上下文
  if (trimmed.includes("\n\n")) {
    return trimmed
      .split(/\n{2,}/)
      .map((s) => s.trim())
      .filter((i) => i !== "");
  }

  return trimmed
    .split(/[.。\n]+/)
    .map((s) => s.trim())
    .filter((i) => i !== "");
};

/**
 * 批量生成文本切片的 1536 维向量
 */
export const generateEmbeddings = async (value) => {
  const chunks = Array.isArray(value) ? value : generateChunks(value);
  if (chunks.length === 0) {
    return [];
  }
  const { embeddings: rawEmbeddings } = await embedMany({
    model: getEmbeddingModel(),
    values: chunks
  });
  return rawEmbeddings.map((e, i) => ({ content: chunks[i], embedding: e }));
};

/**
 * 针对单个查询生成 1536 维向量
 */
export const generateEmbedding = async (value) => {
  const input = String(value || "").replaceAll("\n", " ").trim();
  const { embedding } = await embed({
    model: getEmbeddingModel(),
    value: input
  });
  return embedding;
};

/**
 * 🔍 RAG 核心：基于 pgvector 余弦相似度检索相关售后知识
 * 参考 ai-sdk-preview-rag-study/lib/ai/embedding.ts 的 findRelevantContent
 */
export const findRelevantContent = async (userQuery) => {
  const db = getDb();
  const userQueryEmbedded = await generateEmbedding(userQuery);

  const similarity = sql`1 - (${cosineDistance(embeddings.embedding, userQueryEmbedded)})`;

  const similarGuides = await db
    .select({ name: embeddings.content, similarity })
    .from(embeddings)
    .where(gt(similarity, 0.3))
    .orderBy((t) => desc(t.similarity))
    .limit(4);

  return similarGuides;
};
