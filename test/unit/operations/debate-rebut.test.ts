import { describe, expect, test } from "bun:test";
import type { Debater, Proposal } from "../../../src/debate/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { debateRebutOp } from "../../../src/operations/debate-rebut";

function makeBuildCtx() {
  return {
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG.debate } as any,
    config: DEFAULT_CONFIG.debate,
  };
}

const debaters: Debater[] = [
  { agent: "claude", model: "fast" },
  { agent: "opencode", model: "fast" },
];
const proposals: Proposal[] = [
  { debater: debaters[0], output: "proposal-a" },
  { debater: debaters[1], output: "proposal-b" },
];

describe("debateRebutOp", () => {
  test("kind is complete", () => {
    expect(debateRebutOp.kind).toBe("complete");
  });

  test("name matches op identity", () => {
    expect(debateRebutOp.name).toBe("debate-rebut");
  });

  test("stage is review", () => {
    expect(debateRebutOp.stage).toBe("review");
  });

  test("model resolves from selected debater", () => {
    const input = {
      taskContext: "review code changes",
      stage: "review",
      debaterIndex: 1,
      proposals,
      debaters,
    };
    expect(debateRebutOp.model?.(input, makeBuildCtx())).toEqual({
      agent: "opencode",
      model: "fast",
    });
  });

  test("model falls back to fast for invalid debater index", () => {
    const input = {
      taskContext: "review code changes",
      stage: "review",
      debaterIndex: 99,
      proposals,
      debaters,
    };
    expect(debateRebutOp.model?.(input, makeBuildCtx())).toBe("fast");
  });

  test("build returns ComposeInput with rebuttal prompt", () => {
    const input = {
      taskContext: "review code changes",
      stage: "review",
      debaterIndex: 0,
      proposals,
      debaters,
    };
    const ctx = makeBuildCtx();
    const result = debateRebutOp.build(input, ctx);
    expect(result.task.id).toBe("task");
    expect(result.role.id).toBe("role");
    expect(result.task.content).toBeTruthy();
  });

  test("build excludes the calling debater's own proposal", () => {
    const input = {
      taskContext: "task",
      stage: "review",
      debaterIndex: 0,
      proposals,
      debaters,
    };
    const result = debateRebutOp.build(input, makeBuildCtx());
    // Debater 0 should NOT see proposal-a (own proposal)
    expect(result.task.content).not.toContain("proposal-a");
    expect(result.task.content).toContain("proposal-b");
  });

  test("build for debater 1 excludes debater 1's proposal", () => {
    const input = {
      taskContext: "task",
      stage: "review",
      debaterIndex: 1,
      proposals,
      debaters,
    };
    const result = debateRebutOp.build(input, makeBuildCtx());
    // Debater 1 should NOT see proposal-b (own proposal)
    expect(result.task.content).not.toContain("proposal-b");
    expect(result.task.content).toContain("proposal-a");
  });

  test("parse returns the raw output string unchanged", () => {
    const output = "rebuttal critique text";
    const parsed = debateRebutOp.parse(output, {} as any, makeBuildCtx());
    expect(parsed).toBe(output);
  });

  test("debater with persona includes persona in prompt", () => {
    const debatersWithPersona: Debater[] = [
      { agent: "claude", model: "fast", persona: "challenger" },
      { agent: "opencode", model: "fast", persona: "pragmatist" },
    ];
    const input = {
      taskContext: "task context",
      stage: "review",
      debaterIndex: 1,
      proposals,
      debaters: debatersWithPersona,
    };
    const result = debateRebutOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("pragmatist");
  });
});
