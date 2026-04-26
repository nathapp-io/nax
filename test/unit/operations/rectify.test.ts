import { describe, expect, test } from "bun:test";
import { makeTestRuntime } from "../../helpers";
import { makeStory } from "../../helpers";
import type { RectifyInput } from "../../../src/operations/rectify";
import { rectifyOp } from "../../../src/operations/rectify";

const SAMPLE_STORY = makeStory({
  id: "US-001",
  title: "Add validation",
  description: "Add input validation to the API",
  acceptanceCriteria: ["Rejects empty input", "Returns 400 with message"],
});

const SAMPLE_INPUT: RectifyInput = {
  failedChecks: [
    {
      check: "semantic",
      success: false,
      command: "",
      exitCode: 1,
      output: "Semantic review failed:\n[error] src/api.ts:5 — missing null check",
      durationMs: 100,
      findings: [],
    },
  ],
  story: SAMPLE_STORY,
};

function makeBuildCtx() {
  const runtime = makeTestRuntime();
  const view = runtime.packages.repo();
  return { packageView: view, config: view.select(rectifyOp.config) };
}

describe("rectifyOp shape", () => {
  test("kind is run", () => {
    expect(rectifyOp.kind).toBe("run");
  });
  test("name is rectify", () => {
    expect(rectifyOp.name).toBe("rectify");
  });
  test("session.role is implementer", () => {
    expect(rectifyOp.session.role).toBe("implementer");
  });
  test("session.lifetime is fresh", () => {
    expect(rectifyOp.session.lifetime).toBe("fresh");
  });
  test("stage is review", () => {
    expect(rectifyOp.stage).toBe("review");
  });
});

describe("rectifyOp.build()", () => {
  test("returns ComposeInput with task section", () => {
    const ctx = makeBuildCtx();
    const result = rectifyOp.build(SAMPLE_INPUT, ctx);
    expect(result).toHaveProperty("task");
  });
  test("task content contains story title", () => {
    const ctx = makeBuildCtx();
    const result = rectifyOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("Add validation");
  });
  test("task content contains failed check output", () => {
    const ctx = makeBuildCtx();
    const result = rectifyOp.build(SAMPLE_INPUT, ctx);
    expect(result.task.content).toContain("missing null check");
  });
  test("task content with mechanical check contains error output", () => {
    const ctx = makeBuildCtx();
    const mechanicalInput: RectifyInput = {
      ...SAMPLE_INPUT,
      failedChecks: [
        {
          check: "lint",
          success: false,
          command: "bun run lint",
          exitCode: 1,
          output: "error: unused variable 'x'",
          durationMs: 50,
        },
      ],
    };
    const result = rectifyOp.build(mechanicalInput, ctx);
    expect(result.task.content).toContain("unused variable");
  });
});

describe("rectifyOp.parse()", () => {
  test("returns applied:true regardless of output", () => {
    const ctx = makeBuildCtx();
    const result = rectifyOp.parse("Fixes applied and committed.", SAMPLE_INPUT, ctx);
    expect(result.applied).toBe(true);
  });
  test("returns applied:true for empty output", () => {
    const ctx = makeBuildCtx();
    const result = rectifyOp.parse("", SAMPLE_INPUT, ctx);
    expect(result.applied).toBe(true);
  });
});
