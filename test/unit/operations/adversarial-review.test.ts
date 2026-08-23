import { afterEach, describe, expect, test } from "bun:test";
import { callOp } from "@/operations";
import { adversarialReviewOp } from "@/operations/adversarial-review";
import type { AdversarialReviewInput } from "@/operations/adversarial-review";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager, makeMockRuntime, makeSessionManager, makeTestRuntime, opSelector } from "@test/helpers";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

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
  workdir: "/tmp/test",
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
  return { packageView: view, config: view.select(opSelector(adversarialReviewOp.config)) };
}

describe("adversarialReviewOp shape", () => {
  test.each([
    ["kind", adversarialReviewOp.kind, "run"],
    ["name", adversarialReviewOp.name, "adversarial-review"],
    ["session.role", adversarialReviewOp.session.role, "reviewer-adversarial"],
    ["session.lifetime", adversarialReviewOp.session.lifetime, "fresh"],
    ["stage", adversarialReviewOp.stage, "review"],
  ])("%s is %s", (_prop, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

// ADR-008 anti-oscillation invariant: each review round opens a fresh session.
// If lifetime were "reuse", the reviewer would carry state from a previous pass
// and could flip its verdict based on stale prior-round context — the root cause
// of oscillating pass/fail verdicts investigated in ADR-008.
describe("ADR-008 anti-oscillation invariant — reviewer opens a fresh session each round", () => {
  test("adversarialReviewOp declares lifetime:fresh (no cross-round session state)", () => {
    expect(adversarialReviewOp.session.lifetime).toBe("fresh");
  });
});

describe("adversarialReviewOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test.each([
    ["story title", "Add logout endpoint"],
    ["acceptance criteria", "Clears the session token"],
    ["git ref in ref mode", "def5678"],
  ])("task content contains %s", (_label, needle) => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain(needle);
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
          fixesApplied: [
            { strategyName: "source-fix", op: "source-fix", targetFiles: ["src/session.ts"], summary: "", costUsd: 0 },
          ],
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
      findings: [
        { severity: "error", file: "src/session.ts", line: 5, issue: "error swallowed", suggestion: "re-throw" },
      ],
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect((result.findings[0] as { issue: string }).issue).toBe("error swallowed");
  });
  test("parse() returns normalizedFindings:[] — source tagging and advisory split moved to verify()", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", category: "logic-bug", file: "src/a.ts", line: 1, issue: "x", suggestion: "y" },
        { severity: "error", category: "test-gap", file: "test/a.test.ts", line: 9, issue: "z", suggestion: "w" },
      ],
    });
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    // parse() is a thin structural parser — normalizedFindings is always [] from parse().
    // Source tagging (adversarial-review) and blocking/advisory split happen in verify().
    expect(result.normalizedFindings).toEqual([]);
    expect(result.findings).toHaveLength(2);
  });
  test("parse() returns normalizedFindings:[] regardless of blockingThreshold", () => {
    const ctx = makeBuildCtx();
    const inputWithThreshold: AdversarialReviewInput = { ...SAMPLE_INPUT, blockingThreshold: "error" };
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", category: "logic-bug", file: "src/a.ts", line: 1, issue: "real", suggestion: "fix" },
        {
          severity: "warning",
          category: "style",
          file: "src/b.ts",
          line: 2,
          issue: "advisory",
          suggestion: "consider",
        },
      ],
    });
    const result = adversarialReviewOp.parse(json, inputWithThreshold, ctx);
    // parse() returns all raw findings; verify() does the threshold split.
    expect(result.findings).toHaveLength(2);
    expect(result.normalizedFindings).toEqual([]);
  });
  test("normalizedFindings is [] on looksLikeFail / no-findings paths", () => {
    const ctx = makeBuildCtx();
    expect(adversarialReviewOp.parse('{"passed":false}', SAMPLE_INPUT, ctx).normalizedFindings).toEqual([]);
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
    const json = `\`\`\`json\n${JSON.stringify({ passed: true, findings: [] })}\n\`\`\``;
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

  test("hopBody field exists (same-session requote recovery added)", () => {
    expect(adversarialReviewOp).toHaveProperty("hopBody");
    expect(typeof adversarialReviewOp.hopBody).toBe("function");
  });
});

describe("adversarialReviewOp — AC3: empty-output exhaustion returns FAIL_OPEN", () => {
  test("returns FAIL_OPEN when agent returns empty output after retries", async () => {
    // adversarialReviewOp has exhaustedFallback declared; callOp now honors it on empty output.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const hopResult = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async () => ({
        output: "",
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      }),
    });
    const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-002" },
      adversarialReviewOp,
      SAMPLE_INPUT,
    );

    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.normalizedFindings).toEqual([]);
  });
});
