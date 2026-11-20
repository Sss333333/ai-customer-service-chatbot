import dotenv from "dotenv";
dotenv.config();

import crypto from "crypto";

function rfc5849Encode(str) {
  return encodeURIComponent(String(str))
    .replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function buildOAuthHeader({
  method,
  url,
  queryParams = {},
  realm,
  consumerKey,
  consumerSecret,
  tokenId,
  tokenSecret,
  useSpaces = true
}) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_token: tokenId,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_version: "1.0"
  };

  const allParams = { ...queryParams, ...oauthParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramPairs = [];
  for (const key of sortedKeys) {
    paramPairs.push(`${rfc5849Encode(key)}=${rfc5849Encode(allParams[key])}`);
  }
  const normalizedParamString = paramPairs.join("&");

  const signatureBaseString = [
    method.toUpperCase(),
    rfc5849Encode(url),
    rfc5849Encode(normalizedParamString)
  ].join("&");

  const signingKey = `${rfc5849Encode(consumerSecret)}&${rfc5849Encode(tokenSecret)}`;
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(signatureBaseString)
    .digest("base64");

  const headerParts = [
    `realm="${rfc5849Encode(realm)}"`,
    `oauth_consumer_key="${rfc5849Encode(oauthParams.oauth_consumer_key)}"`,
    `oauth_token="${rfc5849Encode(oauthParams.oauth_token)}"`,
    `oauth_signature_method="${rfc5849Encode(oauthParams.oauth_signature_method)}"`,
    `oauth_timestamp="${rfc5849Encode(oauthParams.oauth_timestamp)}"`,
    `oauth_nonce="${rfc5849Encode(oauthParams.oauth_nonce)}"`,
    `oauth_version="${rfc5849Encode(oauthParams.oauth_version)}"`,
    `oauth_signature="${rfc5849Encode(signature)}"`
  ];

  const delimiter = useSpaces ? ", " : ",";
  return `OAuth ${headerParts.join(delimiter)}`;
}

async function runTests() {
  const accountId = process.env.NETSUITE_ACCOUNT_ID;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET;
  const tokenId = process.env.NETSUITE_TOKEN_ID;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET;

  if (!accountId || !consumerKey || !consumerSecret || !tokenId || !tokenSecret) {
    console.error("Missing NetSuite credentials in .env");
    return;
  }

  console.log("=== Step 1: Testing RESTlet with Token ===");
  const restletUrl = `https://${accountId}.restlets.api.netsuite.com/app/site/hosting/restlet.nl`;
  const restletParams = {
    script: process.env.NETSUITE_STOCK_SCRIPT_ID || "1",
    deploy: process.env.NETSUITE_STOCK_DEPLOY_ID || "1",
    sku: process.env.TEST_SKU || "SKU-1001",
    postcode: process.env.NETSUITE_DEFAULT_POSTCODE || "2000"
  };
  const restletAuth = buildOAuthHeader({
    method: "GET",
    url: restletUrl,
    queryParams: restletParams,
    realm: accountId,
    consumerKey,
    consumerSecret,
    tokenId,
    tokenSecret
  });
  const restletFullUrl = `${restletUrl}?${Object.entries(restletParams).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
  
  const rlRes = await fetch(restletFullUrl, {
    method: "GET",
    headers: { "Authorization": restletAuth }
  });
  console.log("RESTlet Status:", rlRes.status);
  console.log("RESTlet Response:", await rlRes.text());

  console.log("\n=== Step 2: Testing SuiteQL Endpoint with New Token ===");
  const sqlQuery = `SELECT
  t.tranid                      AS so_number,
  tl.linesequencenumber         AS line_no,
  i.itemid                      AS sku,
  i.displayname                 AS product_name,
  ABS(tl.quantity)              AS qty,
  tl.rate                       AS unit_price,
  ABS(tl.foreignamount)         AS amount,
  BUILTIN.DF(tl.location)       AS location
FROM transaction t
JOIN transactionLine tl ON tl.transaction = t.id
LEFT JOIN item i        ON i.id = tl.item
WHERE t.type = 'SalesOrd'
  AND t.tranid = '${process.env.TEST_ORDER_NO || "SO-10001"}'
  AND tl.mainline = 'F'
  AND tl.taxline = 'F'
  AND tl.item IS NOT NULL
ORDER BY tl.linesequencenumber`;

  const suiteqlUrl = `https://${accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const suiteqlAuth = buildOAuthHeader({
    method: "POST",
    url: suiteqlUrl,
    queryParams: {},
    realm: accountId,
    consumerKey,
    consumerSecret,
    tokenId,
    tokenSecret
  });

  const sqlRes = await fetch(suiteqlUrl, {
    method: "POST",
    headers: {
      "Authorization": suiteqlAuth,
      "Content-Type": "application/json",
      "prefer": "transient"
    },
    body: JSON.stringify({ q: sqlQuery })
  });

  console.log("SuiteQL Status:", sqlRes.status);
  console.log("SuiteQL Response:", await sqlRes.text());
}

runTests();
