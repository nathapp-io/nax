/**
 * Integration test: per-story config resolution via workdir (MW-008, MW-009)
 *
 * Verifies that a story with workdir picks up the package-level
 * test command instead of the root test command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigForWorkdir } from "../../../src/config/loader";
import { makeTempDir } from "../../helpers/temp";

describe("per-story config resolution (MW-008 integration)", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-integration-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (originalGlobalDir === undefined) {
      process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  test("story with workdir uses package test command (spec example)", async () => {
    // root nax/config.json: test = "bun test"
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    // .nax/mono/packages/api/config.json: test = "bun run test:unit"
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun run test:unit" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");

    // Story AUTH-001 with workdir: "packages/api" → uses "bun run test:unit"
    const apiConfig = await loadConfigForWorkdir(rootConfigPath, "packages/api");
    expect(apiConfig.quality.commands.test).toBe("bun run test:unit");

    // Story AUTH-003 with no workdir → uses "bun test" (root fallback)
    const rootConfig = await loadConfigForWorkdir(rootConfigPath);
    expect(rootConfig.quality.commands.test).toBe("bun test");
  });

  test("multiple packages each get their own test command", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun run test:api" } } }),
    );

    mkdirSync(join(tempDir, ".nax", "mono", "packages", "web"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "web", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun run test:web", testScoped: "bun test:web -- {{files}}" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");

    const apiConfig = await loadConfigForWorkdir(rootConfigPath, "packages/api");
    expect(apiConfig.quality.commands.test).toBe("bun run test:api");

    const webConfig = await loadConfigForWorkdir(rootConfigPath, "packages/web");
    expect(webConfig.quality.commands.test).toBe("bun run test:web");
    expect(webConfig.quality.commands.testScoped).toBe("bun test:web -- {{files}}");

    const rootConfig = await loadConfigForWorkdir(rootConfigPath);
    expect(rootConfig.quality.commands.test).toBe("bun test");
  });

  test("package without config falls back to root", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    // packages/empty has no nax/config.json

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/empty");
    expect(result.quality.commands.test).toBe("bun test");
  });
});
