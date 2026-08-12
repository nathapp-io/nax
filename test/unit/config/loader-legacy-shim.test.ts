/**
 * Tests for the legacy config deprecation shim (US-005c, #1146)
 *
 * When a project config contains removed keys (execution.inlineReview,
 * review.dialogue.enabled) or legacy values (review.pluginMode "per-story"), the loader must:
 * - Log a warn-level message per removed key containing the key name and "removed"
 * - Not surface those keys in the loaded config
 *
 * Note: review.pluginMode itself is a valid field since #1146 (values: "observational"|"gating").
 * Only the legacy "per-story" value triggers the shim.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { _applyLegacyReviewExecutionShim, _applyRemovedRoutingKeysShim } from "../../../src/config/compat-shims";
import { loadConfig } from "../../../src/config/loader";
import { addSink, initLogger, resetLogger } from "@/logger";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

describe("_applyRemovedRoutingKeysShim — routing keys removed with ROUTE-001", () => {
  test("warns and strips routing.customStrategyPath", () => {
    const captured: string[] = [];
    const result = _applyRemovedRoutingKeysShim(
      { routing: { strategy: "keyword", customStrategyPath: "./my-strategy.ts" } },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("routing.customStrategyPath");
    expect(captured[0]).toContain("removed");
    expect(result.routing as Record<string, unknown>).not.toHaveProperty("customStrategyPath");
  });

  test("warns and strips routing.adaptive", () => {
    const captured: string[] = [];
    const result = _applyRemovedRoutingKeysShim(
      { routing: { strategy: "keyword", adaptive: { costThreshold: 0.5, minSamples: 10 } } },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("routing.adaptive");
    expect(captured[0]).toContain("removed");
    expect(result.routing as Record<string, unknown>).not.toHaveProperty("adaptive");
  });

  test("warns once per removed key when both are present", () => {
    const captured: string[] = [];
    _applyRemovedRoutingKeysShim(
      { routing: { strategy: "keyword", adaptive: {}, customStrategyPath: "./x.ts" } },
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(2);
  });

  test("leaves a routing config without removed keys untouched and silent", () => {
    const captured: string[] = [];
    const input = { routing: { strategy: "llm", llm: { model: "sonnet" } } };
    const result = _applyRemovedRoutingKeysShim(input, (msg) => captured.push(msg));

    expect(captured.length).toBe(0);
    expect(result.routing).toEqual({ strategy: "llm", llm: { model: "sonnet" } });
  });

  test("does not mutate the input config", () => {
    const input = { routing: { strategy: "keyword", customStrategyPath: "./x.ts" } };
    _applyRemovedRoutingKeysShim(input, () => {});

    expect(input.routing).toHaveProperty("customStrategyPath", "./x.ts");
  });

  test("tolerates a config with no routing section", () => {
    const captured: string[] = [];
    const result = _applyRemovedRoutingKeysShim({ execution: {} }, (msg) => captured.push(msg));

    expect(captured.length).toBe(0);
    expect(result).toEqual({ execution: {} });
  });
});

describe("loadConfig — legacy key deprecation shim", () => {
  let tempDir: string;
  let originalGlobalDir: string | undefined;

  beforeEach(() => {
    tempDir = makeTempDir("nax-loader-legacy-shim-");
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

  test("AC7: logs warn for execution.inlineReview when present in project config", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { execution: { inlineReview: true } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("execution.inlineReview");
    expect(captured[0]).toContain("removed");
    expect(result.execution as Record<string, unknown>).not.toHaveProperty("inlineReview");
  });

  test("AC7: logs warn for review.pluginMode when value is legacy 'per-story'", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { pluginMode: "per-story" } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("review.pluginMode");
    expect(captured[0]).toContain("removed");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("pluginMode");
  });

  test("AC7: does NOT strip review.pluginMode when value is valid ('observational')", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { pluginMode: "observational" } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(0);
    expect(result.review as Record<string, unknown>).toHaveProperty("pluginMode", "observational");
  });

  test("AC7: does NOT strip review.pluginMode when value is valid ('gating')", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { pluginMode: "gating" } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(0);
    expect(result.review as Record<string, unknown>).toHaveProperty("pluginMode", "gating");
  });

  test("AC7: logs warn for review.dialogue.enabled:true when present in project config", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { dialogue: { enabled: true } } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toContain("review.dialogue.enabled");
    expect(captured[0]).toContain("removed");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("dialogue");
  });

  test("AC7: logs one warn per removed key when multiple legacy keys are present", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      {
        execution: { inlineReview: true },
        review: { pluginMode: "per-story", dialogue: { enabled: true } },
      } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );

    expect(captured.length).toBe(3);
    expect(captured.some((m) => m.includes("execution.inlineReview") && m.includes("removed"))).toBe(true);
    expect(captured.some((m) => m.includes("review.pluginMode") && m.includes("removed"))).toBe(true);
    expect(captured.some((m) => m.includes("review.dialogue.enabled") && m.includes("removed"))).toBe(true);
    expect(result.execution as Record<string, unknown>).not.toHaveProperty("inlineReview");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("pluginMode");
    expect(result.review as Record<string, unknown>).not.toHaveProperty("dialogue");
  });

  test("AC7: does not warn when no legacy keys are present", () => {
    const captured: string[] = [];
    _applyLegacyReviewExecutionShim({ quality: { commands: { test: "bun test" } } } as Record<string, unknown>, (msg) =>
      captured.push(msg),
    );
    expect(captured.length).toBe(0);
  });

  test("AC7: does not warn for dialogue when enabled is false", () => {
    const captured: string[] = [];
    const result = _applyLegacyReviewExecutionShim(
      { review: { dialogue: { enabled: false } } } as Record<string, unknown>,
      (msg) => captured.push(msg),
    );
    expect(captured.length).toBe(0);
    expect(result.review as Record<string, unknown>).toHaveProperty("dialogue");
  });

  test("AC7: loadConfig strips legacy keys from loaded config end-to-end", async () => {
    await writeProjectConfig({
      execution: { inlineReview: true },
      review: { pluginMode: "per-story", dialogue: { enabled: true } },
    });

    const config = await loadConfig(tempDir);

    expect(config.execution as unknown as Record<string, unknown>).not.toHaveProperty("inlineReview");
    // pluginMode "per-story" is stripped; the field reappears with the default "observational"
    // because pluginMode is now a valid field with default (#1146).
    expect(config.review as unknown as Record<string, unknown>).toHaveProperty("pluginMode", "observational");
    expect(config.review as unknown as Record<string, unknown>).not.toHaveProperty("dialogue");
  });

  test("loadConfig warns about removed routing keys end-to-end (proves the shim is wired)", async () => {
    await writeProjectConfig({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 } } });

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

    expect(captured.some((m) => m.includes("routing.adaptive") && m.includes("removed"))).toBe(true);
  });

  test("AC7: loadConfig preserves valid pluginMode 'gating' end-to-end", async () => {
    await writeProjectConfig({
      review: { pluginMode: "gating" },
    });

    const config = await loadConfig(tempDir);

    expect(config.review as unknown as Record<string, unknown>).toHaveProperty("pluginMode", "gating");
  });

  // BUG-51: profile/CLI config layers must run through the same compat-shim chain as
  // file-based layers (global/project config), or a legacy value set via a profile
  // (or CLI override) hard-fails Zod validation instead of being remapped.
  test("BUG-51: loadConfig remaps a removed routing.strategy set via a profile instead of failing", async () => {
    await Bun.write(
      join(tempDir, ".nax", "profiles", "legacy-manual.json"),
      JSON.stringify({ routing: { strategy: "manual" } }),
    );

    const config = await loadConfig(tempDir, { profile: "legacy-manual" });

    // "manual" was removed in ROUTE-001 and mapped to "keyword" by applyRemovedStrategyCompat.
    expect(config.routing.strategy).toBe("keyword");
  });

  test("BUG-51: loadConfig remaps a removed routing.strategy set via a CLI override instead of failing", async () => {
    const config = await loadConfig(tempDir, { routing: { strategy: "adaptive" } });

    expect(config.routing.strategy).toBe("keyword");
  });

  // BUG-51's fix routed every layer (global, project, profile, CLI) through the
  // same compat-shim chain. Correct, but it made the deprecation warning fire
  // once per layer that carries the key — the same advice repeated up to four
  // times reads as four distinct problems.
  async function captureLoadWarnings(
    load: () => Promise<unknown>,
  ): Promise<string[]> {
    const captured: string[] = [];
    resetLogger();
    initLogger({ level: "warn" });
    const removeSink = addSink((entry) => captured.push(entry.message));
    try {
      await load();
    } finally {
      removeSink();
      resetLogger();
    }
    return captured;
  }

  test("a deprecation warning is emitted once even when several config layers carry the same legacy key", async () => {
    await Bun.write(
      join(tempDir, ".global-nax", "config.json"),
      JSON.stringify({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.1 } } }),
    );
    await writeProjectConfig({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 } } });
    await Bun.write(
      join(tempDir, ".nax", "profiles", "legacy.json"),
      JSON.stringify({ routing: { adaptive: { costThreshold: 0.7 } } }),
    );

    const captured = await captureLoadWarnings(() =>
      loadConfig(tempDir, { profile: "legacy", routing: { adaptive: { costThreshold: 0.9 } } }),
    );

    const hits = captured.filter((m) => m.includes("routing.adaptive"));
    expect(hits).toHaveLength(1);
  });

  test("distinct deprecation warnings are all still emitted", async () => {
    await writeProjectConfig({
      routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 }, customStrategyPath: "./x.ts" },
    });

    const captured = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(captured.filter((m) => m.includes("routing.adaptive"))).toHaveLength(1);
    expect(captured.filter((m) => m.includes("routing.customStrategyPath"))).toHaveLength(1);
  });

  test("dedupe is scoped per load — a second loadConfig warns again", async () => {
    await writeProjectConfig({ routing: { strategy: "keyword", adaptive: { costThreshold: 0.5 } } });

    const first = await captureLoadWarnings(() => loadConfig(tempDir));
    const second = await captureLoadWarnings(() => loadConfig(tempDir));

    expect(first.filter((m) => m.includes("routing.adaptive"))).toHaveLength(1);
    expect(second.filter((m) => m.includes("routing.adaptive"))).toHaveLength(1);
  });
});
