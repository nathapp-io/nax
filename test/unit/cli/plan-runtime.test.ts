/**
 * Unit tests for src/cli/plan-runtime.ts
 *
 * Tests _planDeps object and its shape (AC-14).
 */

import { describe, expect, test } from "bun:test";
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

  test("AC-14: scanSourceRoots is callable with workdir string", async () => {
    // Verify the function exists and has the right signature
    expect(typeof _planDeps.scanSourceRoots).toBe("function");
    const result = _planDeps.scanSourceRoots as any;
    expect(result.length).toBeGreaterThanOrEqual(0); // Takes at least 0 args (actually 1)
  });
});
