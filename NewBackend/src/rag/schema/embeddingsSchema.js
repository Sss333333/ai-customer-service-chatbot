import { index, pgTable, text, varchar, vector } from "drizzle-orm/pg-core";
import { resources, nanoid } from "./resourcesSchema.js";

/**
 * 🧠 embeddings 向量表结构定义（参考 ai-sdk-preview-rag-study/lib/db/schema/embeddings.ts）
 * 存储 2048 维知识向量 (适配 nvidia/nemotron-3.5-embed-1b:free)
 * 
 * 💡 说明：PostgreSQL pgvector 的 HNSW 索引最大上限为 2000 维。
 * 对于 2048 维向量模型，直接进行精确 KNN 余弦扫描，在知识库场景下耗时仅需数毫秒且召回精度为 100%。
 */
export const embeddings = pgTable(
  "embeddings",
  {
    id: varchar("id", { length: 191 })
      .primaryKey()
      .$defaultFn(() => nanoid()),
    resourceId: varchar("resource_id", { length: 191 }).references(
      () => resources.id,
      { onDelete: "cascade" }
    ),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: 2048 }).notNull()
  }
);
