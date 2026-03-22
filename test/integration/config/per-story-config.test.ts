/**
 * Integration test: per-story config resolution via workdir (MW-008, MW-009)
 *
 * Verifies that a story with workdir picks up the package-level
 * test command instead of the root test command.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalConfigPath, loadConfigForWorkdir } from "../../../src/config/loader";

describe("per-story config resolution (MW-008 integration)", () => {
  let tempDir: string;
  let globalBackup: string | null = null;

  beforeEach(() => {
    tempDir = join(tmpdir(), `nax-test-integration-${Date.now()}`);
    mkdirSync(join(tempDir, ".nax"), { recursive: true });

    const globalPath = globalConfigPath();
    if (existsSync(globalPath)) {
      globalBackup = `${globalPath}.test-backup-${Date.now()}`;
      renameSync(globalPath, globalBackup);
    }
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    if (globalBackup && existsSync(globalBackup)) {
      const globalPath = globalConfigPath();
      if (existsSync(globalPath)) {
        rmSync(globalPath);
      }
      renameSync(globalBackup, globalPath);
      globalBackup = null;
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
