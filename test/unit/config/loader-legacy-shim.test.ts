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
import { _applyLegacyReviewExecutionShim, loadConfig } from "../../../src/config/loader";
import { cleanupTempDir, makeTempDir } from "../../helpers/temp";

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

  test("AC7: loadConfig preserves valid pluginMode 'gating' end-to-end", async () => {
    await writeProjectConfig({
      review: { pluginMode: "gating" },
    });

    const config = await loadConfig(tempDir);

    expect(config.review as unknown as Record<string, unknown>).toHaveProperty("pluginMode", "gating");
  });
});
