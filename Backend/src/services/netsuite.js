import { z } from "zod";
import { netsuiteRequest } from "../netsuite-mcp/netsuite-client.js";
import { register as registerSystem } from "../netsuite-mcp/tools/system.js";
import { register as registerQuery } from "../netsuite-mcp/tools/query.js";
import { register as registerRecords } from "../netsuite-mcp/tools/records.js";

// Re-export the low-level netsuite-mcp client for direct access if needed
export { netsuiteRequest };

/**
 * In-memory MCP Tool Registry that mounts all tools from `src/netsuite-mcp/tools/*`
 * so the upper business layer can invoke `netsuite-mcp` tools directly in-process
 * with full Zod schema validation and default injection.
 */
const mcpToolRegistry = new Map();

const inMemoryMcpServer = {
  registerTool(name, config, handler) {
    const zodSchema = config?.inputSchema ? z.object(config.inputSchema) : z.object({});
    mcpToolRegistry.set(name, {
      name,
      description: config?.description || "",
      schema: zodSchema,
      handler
    });
  }
};

// Mount all 3 tool modules from netsuite-mcp (5 tools total)
registerSystem(inMemoryMcpServer);
registerQuery(inMemoryMcpServer);
registerRecords(inMemoryMcpServer);

/**
 * Bridges legacy AIChatBot env vars (NETSUITE_TOKEN_ID / NETSUITE_TOKEN_SECRET)
 * into netsuite-mcp's role-separated env vars (NETSUITE_TBA_TOKEN_ID_READ/WRITE)
 * if they are not already explicitly set.
 */
export function ensureNetSuiteMcpEnv() {
  const legacyTokenId = process.env.NETSUITE_TOKEN_ID;
  const legacyTokenSecret = process.env.NETSUITE_TOKEN_SECRET;

  if (legacyTokenId) {
    if (!process.env.NETSUITE_TBA_TOKEN_ID_READ) {
      process.env.NETSUITE_TBA_TOKEN_ID_READ = legacyTokenId;
    }
    if (!process.env.NETSUITE_TBA_TOKEN_ID_WRITE) {
      process.env.NETSUITE_TBA_TOKEN_ID_WRITE = legacyTokenId;
    }
  }

  if (legacyTokenSecret) {
    if (!process.env.NETSUITE_TBA_TOKEN_SECRET_READ) {
      process.env.NETSUITE_TBA_TOKEN_SECRET_READ = legacyTokenSecret;
    }
    if (!process.env.NETSUITE_TBA_TOKEN_SECRET_WRITE) {
      process.env.NETSUITE_TBA_TOKEN_SECRET_WRITE = legacyTokenSecret;
    }
  }

  // Ensure timeout stays within AIChatBot's chat deadline budget unless overridden
  if (!process.env.NETSUITE_REQUEST_TIMEOUT_MS) {
    process.env.NETSUITE_REQUEST_TIMEOUT_MS = "10000";
  }
}

/**
 * Lists all registered netsuite-mcp tools mounted in the base layer.
 */
export function listNetSuiteMcpTools() {
  return Array.from(mcpToolRegistry.keys());
}

/**
 * Lightweight concurrency queue + 429 retry wrapper to prevent NetSuite
 * CONCURRENCY_LIMIT_EXCEEDED (HTTP 429) when upper-layer tools use Promise.all().
 */
const MAX_CONCURRENT_REQUESTS = 2;
let activeRequests = 0;
const requestQueue = [];

function acquireSlot() {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return Promise.resolve();
  }
  return new Promise(resolve => requestQueue.push(resolve));
}

function releaseSlot() {
  if (requestQueue.length > 0) {
    const next = requestQueue.shift();
    next();
  } else {
    activeRequests--;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Invokes any registered tool from the `netsuite-mcp` base layer in-process,
 * with automatic concurrency throttling and HTTP 429 retry.
 *
 * @param {string} toolName - One of:
 *   - "netsuite_probe"
 *   - "netsuite_suiteql"
 *   - "netsuite_get_record"
 *   - "netsuite_create_record"
 *   - "netsuite_update_record"
 * @param {object} [args={}] - Tool arguments validated by netsuite-mcp's Zod schema
 * @returns {Promise<object>} Parsed JSON result returned by the netsuite-mcp tool
 */
export async function callNetSuiteMcpTool(toolName, args = {}) {
  ensureNetSuiteMcpEnv();

  const tool = mcpToolRegistry.get(toolName);
  if (!tool) {
    throw new Error(`Unknown netsuite-mcp tool: ${toolName}`);
  }

  const parsedArgs = tool.schema.parse(args);
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireSlot();
    let parsedResult;
    try {
      const mcpResponse = await tool.handler(parsedArgs);
      const rawText = mcpResponse?.content?.[0]?.text;
      parsedResult = rawText ? JSON.parse(rawText) : { ok: !mcpResponse?.isError };
    } finally {
      releaseSlot();
    }

    if (parsedResult.status === 429 && attempt < maxRetries) {
      const backoffMs = 500 * Math.pow(2, attempt);
      await sleep(backoffMs);
      continue;
    }

    return parsedResult;
  }
}

/**
 * Upper-layer wrapper: Executes a read-only SuiteQL SELECT query via `netsuite-mcp` (`netsuite_suiteql` tool).
 *
 * @param {string} sql - The SuiteQL SQL query string
 * @param {number} [limit=100] - Max results to return (1..1000)
 * @param {number} [offset=0] - Pagination offset
 * @returns {Promise<Array<object>>} - Array of record rows
 */
export async function runSuiteQL(sql, limit = 100, offset = 0) {
  const cleanSql = String(sql || "").trim();
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const safeOffset = Math.max(Number(offset) || 0, 0);

  const result = await callNetSuiteMcpTool("netsuite_suiteql", {
    query: cleanSql,
    limit: safeLimit,
    offset: safeOffset,
    tokenRole: "read"
  });

  if (!result.ok) {
    const detail = result.error || (result.body ? JSON.stringify(result.body) : result.statusText);
    throw new Error(`SuiteQL HTTP ${result.status}: ${detail}`);
  }

  return result.body?.items || [];
}

/**
 * Upper-layer wrapper: Creates a Support Case in NetSuite via `netsuite-mcp` (`netsuite_create_record` tool)
 * and resolves the human-readable `casenumber` via `netsuite_suiteql`.
 *
 * @param {object} caseData
 * @param {number|string} [caseData.company] - NetSuite Customer internal ID (defaults to NETSUITE_DEFAULT_CUSTOMER_ID or 13)
 * @param {string} caseData.title - Case title / subject
 * @param {string} [caseData.email] - Customer email
 * @param {string} [caseData.phone] - Customer phone
 * @param {string} [caseData.message] - Detailed case message
 * @param {number|string} [caseData.item] - NetSuite Item internal ID
 * @param {string} [caseData.evidenceLink] - Link to photos / videos
 * @returns {Promise<{ success: boolean, internalId?: string, caseNumber?: string, error?: string }>}
 */
export async function createNetSuiteCase({
  company,
  title,
  email,
  phone,
  message,
  item,
  evidenceLink
}) {
  const defaultCustomer = process.env.NETSUITE_DEFAULT_CUSTOMER_ID || "13";
  const cleanCompany = company ? Number(company) : Number(defaultCustomer);
  const cleanTitle = String(title || "Customer Inquiry / Warranty Case").trim();

  // Standard NetSuite supportCase REST payload
  const payload = {
    customForm: { id: process.env.NETSUITE_CASE_FORM_ID || "1" }, // Support Case Custom Form ID
    company: { id: String(cleanCompany) },
    title: cleanTitle
  };

  if (email) payload.email = String(email).trim();
  if (phone) payload.phone = String(phone).trim();
  if (message) payload.incomingMessage = String(message).trim();
  if (item) payload.item = { id: String(item) };
  if (evidenceLink) payload.custevent_case_evidence_link = String(evidenceLink).trim();

  try {
    const createResult = await callNetSuiteMcpTool("netsuite_create_record", {
      recordType: "supportCase",
      body: payload,
      dryRun: false,
      tokenRole: "write"
    });

    if (!createResult.ok) {
      const detail = createResult.error || (createResult.body ? JSON.stringify(createResult.body) : createResult.statusText);
      return {
        success: false,
        error: `NetSuite REST API returned status ${createResult.status}: ${detail}`
      };
    }

    const internalId = createResult.newId;
    if (!internalId) {
      return {
        success: false,
        error: "Support case created, but internalId could not be extracted from Location header."
      };
    }

    // Retrieve official caseNumber (e.g. CASE0000041) via netsuite_suiteql
    let caseNumber = `CASE${internalId}`;
    try {
      const rows = await runSuiteQL(`SELECT casenumber FROM supportCase WHERE id = ${internalId}`, 1);
      if (rows && rows.length > 0 && rows[0].casenumber) {
        caseNumber = rows[0].casenumber;
      }
    } catch (sqlErr) {
      console.warn(`[createNetSuiteCase] Failed to resolve caseNumber for ID ${internalId}:`, sqlErr.message);
    }

    return {
      success: true,
      internalId: String(internalId),
      caseNumber: String(caseNumber)
    };
  } catch (err) {
    console.error("[createNetSuiteCase] Error creating support case via netsuite-mcp:", err.message);
    return {
      success: false,
      error: err.message
    };
  }
}

/**
 * Upper-layer wrapper around `netsuite_get_record` from `netsuite-mcp`.
 */
export async function getNetSuiteRecord(recordType, id, options = {}) {
  return callNetSuiteMcpTool("netsuite_get_record", {
    recordType,
    id: String(id),
    subPath: options.subPath,
    expandSubResources: options.expandSubResources,
    tokenRole: options.tokenRole || "read"
  });
}

/**
 * Upper-layer wrapper around `netsuite_update_record` from `netsuite-mcp`.
 */
export async function updateNetSuiteRecord(recordType, id, body, { dryRun = false, tokenRole = "write" } = {}) {
  return callNetSuiteMcpTool("netsuite_update_record", {
    recordType,
    id: String(id),
    body,
    dryRun,
    tokenRole
  });
}

/**
 * Upper-layer wrapper around `netsuite_probe` from `netsuite-mcp`.
 */
export async function probeNetSuite({ tokenRole = "write", recordType = "customer" } = {}) {
  return callNetSuiteMcpTool("netsuite_probe", { tokenRole, recordType });
}
