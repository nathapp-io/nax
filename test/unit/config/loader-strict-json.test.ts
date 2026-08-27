/**
 * SEC-5: a corrupt config.json (project or global layer) was silently
 * treated as absent — loadJsonFile collapses "file doesn't exist" and
 * "file exists but fails to parse" onto the same `null` return, so a
 * trailing comma or other syntax error caused that layer to be skipped
 * entirely. The run would then proceed on defaults, including permissive
 * `execution.permissionProfile`, with only a warn log as evidence.
 *
 * loadConfig's global and project layers now use loadJsonFileStrict, which
 * throws a NaxError naming the path instead of swallowing the parse failure.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertNaxError, cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadConfig } from "@/config/loader";

describe("loadConfig — corrupt config.json fails fast (SEC-5)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-loader-strict-json-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) {
      process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  test("a project config.json with a trailing comma throws NaxError naming the path, not a silent default fallback", async () => {
    const configPath = join(tempDir, ".nax", "config.json");
    await Bun.write(configPath, '{ "execution": { "permissionProfile": "safe" }, }');

    let thrown: unknown;
    try {
      await loadConfig(tempDir);
    } catch (err) {
      thrown = err;
    }

    assertNaxError(thrown);
    expect(thrown.message).toContain(configPath);
  });

  test("a well-formed project config.json still loads normally", async () => {
    await Bun.write(join(tempDir, ".nax", "config.json"), JSON.stringify({ execution: { permissionProfile: "safe" } }));
    const config = await loadConfig(tempDir);
    expect(config.execution.permissionProfile).toBe("safe");
  });

  test("a missing project config.json is still absent, not an error", async () => {
    const config = await loadConfig(tempDir);
    expect(config).toBeDefined();
  });
});
