import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config";
import { debateConfigSelector } from "@/config";
import type { Debater } from "@/debate/types";
import { judgeOp } from "@/operations";
import type { DebateJudgeInput } from "@/operations/debate-judge";
import { DebatePromptBuilder } from "@/prompts";
import { composeSections, join } from "@/prompts";

function makeBuildCtx() {
  return {
    packageView: { config: DEFAULT_CONFIG, select: (_sel: unknown) => DEFAULT_CONFIG.debate } as any,
    config: DEFAULT_CONFIG.debate,
  } as Parameters<typeof judgeOp.build>[1];
}

describe("judgeOp", () => {
  test("kind is complete (AC1)", () => {
    expect(judgeOp.kind).toBe("complete");
  });

  test("name is debate-judge (AC1)", () => {
    expect(judgeOp.name).toBe("debate-judge");
  });

  test("stage is review (AC1)", () => {
    expect(judgeOp.stage).toBe("review");
  });

  test("config is debateConfigSelector (AC1)", () => {
    expect(judgeOp.config).toBe(debateConfigSelector);
  });

  test("model returns { agent, model } from input when both non-empty (AC2)", () => {
    const input: DebateJudgeInput = {
      proposals: ["p1"],
      critiques: ["c1"],
      resolverAgent: "judge-agent",
      resolverModel: "fast",
    };
    expect(judgeOp.model?.(input, makeBuildCtx())).toEqual({
      agent: "judge-agent",
      model: "fast",
    });
  });

  test("model uses the exact agent and model strings from input (AC2)", () => {
    const input: DebateJudgeInput = {
      proposals: [],
      critiques: [],
      resolverAgent: "custom-resolver",
      resolverModel: "opus",
    };
    expect(judgeOp.model?.(input, makeBuildCtx())).toEqual({
      agent: "custom-resolver",
      model: "opus",
    });
  });

  test("build produces prompt matching resolverJudgePrompt for proposals and critiques (AC3)", () => {
    const proposals = ["proposal alpha", "proposal beta"];
    const critiques = ["critique one"];
    const debaters: Debater[] = [{ agent: "claude" }, { agent: "opencode" }];
    const input: DebateJudgeInput = {
      proposals,
      critiques,
      debaters,
      resolverAgent: "judge-agent",
      resolverModel: "fast",
    };

    const builtPrompt = join(composeSections(judgeOp.build(input, makeBuildCtx())));
    const expected = DebatePromptBuilder.resolverJudgePrompt(proposals, critiques, debaters);
    expect(builtPrompt).toBe(expected);
  });

  test("build passes undefined debaters when not provided (AC3)", () => {
    const proposals = ["proposal one"];
    const critiques: string[] = [];
    const input: DebateJudgeInput = {
      proposals,
      critiques,
      resolverAgent: "judge-agent",
      resolverModel: "fast",
    };

    const builtPrompt = join(composeSections(judgeOp.build(input, makeBuildCtx())));
    const expected = DebatePromptBuilder.resolverJudgePrompt(proposals, critiques, undefined);
    expect(builtPrompt).toBe(expected);
  });

  test("parse returns the output string unchanged (AC4)", () => {
    const output = "judge verdict text here";
    const input: DebateJudgeInput = {
      proposals: [],
      critiques: [],
      resolverAgent: "judge-agent",
      resolverModel: "fast",
    };
    expect(judgeOp.parse(output, input, makeBuildCtx())).toBe(output);
  });

  test("parse returns empty string unchanged (AC4)", () => {
    const input: DebateJudgeInput = {
      proposals: [],
      critiques: [],
      resolverAgent: "judge-agent",
      resolverModel: "fast",
    };
    expect(judgeOp.parse("", input, makeBuildCtx())).toBe("");
  });
});
