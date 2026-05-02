import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";
import type { AdversarialReviewInput } from "../../../src/operations/adversarial-review";
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

  test("task content contains prior findings block when priorAdversarialFindings is set", () => {
    const ctx = makeBuildCtx();
    const inputWithPrior: AdversarialReviewInput = {
      ...SAMPLE_INPUT,
      priorAdversarialFindings: {
        round: 2,
        findings: [
            {
              source: "adversarial-review",
              severity: "error",
              category: "error-path",
              file: "src/session.ts",
              line: 10,
              message: "Silent catch block",
            },
          ],
      },
    };
    const result = adversarialReviewOp.build(inputWithPrior, ctx);
    expect(result.task.content).toContain("Prior Adversarial Findings — Round 2");
    expect(result.task.content).toContain("Silent catch block");
  });

  test("task content has no prior findings block when priorAdversarialFindings is absent", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).not.toContain("Prior Adversarial Findings");
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
    expect(result.findings[0].issue).toBe("error swallowed");
  });
  test("fails open on unparseable output", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.parse("no json here", SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.failOpen).toBe(true);
  });
  test("fails open on missing passed field", () => {
    const ctx = makeBuildCtx();
    const result = adversarialReviewOp.parse(JSON.stringify({ findings: [] }), SAMPLE_INPUT, ctx);
    expect(result.failOpen).toBe(true);
  });
  test("parses fence-wrapped JSON response", () => {
    const ctx = makeBuildCtx();
    const json = "```json\n" + JSON.stringify({ passed: true, findings: [] }) + "\n```";
    const result = adversarialReviewOp.parse(json, SAMPLE_INPUT, ctx);
    expect(result.passed).toBe(true);
    expect(result.failOpen).toBeUndefined();
  });
});
