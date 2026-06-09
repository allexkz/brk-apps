import {
  vitePlugin as remix,
} from "@remix-run/dev";
import { defineConfig } from "vite";

// Replace HOST with SHOPIFY_APP_URL
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

export default defineConfig({
  plugins: [
    remix({
      ignoredRouteFiles: ["**/.*"],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: true,
      },
    }),
  ],
  ssr: {
    resolve: {
      conditions: ["workerd", "worker", "node"],
    },
    // Externalize Node.js-dependent packages for the SSR bundle
    // They will be bundled by wrangler with nodejs_compat
    noExternal: true,
  },
  resolve: {
    mainFields: ["browser", "module", "main"],
  },
  build: {
    minify: true,
  },
});
