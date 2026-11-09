import path from "path";
import fs from "fs";
import { execFileSync } from "child_process";
import { describe, beforeAll, test, expect } from "vitest";
import { loadSchema, loadInputQuery, loadFixture, validateTestAssets, runFunction } from "@shopify/shopify-function-test-helpers";

// On Windows the global Shopify CLI binary is `shopify.cmd`, which Node's
// spawn (used by buildFunction/getFunctionInfo) does NOT resolve without a
// shell. We invoke the CLI directly here with `shell: true` so PATHEXT applies
// cross-platform.
function shopifyCli(args, appRootDir) {
  return execFileSync("shopify", args, {
    cwd: appRootDir,
    encoding: "utf8",
    shell: true,
    env: { ...process.env, SHOPIFY_INVOKED_BY: "shopify-function-test-helpers" },
  });
}

// Decimal é o mesmo valor em formatos diferentes: o JS escreve 100 / "49.90" e o Rust
// (scalar Decimal do crate) "100.0" / "49.9". Compara os campos Decimal como número.
function normalizeDecimals(v, key) {
  if (Array.isArray(v)) return v.map((x) => normalizeDecimals(x));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalizeDecimals(x, k)]));
  }
  if ((key === "value" || key === "amount") && (typeof v === "string" || typeof v === "number")) return Number(v);
  return v;
}

describe("BRK Bundles Discount — Integration Test", () => {
  let schema;
  let functionDir;
  let functionInfo;
  let schemaPath;
  let targeting;
  let functionRunnerPath;
  let wasmPath;

  beforeAll(async () => {
    functionDir = path.dirname(__dirname);
    const appRootDir = path.dirname(functionDir);
    const functionName = path.basename(functionDir);

    shopifyCli(["app", "function", "build", "--path", functionName], appRootDir);
    const infoJson = shopifyCli(["app", "function", "info", "--json", "--path", functionName], appRootDir);
    functionInfo = JSON.parse(infoJson.trim());
    ({ schemaPath, functionRunnerPath, wasmPath, targeting } = functionInfo);
    schema = await loadSchema(schemaPath);
  }, 120000);

  const fixturesDir = path.join(__dirname, "fixtures");
  const fixtureFiles = fs
    .readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(fixturesDir, file));

  fixtureFiles.forEach((fixtureFile) => {
    test(`runs ${path.relative(fixturesDir, fixtureFile)}`, async () => {
      const fixture = await loadFixture(fixtureFile);
      const targetInputQueryPath = targeting[fixture.target].inputQueryPath;
      const inputQueryAST = await loadInputQuery(targetInputQueryPath);

      const validationResult = await validateTestAssets({ schema, fixture, inputQueryAST });
      expect(validationResult.inputQuery.errors).toEqual([]);
      expect(validationResult.inputFixture.errors).toEqual([]);
      expect(validationResult.outputFixture.errors).toEqual([]);

      // O `export` gravado no fixture é o nome JS; usa o do shopify.extension.toml (JS ou Rust).
      const runResult = await runFunction(
        { ...fixture, export: targeting[fixture.target].export ?? fixture.export },
        functionRunnerPath,
        wasmPath,
        targetInputQueryPath,
        schemaPath,
      );
      expect(runResult.error).toBeNull();
      expect(normalizeDecimals(runResult.result.output)).toEqual(normalizeDecimals(fixture.expectedOutput));
    }, 10000);
  });
});
