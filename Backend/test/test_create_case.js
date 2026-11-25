import dotenv from "dotenv";
dotenv.config();

import { buildOAuthHeader } from "../src/erp/netsuite.js";

async function testCreateCase(scriptId, deployId) {
  const accountId = process.env.NETSUITE_ACCOUNT_ID;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET;
  const tokenId = process.env.NETSUITE_TOKEN_ID;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET;

  if (!accountId || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
    console.error("❌ NetSuite 凭证未在 .env 中完整配置");
    return;
  }

  const targetScript = scriptId || process.env.NETSUITE_CASE_SCRIPT_ID;
  const targetDeploy = deployId || process.env.NETSUITE_CASE_DEPLOY_ID || "1";

  if (!targetScript) {
    console.log("⚠️ 请传入 Script ID，使用方式: node test/test_create_case.js <script_id> [deploy_id]");
    console.log("例如: node test/test_create_case.js customscript_case_create 1");
    return;
  }

  const baseUrl = `https://${accountId}.restlets.api.netsuite.com/app/site/hosting/restlet.nl`;
  const queryParams = {
    script: targetScript,
    deploy: targetDeploy
  };

  // 示例测试数据（按实际 NetSuite 环境修改）
  const payload = {
    company: Number(process.env.NETSUITE_DEFAULT_CUSTOMER_ID || 1),
    title: "测试售后工单 - Automated Test",
    email: "test@example.com",
    phone: "0412345678",
    message: "这是一条自动化测试创建的 Support Case，用于验证表单与字段映射。",
    item: 1001,
    evidenceLink: "https://example.com/test-evidence.jpg"
  };

  const authHeader = buildOAuthHeader({
    method: "POST",
    url: baseUrl,
    queryParams,
    realm: accountId,
    consumerKey,
    consumerSecret,
    tokenId,
    tokenSecret
  });

  const queryString = Object.entries(queryParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const requestUrl = `${baseUrl}?${queryString}`;

  console.log(`\n🚀 正在向 NetSuite RESTlet 发送创建工单请求...`);
  console.log(`URL: ${requestUrl}`);
  console.log("Payload:", JSON.stringify(payload, null, 2));

  try {
    const res = await fetch(requestUrl, {
      method: "POST",
      headers: {
        "Authorization": authHeader,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const rawText = await res.text();
    console.log(`\nHTTP 响应状态码: ${res.status}`);
    console.log("响应结果 (Raw Text):", rawText);

    try {
      const parsed = JSON.parse(rawText);
      if (parsed.success) {
        console.log(`\n✅ 工单创建成功！`);
        console.log(`Internal ID: ${parsed.internalId}`);
        console.log(`Case Number: ${parsed.caseNumber}`);
      } else {
        console.log(`\n❌ 工单创建失败，NetSuite 返回错误:`, parsed.error);
      }
    } catch {
      // 非 JSON 格式
    }
  } catch (err) {
    console.error("请求失败:", err.message);
  }
}

const scriptId = process.argv[2];
const deployId = process.argv[3];
testCreateCase(scriptId, deployId);
