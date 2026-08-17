import { createRequestHandler } from "@remix-run/cloudflare";
import * as build from "./build/server/index.js";
import { drainSankhyaQueue } from "./app/personalizados.server";
import { getSankhyaToken } from "./app/sankhya.server";

const requestHandler = createRequestHandler(build);

const SHOP_DOMAIN = "zaevym-aj.myshopify.com";

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

  // Cron (a cada 15 min): apenas ARMA o Durable Object (que faz o drain de São Paulo).
  // Não chama o Sankhya daqui (Singapura), que seria bloqueado. É rede de segurança —
  // o alarme do DO já se re-agenda sozinho.
  async scheduled(event, env, ctx) {
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
