import { handleRequest } from "./api/router.js";

/**
 * AWS Lambda Function Handler for API Gateway
 */
export async function handler(event, context) {
  // Support both API Gateway HTTP API (payload v2) and REST API (payload v1)
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path = event.rawPath || event.path || "/";
  const headers = event.headers || {};
  const query = event.queryStringParameters || {};
  
  let body = event.body;
  if (event.isBase64Encoded && body) {
    body = Buffer.from(body, "base64").toString("utf-8");
  }

  const response = await handleRequest(method, path, headers, body, query);

  if (response.webResponse) {
    const streamBody = await response.webResponse.text();
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: streamBody
    };
  }

  return {
    statusCode: response.statusCode,
    headers: response.headers,
    body: response.body
  };
}
