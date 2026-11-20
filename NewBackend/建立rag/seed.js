import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";
import "dotenv/config";
import { getDb, closeDb } from "../src/rag/index.js";
import { resources } from "../src/rag/schema/resourcesSchema.js";
import { embeddings as embeddingsTable } from "../src/rag/schema/embeddingsSchema.js";
import { generateEmbeddings } from "../src/rag/embeddingAndRecall.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 标准 RFC 4180 CSV 解析器，支持引号、逗号、转义引号和跨行换行
 */
function parseCsv(text) {
  const rows = [];
  let currentRow = [];
  let currentField = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (inQuotes) {
      if (char === '"' && nextChar === '"') {
        currentField += '"';
        i++; // 跳过转义双引号
      } else if (char === '"') {
        inQuotes = false;
      } else {
        currentField += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
      } else if (char === "\n" || char === "\r") {
        if (char === "\r" && nextChar === "\n") {
          i++;
        }
        currentRow.push(currentField);
        currentField = "";
        if (currentRow.length > 1 || (currentRow.length === 1 && currentRow[0] !== "")) {
          rows.push(currentRow);
        }
        currentRow = [];
      } else {
        currentField += char;
      }
    }
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] ?? "";
    });
    return obj;
  });
}

/**
 * 初始化 pgvector 表结构并将 warranty_sop.csv 导入 Supabase / PostgreSQL 向量数据库
 */
async function migrateAndSeed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("❌ DATABASE_URL is not defined in .env");
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false });

  console.log("⏳ 1. Ensuring pgvector extension, columns and tables exist (2048-d)...");
  await sql.unsafe(`
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS "resources" (
      "id" varchar(191) PRIMARY KEY NOT NULL,
      "category" text,
      "issue" text,
      "content" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );

    ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "category" text;
    ALTER TABLE "resources" ADD COLUMN IF NOT EXISTS "issue" text;

    CREATE TABLE IF NOT EXISTS "embeddings" (
      "id" varchar(191) PRIMARY KEY NOT NULL,
      "resource_id" varchar(191) REFERENCES "resources"("id") ON DELETE cascade,
      "content" text NOT NULL,
      "embedding" vector(2048) NOT NULL
    );

    DROP INDEX IF EXISTS "embeddingIndex";
    TRUNCATE TABLE "embeddings";
    ALTER TABLE "embeddings" ALTER COLUMN "embedding" TYPE vector(2048);
  `);
  console.log("✅ Tables and 2048-d vector schema verified (exact KNN search).");

  // 2. 读取 warranty_sop.csv
  const sopCsvPath = path.join(__dirname, "data", "warranty_sop.csv");
  if (!fs.existsSync(sopCsvPath)) {
    throw new Error(`❌ File not found: ${sopCsvPath}`);
  }

  const csvRaw = fs.readFileSync(sopCsvPath, "utf-8");
  const sopRecords = parseCsv(csvRaw);
  console.log(`⏳ 2. Parsed ${sopRecords.length} records from warranty_sop.csv.`);

  // 清除旧的 SOP 记录（避免重复插入），保持数据库纯净
  console.log("⏳ 3. Cleaning previous Warranty SOP resources...");
  await sql.unsafe(`
    DELETE FROM "resources" 
    WHERE "id" LIKE 'sop-%' 
       OR "category" IS NOT NULL
       OR ("category" IS NULL AND "id" != 'v2sifyogo4igfghf32pl1');
  `);
  await sql.end();

  // 3. 生成 2048-d 向量
  console.log(`⏳ 4. Generating 2048-d embeddings for ${sopRecords.length} chunks via nvidia/nemotron-3.5-embed-1b:free...`);
  const contents = sopRecords.map((r) => r.content);
  const embeddedItems = await generateEmbeddings(contents);

  // 4. 插入 Supabase resources 和 embeddings 表
  console.log("⏳ 5. Writing to Supabase tables...");
  const db = getDb();
  let insertedCount = 0;

  for (let i = 0; i < sopRecords.length; i++) {
    const record = sopRecords[i];
    const embedded = embeddedItems[i];

    const [res] = await db
      .insert(resources)
      .values({
        id: record.id || undefined,
        category: record.category || null,
        issue: record.issue || null,
        content: record.content
      })
      .returning();

    await db.insert(embeddingsTable).values({
      resourceId: res.id,
      content: record.content,
      embedding: embedded.embedding
    });
    insertedCount++;
  }

  await closeDb();
  console.log(`🎉 Successfully seeded ${insertedCount} Warranty SOP records into database!`);
}

migrateAndSeed().catch((err) => {
  console.error("❌ Migration/Seed failed:", err);
  process.exit(1);
});
