import { customAlphabet } from "nanoid";
import { timestamp, pgTable, text, varchar } from "drizzle-orm/pg-core";
import { z } from "zod";

export const nanoid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789");

/**
 * 🗂️ resources 表结构定义（参考 ai-sdk-preview-rag-study/lib/db/schema/resources.ts）
 * 存储原始知识条目（如单条售后 SOP 规则或知识文档段落）
 */
export const resources = pgTable("resources", {
  id: varchar("id", { length: 191 })
    .primaryKey()
    .$defaultFn(() => nanoid()),
  category: text("category"),
  issue: text("issue"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow()
});

export const insertResourceSchema = z.object({
  id: z.string().optional(),
  category: z.string().optional(),
  issue: z.string().optional(),
  content: z.string().min(1)
});
