import { afterEach, describe, expect, test } from "bun:test";
import type { Iteration } from "@/findings";
import { callOp } from "@/operations";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { SemanticReviewInput } from "@/operations/semantic-review";
import type { NaxRuntime } from "@/runtime";
import { makeMockAgentManager, makeMockRuntime, makeSessionManager, makeTestRuntime } from "@test/helpers";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const SAMPLE_STORY = {
  id: "STORY-001",
  title: "Add login endpoint",
  description: "Implement POST /login returning a JWT",
  acceptanceCriteria: ["Returns 200 on valid credentials", "Returns 401 on invalid credentials"],
};

const SAMPLE_CONFIG = {
  model: "balanced" as const,
  diffMode: "ref" as const,
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 600_000,
  substantiation: { requote: true, maxRequotes: 5 },
};

const SAMPLE_INPUT: SemanticReviewInput = {
  workdir: "/tmp/wd",
  story: SAMPLE_STORY,
  semanticConfig: SAMPLE_CONFIG,
  mode: "ref",
  storyGitRef: "abc1234",
  stat: "src/auth.ts | 20 +++++",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(semanticReviewOp.config) };
}

describe("semanticReviewOp shape", () => {
  test.each([
    ["kind", semanticReviewOp.kind, "run"],
    ["name", semanticReviewOp.name, "semantic-review"],
    ["session.role", semanticReviewOp.session.role, "reviewer-semantic"],
    ["session.lifetime", semanticReviewOp.session.lifetime, "fresh"],
    ["stage", semanticReviewOp.stage, "review"],
  ])("%s is %s", (_prop, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

// ADR-008 anti-oscillation invariant: each review round opens a fresh session.
// If lifetime were "reuse", the reviewer would carry state from a previous pass
// and could flip its verdict based on stale prior-round context — the root cause
// of oscillating pass/fail verdicts investigated in ADR-008.
describe("ADR-008 anti-oscillation invariant — reviewer opens a fresh session each round", () => {
  test("semanticReviewOp declares lifetime:fresh (no cross-round session state)", () => {
    expect(semanticReviewOp.session.lifetime).toBe("fresh");
  });
});

describe("semanticReviewOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test.each([
    ["story title", "Add login endpoint"],
    ["acceptance criteria", "Returns 200 on valid credentials"],
    ["git ref in ref mode", "abc1234"],
  ])("task content contains %s", (_label, needle) => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain(needle);
  });
  test("task content contains embedded diff in embedded mode", () => {
    const ctx = makeBuildCtx();
    const embeddedInput: SemanticReviewInput = { ...SAMPLE_INPUT, mode: "embedded", diff: "+const x = 1;" };
    const result = semanticReviewOp.build(embeddedInput, ctx);
    expect(result.task.content).toContain("+const x = 1;");
  });
});

describe("semanticReviewOp.build() — priorSemanticIterations", () => {
  test("includes prior iterations block when priorSemanticIterations has entries", () => {
    const ctx = makeBuildCtx();
    const iteration: Iteration = {
      iterationNum: 1,
      findingsBefore: [],
      fixesApplied: [],
      findingsAfter: [
        { source: "semantic-review", message: "handler not wired", severity: "error", category: "ac-coverage" },
      ],
      outcome: "partial",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:01.000Z",
    };
    const inputWithIterations: SemanticReviewInput = {
      ...SAMPLE_INPUT,
      priorSemanticIterations: [iteration],
    };
    const result = semanticReviewOp.build(inputWithIterations, ctx);
    expect(result.task.content).toContain("## Prior Iterations — verdict required before new analysis");
    expect(result.task.content).toContain("### Round 1 — outcome: partial");
    // Finding text rendered verbatim
    expect(result.task.content).toContain("handler not wired");
  });

  test("omits prior iterations block when priorSemanticIterations is undefined", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).not.toContain("## Prior Iterations");
  });
});

describe("semanticReviewOp.parse()", () => {
  test("parses passed:true with no findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({ passed: true, findings: [] });
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBeUndefined();
  });
  test("parses passed:false with findings", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [{ severity: "error", file: "src/auth.ts", line: 10, issue: "missing check", suggestion: "add guard" }],
    });
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect((result.findings[0] as { severity: string }).severity).toBe("error");
  });
  test("returns fail-open for unparseable output (retry handled in hopBody, not callOp parse)", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse("not json", SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
  });
  test("returns fail-open for missing passed field (retry handled in hopBody, not callOp parse)", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse(JSON.stringify({ findings: [] }), SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
  });
  test("parses fence-wrapped JSON response", () => {
    const ctx = makeBuildCtx();
    const json = "```json\n" + JSON.stringify({ passed: true, findings: [] }) + "\n```";
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBeUndefined();
  });
  test("parse() returns normalizedFindings:[] — advisory split moved to verify()", () => {
    // parse() is no longer responsible for the advisory split or source-tagging.
    // Those responsibilities moved to verify(), which runs the full filter pipeline
    // (sanitize → substantiate → AC-ground → blocking split). Tests for that
    // pipeline live in test/unit/operations/semantic-review-verify.test.ts.
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "x", suggestion: "y", acIndex: 1 },
        { severity: "warning", file: "src/b.ts", line: 2, issue: "advisory", suggestion: "consider" },
      ],
    });
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    // Raw findings preserved for verify() to process.
    expect(result.findings).toHaveLength(2);
    // normalizedFindings is always [] from parse(); populated only after verify() runs.
    expect(result.normalizedFindings).toEqual([]);
  });
  test("normalizedFindings is [] on fail-open / looksLikeFail / no-findings paths", () => {
    const ctx = makeBuildCtx();
    expect(semanticReviewOp.parse("not json", SAMPLE_INPUT, ctx).normalizedFindings).toEqual([]);
    expect(semanticReviewOp.parse('{"passed":false}', SAMPLE_INPUT, ctx).normalizedFindings).toEqual([]);
    expect(
      semanticReviewOp.parse(JSON.stringify({ passed: true, findings: [] }), SAMPLE_INPUT, ctx).normalizedFindings,
    ).toEqual([]);
  });
});

describe("semanticReviewOp.hopBody", () => {
  test("hopBody field exists (semantic uses multi-turn for requote recovery)", () => {
    expect(semanticReviewOp).toHaveProperty("hopBody");
  });

  test("hopBody is an async function", () => {
    expect(typeof semanticReviewOp.hopBody).toBe("function");
  });

  test("retry field exists (parse-retry SSOT)", () => {
    expect(semanticReviewOp).toHaveProperty("retry");
  });
});

describe("semanticReviewOp — AC4: empty-output exhaustion returns FAIL_OPEN", () => {
  test("returns FAIL_OPEN when agent returns empty output after retries", async () => {
    // semanticReviewOp now has exhaustedFallback; empty-output exhaustion should
    // produce the same FAIL_OPEN that parse failure already produces.
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
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      semanticReviewOp,
      SAMPLE_INPUT,
    );

    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.normalizedFindings).toEqual([]);
  });

  test("parse-failure path still returns FAIL_OPEN — no regression", () => {
    // Direct parse call with unparseable output should still return FAIL_OPEN (existing behavior).
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse("not json at all", SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBe(true);
    expect(result.normalizedFindings).toEqual([]);
  });
});
