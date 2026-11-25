import dotenv from "dotenv";
dotenv.config();

import assert from "assert";
import { executeTool } from "../src/erp/tools/index.js";
import { handleRequest } from "../src/api/router.js";
import { listNetSuiteMcpTools, probeNetSuite } from "../src/erp/netsuite.js";

async function runTests() {
  console.log("=== Testing NewBackend (netsuite-mcp Base + Upper Business Layer) ===\n");

  // Test 0: Verify netsuite-mcp base layer tools are all mounted and probe succeeds
  console.log("Test 0: Verifying netsuite-mcp base layer tools & probe...");
  const mountedTools = listNetSuiteMcpTools();
  console.log("Mounted netsuite-mcp tools:", mountedTools);
  assert.strictEqual(mountedTools.length, 5);
  assert(mountedTools.includes("netsuite_probe"));
  assert(mountedTools.includes("netsuite_suiteql"));
  assert(mountedTools.includes("netsuite_get_record"));
  assert(mountedTools.includes("netsuite_create_record"));
  assert(mountedTools.includes("netsuite_update_record"));
  const probeRes = await probeNetSuite({ tokenRole: "write", recordType: "supportCase" });
  console.log("Probe Result:", probeRes);
  assert.strictEqual(probeRes.ok, true);
  assert.strictEqual(probeRes.status, 200);
  console.log("✔ netsuite-mcp base layer verification passed.\n");

  // Test 1: get_product_info with real NetSuite SKU (109.795.00.1) via SuiteQL
  console.log("Test 1: get_product_info with live NetSuite SKU '109.795.00.1' via SuiteQL...");
  const nsRes = await executeTool("get_product_info", { query: "109.795.00.1" });
  console.log("Result 1:", nsRes);
  assert.strictEqual(nsRes.exists, true);
  assert.strictEqual(nsRes.sku, "109.795.00.1");
  assert.strictEqual(nsRes.name, "Sigma8 Concealed Cistern BTW Front Flush 4 Stars");
  assert.strictEqual(nsRes.brand, "IA");
  assert.strictEqual(nsRes.class_category, "Toilets — Inwall Cisterns & Plates");
  assert.strictEqual(nsRes.rrp, "$534");
  assert(nsRes.availability.includes("NSW: in stock"));
  console.log("✔ NetSuite SuiteQL SKU verification passed.");

  // Test 2: get_product_info with second SKU (IAWFPRLVA)
  console.log("\nTest 2: get_product_info with second SKU 'IAWFPRLVA'...");
  const iawfRes = await executeTool("get_product_info", { query: "IAWFPRLVA" });
  console.log("Result 2:", iawfRes);
  assert.strictEqual(iawfRes.exists, true);
  assert.strictEqual(iawfRes.sku, "IAWFPRLVA");
  assert.strictEqual(iawfRes.rrp, "$550");
  assert.strictEqual(iawfRes.status, "Inactive");
  console.log("✔ Second SKU verification passed.");

  // Test 3: get_product_info with non-existent SKU
  console.log("\nTest 3: get_product_info with non-existent SKU 'NON_EXISTENT_999'...");
  const notFoundRes = await executeTool("get_product_info", { query: "NON_EXISTENT_999" });
  console.log("Result 3:", notFoundRes);
  assert.strictEqual(notFoundRes.exists, false);
  assert(notFoundRes.error.includes("未找到产品"));
  console.log("✔ Non-existent SKU correctly identified as not found.");

  // Test 4: start_warranty_claim (Creates live NetSuite Support Case)
  console.log("\nTest 4: start_warranty_claim with live NetSuite case creation...");
  const claimRes = await executeTool("start_warranty_claim", {
    case_reason: "repair_required",
    customer_name: "Alice Smith",
    phone: "0412345678",
    email: "test@example.com",
    product_code: "109.795.00.1",
    issue_description: "Cracked toilet seat on arrival, technician inspection or replacement required"
  });
  console.log("Result 4:", claimRes);
  assert.strictEqual(claimRes.success, true);
  assert(typeof claimRes.case_number === "string" && claimRes.case_number.startsWith("CASE"));
  console.log(`✔ Live NetSuite Support Case creation passed: ${claimRes.case_number} (Internal ID: ${claimRes.internal_id})`);

  // Test 5: check_order_status with sample NetSuite order via SuiteQL
  const testOrderNo = process.env.TEST_ORDER_NO || "SO-10001";
  console.log(`\nTest 5: check_order_status with NetSuite order '${testOrderNo}'...`);
  const orderRes = await executeTool("check_order_status", { order_number: testOrderNo });
  console.log("Result 5:", JSON.stringify(orderRes, null, 2));
  assert.strictEqual(orderRes.order_no, testOrderNo);
  console.log("✔ NetSuite SuiteQL order status and fulfillment verification passed.");

  // Test 5b: check_case_status with sample NetSuite supportCase via SuiteQL
  const testCaseNo = process.env.TEST_CASE_NO || "CASE0000001";
  const testEmail = process.env.TEST_CASE_EMAIL || "customer@example.com";
  console.log(`\nTest 5b: check_case_status with NetSuite case '${testCaseNo}'...`);
  const caseRes = await executeTool("check_case_status", {
    case_no: testCaseNo,
    email: testEmail
  });
  console.log("Result 5b:", JSON.stringify(caseRes, null, 2));
  assert.strictEqual(caseRes.case_no, testCaseNo);
  assert(Array.isArray(caseRes.outstanding_items));
  console.log("✔ NetSuite SuiteQL case status verification passed.");

  // Test 5c: start_warranty_claim with case lookup mode
  console.log("\nTest 5c: start_warranty_claim case lookup...");
  const caseLookupRes = await executeTool("start_warranty_claim", {
    case_no: testCaseNo,
    email: testEmail
  });
  assert.strictEqual(caseLookupRes.case_no, testCaseNo);
  console.log("✔ start_warranty_claim case lookup mode passed.");

  // Test 6: Router GET /health
  console.log("\nTest 6: Router GET /health...");
  const healthRes = await handleRequest("GET", "/health", {}, null);
  assert.strictEqual(healthRes.statusCode, 200);
  const healthBody = JSON.parse(healthRes.body);
  assert.strictEqual(healthBody.status, "healthy");
  console.log("✔ Health route passed.");

  // Test 7: Router POST /upload-url (Local dev mock)
  console.log("\nTest 7: Router POST /upload-url...");
  const uploadRes = await handleRequest("POST", "/upload-url", {}, {
    caseRef: "WEBTEST123",
    filename: "damage.jpg",
    contentType: "image/jpeg"
  });
  assert.strictEqual(uploadRes.statusCode, 200);
  const uploadBody = JSON.parse(uploadRes.body);
  assert(uploadBody.uploadUrl.length > 0);
  assert(uploadBody.key.includes("WEBTEST123"));
  assert.strictEqual(uploadBody.s3Key, uploadBody.key);
  assert(uploadBody.fileUrl.length > 0);
  console.log("✔ Upload URL generation passed with s3Key and fileUrl.");

  // Test 7c: Router /api/ prefix alias
  console.log("\nTest 7c: Router POST /api/upload-url alias...");
  const apiUploadRes = await handleRequest("POST", "/api/upload-url", {}, {
    filename: "test.png",
    contentType: "image/png"
  });
  assert.strictEqual(apiUploadRes.statusCode, 200);
  const apiUploadBody = JSON.parse(apiUploadRes.body);
  assert(apiUploadBody.uploadUrl.length > 0);
  assert(apiUploadBody.fileUrl.length > 0);
  console.log("✔ /api/ route alias passed.");

  // Test 8: Router POST /chat initial turn (empty messages)
  console.log("\nTest 8: Router POST /chat initial greeting turn...");
  const chatRes = await handleRequest("POST", "/chat", {}, { messages: [] });
  assert.strictEqual(chatRes.statusCode, 200);
  const chatBody = JSON.parse(chatRes.body);
  assert(chatBody.reply.includes("Hi, I'm Nova"));
  console.log("✔ Chat bootstrap greeting turn passed.");

  console.log("\n🎉 ALL UNIT & INTEGRATION TESTS PASSED SUCCESSFULLY!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
