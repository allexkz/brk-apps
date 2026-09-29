// Runner do teste: registra o loader (resolve imports relativos sem extensão) e executa.
// Uso: node scripts/run-test.mjs
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
await import("./kv-writes.test.mjs");
