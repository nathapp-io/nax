/**
 * Tests for src/precheck/types.ts
 *
 * Tests the precheck type definitions including PrecheckResult, CheckStatus, and CheckTier.
 */

import { describe, expect, test } from "bun:test";
import type { Check, CheckStatus, CheckTier, PrecheckResult } from "../../src/precheck/types";

describe("PrecheckResult type structure", () => {
  test("PrecheckResult has blockers array", () => {
    const result: PrecheckResult = {
      blockers: [],
      warnings: [],
    };

    expect(result.blockers).toBeDefined();
    expect(Array.isArray(result.blockers)).toBe(true);
  });

  test("PrecheckResult has warnings array", () => {
    const result: PrecheckResult = {
      blockers: [],
      warnings: [],
    };

    expect(result.warnings).toBeDefined();
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  test("PrecheckResult can contain Check objects in blockers", () => {
    const check: Check = {
      name: "git-repo-exists",
      tier: "blocker",
      passed: false,
      message: "Not a git repository",
    };

    const result: PrecheckResult = {
      blockers: [check],
      warnings: [],
    };

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].name).toBe("git-repo-exists");
    expect(result.blockers[0].tier).toBe("blocker");
    expect(result.blockers[0].passed).toBe(false);
  });

  test("PrecheckResult can contain Check objects in warnings", () => {
    const check: Check = {
      name: "claude-md-exists",
      tier: "warning",
      passed: false,
      message: "CLAUDE.md not found",
    };

    const result: PrecheckResult = {
      blockers: [],
      warnings: [check],
    };

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].name).toBe("claude-md-exists");
    expect(result.warnings[0].tier).toBe("warning");
  });
});

describe("Check type structure", () => {
  test("Check has required name field", () => {
    const check: Check = {
      name: "test-check",
      tier: "blocker",
      passed: true,
      message: "Check passed",
    };

    expect(check.name).toBe("test-check");
  });

  test("Check has required tier field", () => {
    const check: Check = {
      name: "test-check",
      tier: "blocker",
      passed: true,
      message: "Check passed",
    };

    expect(check.tier).toBe("blocker");
  });

  test("Check has required passed field", () => {
    const check: Check = {
      name: "test-check",
      tier: "blocker",
      passed: false,
      message: "Check failed",
    };

    expect(check.passed).toBe(false);
  });

  test("Check has required message field", () => {
    const check: Check = {
      name: "test-check",
      tier: "blocker",
      passed: true,
      message: "All good",
    };

    expect(check.message).toBe("All good");
  });
});

describe("CheckTier type values", () => {
  test("CheckTier accepts blocker value", () => {
    const tier: CheckTier = "blocker";
    expect(tier).toBe("blocker");
  });

  test("CheckTier accepts warning value", () => {
    const tier: CheckTier = "warning";
    expect(tier).toBe("warning");
  });
});

describe("CheckStatus type values", () => {
  test("CheckStatus accepts passed value", () => {
    const status: CheckStatus = "passed";
    expect(status).toBe("passed");
  });

  test("CheckStatus accepts failed value", () => {
    const status: CheckStatus = "failed";
    expect(status).toBe("failed");
  });

  test("CheckStatus accepts skipped value", () => {
    const status: CheckStatus = "skipped";
    expect(status).toBe("skipped");
  });
});
