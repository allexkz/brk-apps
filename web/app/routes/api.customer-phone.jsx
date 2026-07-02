import { json } from "@remix-run/cloudflare";
import { Session } from "@shopify/shopify-api";

const SHOP_DOMAIN = "brk-agro.myshopify.com";
const ALLOWED_ORIGINS = [
  "https://www.brkagro.com.br",
  "https://brkagro.com.br",
  "https://brk-agro.myshopify.com",
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export const loader = async ({ request }) => {
  const origin = request.headers.get("Origin") || "";
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  return json({ ok: true }, { headers: corsHeaders(origin) });
};

export const action = async ({ request, context }) => {
  const origin = request.headers.get("Origin") || "";
  const headers = corsHeaders(origin);

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: "Forbidden" }, { status: 403, headers });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400, headers });
  }

  const { customerId, phone } = body;
  if (!customerId || !phone) {
    return json({ error: "customerId and phone are required" }, { status: 400, headers });
  }

  // Get offline session from KV
  const kv = context.env.SESSIONS;
  const indexKey = `shop_sessions:${SHOP_DOMAIN}`;
  const sessionIds = await kv.get(indexKey, "json");

  if (!sessionIds || sessionIds.length === 0) {
    return json({ error: "No session found" }, { status: 500, headers });
  }

  // Find offline session
  let accessToken = null;
  for (const id of sessionIds) {
    if (id.startsWith("offline_")) {
      const data = await kv.get(`shopify_session:${id}`, "json");
      if (data?.accessToken) {
        accessToken = data.accessToken;
        break;
      }
    }
  }

  if (!accessToken) {
    return json({ error: "No access token" }, { status: 500, headers });
  }

  // Call Admin API to update customer phone
  const gqlResponse = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/2026-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: `
          mutation customerUpdate($input: CustomerInput!) {
            customerUpdate(input: $input) {
              customer { id phone }
              userErrors { field message }
            }
          }
        `,
        variables: {
          input: {
            id: `gid://shopify/Customer/${customerId}`,
            phone: phone,
          },
        },
      }),
    }
  );

  const result = await gqlResponse.json();
  const errors = result?.data?.customerUpdate?.userErrors;

  if (errors && errors.length > 0) {
    return json({ error: errors[0].message }, { status: 422, headers });
  }

  return json({ success: true, phone: result?.data?.customerUpdate?.customer?.phone }, { headers });
};
