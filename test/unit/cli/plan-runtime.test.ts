/**
 * Unit tests for src/cli/plan-runtime.ts
 *
 * Tests _planDeps object and its shape (AC-14).
 */

import { describe, expect, test } from "bun:test";
import { withTempDir } from "@test/helpers";
import { _planDeps } from "@/cli";

describe("_planDeps", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // AC-14: _planDeps exposes scanSourceRoots and does NOT expose scanCodebase
  // ──────────────────────────────────────────────────────────────────────────

  test("AC-14: _planDeps exposes scanSourceRoots property", () => {
    expect(_planDeps).toHaveProperty("scanSourceRoots");
    expect(typeof _planDeps.scanSourceRoots).toBe("function");
  });

  test("AC-14: _planDeps does NOT expose scanCodebase property", () => {
    expect(_planDeps).not.toHaveProperty("scanCodebase");
  });

  test("AC-14: scanSourceRoots returns an array for a real workdir", async () => {
    await withTempDir(async (tmpDir) => {
      const roots = await _planDeps.scanSourceRoots(tmpDir);
      expect(Array.isArray(roots)).toBe(true);
    });
  });
});
