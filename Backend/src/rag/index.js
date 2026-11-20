import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import "dotenv/config";

let _db = null;
let _client = null;

/**
 * 获取 PostgreSQL + Drizzle ORM 实例（参考 ai-sdk-preview-rag-study/lib/db/index.ts）
 */
export function getDb() {
  if (_db) return _db;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured in environment variables.");
  }
  _client = postgres(databaseUrl, { prepare: false });
  _db = drizzle(_client);
  return _db;
}

export async function closeDb() {
  if (_client) {
    await _client.end();
    _client = null;
    _db = null;
  }
}
