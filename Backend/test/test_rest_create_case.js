import dotenv from "dotenv";
dotenv.config();

import { ProxyAgent, setGlobalDispatcher } from "undici";
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || "http://127.0.0.1:7890";
setGlobalDispatcher(new ProxyAgent(proxy));

import { buildOAuthHeader, runSuiteQL } from "../src/erp/netsuite.js";

async function testNativeRestCreateCase() {
  const accountId = process.env.NETSUITE_ACCOUNT_ID;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET;
  const tokenId = process.env.NETSUITE_TOKEN_ID;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET;

  const url = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/supportCase`;

  const payload = {
    customForm: { id: process.env.NETSUITE_CASE_FORM_ID || "1" },
    company: { id: process.env.NETSUITE_DEFAULT_CUSTOMER_ID || "1" },
    title: "测试售后工单 - SuiteTalk REST API Test",
    email: "test@example.com",
    phone: "0412345678",
    incomingMessage: "这是一条通过原生 SuiteTalk REST API 创建的测试 Support Case。",
    item: { id: "1001" },
    custevent_case_evidence_link: "https://example.com/test-evidence.jpg"
  };

  const authHeader = buildOAuthHeader({
    method: "POST",
    url,
    realm: accountId,
    consumerKey,
    consumerSecret,
    tokenId,
    tokenSecret
  });

  console.log("Posting to:", url);
  console.log("Payload:", JSON.stringify(payload, null, 2));

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    console.log("HTTP Status:", res.status);
    console.log("Location header:", res.headers.get("location"));
    const text = await res.text();
    console.log("Response text:", text);

    if (res.status === 201 || res.ok) {
      const location = res.headers.get("location") || "";
      const internalId = location.split("/").filter(Boolean).pop();
      console.log("Created internalId:", internalId);
      if (internalId) {
        const rows = await runSuiteQL(`SELECT casenumber, title FROM supportCase WHERE id = ${internalId}`, 1);
        console.log("SuiteQL lookup result:", JSON.stringify(rows));
      }
    }
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testNativeRestCreateCase();
