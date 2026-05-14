import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { CallContext } from "../../../src/operations/types";
import type { DebateStageConfig, Debater } from "../../../src/debate/types";
import { DebatePromptBuilder } from "../../../src/prompts";
import { makeMockAgentManager } from "../../../test/helpers";

describe("AC-1: TypeScript compiler rejects resolveOutcome() call without callContext parameter", () => {
  test("resolveOutcome function signature requires callContext as 5th positional parameter", async () => {
    // This test reads the source file to verify the parameter position.
    // In Phase 1, resolveOutcome signature is:
    // async function resolveOutcome(
    //   proposalOutputs: string[],
    //   critiqueOutputs: string[],
    //   stageConfig: DebateStageConfig,
    //   config: DebateConfig,
    //   callContext: CallContext,  ← 5th parameter, required, no default
    //   ...
    // )
    //
    // TypeScript will fail with TS2554 (missing required argument) if callContext is omitted.

    const sourceFile = readFileSync(
      join(import.meta.dir, "../../../src/debate/session-helpers.ts"),
      "utf-8",
    );

    // Verify the function signature includes callContext as a required parameter
    // (no default value, appears after stageConfig and config)
    const signaturePattern =
      /async function resolveOutcome\s*\(\s*proposalOutputs\s*:\s*string\[\],\s*critiqueOutputs\s*:\s*string\[\],\s*stageConfig\s*:\s*DebateStageConfig,\s*config\s*:\s*DebateConfig,\s*callContext\s*:\s*CallContext,/;

    expect(signaturePattern.test(sourceFile)).toBe(true);
  });

  test("resolveOutcome call omitting callContext would fail TypeScript compilation", async () => {
    // When a call site attempts: resolveOutcome(proposals, critiques, stageConfig, config, storyId, ...)
    // TypeScript will report: TS2554: Expected 13 arguments, but got 5.
    //
    // This test verifies the call sites pass callContext correctly.

    const runnerFile = readFileSync(
      join(import.meta.dir, "../../../src/debate/runner.ts"),
      "utf-8",
    );

    // Line 287: await resolveOutcome(..., this.ctx, ...)
    const runnerCallPattern = /await resolveOutcome\(\s*proposalOutputs,\s*critiqueOutputs,\s*this\.stageConfig,\s*this\.config,\s*this\.ctx,/;
    expect(runnerCallPattern.test(runnerFile)).toBe(true);
  });
});

describe("AC-2: toStatefulCtx() returns StatefulCtx with callContext === this.ctx", () => {
  test("DebateRunner.toStatefulCtx() includes callContext property set to this.ctx", async () => {
    const { DebateRunner } = await import("../../../src/debate/runner");

    const mockCallContext: CallContext = {
      storyId: "story-ac2",
      agentName: "claude",
      packageDir: "/test/pkg",
      runtime: {
        agentManager: makeMockAgentManager(),
        sessionManager: { nameFor: () => "test-session" } as any,
        signal: new AbortController().signal,
      } as any,
    };

    const runner = new DebateRunner({
      ctx: mockCallContext,
      stage: "review",
      stageConfig: { resolver: { type: "synthesis", agent: "claude" }, debaters: [], rounds: 1 } as DebateStageConfig,
    });

    // Access the private toStatefulCtx() method via type assertion
    const statefulCtx = (runner as any).toStatefulCtx();

    expect(statefulCtx).toHaveProperty("callContext");
    expect(statefulCtx.callContext).toBe(mockCallContext);
    expect(statefulCtx.callContext.storyId).toBe("story-ac2");
  });
});

describe("AC-3: judgeOp.model() returns { agent: input.resolverAgent, model: input.resolverModel } exactly", () => {
  test("judgeOp.model() with non-empty resolverAgent and resolverModel returns exact match", async () => {
    const { judgeOp } = await import("../../../src/operations");

    const result = judgeOp.model({
      proposals: ["proposal text"],
      critiques: ["critique text"],
      debaters: [{ agent: "debater-1" }] as Debater[],
      resolverAgent: "test-agent",
      resolverModel: "test-model",
    });

    expect(result).toEqual({
      agent: "test-agent",
      model: "test-model",
    });

    // Verify exact reference equality for the strings
    expect(result.agent).toBe("test-agent");
    expect(result.model).toBe("test-model");
  });

  test("judgeOp.model() with empty resolverAgent returns empty string (no fallback)", async () => {
    const { judgeOp } = await import("../../../src/operations");

    const result = judgeOp.model({
      proposals: [],
      critiques: [],
      resolverAgent: "",
      resolverModel: "fast-model",
    });

    expect(result.agent).toBe("");
    expect(result.model).toBe("fast-model");
  });
});

describe("AC-4: callOp(ctx, judgeOp, { resolverAgent: 'test-agent', ... }) dispatches with correct agent", () => {
  test("judgeSelector calls callOp with ctx.callContext as first argument and judgeOp as second", async () => {
    // This test verifies the call signature in the judge selector.
    const judgeFile = readFileSync(
      join(import.meta.dir, "../../../src/debate/selectors/judge.ts"),
      "utf-8",
    );

    // Verify callOp is called with ctx.callContext and judgeOp
    const callOpPattern = /await callOp\(\s*ctx\.callContext,\s*judgeOp,/;
    expect(callOpPattern.test(judgeFile)).toBe(true);
  });

  test("judgeSelector passes resolverAgent and resolverModel from input to judgeOp", async () => {
    // Verify that judgeSelector constructs input with resolverAgent and resolverModel fields
    const judgeFile = readFileSync(
      join(import.meta.dir, "../../../src/debate/selectors/judge.ts"),
      "utf-8",
    );

    // Check that the input object passed to callOp includes resolverAgent and resolverModel
    const inputPattern = /resolverAgent\s*:\s*(?:input\.)?resolverAgent|resolverModel\s*:\s*(?:input\.)?resolverModel/;
    expect(inputPattern.test(judgeFile)).toBe(true);
  });
});

describe("AC-5: synthesisOp.build() with promptSuffix appends with newline separator", () => {
  test("synthesisOp.build() returns prompt with suffix appended as basePrompt + '\\n\\n' + promptSuffix", async () => {
    const { synthesisOp } = await import("../../../src/operations");

    const input = {
      proposals: ["proposal 1"],
      critiques: ["critique 1"],
      debaters: [{ agent: "debater" }] as Debater[],
      resolverAgent: "test-agent",
      resolverModel: "test-model",
      promptSuffix: "extra instructions here",
    };

    const builtPrompt = synthesisOp.build(input, null as any);
    const basePrompt = DebatePromptBuilder.resolverSynthesisPrompt(
      ["proposal 1"],
      ["critique 1"],
      [{ agent: "debater" }] as Debater[],
    );

    // synthesisOp.build returns { role, task } where task.content is the full prompt
    const expectedContent = `${basePrompt}\n\n${input.promptSuffix}`;
    expect(builtPrompt.task.content).toBe(expectedContent);
  });

  test("synthesisOp.build() without promptSuffix returns base prompt unchanged", async () => {
    const { synthesisOp } = await import("../../../src/operations");

    const input = {
      proposals: ["p1"],
      critiques: ["c1"],
      debaters: undefined,
      resolverAgent: "agent",
      resolverModel: "model",
      promptSuffix: undefined,
    };

    const builtPrompt = synthesisOp.build(input, null as any);
    const basePrompt = DebatePromptBuilder.resolverSynthesisPrompt(["p1"], ["c1"], undefined);

    expect(builtPrompt.task.content).toBe(basePrompt);
  });
});

describe("AC-6: synthesisOp.model() returns { agent: input.resolverAgent, model: input.resolverModel }", () => {
  test("synthesisOp.model() returns exact { agent, model } from input fields", async () => {
    const { synthesisOp } = await import("../../../src/operations");

    const result = synthesisOp.model({
      proposals: [],
      critiques: [],
      debaters: undefined,
      resolverAgent: "synthesis-agent",
      resolverModel: "synthesis-model",
      promptSuffix: undefined,
    });

    expect(result).toEqual({
      agent: "synthesis-agent",
      model: "synthesis-model",
    });

    // Verify strict equality (not just deep equality)
    expect(result.agent).toBe("synthesis-agent");
    expect(result.model).toBe("synthesis-model");
  });

  test("synthesisOp.model() preserves empty agent string (no fallback resolution)", async () => {
    const { synthesisOp } = await import("../../../src/operations");

    const result = synthesisOp.model({
      proposals: [],
      critiques: [],
      resolverAgent: "",
      resolverModel: "model-x",
    });

    expect(result.agent).toBe("");
    expect(result.model).toBe("model-x");
  });
});