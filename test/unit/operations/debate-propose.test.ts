import { describe, expect, test } from "bun:test";
import type { Debater } from "../../../src/debate/types";
import { DEFAULT_CONFIG } from "../../../src/config";
import { debateProposeOp } from "../../../src/operations/debate-propose";

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

describe("debateProposeOp", () => {
  test("kind is complete", () => {
    expect(debateProposeOp.kind).toBe("complete");
  });

  test("name matches op identity", () => {
    expect(debateProposeOp.name).toBe("debate-propose");
  });

  test("stage is review", () => {
    expect(debateProposeOp.stage).toBe("review");
  });

  test("build returns ComposeInput with proposal prompt", () => {
    const input = {
      taskContext: "implement X",
      outputFormat: "json",
      stage: "review",
      debaterIndex: 0,
      debaters,
    };
    const ctx = makeBuildCtx();
    const result = debateProposeOp.build(input, ctx);
    expect(result.task.content).toContain("implement X");
    expect(result.task.id).toBe("task");
    expect(result.role.id).toBe("role");
  });

  test("parse returns the raw output string unchanged", () => {
    const output = "some proposal text";
    const parsed = debateProposeOp.parse(output, {} as any, makeBuildCtx());
    expect(parsed).toBe(output);
  });

  test("debaterIndex 1 includes second debater persona if present", () => {
    const debatersWithPersona: Debater[] = [
      { agent: "claude", model: "fast", persona: "challenger" },
      { agent: "opencode", model: "fast", persona: "pragmatist" },
    ];
    const input = {
      taskContext: "task context",
      outputFormat: "json",
      stage: "review",
      debaterIndex: 1,
      debaters: debatersWithPersona,
    };
    const result = debateProposeOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("pragmatist");
  });

  test("build constructs prompt with task context and output format", () => {
    const input = {
      taskContext: "Review the code changes",
      outputFormat: "Respond with JSON",
      stage: "review",
      debaterIndex: 0,
      debaters,
    };
    const result = debateProposeOp.build(input, makeBuildCtx());
    expect(result.task.content).toContain("Review the code changes");
    expect(result.task.content).toContain("Respond with JSON");
  });
});
