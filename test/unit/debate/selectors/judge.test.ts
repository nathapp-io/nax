/**
 * Tests for judgeSelector — rewired to callOp (US-002)
 */

import { describe, expect, test } from "bun:test";
import type { IAgentManager } from "@/agents";
import { judgeSelector } from "@/debate";
import type { SelectorContext } from "@/debate/selectors/types";
import type { SuccessfulProposal } from "@/debate/session-helpers";
import type { CallContext } from "@/operations/types";
import { DebatePromptBuilder } from "@/prompts";
import { makeMockAgentManager, makeMockRuntime } from "@test/helpers";

function makeProposals(outputs: string[]): SuccessfulProposal[] {
  return outputs.map((output) => ({
    debater: { agent: "claude" },
    agentName: "claude",
    output,
    cost: 0,
  }));
}

const DEFAULT_SELECTOR_CONFIG: SelectorContext["config"] = {
  debate: {
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
  models: {},
  agent: { default: "claude" },
};

function makeCallContext(agentManager: IAgentManager): CallContext {
  const runtime = makeMockRuntime({ agentManager });
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/test",
    agentName: "claude",
  };
}

function makeCtx(overrides: Partial<SelectorContext> = {}): SelectorContext {
  const agentManager = overrides.agentManager ?? makeMockAgentManager();
  // Ensure callContext uses the same agentManager as ctx.agentManager
  // so tests that override agentManager get consistent dispatch behavior
  const callContext = overrides.callContext ?? makeCallContext(agentManager);
  return {
    storyId: "US-001",
    stage: "plan",
    stageConfig: {
      enabled: true,
      resolver: { type: "majority-fail-closed" },
      sessionMode: "one-shot",
      rounds: 1,
    },
    config: DEFAULT_SELECTOR_CONFIG,
    proposals: makeProposals([]),
    critiques: [],
    workdir: "/tmp/test",
    featureName: "test",
    timeoutMs: 30000,
    agentManager,
    debaters: [],
    ...overrides,
    callContext,
  };
}

describe("judgeSelector", () => {
  test("calls agentManager.completeAs exactly once (AC5)", async () => {
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

  test("returns result without resolverCostUsd property (AC4)", async () => {
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

    expect("resolverCostUsd" in result).toBe(false);
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

  test("returns outcome: passed when the judge emits a leading JUDGE_VERDICT: ACCEPT marker (BUG-32)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "JUDGE_VERDICT: ACCEPT\n\nProposal 1 is the strongest approach.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("passed");
    // The marker line is stripped — downstream consumers (e.g. the persisted
    // plan/PRD content) must not see the machine-readable prefix.
    expect(result.output).toBe("Proposal 1 is the strongest approach.");
  });

  test("returns outcome: failed when the judge emits a leading JUDGE_VERDICT: REJECT marker (BUG-32)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "JUDGE_VERDICT: REJECT\n\nNone of the proposals are acceptable — reject.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("failed");
    expect(result.output).toBe("None of the proposals are acceptable — reject.");
  });

  test("fails closed when the judge's response has no parseable JUDGE_VERDICT marker (BUG-32)", async () => {
    // Prior behaviour: any non-empty text passed. A judge that ignores the
    // format instruction and writes free-form prose must not silently pass.
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "I think proposal 1 is best, going with that.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("failed");
  });

  test("marker matching is case-insensitive and tolerates a missing trailing newline", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "judge_verdict: accept",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("passed");
    expect(result.output).toBe("");
  });

  test("tolerates a bolded marker (a model told 'one line' commonly wraps it in **)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "**JUDGE_VERDICT: ACCEPT**\n\nProposal 1 wins.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("passed");
    expect(result.output).toBe("Proposal 1 wins.");
  });

  test("tolerates a short preamble before the marker line", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "Here is my verdict:\nJUDGE_VERDICT: ACCEPT\n\nProposal 1 wins.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("passed");
    expect(result.output).toBe("Here is my verdict:\n\nProposal 1 wins.");
  });

  test("does not false-positive-match ACCEPTED as ACCEPT (word boundary)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "JUDGE_VERDICT: ACCEPTED\n\nProposal 1 wins.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    // "ACCEPTED" is not a recognized token — fails closed, and the output is
    // returned unstripped since no marker was actually matched.
    expect(result.outcome).toBe("failed");
    expect(result.output).toBe("JUDGE_VERDICT: ACCEPTED\n\nProposal 1 wins.");
  });

  test("does not scan past the first few lines for a marker (avoids false matches deep in prose)", async () => {
    const longPreamble = Array.from({ length: 10 }, (_, i) => `Reasoning line ${i}.`).join("\n");
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: `${longPreamble}\nJUDGE_VERDICT: ACCEPT`,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("failed");
  });

  test("returns outcome: failed when op result is empty string (AC7)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("failed");
  });

  test("returns outcome: failed when op result is whitespace-only string (AC7)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "   \n\t  ",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    expect(result.outcome).toBe("failed");
  });

  test("forwards ctx.callContext unchanged to callOp — no onCostAccumulated injected (AC6)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "verdict",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await judgeSelector(ctx);

    // callContext is not mutated — result does not contain onCostAccumulated artifact
    expect("onCostAccumulated" in ctx.callContext).toBe(false);
    expect(result.outcome).toBeDefined();
  });
});
