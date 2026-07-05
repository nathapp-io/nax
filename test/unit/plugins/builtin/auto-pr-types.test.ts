/**
 * Auto-PR Plugin — Types Tests
 *
 * Tests for AutoPrConfig and AutoPrDeps type shapes.
 */

import { describe, expect, test } from "bun:test";
import type { AutoPrConfig, AutoPrDeps } from "../../../../src/plugins/builtin/auto-pr/types";

describe("AutoPrConfig", () => {
  test("supports enabled and draft flags", () => {
    const cfg: AutoPrConfig = { enabled: true, draft: true };
    expect(cfg.enabled).toBe(true);
    expect(cfg.draft).toBe(true);
  });

  test("supports draft=false variant", () => {
    const cfg: AutoPrConfig = { enabled: true, draft: false };
    expect(cfg.draft).toBe(false);
  });
});

describe("AutoPrDeps", () => {
  test("exposes run and readText", () => {
    const deps: AutoPrDeps = {
      run: async (_cmd, _opts) => ({ exitCode: 0, stdout: "", stderr: "" }),
      readText: async (_path) => null,
    };
    expect(typeof deps.run).toBe("function");
    expect(typeof deps.readText).toBe("function");
  });
});
