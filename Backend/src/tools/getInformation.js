import { findRelevantContent } from "../rag/embeddingAndRecall.js";

/**
 * Tool Definition Schema: getInformation (RAG 向量知识库检索工具)
 * 参考 F:\Workspace\ai-sdk-preview-rag-study\app\(preview)\api\chat\route.ts
 */
export const schema = {
  name: "getInformation",
  description:
    "Search the warranty & after-sales SOP knowledge base using semantic vector search (RAG). Always call this tool when a customer asks about warranty policies, product defects/faults (e.g. chip, crack, sensor faulty, leaking, splashing, drawer stuck), required claim documents, or troubleshooting steps.",
  input_schema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The customer's question or reported product issue"
      },
      similarQuestions: {
        type: "array",
        items: { type: "string" },
        description: "2 to 3 related search queries or bilingual keywords (e.g. ['mirror chip warranty', '镜子崩边理赔']) to maximize recall"
      }
    },
    required: ["question", "similarQuestions"]
  }
};

/**
 * Tool Implementation: 对问题与相似问题并行执行向量相似度搜索并去重
 */
export async function execute({ question, similarQuestions = [] }) {
  const queries = Array.from(
    new Set([question, ...(Array.isArray(similarQuestions) ? similarQuestions : [])].filter(Boolean))
  );

  try {
    const results = await Promise.all(
      queries.map(async (q) => await findRelevantContent(q))
    );

    const uniqueResults = Array.from(
      new Map(results.flat().map((item) => [item?.name, item])).values()
    );

    return uniqueResults;
  } catch (err) {
    console.error("[getInformation] Vector search failed:", err.message);
    return { error: `Knowledge base search error: ${err.message}` };
  }
}
