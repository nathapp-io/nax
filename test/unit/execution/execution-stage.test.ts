// RE-ARCH: keep
/**
 * Tests for src/pipeline/stages/execution.ts
 *
 * Covers: routeTddFailure, execution stage critical paths
 */

import { describe, expect, it } from "bun:test";
import { routeTddFailure } from "../../../src/pipeline/stages/execution";
import type { FailureCategory } from "../../../src/tdd";

// ─────────────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────────────

interface MockContext {
  retryAsLite?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// routeTddFailure
// ─────────────────────────────────────────────────────────────────────────────

describe("routeTddFailure", () => {
  it("escalates on isolation-violation in strict mode", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("isolation-violation", false, ctx);

    expect(result.action).toBe("escalate");
    expect(ctx.retryAsLite).toBe(true);
  });

  it("escalates on isolation-violation in lite mode without setting retryAsLite", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("isolation-violation", true, ctx);

    expect(result.action).toBe("escalate");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on session-failure", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("session-failure", false, ctx);

    expect(result.action).toBe("escalate");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on tests-failing", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("tests-failing", false, ctx);

    expect(result.action).toBe("escalate");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on verifier-rejected", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("verifier-rejected", false, ctx);

    expect(result.action).toBe("escalate");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("escalates on greenfield-no-tests (tier-escalation will switch to test-after)", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("greenfield-no-tests", false, ctx);

    expect(result.action).toBe("escalate");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on undefined failureCategory", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx, "Unknown failure");

    expect(result.action).toBe("pause");
    expect(result.reason).toBe("Unknown failure");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("pauses on unknown failureCategory", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure("unknown" as FailureCategory, false, ctx);

    expect(result.action).toBe("pause");
    expect(result.reason).toBe("Three-session TDD requires review");
    expect(ctx.retryAsLite).toBeUndefined();
  });

  it("uses custom reviewReason when pausing", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx, "Custom reason for pause");

    expect(result.action).toBe("pause");
    expect(result.reason).toBe("Custom reason for pause");
  });

  it("defaults to generic pause message when no reviewReason provided", () => {
    const ctx: MockContext = {};
    const result = routeTddFailure(undefined, false, ctx);

    expect(result.action).toBe("pause");
    expect(result.reason).toBe("Three-session TDD requires review");
  });

  it("handles all known failure categories correctly", () => {
    const categories: FailureCategory[] = [
      "isolation-violation",
      "session-failure",
      "tests-failing",
      "verifier-rejected",
    ];

    for (const category of categories) {
      const ctx: MockContext = {};
      const result = routeTddFailure(category, false, ctx);
      expect(result.action).toBe("escalate");
    }
  });

  it("only sets retryAsLite for isolation-violation in strict mode", () => {
    const categories: FailureCategory[] = ["session-failure", "tests-failing", "verifier-rejected"];

    for (const category of categories) {
      const ctx: MockContext = {};
      routeTddFailure(category, false, ctx);
      expect(ctx.retryAsLite).toBeUndefined();
    }
  });
});
