import { describe, expect, test } from "bun:test";
import type { Debater, Proposal, Rebuttal } from "../../../src/debate/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { debateRankOp } from "../../../src/operations/debate-rank";

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
  { debater: debaters[0], output: "prop-alpha" },
  { debater: debaters[1], output: "prop-beta" },
];
const critiques: Rebuttal[] = [];

describe("debateRankOp", () => {
  test("kind is complete", () => {
    expect(debateRankOp.kind).toBe("complete");
  });

  test("name matches op identity", () => {
    expect(debateRankOp.name).toBe("debate-rank");
  });

  test("stage is review", () => {
    expect(debateRankOp.stage).toBe("review");
  });

  test("build includes all proposals", () => {
    const input = {
      taskContext: "task",
      outputFormat: "json",
      stage: "review",
      proposals,
      critiques,
      debaters,
    };
    const result = debateRankOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("prop-alpha");
    expect(result.task.content).toContain("prop-beta");
  });

  test("build includes promptSuffix when provided", () => {
    const input = {
      taskContext: "task",
      outputFormat: "json",
      stage: "plan",
      proposals,
      critiques,
      debaters,
      promptSuffix: "Output raw JSON only.",
    };
    const result = debateRankOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("Output raw JSON only.");
  });

  test("parse returns the raw output string unchanged", () => {
    const parsed = debateRankOp.parse("synthesized output", {} as any, makeBuildCtx());
    expect(parsed).toBe("synthesized output");
  });

  test("task and role section ids are correct", () => {
    const input = { taskContext: "t", outputFormat: "f", stage: "review", proposals, critiques, debaters };
    const result = debateRankOp.build(input, makeBuildCtx());
    expect(result.task.id).toBe("task");
    expect(result.role.id).toBe("role");
  });

  test("build constructs prompt with task context and output format", () => {
    const input = {
      taskContext: "Evaluate the proposals",
      outputFormat: "Rank 1-2, best first",
      stage: "review",
      proposals,
      critiques,
      debaters,
    };
    const result = debateRankOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("Evaluate the proposals");
    expect(result.task.content).toContain("Rank 1-2, best first");
  });

  test("build works with critiques in input", () => {
    const critiquesWithData: Rebuttal[] = [
      { debater: debaters[0], output: "critique-1", round: 1 },
      { debater: debaters[1], output: "critique-2", round: 1 },
    ];
    const input = {
      taskContext: "task",
      outputFormat: "json",
      stage: "review",
      proposals,
      critiques: critiquesWithData,
      debaters,
    };
    const result = debateRankOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("prop-alpha");
    expect(result.task.content).toContain("prop-beta");
  });
});
