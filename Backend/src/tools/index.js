import { tool } from "ai";
import { z } from "zod";
import * as getProductInfo from "./getProductInfo.js";
import * as startWarranty from "./startWarranty.js";
import * as checkOrder from "./checkOrder.js";
import * as getInformation from "./getInformation.js";

const toolModules = {
  getInformation,
  get_product_info: getProductInfo,
  start_warranty_claim: startWarranty,
  check_order_status: checkOrder,
  check_case_status: {
    schema: startWarranty.checkCaseStatusSchema,
    execute: startWarranty.checkCaseStatus
  }
};

/**
 * Execute a tool by name with arguments (used by unit tests)
 */
export async function executeTool(name, input) {
  const mod = toolModules[name];
  if (!mod || typeof mod.execute !== "function") {
    throw new Error(`Tool '${name}' not found.`);
  }
  return await mod.execute(input);
}

/**
 * Build Vercel AI SDK tools (参考 ai-sdk-preview-rag-study 的 tool() + Zod inputSchema 模式)
 * @param {{ caseRef: string, conversationMessages: Array }} ctx
 */
export function createAiSdkTools({ caseRef, conversationMessages }) {
  return {
    getInformation: tool({
      description: getInformation.schema.description,
      inputSchema: z.object({
        question: z.string().describe("the users question or product fault"),
        similarQuestions: z
          .array(z.string())
          .describe("2 to 3 related keywords or similar questions (bilingual EN/ZH) to search in the warranty SOP knowledge base")
      }),
      execute: async ({ question, similarQuestions }) =>
        getInformation.execute({ question, similarQuestions })
    }),

    get_product_info: tool({
      description: getProductInfo.schema.description,
      inputSchema: z.object({
        query: z.string().describe("Product code or SKU (e.g. SKU-1001, SKU-2002)")
      }),
      execute: async ({ query }) => getProductInfo.execute({ query })
    }),

    check_order_status: tool({
      description: checkOrder.schema.description,
      inputSchema: z.object({
        order_number: z.string().describe("The customer order or sales order number (e.g. SO-10001, PO-9876)"),
        account_id: z.string().optional().describe("Trade account ID or business name (optional)")
      }),
      execute: async (args) => checkOrder.execute(args)
    }),

    check_case_status: tool({
      description: startWarranty.checkCaseStatusSchema.description,
      inputSchema: z.object({
        case_no: z.string().describe("Case number (e.g. CASE0000022 or CASE22)"),
        email: z.string().describe("Customer email the case was logged under")
      }),
      execute: async (args) => startWarranty.checkCaseStatus(args)
    }),

    start_warranty_claim: tool({
      description: startWarranty.schema.description,
      inputSchema: z.object({
        action: z.enum(["create", "check_status"]).optional().describe("Whether to create a new case or check an existing case status (defaults to create)"),
        case_reason: z.enum(["repair_required", "unconfirmed_inquiry", "warranty_claim", "transit_damage", "other"]).optional().describe("Reason for logging the case"),
        title: z.string().optional().describe("Brief summary/title for the case"),
        customer_name: z.string().optional().describe("Customer full name or contact person"),
        email: z.string().optional().describe("Customer email address. STRICT REQUIREMENT: Must be directly provided/typed by the customer in chat messages."),
        phone: z.string().optional().describe("Customer contact phone number"),
        product_code: z.string().optional().describe("Product code or SKU under warranty"),
        issue_description: z.string().optional().describe("Detailed description of the defect, questions, symptoms, or repair request"),
        evidence_link: z.string().optional().describe("URL link to photos, videos, or proof of purchase uploaded by the customer"),
        case_no: z.string().optional().describe("Existing NetSuite case number when checking status (e.g. CASE0000022)")
      }),
      execute: async (args) =>
        startWarranty.execute({
          ...args,
          caseRef,
          conversationMessages
        })
    })
  };
}
