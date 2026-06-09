import { createRequestHandler } from "@remix-run/cloudflare";
import * as build from "./build/server/index.js";

const requestHandler = createRequestHandler(build);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
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
