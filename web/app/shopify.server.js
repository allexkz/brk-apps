// Use the Cloudflare Worker adapter instead of Node.js
// This sets Web API-compatible request/response converters
import "@shopify/shopify-api/adapters/cf-worker";
import { setAbstractRuntimeString } from "@shopify/shopify-api/runtime";
import { ApiVersion, shopifyApp } from "@shopify/shopify-app-remix/server";
import { KVSessionStorage, setKV } from "./kv-session-storage";

// Override the runtime string for Remix context
setAbstractRuntimeString(() => "Remix (Cloudflare Worker)");

/** @type {ReturnType<typeof shopifyApp> | null} */
let _shopify = null;

/**
 * Get or create the Shopify app singleton.
 * The KV binding is updated per-request via setKV().
 *
 * @param {object} env - Cloudflare Worker env bindings
 */
export function getShopify(env) {
  // Update KV binding for this request
  setKV(env.SESSIONS);

  if (!_shopify) {
    _shopify = shopifyApp({
      apiKey: env.SHOPIFY_API_KEY,
      apiSecretKey: env.SHOPIFY_API_SECRET || "",
      // Versão explícita da Admin API (a lib >= 12 exige). 2026-10 = suporte até ~out/2027.
      // Antes (lib 11) January26 não existia → caía na 2025-07 e a Shopify servia a mais
      // antiga suportada. Ao atualizar, validar as queries na versão nova.
      apiVersion: ApiVersion.October26,
      scopes: env.SCOPES?.split(","),
      appUrl: env.SHOPIFY_APP_URL || "",
      authPathPrefix: "/auth",
      sessionStorage: new KVSessionStorage(),
      isEmbeddedApp: true,
      future: {
        unstable_newEmbeddedAuthStrategy: true,
      },
    });
  }

  return _shopify;
}
