import { createRequestHandler } from "@remix-run/cloudflare";
import * as build from "./build/server/index.js";

const requestHandler = createRequestHandler(build);

/* ── Phone capture API ── */
const SHOP_DOMAIN = "54cea3-73.myshopify.com";
const ALLOWED_ORIGINS = [
  "https://www.brkagro.com.br",
  "https://brkagro.com.br",
  "https://brk-agro.myshopify.com",
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function handlePhoneCapture(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(origin);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...headers, "Content-Type": "application/json" } });
  }

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers: { ...headers, "Content-Type": "application/json" } });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }

  const { customerId, phone } = body;
  if (!customerId || !phone) {
    return new Response(JSON.stringify({ error: "customerId and phone are required" }), { status: 400, headers: { ...headers, "Content-Type": "application/json" } });
  }

  const accessToken = env.SHOPIFY_ADMIN_TOKEN;
  if (!accessToken) {
    return new Response(JSON.stringify({ error: "No access token configured" }), { status: 500, headers: { ...headers, "Content-Type": "application/json" } });
  }

  const gqlResponse = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `mutation customerUpdate($input: CustomerInput!) { customerUpdate(input: $input) { customer { id phone } userErrors { field message } } }`,
        variables: { input: { id: `gid://shopify/Customer/${customerId}`, phone } },
      }),
    }
  );

  const result = await gqlResponse.json();
  const errors = result?.data?.customerUpdate?.userErrors;

  if (errors && errors.length > 0) {
    return new Response(JSON.stringify({ error: errors[0].message }), { status: 422, headers: { ...headers, "Content-Type": "application/json" } });
  }

  return new Response(JSON.stringify({ success: true, phone: result?.data?.customerUpdate?.customer?.phone }), { headers: { ...headers, "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Intercept phone capture API before Remix
    if (url.pathname === "/api/customer-phone") {
      return handlePhoneCapture(request, env);
    }

    try {
      const response = await requestHandler(request, {
        cloudflare: { env, ctx },
        env,
      });
      console.log(`[${response.status}] ${request.method} ${url.pathname}`);
      return response;
    } catch (error) {
      console.error(`[ERROR] ${request.method} ${url.pathname}`);
      console.error("Message:", error?.message || error);
      console.error("Stack:", error?.stack);
      return new Response(
        JSON.stringify({
          error: error?.message || "Unknown error",
          stack: error?.stack,
          path: url.pathname,
        }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
            "Content-Security-Policy":
              "frame-ancestors https://*.myshopify.com https://admin.shopify.com;",
          },
        }
      );
    }
  },
};
