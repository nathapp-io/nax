/**
 * Unit tests for loadConfigForWorkdir (MW-008, BUG-134)
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { _clearRootConfigCache, loadConfigForWorkdir } from "../../../src/config/loader";
import { getLogger } from "../../../src/logger";
import { makeTempDir } from "../../helpers/temp";

describe("loadConfigForWorkdir", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-test-workdir-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
    _clearRootConfigCache();
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

  test("returns root config when no packageDir provided", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath);

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("returns root config when package config does not exist", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/api");

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("merges package quality.commands when package config exists", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test", typecheck: "bun run typecheck" } } }),
    );

    // Create package config at new location: .nax/mono/<packageDir>/config.json
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun run test:unit" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/api");

    // Package test command overrides root
    expect(result.quality.commands.test).toBe("bun run test:unit");
    // Root typecheck preserved
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
  });

  test("story without workdir (no packageDir) uses root test command", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "npm test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath);

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("BUG-134: logs info when package config not found (fallback to root)", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const logger = getLogger();
    const infoSpy = spyOn(logger, "info");

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    await loadConfigForWorkdir(rootConfigPath, "packages/missing");

    const fallbackCall = infoSpy.mock.calls.find(
      (args) => typeof args[1] === "string" && args[1].includes("Per-package config not found"),
    );
    expect(fallbackCall).toBeDefined();
    expect(fallbackCall?.[2]).toMatchObject({ packageDir: "packages/missing" });

    infoSpy.mockRestore();
  });

  test("BUG-134: logs debug when packageDir is undefined (no per-package resolution)", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );

    const logger = getLogger();
    const debugSpy = spyOn(logger, "debug");

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    await loadConfigForWorkdir(rootConfigPath);

    const noWorkdirCall = debugSpy.mock.calls.find(
      (args) => typeof args[1] === "string" && args[1].includes("No packageDir"),
    );
    expect(noWorkdirCall).toBeDefined();

    debugSpy.mockRestore();
  });

  test("package config without quality.commands does not change test command", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "web"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "web", "config.json"),
      JSON.stringify({ routing: { strategy: "keyword" } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/web");

    expect(result.quality.commands.test).toBe("bun test");
  });

  test("caches root config: second call with same path skips I/O (same promise)", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "api"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "api", "config.json"),
      JSON.stringify({ quality: { commands: { test: "npm test" } } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "web"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "web", "config.json"),
      JSON.stringify({ quality: { commands: { test: "yarn test" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    // Two different packages load config with the same root path
    const [api, web] = await Promise.all([
      loadConfigForWorkdir(rootConfigPath, "packages/api"),
      loadConfigForWorkdir(rootConfigPath, "packages/web"),
    ]);

    expect(api.quality.commands.test).toBe("npm test");
    expect(web.quality.commands.test).toBe("yarn test");
  });

  test("caches root config: clearing cache allows fresh load after config file changes", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test v1" } } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const first = await loadConfigForWorkdir(rootConfigPath);
    expect(first.quality.commands.test).toBe("bun test v1");

    // Simulate config file change + cache clear
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ quality: { commands: { test: "bun test v2" } } }),
    );
    _clearRootConfigCache();

    const second = await loadConfigForWorkdir(rootConfigPath);
    expect(second.quality.commands.test).toBe("bun test v2");
  });

  test("per-package agent.protocol override is applied", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ agent: { protocol: "acp" } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "pkg-a"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "pkg-a", "config.json"),
      JSON.stringify({ agent: { maxInteractionTurns: 5 } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/pkg-a");

    expect(result.agent?.protocol).toBe("acp");
    expect(result.agent?.maxInteractionTurns).toBe(5);
  });

  test("per-package routing.strategy override is applied", async () => {
    writeFileSync(
      join(tempDir, ".nax", "config.json"),
      JSON.stringify({ routing: { strategy: "keyword" } }),
    );
    mkdirSync(join(tempDir, ".nax", "mono", "packages", "ml"), { recursive: true });
    writeFileSync(
      join(tempDir, ".nax", "mono", "packages", "ml", "config.json"),
      JSON.stringify({ routing: { strategy: "llm" } }),
    );

    const rootConfigPath = join(tempDir, ".nax", "config.json");
    const result = await loadConfigForWorkdir(rootConfigPath, "packages/ml");

    expect(result.routing?.strategy).toBe("llm");
  });
});
