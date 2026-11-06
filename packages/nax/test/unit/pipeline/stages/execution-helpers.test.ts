/**
 * Unit tests for `src/pipeline/stages/execution-helpers.ts`.
 *
 * The three helpers here are retained after the default-pipeline cut (US-002)
 * and are deleted with their module in US-003. Until then this file is the
 * module's own test suite: the two suites that used to reach these helpers
 * through the deleted `execution.ts` re-export are gone, and nothing else in
 * `test/` references them.
 */

import { describe, expect, test } from "bun:test";
import { makeAgentAdapter } from "@test/helpers";
import { resolveExecutionAgent, resolveStoryWorkdir, routeTddFailure } from "@/pipeline/stages/execution-helpers";
import type { FailureCategory } from "@/tdd/types";

const fakeAdapter = (name: string) => makeAgentAdapter({ name });

describe("resolveExecutionAgent", () => {
  test("uses the routed agent when its adapter resolves", () => {
    const result = resolveExecutionAgent({
      routedAgent: "opencode",
      defaultAgent: "claude",
      getAgent: (n: string) => (n === "opencode" ? fakeAdapter("opencode") : undefined),
    });
    expect(result.agentName).toBe("opencode");
    expect(result.degraded).toBe(false);
    expect(result.agent).toBeDefined();
  });

  test("degrades to the default agent when the routed agent is unresolvable", () => {
    const result = resolveExecutionAgent({
      routedAgent: "ghost",
      defaultAgent: "claude",
      getAgent: (n: string) => (n === "claude" ? fakeAdapter("claude") : undefined),
    });
    expect(result.agentName).toBe("claude");
    expect(result.degraded).toBe(true);
    expect(result.agent).toBeDefined();
  });

  test("uses the default agent when no routed agent is set", () => {
    const result = resolveExecutionAgent({
      routedAgent: undefined,
      defaultAgent: "claude",
      getAgent: (n: string) => (n === "claude" ? fakeAdapter("claude") : undefined),
    });
    expect(result.agentName).toBe("claude");
    expect(result.degraded).toBe(false);
  });

  test("returns undefined adapter (degraded) when neither resolves", () => {
    const result = resolveExecutionAgent({
      routedAgent: "ghost",
      defaultAgent: "claude",
      getAgent: () => undefined,
    });
    expect(result.agentName).toBe("claude");
    expect(result.agent).toBeUndefined();
    expect(result.degraded).toBe(true);
  });
});

describe("resolveStoryWorkdir (MW-002)", () => {
  test("returns repoRoot unchanged when storyWorkdir is undefined", () => {
    expect(resolveStoryWorkdir("/tmp")).toBe("/tmp");
  });

  test("returns repoRoot unchanged when storyWorkdir is empty string", () => {
    expect(resolveStoryWorkdir("/tmp", "")).toBe("/tmp");
  });

  test("joins repoRoot with storyWorkdir when directory exists", () => {
    // /tmp always exists — use it as the package dir
    expect(resolveStoryWorkdir("/", "tmp")).toBe("/tmp");
  });

  test("throws when storyWorkdir does not exist on disk", () => {
    expect(() => resolveStoryWorkdir("/tmp", "nonexistent-package-xyz")).toThrow(
      'story workdir "nonexistent-package-xyz" does not exist',
    );
  });
});

describe("routeTddFailure", () => {
  /** Minimal context stub — only retryAsLite is read */
  function makeCtx(): { retryAsLite?: boolean } {
    return {};
  }

  describe("isolation-violation", () => {
    test("strict mode sets retryAsLite=true; lite mode does not", () => {
      const ctx1 = makeCtx();
      expect(routeTddFailure("isolation-violation", false, ctx1, "isolation error").action).toBe("escalate");
      expect(ctx1.retryAsLite).toBe(true);

      const ctx2 = makeCtx();
      expect(routeTddFailure("isolation-violation", true, ctx2, "isolation error lite").action).toBe("escalate");
      expect(ctx2.retryAsLite).toBeUndefined();
    });
  });

  describe("escalating categories", () => {
    test("all escalate without setting retryAsLite", () => {
      for (const cat of [
        "tests-failing",
        "full-suite-gate-exhausted",
        "verifier-rejected",
        "runtime-crash",
        "review-incomplete",
        "greenfield-no-tests",
      ] as const) {
        const ctx = makeCtx();
        const result = routeTddFailure(cat, false, ctx, `${cat} reason`);
        expect(result.action, cat).toBe("escalate");
        if (result.action === "escalate") expect(result.reason).toBe(`TDD ${cat}`);
        expect(ctx.retryAsLite, cat).toBeUndefined();
      }
    });

    test("the failure detail is carried into the escalation reason", () => {
      const result = routeTddFailure("tests-failing", false, makeCtx(), undefined, "  3 assertions failed  ");
      expect(result.action).toBe("escalate");
      if (result.action === "escalate") expect(result.reason).toBe("TDD tests-failing: 3 assertions failed");
    });

    test("a blank failure detail falls back to the bare category", () => {
      const result = routeTddFailure("tests-failing", false, makeCtx(), undefined, "   ");
      expect(result.action).toBe("escalate");
      if (result.action === "escalate") expect(result.reason).toBe("TDD tests-failing");
    });
  });

  describe("no-tests-authored", () => {
    test("escalates with the test-authoring directive", () => {
      const result = routeTddFailure("no-tests-authored", false, makeCtx());
      expect(result.action).toBe("escalate");
      if (result.action === "escalate") expect(result.reason).toContain("You MUST write tests covering every");
    });
  });

  describe("pausing categories", () => {
    test("test-incorrect pauses with the verifier review reason", () => {
      const result = routeTddFailure("test-incorrect", false, makeCtx(), "Assertion conflicts with AC7");
      expect(result.action).toBe("pause");
      if (result.action === "pause") expect(result.reason).toBe("Assertion conflicts with AC7");
    });

    test("test-incorrect without a review reason pauses on the review default", () => {
      const result = routeTddFailure("test-incorrect", false, makeCtx());
      expect(result.action).toBe("pause");
      if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
    });

    test("dependency-prep pauses for human review", () => {
      const result = routeTddFailure("dependency-prep", false, makeCtx());
      expect(result.action).toBe("pause");
      if (result.action === "pause") expect(result.reason).toBe("Three-session TDD requires review");
    });
  });

  describe("no failureCategory (backward compat)", () => {
    test("undefined category → pause with reviewReason, default message, and in lite mode", () => {
      const r1 = routeTddFailure(undefined, false, makeCtx(), "human review needed");
      expect(r1.action).toBe("pause");
      if (r1.action === "pause") expect(r1.reason).toBe("human review needed");

      const r2 = routeTddFailure(undefined, false, makeCtx());
      expect(r2.action).toBe("pause");
      if (r2.action === "pause") expect(r2.reason).toBe("Three-session TDD requires review");

      expect(routeTddFailure(undefined, true, makeCtx(), "lite mode no category").action).toBe("pause");
    });
  });

  describe("retryAsLite is not set for non-isolation failures", () => {
    const nonIsolationCategories: Array<FailureCategory | undefined> = [
      "session-failure",
      "tests-failing",
      "test-incorrect",
      "full-suite-gate-exhausted",
      "verifier-rejected",
      "runtime-crash",
      "review-incomplete",
      "greenfield-no-tests",
      "no-tests-authored",
      "dependency-prep",
      undefined,
    ];

    for (const category of nonIsolationCategories) {
      test(`category=${category ?? "undefined"} does not set retryAsLite`, () => {
        const ctx = makeCtx();
        routeTddFailure(category, false, ctx);
        expect(ctx.retryAsLite).toBeUndefined();
      });
    }
  });
});
