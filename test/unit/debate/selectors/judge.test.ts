/**
 * Tests for judgeSelector — US-002 AC3
 */

import { describe, expect, test } from "bun:test";
import { judgeSelector } from "../../../../src/debate/selectors/judge";
import type { SelectorContext } from "../../../../src/debate/selectors/types";
import type { SuccessfulProposal } from "../../../../src/debate/session-helpers";
import { DebatePromptBuilder } from "../../../../src/prompts";
import { makeMockAgentManager } from "../../../helpers";

function makeProposals(outputs: string[]): SuccessfulProposal[] {
  return outputs.map((output) => ({
    debater: { agent: "claude" },
    agentName: "claude",
    output,
    cost: 0,
  }));
}

function makeCtx(overrides: Partial<SelectorContext> = {}): SelectorContext {
  return {
    storyId: "US-001",
    stage: "plan",
    stageConfig: {
      enabled: true,
      resolver: { type: "majority-fail-closed" },
      sessionMode: "one-shot",
      rounds: 1,
    },
    config: {
      enabled: true,
      grounder: { model: "fast", timeoutSeconds: 60 },
      agents: 2,
      maxConcurrentDebaters: 2,
      stages: {
        plan: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
        review: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
        acceptance: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
        rectification: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
        escalation: { enabled: false, resolver: { type: "majority-fail-closed" }, sessionMode: "one-shot", rounds: 1 },
      },
    },
    proposals: makeProposals([]),
    critiques: [],
    workdir: "/tmp/test",
    featureName: "test",
    timeoutMs: 30000,
    agentManager: makeMockAgentManager(),
    debaters: [],
    ...overrides,
  };
}

describe("judgeSelector", () => {
  test("calls agentManager.completeAs exactly once", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        callCount++;
        return { output: "verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1", "p2"]),
      agentManager,
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed", agent: "judge-agent" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });
    await judgeSelector(ctx);

    expect(callCount).toBe(1);
  });

  test("uses ctx.stageConfig.resolver.agent as the agent name", async () => {
    let usedAgent = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        usedAgent = name;
        return { output: "verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1"]),
      agentManager,
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed", agent: "custom-judge" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });
    await judgeSelector(ctx);

    expect(usedAgent).toBe("custom-judge");
  });

  test("falls back to RESOLVER_FALLBACK_AGENT when resolver.agent is unset", async () => {
    let usedAgent = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        usedAgent = name;
        return { output: "verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1"]),
      agentManager,
      // resolver.agent not set
    });
    await judgeSelector(ctx);

    // RESOLVER_FALLBACK_AGENT = "synthesis"
    expect(usedAgent).toBe("synthesis");
  });

  test("calls completeAs with prompt from DebatePromptBuilder.resolverJudgePrompt", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const proposals = makeProposals(["proposal alpha", "proposal beta"]);
    const critiques = ["critique one"];
    const ctx = makeCtx({
      proposals,
      critiques,
      agentManager,
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed", agent: "judge" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });

    await judgeSelector(ctx);

    const expected = DebatePromptBuilder.resolverJudgePrompt(
      proposals.map((p) => p.output),
      critiques,
      [],
    );
    expect(capturedPrompt).toBe(expected);
  });

  test("includes all proposals in the judge prompt", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["proposal content alpha", "proposal content beta"]),
      agentManager,
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed", agent: "judge" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });
    await judgeSelector(ctx);

    expect(capturedPrompt).toContain("proposal content alpha");
    expect(capturedPrompt).toContain("proposal content beta");
  });

  test("returns resolverCostUsd from completeAs cost", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "verdict",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.88,
        exactCostUsd: 0.88,
      }),
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1"]),
      agentManager,
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed", agent: "judge" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });
    const result = await judgeSelector(ctx);

    expect(result.resolverCostUsd).toBeCloseTo(0.88, 6);
  });

  test("passes ctx.debaters to the prompt builder", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "verdict", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1", "p2"]),
      agentManager,
      debaters: [
        { agent: "claude", persona: "testability" },
        { agent: "claude", persona: "security" },
      ],
      stageConfig: {
        enabled: true,
        resolver: { type: "majority-fail-closed", agent: "judge" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });
    await judgeSelector(ctx);

    expect(capturedPrompt).toContain("testability");
    expect(capturedPrompt).toContain("security");
  });
});
