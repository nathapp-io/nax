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
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadConfig } from "@/config";
import { _applyFinishAutoFlowShim } from "@/config/compat-shims";
import { addSink, initLogger, resetLogger } from "@/logger";

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

/**
 * Tests for `_applyFinishAutoFlowShim` — the compat shim that lifts the removed
 * `finish.autoFlow.*` config shape onto the flattened `finish.*` shape.
 *
 * Split out of `loader-legacy-shim.test.ts` (which owns the rest of the
 * compat-shim chain) once adding this describe block pushed that file over the
 * 800-line test file limit.
 */

describe("_applyFinishAutoFlowShim", () => {
  test("lifts finish.autoFlow.* onto finish.* and drops the removed keys", () => {
    const warnings: string[] = [];
    const out = _applyFinishAutoFlowShim(
      {
        finish: {
          autoFlow: {
            enabled: true,
            flowPath: "flows/nax-finish/nax-finish.flow.ts",
            defaultAgent: "claude",
            model: "sonnet",
            narrative: false,
            timeouts: { acceptanceMs: 1, gateMs: 2, flowMs: 3, stepMs: 4 },
          },
        },
      },
      (m) => warnings.push(m),
    );
    expect(out.finish).toEqual({
      enabled: true,
      narrative: false,
      timeouts: { acceptanceMs: 1, gateMs: 2, flowMs: 3, stepMs: 4 },
    });
    expect(warnings.join(" ")).toContain("finish.autoFlow");
  });

  test("maps a reviewer profile string to null and warns, rather than failing validation", () => {
    const warnings: string[] = [];
    const out = _applyFinishAutoFlowShim(
      {
        finish: { autoFlow: { enabled: true, reviewers: { spec: "nax-finish-spec", quality: null, narrative: null } } },
      },
      (m) => warnings.push(m),
    );
    expect((out.finish as { reviewers: Record<string, unknown> }).reviewers).toEqual({
      spec: null,
      quality: null,
      narrative: null,
    });
    expect(warnings.join(" ")).toContain("reviewers.spec");
  });

  test("an explicit finish.* alongside finish.autoFlow wins", () => {
    const out = _applyFinishAutoFlowShim({ finish: { enabled: false, autoFlow: { enabled: true } } }, () => {});
    expect((out.finish as { enabled: boolean }).enabled).toBe(false);
  });

  test("a config with no finish block is returned unchanged, same reference", () => {
    const conf = { review: {} };
    expect(_applyFinishAutoFlowShim(conf, () => {})).toBe(conf);
  });
});
