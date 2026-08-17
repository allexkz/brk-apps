import { createRequestHandler } from "@remix-run/cloudflare";
import * as build from "./build/server/index.js";
import { drainSankhyaQueue } from "./app/personalizados.server";
import { getSankhyaToken } from "./app/sankhya.server";

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

const DRAIN_INTERVAL_MS = 15 * 60 * 1000; // 15 min

// Durable Object fixado em São Paulo (locationHint "sam" no .get). Faz o drain do
// Sankhya DE DENTRO do Brasil, contornando o bloqueio da Cloudflare do Sankhya a
// origens fora do BR (o cron normal roda de Singapura e toma 401). O alarme se
// re-agenda sozinho a cada 15 min — o cron do worker só serve de rede de segurança.
export class SankhyaDrainer {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async ensureAlarm() {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
    }
  }
  async alarm() {
    // Re-agenda ANTES de trabalhar, pra continuidade mesmo se o drain lançar.
    await this.state.storage.setAlarm(Date.now() + DRAIN_INTERVAL_MS);
    try {
      const r = await drainSankhyaQueue(this.env, this.env.SESSIONS, SHOP_DOMAIN);
      console.log(`[drainer] processed=${r.processed} sent=${r.sent} pending=${r.pending} errors=${r.errors.length}`);
    } catch (e) {
      console.error("[drainer]", e?.message || e);
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/debug") {
      // Validação: de onde o DO sai (deve ser BR) e se a auth de lá passa.
      const out = {};
      try {
        const trace = await fetch("https://cloudflare.com/cdn-cgi/trace").then((r) => r.text());
        const g = (k) => (trace.match(new RegExp("^" + k + "=(.*)$", "m")) || [])[1];
        out.loc = g("loc"); out.colo = g("colo"); out.ip = g("ip");
      } catch (e) { out.traceErr = String(e?.message || e); }
      try {
        const t = await getSankhyaToken(this.env, this.env.SESSIONS, true);
        out.authOk = true; out.tokenLen = t ? String(t).length : 0;
      } catch (e) { out.authOk = false; out.authErr = String(e?.message || e); }
      return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
    }
    await this.ensureAlarm();
    return new Response("armed");
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Intercept phone capture API before Remix
    if (url.pathname === "/api/customer-phone") {
      return handlePhoneCapture(request, env);
    }

    // Valida que o Durable Object sai do Brasil e que a auth do Sankhya funciona de lá.
    // Chamar via: GET /api/drainer-debug — remover após validação.
    if (url.pathname === "/api/drainer-debug") {
      const id = env.SANKHYA_DRAINER.idFromName("drainer");
      return env.SANKHYA_DRAINER.get(id, { locationHint: "sam" }).fetch("https://drainer/debug");
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

  // Cron Trigger (wrangler.toml [triggers]): dreno da fila de personalizações →
  // reprocessa os jobs pendentes (aguardando NUNOTA / erro transitório) gravando no
  // Sankhya assim que o pedido estiver sincronizado lá. Puro KV + Sankhya (sem Shopify).
  async scheduled(event, env, ctx) {
    // Só ARMA o Durable Object (que roda em São Paulo e faz o drain de lá). Nada de
    // Sankhya daqui (Singapura), que seria bloqueado. O alarme do DO já se re-agenda
    // sozinho — isto é só rede de segurança caso o alarme se perca.
    ctx.waitUntil((async () => {
      try {
        const id = env.SANKHYA_DRAINER.idFromName("drainer");
        await env.SANKHYA_DRAINER.get(id, { locationHint: "sam" }).fetch("https://drainer/arm");
      } catch (e) {
        console.error("[cron arm drainer]", e?.message || e);
      }
    })());
  },
};
