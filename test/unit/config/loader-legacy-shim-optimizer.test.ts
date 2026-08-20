/**
 * Compat shim for the removed `optimizer.strategy` / `optimizer.strategies` keys.
 *
 * Split from loader-legacy-shim.test.ts by describe block (that file sits at the
 * 800-line test ceiling), mirroring loader-legacy-shim-finish.test.ts.
 *
 * Driven through `loadConfig` rather than the `@internal` shim function: the shim
 * existing is not the claim worth pinning — the claim is that it is WIRED into the
 * chain the loader actually runs. Zod strips unknown keys silently, so without the
 * shim these keys would vanish with no warning at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@/config";
import { addSink, initLogger, resetLogger } from "@/logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("loadConfig — optimizer keys removed with the rule-based optimizer", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-loader-optimizer-shim-");
    mkdirSync(join(tempDir, ".nax"), { recursive: true });
    originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
    process.env.NAX_GLOBAL_CONFIG_DIR = join(tempDir, ".global-nax");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    if (originalGlobalDir === undefined) {
      delete process.env.NAX_GLOBAL_CONFIG_DIR;
    } else {
      process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
    }
  });

  async function writeProjectConfig(config: Record<string, unknown>): Promise<void> {
    await Bun.write(join(tempDir, ".nax", "config.json"), JSON.stringify(config));
  }

  async function captureLoadWarnings(): Promise<string[]> {
    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    try {
      await loadConfig(tempDir);
    } finally {
      removeSink();
      resetLogger();
    }
    return captured;
  }

  test("warns that optimizer.strategy was removed", async () => {
    await writeProjectConfig({ optimizer: { enabled: true, strategy: "rule-based" } });

    const captured = await captureLoadWarnings();

    expect(captured.some((m) => m.includes("optimizer.strategy") && m.includes("removed"))).toBe(true);
  });

  test("warns that optimizer.strategies was removed", async () => {
    await writeProjectConfig({
      optimizer: { enabled: true, strategies: { "rule-based": { stripWhitespace: false } } },
    });

    const captured = await captureLoadWarnings();

    expect(captured.some((m) => m.includes("optimizer.strategies") && m.includes("removed"))).toBe(true);
  });

  test("strips the removed keys but preserves optimizer.enabled", async () => {
    await writeProjectConfig({ optimizer: { enabled: true, strategy: "rule-based", strategies: {} } });

    const config = await loadConfig(tempDir);

    expect(config.optimizer?.enabled).toBe(true);
    expect(Object.keys(config.optimizer ?? {})).toEqual(["enabled"]);
  });

  test("a clean optimizer block loads silently", async () => {
    await writeProjectConfig({ optimizer: { enabled: true } });

    const captured = await captureLoadWarnings();

    expect(captured.filter((m) => m.includes("optimizer."))).toHaveLength(0);
  });
});
