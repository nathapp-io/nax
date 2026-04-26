import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";
import type { SemanticReviewInput } from "../../../src/operations/semantic-review";
import { semanticReviewOp } from "../../../src/operations/semantic-review";

const SAMPLE_STORY = {
  id: "STORY-001",
  title: "Add login endpoint",
  description: "Implement POST /login returning a JWT",
  acceptanceCriteria: ["Returns 200 on valid credentials", "Returns 401 on invalid credentials"],
};

const SAMPLE_CONFIG = {
  modelTier: "balanced" as const,
  diffMode: "ref" as const,
  resetRefOnRerun: false,
  rules: [],
  timeoutMs: 600_000,
};

const SAMPLE_INPUT: SemanticReviewInput = {
  story: SAMPLE_STORY,
  semanticConfig: SAMPLE_CONFIG,
  mode: "ref",
  storyGitRef: "abc1234",
  stat: "src/auth.ts | 20 +++++",
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
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
    expect(result.findings[0].severity).toBe("error");
  });
  test("fails open on unparseable output", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse("not json", SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBe(true);
  });
  test("fails open on missing passed field", () => {
    const ctx = makeBuildCtx();
    const result = semanticReviewOp.parse(JSON.stringify({ findings: [] }), SAMPLE_INPUT, ctx);
    expect(result.failOpen).toBe(true);
  });
});
