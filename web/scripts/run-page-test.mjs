// Runner dos testes da dashboard paginada (mesmo hook de resolução do run-test.mjs).
// Uso: node scripts/run-page-test.mjs
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
await import("./personalizados-page.test.mjs");
