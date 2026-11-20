import { runSuiteQL, createNetSuiteCase } from "../services/netsuite.js";

/**
 * Resolves customer internal ID from NetSuite by email, or falls back to default customer ID (13)
 */
async function resolveCustomerId(email) {
  const defaultId = Number(process.env.NETSUITE_DEFAULT_CUSTOMER_ID || 13);
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (!cleanEmail || !/^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(cleanEmail)) {
    return defaultId;
  }

  try {
    const sql = `SELECT id FROM customer WHERE LOWER(email) = '${cleanEmail.replace(/'/g, "''")}' AND isinactive = 'F'`;
    const rows = await runSuiteQL(sql, 1);
    if (rows && rows.length > 0 && rows[0].id) {
      return Number(rows[0].id);
    }
  } catch (err) {
    console.warn(`[resolveCustomerId] Lookup failed for ${cleanEmail}:`, err.message);
  }
  return defaultId;
}

/**
 * Resolves item internal ID from NetSuite by SKU / product_code
 */
async function resolveItemId(productCode) {
  const cleanSku = String(productCode || "").trim().toUpperCase();
  if (!cleanSku) return null;

  try {
    const sql = `SELECT id FROM item WHERE UPPER(itemid) = '${cleanSku.replace(/'/g, "''")}' AND isinactive = 'F'`;
    const rows = await runSuiteQL(sql, 1);
    if (rows && rows.length > 0 && rows[0].id) {
      return Number(rows[0].id);
    }
  } catch (err) {
    console.warn(`[resolveItemId] Lookup failed for SKU ${cleanSku}:`, err.message);
  }
  return null;
}

const _cache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60s cache

const CASE_SQL = `
SELECT
  c.casenumber, c.title,
  BUILTIN.DF(c.status) AS status,
  c.startdate AS opened, c.lastmodifieddate AS last_updated,
  BUILTIN.DF(c.item) AS sku,
  (SELECT COUNT(*) FROM supportCaseMediaItemMap m WHERE m.supportcase = c.id) AS attached_files,
  (SELECT COUNT(*) FROM message ms WHERE ms.activity = c.id
      AND ms.incoming = 'T' AND ms.hasattachment = 'T') AS emails_with_attachment
FROM supportCase c
WHERE (c.casenumber = '{case_no}' OR c.casenumber = '{normalized}')
  AND LOWER(c.email) = LOWER('{email}')
  AND c.isinactive = 'F'
`;

function getOutstanding(row) {
  const attached = parseInt(row.attached_files || 0, 10);
  const emailsWithAtt = parseInt(row.emails_with_attachment || 0, 10);
  if (attached === 0 && emailsWithAtt === 0) {
    return ["Photo of the damaged item", "Proof of purchase"];
  }
  return [];
}

/**
 * Check existing warranty case status from NetSuite supportCase via SuiteQL
 * Requires both case number and customer email for security.
 */
export async function checkCaseStatus({ case_no, case_id, case_reference, email }) {
  const rawCase = String(case_no || case_id || case_reference || "").trim().toUpperCase();
  const cleanEmail = String(email || "").trim().toLowerCase();

  if (!rawCase || !/^CASE\d{1,10}$/i.test(rawCase)) {
    return { error: "Invalid case number format. Please provide a valid case number (e.g. CASE0000022)." };
  }

  if (!cleanEmail || !/^[a-z0-9._%+\-']+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(cleanEmail)) {
    return { error: "Please provide the email address the warranty case was logged under for verification." };
  }

  // Normalize CASE22 -> CASE0000022
  const match = rawCase.match(/^CASE(\d+)$/i);
  const normalized = match ? `CASE${match[1].padStart(7, "0")}` : rawCase;

  const cacheKey = `${normalized}:${cleanEmail}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }

  const sql = CASE_SQL
    .replace("{case_no}", rawCase)
    .replace("{normalized}", normalized)
    .replace("{email}", cleanEmail.replace(/'/g, "''"));

  let rows;
  try {
    rows = await runSuiteQL(sql, 1);
  } catch (err) {
    console.error(`[checkCaseStatus] SuiteQL error for case ${rawCase}:`, err.message);
    return { error: "NetSuite 暂时无法访问" };
  }

  if (!rows || rows.length === 0) {
    return { error: "No case found matching both the case number and email." };
  }

  const r = rows[0];
  const result = {
    case_no: r.casenumber,
    issue: r.title,
    status: r.status,
    opened: r.opened,
    as_of: r.last_updated,
    sku: r.sku || null,
    outstanding_items: getOutstanding(r),
    followup_recorded: false
  };

  _cache.set(cacheKey, { data: result, ts: Date.now() });
  return result;
}

/**
 * Dedicated Schema: check_case_status
 */
export const checkCaseStatusSchema = {
  name: "check_case_status",
  description: "Check the status of an existing warranty or claim case from NetSuite ERP. Requires BOTH the case number (e.g. CASE0000022) and the email the case was logged under.",
  input_schema: {
    type: "object",
    properties: {
      case_no: {
        type: "string",
        description: "Case number (e.g. CASE0000022 or CASE22)"
      },
      email: {
        type: "string",
        description: "Customer email the case was logged under"
      }
    },
    required: ["case_no", "email"]
  }
};

/**
 * Primary Tool Definition Schema: start_warranty_claim
 */
export const schema = {
  name: "start_warranty_claim",
  description: "Create or register a Support Case in NetSuite ERP when: 1) product fault requires repair, parts replacement, or technician service; 2) customer inquiry/fault cannot be confirmed by AI or requires specialist investigation; 3) formal warranty or transit damage claim. Alternatively, check status of an existing case with case_no and email. IMPORTANT: When creating a case, customer email MUST be directly provided by the customer in the chat, NEVER extracted from uploaded photos/invoices.",
  input_schema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "check_status"],
        description: "Whether to create a new case or check an existing case status (defaults to create)"
      },
      case_reason: {
        type: "string",
        enum: ["repair_required", "unconfirmed_inquiry", "warranty_claim", "transit_damage", "other"],
        description: "Reason for logging the case: repair_required (needs repair/technician), unconfirmed_inquiry (AI cannot confirm issue or needs specialist), warranty_claim, transit_damage, or other."
      },
      title: {
        type: "string",
        description: "Brief summary/title for the case (e.g. 'Toilet leaking - technician repair required')"
      },
      customer_name: {
        type: "string",
        description: "Customer full name or contact person"
      },
      email: {
        type: "string",
        description: "Customer email address. STRICT REQUIREMENT: Must be directly provided/typed by the customer in chat messages. NEVER extract or use an email found inside uploaded pictures or invoices."
      },
      phone: {
        type: "string",
        description: "Customer contact phone number"
      },
      product_code: {
        type: "string",
        description: "Product code or SKU under warranty (e.g. SKU-1001, SKU-2002)"
      },
      issue_description: {
        type: "string",
        description: "Detailed description of the defect, questions, symptoms, or repair request"
      },
      evidence_link: {
        type: "string",
        description: "URL link to photos, videos, or proof of purchase uploaded by the customer"
      },
      case_no: {
        type: "string",
        description: "Existing NetSuite case number when checking status (e.g. CASE0000022)"
      }
    }
  }
};

/**
 * Tool Implementation: start_warranty_claim
 */
export async function execute(params = {}) {
  const {
    action,
    case_reason,
    title,
    case_no,
    case_id,
    case_reference,
    email,
    phone,
    customer_name,
    product_code,
    issue_description,
    evidence_link,
    evidenceLink,
    conversationMessages
  } = params;

  const targetCase = case_no || case_id || case_reference || "";

  // If action is explicitly "check_status", or if case number starts with "CASE", or if email + case provided
  const isCaseLookup =
    action === "check_status" ||
    (email && targetCase && String(targetCase).toUpperCase().startsWith("CASE")) ||
    (targetCase && String(targetCase).toUpperCase().startsWith("CASE") && !issue_description && !customer_name);

  if (isCaseLookup) {
    return await checkCaseStatus({ case_no: targetCase, email });
  }

  // Validate email provenance if creating a case: Email MUST be directly provided by the customer in chat
  if (!isCaseLookup) {
    const cleanEmail = String(email || "").trim().toLowerCase();
    if (!cleanEmail) {
      return {
        success: false,
        error: "Customer email is required to create a support case. Please ask the customer directly in the chat to provide their email address."
      };
    }

    if (Array.isArray(conversationMessages) && conversationMessages.length > 0) {
      const foundInUserChat = conversationMessages.some(msg => {
        if (msg.role !== "user") return false;
        if (Array.isArray(msg.parts)) {
          return msg.parts.some(part => {
            if (part.type === "text" && typeof part.text === "string") {
              if (part.text.startsWith("[The customer attached")) return false;
              return part.text.toLowerCase().includes(cleanEmail);
            }
            return false;
          });
        }
        if (typeof msg.content === "string") {
          return msg.content.toLowerCase().includes(cleanEmail);
        }
        if (Array.isArray(msg.content)) {
          return msg.content.some(block => {
            if (block.type === "text" && typeof block.text === "string") {
              if (block.text.startsWith("[The customer attached")) return false;
              return block.text.toLowerCase().includes(cleanEmail);
            }
            return false;
          });
        }
        return false;
      });

      if (!foundInUserChat) {
        console.warn(`[startWarranty] Blocked case creation: email '${email}' was NOT provided in customer chat messages.`);
        return {
          success: false,
          error: `CRITICAL VALIDATION ERROR: The email address '${email}' was not found in any message typed by the customer in this chat. Do NOT extract email addresses from uploaded photos, invoices, or receipts. You MUST ask the customer directly in the chat: "Could you please confirm your email address so we can create your support case?"`
        };
      }
    }
  }

  // Determine case title
  const cleanSku = String(product_code || "").trim();
  const reasonLabel = case_reason === "repair_required" ? "Repair Request" :
                      case_reason === "unconfirmed_inquiry" ? "Unconfirmed Inquiry" :
                      case_reason === "transit_damage" ? "Transit Damage" :
                      "Warranty Case";

  const caseTitle = title || `[${reasonLabel}] ${cleanSku ? cleanSku + " - " : ""}${customer_name || "Customer"}`;

  // Build comprehensive message
  const msgParts = [];
  if (customer_name) msgParts.push(`Customer: ${customer_name}`);
  if (phone) msgParts.push(`Phone: ${phone}`);
  if (email) msgParts.push(`Email: ${email}`);
  if (cleanSku) msgParts.push(`Product SKU: ${cleanSku}`);
  if (case_reason) msgParts.push(`Category / Reason: ${reasonLabel}`);
  msgParts.push(`\nDetails:\n${issue_description || "Customer reported an issue requiring assistance."}`);

  const fullMessage = msgParts.join("\n");
  
  const bucket = process.env.S3_BUCKET_NAME || "your-s3-bucket-name";
  const region = process.env.AWS_REGION || "ap-southeast-2";
  const caseRefId = case_reference || params.caseRef || "";

  let finalEvidence = evidence_link || evidenceLink || null;
  // If not explicitly provided, but caseRef exists, point to the S3 uploads directory for this case
  if (!finalEvidence && caseRefId) {
    finalEvidence = `https://${bucket}.s3.${region}.amazonaws.com/uploads/${caseRefId}/`;
  }

  // Resolve Customer & Item ID asynchronously
  const [companyId, itemId] = await Promise.all([
    resolveCustomerId(email),
    resolveItemId(cleanSku)
  ]);

  console.log(`[startWarranty] Creating NetSuite case: company=${companyId}, item=${itemId}, title="${caseTitle}"`);

  const createRes = await createNetSuiteCase({
    company: companyId,
    title: caseTitle,
    email: email || undefined,
    phone: phone || undefined,
    message: fullMessage,
    item: itemId || undefined,
    evidenceLink: finalEvidence || undefined
  });

  if (!createRes.success) {
    console.error(`[startWarranty] Failed to create NetSuite case:`, createRes.error);
    return {
      success: false,
      error: `Failed to create support case in NetSuite: ${createRes.error}`
    };
  }

  return {
    success: true,
    case_number: createRes.caseNumber,
    internal_id: createRes.internalId,
    customer_name: customer_name || "Valued Customer",
    status: "Logged in NetSuite",
    message: `Support case ${createRes.caseNumber} has been successfully logged. Our warranty and support team will review it within 1 business day.`
  };
}

