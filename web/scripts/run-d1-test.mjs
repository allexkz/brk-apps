// Runner dos testes do pipeline no D1 (mesmo hook de resolução do run-test.mjs).
// Uso: node --no-warnings scripts/run-d1-test.mjs
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
await import("./perso-d1.test.mjs");
