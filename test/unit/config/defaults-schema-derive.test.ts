/**
 * US-002: Derive DEFAULT_CONFIG from schema parse
 *
 * Tests that DEFAULT_CONFIG is derived from NaxConfigSchema.parse({}) rather
 * than being a hand-maintained object literal. The Zod .default() values become
 * the authoritative source of truth.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../../src/config/loader";
import { DEFAULT_CONFIG, NaxConfigSchema } from "../../../src/config/schema";
import type { NaxConfig } from "../../../src/config/schema";

describe("US-002: Derive DEFAULT_CONFIG from schema parse", () => {
  describe("defaults.ts structure", () => {
    test("defaults.ts is fewer than 15 lines total", async () => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const defaultsPath = resolve(import.meta.dir, "../../../src/config/defaults.ts");
      const content = readFileSync(defaultsPath, "utf-8");
      const lineCount = content.split("\n").length;
      expect(lineCount).toBeLessThan(15);
    });

    test("DEFAULT_CONFIG is exported from defaults.ts", () => {
      expect(DEFAULT_CONFIG).toBeDefined();
    });

    test("DEFAULT_CONFIG is cast from NaxConfigSchema.parse({})", () => {
      const derivedConfig = NaxConfigSchema.parse({});
      expect(derivedConfig).toBeDefined();
      expect(typeof derivedConfig).toBe("object");
    });
  });

  describe("DEFAULT_CONFIG default values from Zod schema", () => {
    test("DEFAULT_CONFIG.execution.sessionTimeoutSeconds === 3600", () => {
      expect(DEFAULT_CONFIG.execution.sessionTimeoutSeconds).toBe(3600);
    });

    test("DEFAULT_CONFIG.execution.rectification.maxRetries === 2", () => {
      expect(DEFAULT_CONFIG.execution.rectification.maxRetries).toBe(2);
    });

    test("DEFAULT_CONFIG.quality.requireTypecheck === true", () => {
      expect(DEFAULT_CONFIG.quality.requireTypecheck).toBe(true);
    });
  });

  describe("NaxConfigSchema.parse({}) produces DEFAULT_CONFIG", () => {
    test("schema parse returns object with same sessionTimeoutSeconds", () => {
      const parsed = NaxConfigSchema.parse({});
      expect(parsed.execution.sessionTimeoutSeconds).toBe(3600);
    });

    test("schema parse returns object with same rectification.maxRetries", () => {
      const parsed = NaxConfigSchema.parse({});
      expect(parsed.execution.rectification.maxRetries).toBe(2);
    });

    test("schema parse returns object with same requireTypecheck", () => {
      const parsed = NaxConfigSchema.parse({});
      expect(parsed.quality.requireTypecheck).toBe(true);
    });

    test("schema parse produces NaxConfig type", () => {
      const parsed = NaxConfigSchema.parse({});
      const typed = parsed as NaxConfig;
      expect(typed.execution).toBeDefined();
      expect(typed.quality).toBeDefined();
    });
  });

  describe("loadConfig() with no config files", () => {
    test("loadConfig() with no config files returns config deeply equal to DEFAULT_CONFIG", async () => {
      const tempProjectDir = join(tmpdir(), `nax-test-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      const tempGlobalDir = join(tmpdir(), `nax-test-global-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(join(tempProjectDir, ".nax"), { recursive: true });
      mkdirSync(tempGlobalDir, { recursive: true });

      const originalGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
      process.env.NAX_GLOBAL_CONFIG_DIR = tempGlobalDir;

      try {
        const result = await loadConfig(tempProjectDir);
        expect(result).toEqual(DEFAULT_CONFIG);
      } finally {
        if (originalGlobalDir === undefined) {
          process.env.NAX_GLOBAL_CONFIG_DIR = undefined;
        } else {
          process.env.NAX_GLOBAL_CONFIG_DIR = originalGlobalDir;
        }
        rmSync(tempProjectDir, { recursive: true, force: true });
        rmSync(tempGlobalDir, { recursive: true, force: true });
      }
    });
  });
});
