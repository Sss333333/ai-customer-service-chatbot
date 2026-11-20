import dotenv from "dotenv";
dotenv.config();

import { checkItemAvailability } from "../src/services/netsuite.js";

async function test() {
  console.log("=== Testing NetSuite RESTlet Integration ===");
  console.log("Account ID:", process.env.NETSUITE_ACCOUNT_ID);
  console.log("Script ID:", process.env.NETSUITE_STOCK_SCRIPT_ID);

  // Test 1: Real SKU from user's Postman (109.795.00.1, postcode 3358)
  console.log("\n[Test 1] Querying existing SKU '109.795.00.1' with postcode 3358...");
  try {
    const res1 = await checkItemAvailability("109.795.00.1", "3358");
    console.log("Result 1:", JSON.stringify(res1, null, 2));
    if (res1.exists) {
      console.log("✔ Test 1 PASSED: Product confirmed in NetSuite!");
    } else {
      console.error("❌ Test 1 FAILED: Product was not found or error returned.");
    }
  } catch (err) {
    console.error("❌ Test 1 Exception:", err.message);
  }

  // Test 2: Non-existent SKU
  console.log("\n[Test 2] Querying non-existent SKU 'NON_EXISTENT_SKU_12345'...");
  try {
    const res2 = await checkItemAvailability("NON_EXISTENT_SKU_12345", "2000");
    console.log("Result 2:", JSON.stringify(res2, null, 2));
    if (!res2.exists) {
      console.log("✔ Test 2 PASSED: Correctly identified as not found!");
    } else {
      console.error("❌ Test 2 FAILED: Expected false exists.");
    }
  } catch (err) {
    console.error("❌ Test 2 Exception:", err.message);
  }
}

test();
