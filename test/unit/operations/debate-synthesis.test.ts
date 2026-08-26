import { describe, expect, test } from "bun:test";
import { makeTestRuntime, opModelResolver } from "@test/helpers";
import { debateConfigSelector } from "@/config";
import type { Debater } from "@/debate/types";
import { synthesisOp } from "@/operations";
import type { DebateSynthesisInput } from "@/operations/debate-synthesis";
import { composeSections, DebatePromptBuilder, join } from "@/prompts";

function makeBuildCtx(): Parameters<typeof synthesisOp.build>[1] {
  const view = makeTestRuntime().packages.repo();
  return { packageView: view, config: view.select(debateConfigSelector) };
}

describe("synthesisOp", () => {
  test("kind is complete (AC1)", () => {
    expect(synthesisOp.kind).toBe("complete");
  });

  test("name is debate-synthesis (AC1)", () => {
    expect(synthesisOp.name).toBe("debate-synthesis");
  });

  test("stage is review (AC1)", () => {
    expect(synthesisOp.stage).toBe("review");
  });

  test("config is debateConfigSelector (AC1)", () => {
    expect(synthesisOp.config).toBe(debateConfigSelector);
  });

  test("model returns { agent, model } from input (AC2)", () => {
    const input: DebateSynthesisInput = {
      proposals: ["p1"],
      critiques: ["c1"],
      resolverAgent: "synth-agent",
      resolverModel: "fast",
    };
    expect(opModelResolver(synthesisOp)(input, makeBuildCtx())).toEqual({
      agent: "synth-agent",
      model: "fast",
    });
  });

  test("model uses the exact agent and model strings from input (AC2)", () => {
    const input: DebateSynthesisInput = {
      proposals: [],
      critiques: [],
      resolverAgent: "custom-synth",
      resolverModel: "opus",
    };
    expect(opModelResolver(synthesisOp)(input, makeBuildCtx())).toEqual({
      agent: "custom-synth",
      model: "opus",
    });
  });

  test("build produces prompt matching resolverSynthesisPrompt when no promptSuffix (AC3)", () => {
    const proposals = ["proposal alpha", "proposal beta"];
    const critiques = ["critique one"];
    const debaters: Debater[] = [{ agent: "claude" }, { agent: "opencode" }];
    const input: DebateSynthesisInput = {
      proposals,
      critiques,
      debaters,
      resolverAgent: "synth-agent",
      resolverModel: "fast",
    };

    const builtPrompt = join(composeSections(synthesisOp.build(input, makeBuildCtx())));
    const expected = DebatePromptBuilder.resolverSynthesisPrompt(proposals, critiques, debaters);
    expect(builtPrompt).toBe(expected);
  });

  test("build appends promptSuffix with double-newline separator (AC3)", () => {
    const proposals = ["proposal alpha"];
    const critiques = ["critique one"];
    const input: DebateSynthesisInput = {
      proposals,
      critiques,
      resolverAgent: "synth-agent",
      resolverModel: "fast",
      promptSuffix: "additional instructions here",
    };

    const builtPrompt = join(composeSections(synthesisOp.build(input, makeBuildCtx())));
    const base = DebatePromptBuilder.resolverSynthesisPrompt(proposals, critiques, undefined);
    expect(builtPrompt).toBe(`${base}\n\nadditional instructions here`);
  });

  test("build does not append separator when promptSuffix is absent (AC3)", () => {
    const proposals = ["proposal one"];
    const critiques: string[] = [];
    const input: DebateSynthesisInput = {
      proposals,
      critiques,
      resolverAgent: "synth-agent",
      resolverModel: "fast",
    };

    const builtPrompt = join(composeSections(synthesisOp.build(input, makeBuildCtx())));
    const expected = DebatePromptBuilder.resolverSynthesisPrompt(proposals, critiques, undefined);
    expect(builtPrompt).toBe(expected);
  });

  test("build passes undefined debaters when not provided (AC3)", () => {
    const proposals = ["proposal one"];
    const critiques: string[] = [];
    const input: DebateSynthesisInput = {
      proposals,
      critiques,
      resolverAgent: "synth-agent",
      resolverModel: "fast",
    };

    const builtPrompt = join(composeSections(synthesisOp.build(input, makeBuildCtx())));
    const expected = DebatePromptBuilder.resolverSynthesisPrompt(proposals, critiques, undefined);
    expect(builtPrompt).toBe(expected);
  });

  test("parse returns the output string unchanged", () => {
    const output = "synthesis result text here";
    const input: DebateSynthesisInput = {
      proposals: [],
      critiques: [],
      resolverAgent: "synth-agent",
      resolverModel: "fast",
    };
    expect(synthesisOp.parse(output, input, makeBuildCtx())).toBe(output);
  });

  test("parse returns empty string unchanged", () => {
    const input: DebateSynthesisInput = {
      proposals: [],
      critiques: [],
      resolverAgent: "synth-agent",
      resolverModel: "fast",
    };
    expect(synthesisOp.parse("", input, makeBuildCtx())).toBe("");
  });
});
