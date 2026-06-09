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

describe("Default Integration Test", () => {
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

      const runResult = await runFunction(fixture, functionRunnerPath, wasmPath, targetInputQueryPath, schemaPath);
      expect(runResult.error).toBeNull();
      expect(runResult.result.output).toEqual(fixture.expectedOutput);
    }, 10000);
  });
});
