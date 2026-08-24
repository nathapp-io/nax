/**
 * Tests for synthesisSelector — rewired to callOp (US-003)
 */

import { describe, expect, test } from "bun:test";
import type { IAgentManager } from "@/agents";
import { synthesisSelector } from "@/debate";
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
      plan: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
      review: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
      acceptance: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
      rectification: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
      escalation: { enabled: false, resolver: { type: "synthesis" }, sessionMode: "one-shot", rounds: 1 },
    },
  },
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
  const callContext = overrides.callContext ?? makeCallContext(agentManager);
  return {
    storyId: "US-001",
    stage: "plan",
    stageConfig: {
      enabled: true,
      resolver: { type: "synthesis" },
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

describe("synthesisSelector", () => {
  test("calls agentManager.completeAs exactly once (AC4)", async () => {
    let callCount = 0;
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => {
        callCount++;
        return { output: "synthesis output", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1", "p2"]),
      agentManager,
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis", agent: "synth-agent" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });
    await synthesisSelector(ctx);

    expect(callCount).toBe(1);
  });

  test("calls completeAs with prompt from DebatePromptBuilder.resolverSynthesisPrompt", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "synthesis", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
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
        resolver: { type: "synthesis", agent: "synth-agent" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });

    await synthesisSelector(ctx);

    const expected = DebatePromptBuilder.resolverSynthesisPrompt(
      proposals.map((p) => p.output),
      critiques,
      [],
    );
    expect(capturedPrompt).toBe(expected);
  });

  test("returns outcome 'passed' when completeAs output is non-empty (AC5)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "non-empty synthesis result",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await synthesisSelector(ctx);

    expect(result.outcome).toBe("passed");
  });

  test("returns outcome 'failed' when completeAs output is empty string (AC6)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await synthesisSelector(ctx);

    expect(result.outcome).toBe("failed");
  });

  test("returns outcome 'failed' when completeAs output is whitespace-only (AC6)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "   \n\t  ",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await synthesisSelector(ctx);

    expect(result.outcome).toBe("failed");
  });

  test("returns result without resolverCostUsd property (AC5)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "synthesis",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0.75,
        exactCostUsd: 0.55,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    const result = await synthesisSelector(ctx);

    expect("resolverCostUsd" in result).toBe(false);
  });

  test("forwards ctx.callContext unchanged to callOp — no onCostAccumulated injected (AC6)", async () => {
    const agentManager = makeMockAgentManager({
      completeAsFn: async () => ({
        output: "synthesis",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
      }),
    });

    const ctx = makeCtx({ proposals: makeProposals(["p1"]), agentManager });
    await synthesisSelector(ctx);

    expect("onCostAccumulated" in ctx.callContext).toBe(false);
  });

  test("uses ctx.stageConfig.resolver.agent as the agent name", async () => {
    let usedAgent = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        usedAgent = name;
        return { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1"]),
      agentManager,
      stageConfig: {
        enabled: true,
        resolver: { type: "synthesis", agent: "custom-synth-agent" },
        sessionMode: "one-shot",
        rounds: 1,
      },
    });
    await synthesisSelector(ctx);

    expect(usedAgent).toBe("custom-synth-agent");
  });

  test("falls back to RESOLVER_FALLBACK_AGENT when resolver.agent is unset", async () => {
    let usedAgent = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (name) => {
        usedAgent = name;
        return { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1"]),
      agentManager,
    });
    await synthesisSelector(ctx);

    expect(usedAgent).toBe("synthesis");
  });

  test("passes proposals from ctx.proposals.map(p => p.output) to the prompt builder", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["proposal content alpha", "proposal content beta"]),
      agentManager,
    });
    await synthesisSelector(ctx);

    expect(capturedPrompt).toContain("proposal content alpha");
    expect(capturedPrompt).toContain("proposal content beta");
  });

  test("passes ctx.critiques to the prompt builder", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1"]),
      critiques: ["critique X", "critique Y"],
      agentManager,
    });
    await synthesisSelector(ctx);

    expect(capturedPrompt).toContain("critique X");
    expect(capturedPrompt).toContain("critique Y");
  });

  test("passes ctx.debaters to the prompt builder", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const ctx = makeCtx({
      proposals: makeProposals(["p1", "p2"]),
      agentManager,
      debaters: [
        { agent: "claude", persona: "challenger" },
        { agent: "claude", persona: "pragmatist" },
      ],
    });
    await synthesisSelector(ctx);

    expect(capturedPrompt).toContain("challenger");
    expect(capturedPrompt).toContain("pragmatist");
  });

  test("appends ctx.promptSuffix to the synthesis prompt with double-newline separator", async () => {
    let capturedPrompt = "";
    const agentManager = makeMockAgentManager({
      completeAsFn: async (_name, prompt) => {
        capturedPrompt = prompt;
        return { output: "out", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
      },
    });

    const proposals = makeProposals(["p1"]);
    const ctx = makeCtx({
      proposals,
      agentManager,
      promptSuffix: "extra instructions",
    });
    await synthesisSelector(ctx);

    const base = DebatePromptBuilder.resolverSynthesisPrompt(
      proposals.map((p) => p.output),
      [],
      [],
    );
    expect(capturedPrompt).toBe(`${base}\n\nextra instructions`);
  });
});
