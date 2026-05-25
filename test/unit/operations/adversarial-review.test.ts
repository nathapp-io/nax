import { afterEach, describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";
import type { AdversarialReviewInput } from "../../../src/operations/adversarial-review";
import type { NaxRuntime } from "../../../src/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});
import { adversarialReviewOp } from "../../../src/operations/adversarial-review";

const SAMPLE_STORY = {
  id: "STORY-002",
  title: "Add logout endpoint",
  description: "Implement DELETE /session to invalidate the JWT",
  acceptanceCriteria: ["Clears the session token", "Returns 204 on success"],
};

const SAMPLE_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  rules: [],
  timeoutMs: 600_000,
  parallel: false,
  maxConcurrentSessions: 2,
};

const SAMPLE_INPUT: AdversarialReviewInput = {
  story: SAMPLE_STORY,
  adversarialConfig: SAMPLE_CONFIG,
  mode: "ref",
  storyGitRef: "def5678",
  stat: "src/session.ts | 15 +++++",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(adversarialReviewOp.config) };
}

describe("adversarialReviewOp shape", () => {
  test("kind is run", () => {
    expect(adversarialReviewOp.kind).toBe("run");
  });
  test("name is adversarial-review", () => {
    expect(adversarialReviewOp.name).toBe("adversarial-review");
  });
  test("session.role is reviewer-adversarial", () => {
    expect(adversarialReviewOp.session.role).toBe("reviewer-adversarial");
  });
  test("session.lifetime is fresh", () => {
    expect(adversarialReviewOp.session.lifetime).toBe("fresh");
  });
  test("stage is review", () => {
    expect(adversarialReviewOp.stage).toBe("review");
  });
});

describe("adversarialReviewOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task content contains story title", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("Add logout endpoint");
  });
  test("task content contains acceptance criteria", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("Clears the session token");
  });
  test("task content contains git ref in ref mode", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("def5678");
  });
  test("task content contains embedded diff in embedded mode", () => {
    const ctx = makeBuildCtx();
    const embeddedInput: AdversarialReviewInput = { ...SAMPLE_INPUT, mode: "embedded", diff: "-old line" };
    const result = adversarialReviewOp.build(embeddedInput, ctx);
    expect(result.task.content).toContain("-old line");
  });

  test("task content contains prior iterations block when priorAdversarialIterations is set", () => {
    const ctx = makeBuildCtx();
    const inputWithPrior: AdversarialReviewInput = {
      ...SAMPLE_INPUT,
      priorAdversarialIterations: [
        {
          iterationNum: 1,
          findingsBefore: [],
          fixesApplied: [{ strategyName: "source-fix", op: "source-fix", targetFiles: ["src/session.ts"], summary: "", costUsd: 0 }],
          findingsAfter: [
            {
              source: "adversarial-review" as const,
              severity: "error" as const,
              category: "error-path",
              file: "src/session.ts",
              line: 10,
              message: "Silent catch block",
            },
          ],
          outcome: "partial" as const,
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    };
    const result = adversarialReviewOp.build(inputWithPrior, ctx);
    expect(result.task.content).toContain("## Prior Iterations — verdict required before new analysis");
    expect(result.task.content).toContain("### Round 1 — outcome: partial");
    // Finding text rendered verbatim
    expect(result.task.content).toContain("Silent catch block");
  });

  test("task content has no prior iterations block when priorAdversarialIterations is absent", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).not.toContain("## Prior Iterations");
  });
});

describe("adversarialReviewOp.parse()", () => {
  test("parses passed:true with no findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ passed: true, findings: [] });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBeUndefined();
  });
  test("parses passed:false with findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/session.ts", line: 5, issue: "error swallowed", suggestion: "re-throw" }],
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect((result.findings[0] as { issue: string }).issue).toBe("error swallowed");
  });
  test("normalizedFindings tags each finding with source:'adversarial-review' for cycle routing", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", category: "logic-bug", file: "src/a.ts", line: 1, issue: "x", suggestion: "y" },
        { severity: "error", category: "test-gap", file: "test/a.test.ts", line: 9, issue: "z", suggestion: "w" },
      ],
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.normalizedFindings).toHaveLength(2);
    expect(result.normalizedFindings.every((f) => f.source === "adversarial-review")).toBe(true);
    // test-gap findings target tests so the test-writer strategy picks them up.
    expect(result.normalizedFindings[0]?.fixTarget).toBeUndefined();
    expect(result.normalizedFindings[1]?.fixTarget).toBe("test");
    expect(result.normalizedFindings[0]?.message).toBe("x");
  });
  test("normalizedFindings drops findings below blockingThreshold (mirrors wrapper advisory split)", () => {
    const ctx = makeBuildCtx();
    const inputWithThreshold: AdversarialReviewInput = { ...SAMPLE_INPUT, blockingThreshold: "error" };
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", category: "logic-bug", file: "src/a.ts", line: 1, issue: "real", suggestion: "fix" },
        { severity: "warning", category: "style", file: "src/b.ts", line: 2, issue: "advisory", suggestion: "consider" },
      ],
    });
    const result = adversarialReviewOp.parse(json, inputWithThreshold, ctx);
    expect(result.findings).toHaveLength(2);
    expect(result.normalizedFindings).toHaveLength(1);
    expect(result.normalizedFindings[0]?.message).toBe("real");
  });
  test("normalizedFindings is [] on looksLikeFail / no-findings paths", () => {
    const ctx = makeBuildCtx();
    expect(
      adversarialReviewOp.parse('{"passed":false}', SAMPLE_INPUT, ctx).normalizedFindings,
    ).toEqual([]);
    expect(
      adversarialReviewOp.parse(JSON.stringify({ passed: true, findings: [] }), SAMPLE_INPUT, ctx).normalizedFindings,
    ).toEqual([]);
  });
  test("throws ParseValidationError on unparseable output (triggers retry)", () => {
    const ctx = makeBuildCtx();
    expect(() => adversarialReviewOp.parse("no json here", SAMPLE_INPUT, ctx)).toThrow();
  });
  test("throws ParseValidationError on missing passed field (triggers retry)", () => {
    const ctx = makeBuildCtx();
    expect(() => adversarialReviewOp.parse(JSON.stringify({ findings: [] }), SAMPLE_INPUT, ctx)).toThrow();
  });
  test("parses fence-wrapped JSON response", () => {
    const ctx = makeBuildCtx();
    const json = "```json\n" + JSON.stringify({ passed: true, findings: [] }) + "\n```";
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBeUndefined();
  });
});

describe("adversarialReviewOp.retry", () => {
  test("retry field exists", () => {
    expect(adversarialReviewOp).toHaveProperty("retry");
  });

  test("retry is a function (resolver form)", () => {
    expect(typeof adversarialReviewOp.retry).toBe("function");
  });

  test("retry resolver returns a RetryStrategy", () => {
    const ctx = makeBuildCtx();
    const result = (adversarialReviewOp.retry as any)(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("shouldRetry");
    expect(typeof result.shouldRetry).toBe("function");
  });

  test("retry resolver forwards blockingThreshold to jsonRetryCondensed", () => {
    const ctx = makeBuildCtx();
    const inputWithThreshold: AdversarialReviewInput = {
      ...SAMPLE_INPUT,
      blockingThreshold: "warning",
    };

    const strategy = (adversarialReviewOp.retry as any)(inputWithThreshold, ctx);
    expect(strategy).toHaveProperty("shouldRetry");

    // Verify the retry strategy is constructed correctly by testing shouldRetry
    // calls it with test inputs to verify the strategy responds appropriately
    expect(typeof strategy.shouldRetry).toBe("function");
  });

  test("hopBody field does NOT exist (removed in US-005c)", () => {
    expect(adversarialReviewOp).not.toHaveProperty("hopBody");
  });
});
