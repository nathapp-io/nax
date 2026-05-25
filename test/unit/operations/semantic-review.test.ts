import { afterEach, describe, expect, test } from "bun:test";
import type { Iteration } from "../../../src/findings";
import { makeTestRuntime } from "../../helpers";
import type { SemanticReviewInput } from "../../../src/operations/semantic-review";
import type { NaxRuntime } from "../../../src/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});
import { semanticReviewOp } from "../../../src/operations/semantic-review";

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
  test("kind is run", () => {
    expect(semanticReviewOp.kind).toBe("run");
  });
  test("name is semantic-review", () => {
    expect(semanticReviewOp.name).toBe("semantic-review");
  });
  test("session.role is reviewer-semantic", () => {
    expect(semanticReviewOp.session.role).toBe("reviewer-semantic");
  });
  test("session.lifetime is fresh", () => {
    expect(semanticReviewOp.session.lifetime).toBe("fresh");
  });
  test("stage is review", () => {
    expect(semanticReviewOp.stage).toBe("review");
  });
});

describe("semanticReviewOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task content contains story title", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("Add login endpoint");
  });
  test("task content contains acceptance criteria", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("Returns 200 on valid credentials");
  });
  test("task content contains git ref in ref mode", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("abc1234");
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
  test("normalizedFindings tags each finding with source:'semantic-review' for cycle routing", () => {
    const ctx = makeBuildCtx();
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "x", suggestion: "y", acIndex: 1 },
        { severity: "error", file: "src/b.ts", line: 2, issue: "z", suggestion: "w", acIndex: 2 },
      ],
    });
    const result = semanticReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.normalizedFindings).toHaveLength(2);
    expect(result.normalizedFindings.every((f) => f.source === "semantic-review")).toBe(true);
    expect(result.normalizedFindings.every((f) => f.fixTarget === "source")).toBe(true);
    // LLM-shape `issue` projected onto Finding `message`
    expect(result.normalizedFindings[0]?.message).toBe("x");
  });
  test("normalizedFindings drops findings below blockingThreshold (mirrors wrapper advisory split)", () => {
    const ctx = makeBuildCtx();
    const inputWithThreshold: SemanticReviewInput = { ...SAMPLE_INPUT, blockingThreshold: "error" };
    const json = JSON.stringify({
      passed: false,
      findings: [
        { severity: "error", file: "src/a.ts", line: 1, issue: "real", suggestion: "fix" },
        { severity: "warning", file: "src/b.ts", line: 2, issue: "advisory", suggestion: "consider" },
        { severity: "info", file: "src/c.ts", line: 3, issue: "fyi", suggestion: "noop" },
      ],
    });
    const result = semanticReviewOp.parse(json, inputWithThreshold, ctx);
    // Raw `findings` retains all three for the wrapper's downstream processing.
    expect(result.findings).toHaveLength(3);
    // normalizedFindings (consumed by rectification) only carries the blocking one.
    expect(result.normalizedFindings).toHaveLength(1);
    expect(result.normalizedFindings[0]?.message).toBe("real");
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
