// Runner dos testes do webhook (bundles + campanhas). Uso: node scripts/run-webhook-test.mjs
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
await import("./webhook-tags.test.mjs");
