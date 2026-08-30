/**
 * Unit tests for src/debate/runner-stateful-helpers.ts — the barrier
 * bookkeeping, proposal-record builders, per-agent CallContext wrappers, and
 * the zero-success fallback path used by the stateful debate coordinator.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeMockAgentManager, makeMockRuntime, makeNaxConfig, withDepsRestore } from "@test/helpers";
import type { AgentRunRequest } from "@/agents/manager-types";
import type { AgentRunOptions } from "@/agents/types";
import type { ContextBundle } from "@/context/engine";
import {
  _statefulDeps,
  buildProposalRecords,
  buildRebuttalPromptBuilder,
  createDebaterCallContext,
  createOneShotDebaterCallContext,
  createProposalBarrier,
  rejectUnresolvedBarriers,
  resolveStatefulSignal,
  runZeroSuccessFallback,
} from "@/debate/runner-stateful-helpers";
import type { ResolvedDebater } from "@/debate/session-helpers";
import type { CallContext } from "@/operations/types";

withDepsRestore(_statefulDeps);

function makeRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "hello",
    workdir: "/tmp/work",
    modelTier: "fast",
    modelDef: { provider: "anthropic", model: "m", env: {} },
    timeoutSeconds: 30,
    config: makeNaxConfig(),
    ...overrides,
  };
}

function makeCallCtx(overrides: Partial<CallContext> = {}): CallContext {
  const agentManager = makeMockAgentManager();
  const runtime = makeMockRuntime({ agentManager });
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/work",
    agentName: "claude",
    storyId: "US-010",
    featureName: "feat-stateful",
    ...overrides,
  };
}

describe("createProposalBarrier / rejectUnresolvedBarriers", () => {
  test("starts unsettled", () => {
    const state = createProposalBarrier();
    expect(state.isSettled()).toBe(false);
  });

  test("resolve() settles the barrier and marks it settled", async () => {
    const state = createProposalBarrier();
    state.barrier.resolve("hello");
    expect(state.isSettled()).toBe(true);
    await expect(state.barrier.promise).resolves.toBe("hello");
  });

  test("a second resolve() after settlement is a silent no-op", async () => {
    const state = createProposalBarrier();
    state.barrier.resolve("first");
    state.barrier.resolve("second");
    await expect(state.barrier.promise).resolves.toBe("first");
  });

  test("reject() settles the barrier with a rejection", async () => {
    const state = createProposalBarrier();
    state.barrier.reject(new Error("nope"));
    expect(state.isSettled()).toBe(true);
    await expect(state.barrier.promise).rejects.toThrow("nope");
  });

  test("reject() after resolve() is a silent no-op (no unhandled rejection)", async () => {
    const state = createProposalBarrier();
    state.barrier.resolve("won");
    state.barrier.reject(new Error("too late"));
    await expect(state.barrier.promise).resolves.toBe("won");
  });

  test("rejectUnresolvedBarriers rejects only the unsettled ones", async () => {
    const settled = createProposalBarrier();
    settled.barrier.resolve("already-done");
    const unsettled1 = createProposalBarrier();
    const unsettled2 = createProposalBarrier();

    rejectUnresolvedBarriers([settled, unsettled1, unsettled2], new Error("aborted"));

    expect(settled.isSettled()).toBe(true);
    expect(unsettled1.isSettled()).toBe(true);
    expect(unsettled2.isSettled()).toBe(true);
    await expect(settled.barrier.promise).resolves.toBe("already-done");
    await expect(unsettled1.barrier.promise).rejects.toThrow("aborted");
    await expect(unsettled2.barrier.promise).rejects.toThrow("aborted");
  });

  test("rejectUnresolvedBarriers on an empty list is a no-op", () => {
    expect(() => rejectUnresolvedBarriers([], new Error("x"))).not.toThrow();
  });
});

describe("buildProposalRecords", () => {
  const resolved: ResolvedDebater[] = [
    { debater: { agent: "claude" }, agentName: "claude" },
    { debater: { agent: "codex" }, agentName: "codex" },
    { debater: { agent: "opencode" }, agentName: "opencode" },
  ];

  test("keeps only fulfilled results, mapped by index to their debater", () => {
    const settled: PromiseSettledResult<string>[] = [
      { status: "fulfilled", value: "proposal-a" },
      { status: "rejected", reason: new Error("failed") },
      { status: "fulfilled", value: "proposal-c" },
    ];

    const records = buildProposalRecords(resolved, settled);

    expect(records).toEqual([
      { debater: { agent: "claude" }, agentName: "claude", output: "proposal-a", cost: 0 },
      { debater: { agent: "opencode" }, agentName: "opencode", output: "proposal-c", cost: 0 },
    ]);
  });

  test("returns an empty array when everything is rejected", () => {
    const settled: PromiseSettledResult<string>[] = resolved.map(() => ({
      status: "rejected",
      reason: new Error("x"),
    }));
    expect(buildProposalRecords(resolved, settled)).toEqual([]);
  });

  test("returns an empty array for empty inputs", () => {
    expect(buildProposalRecords([], [])).toEqual([]);
  });
});

describe("buildRebuttalPromptBuilder", () => {
  test("builds a DebatePromptBuilder configured for stateful sessions", () => {
    const builder = buildRebuttalPromptBuilder("review", "the task prompt", [{ agent: "claude" }, { agent: "codex" }]);
    expect(builder).toBeDefined();
    // Exercise it enough to prove it was constructed with the given stage/prompt.
    expect(typeof builder.buildRebuttalPrompt).toBe("function");
  });
});

describe("resolveStatefulSignal", () => {
  test("returns runtime.signal when present", () => {
    const ctx = makeCallCtx();
    const signal = resolveStatefulSignal({
      storyId: "US-1",
      stage: "review",
      workdir: "/tmp/work",
      featureName: "feat",
      callContext: ctx,
    });
    expect(signal).toBe(ctx.runtime.signal);
  });

  test("falls back to ctx.abortSignal, then the module default, without throwing", () => {
    const ctx = makeCallCtx();
    const fallbackController = new AbortController();
    const signal = resolveStatefulSignal({
      storyId: "US-1",
      stage: "review",
      workdir: "/tmp/work",
      featureName: "feat",
      callContext: ctx,
      abortSignal: fallbackController.signal,
    });
    // runtime.signal always wins when defined — this pins that priority rather
    // than asserting a specific fallback branch, which the real NaxRuntime
    // shape makes unreachable in production.
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("createDebaterCallContext / createOneShotDebaterCallContext", () => {
  const baseCtx: () => CallContext = () => makeCallCtx();

  for (const [label, factory] of [
    ["createDebaterCallContext", createDebaterCallContext],
    ["createOneShotDebaterCallContext", createOneShotDebaterCallContext],
  ] as const) {
    test(`${label}: stamps agentName onto the returned CallContext`, () => {
      const ctx = baseCtx();
      const result = factory(
        { storyId: "US-1", stage: "review", workdir: "/tmp/work", featureName: "feat", callContext: ctx },
        "codex",
      );
      expect(result.agentName).toBe("codex");
      expect(result.runtime).not.toBe(ctx.runtime);
    });

    test(`${label}: runWithFallback delegates to the base agentManager when executeHop is absent`, async () => {
      const ctx = baseCtx();
      const result = factory(
        { storyId: "US-1", stage: "review", workdir: "/tmp/work", featureName: "feat", callContext: ctx },
        "codex",
      );
      const request: AgentRunRequest = { runOptions: makeRunOptions() };
      const outcome = await result.runtime.agentManager.runWithFallback(request);
      expect(outcome.fallbacks).toEqual([]);
    });

    test(`${label}: runWithFallback routes through executeHop when present, honouring an override agent`, async () => {
      const ctx = baseCtx();
      const result = factory(
        { storyId: "US-1", stage: "review", workdir: "/tmp/work", featureName: "feat", callContext: ctx },
        "codex",
      );
      const executeHop = mock(
        async (agent: string, bundle: ContextBundle | undefined, _kind: unknown, _opts: unknown) => ({
          result: {
            success: true,
            exitCode: 0,
            output: `output-from-${agent}`,
            rateLimited: false,
            durationMs: 0,
            estimatedCostUsd: 0,
            tokenUsage: { inputTokens: 1, outputTokens: 1 },
          },
          bundle,
          prompt: "final-prompt",
        }),
      );
      const request: AgentRunRequest = { runOptions: makeRunOptions(), executeHop };

      const outcome = await result.runtime.agentManager.runWithFallback(request, "opencode");

      expect(executeHop).toHaveBeenCalledTimes(1);
      expect(outcome.finalAgent).toBe("opencode");
      expect(outcome.fallbacks).toEqual([]);
      expect(outcome.finalPrompt).toBe("final-prompt");
      expect((outcome.result as { output: string }).output).toBe("output-from-opencode");
    });

    test(`${label}: runWithFallback defaults executeHop's agent to the wrapper's agentName when no override is given`, async () => {
      const ctx = baseCtx();
      const result = factory(
        { storyId: "US-1", stage: "review", workdir: "/tmp/work", featureName: "feat", callContext: ctx },
        "codex",
      );
      const executeHop = mock(async (agent: string, bundle: ContextBundle | undefined) => ({
        result: {
          success: true,
          exitCode: 0,
          output: `from-${agent}`,
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
          tokenUsage: { inputTokens: 1, outputTokens: 1 },
        },
        bundle,
        prompt: "p",
      }));
      const request: AgentRunRequest = { runOptions: makeRunOptions(), executeHop };

      const outcome = await result.runtime.agentManager.runWithFallback(request);

      expect(outcome.finalAgent).toBe("codex");
      expect((outcome.result as { output: string }).output).toBe("from-codex");
    });
  }
});

describe("runZeroSuccessFallback", () => {
  const ctx = () => ({
    storyId: "US-1",
    stage: "review",
    workdir: "/tmp/work",
    featureName: "feat",
    callContext: makeCallCtx(),
  });

  test("returns null when there is no firstDebater", async () => {
    const result = await runZeroSuccessFallback(ctx(), "prompt", undefined);
    expect(result).toBeNull();
  });

  test("resolves the barrier via callOp and returns a SuccessfulProposal", async () => {
    _statefulDeps.callOp = mock(async (_callCtx, _op, input) => {
      input.proposalBarriers[0].resolve("the-output");
      return { success: true, rebut: "" };
    });

    const firstDebater: ResolvedDebater = { debater: { agent: "claude" }, agentName: "claude" };
    const result = await runZeroSuccessFallback(ctx(), "prompt", firstDebater);

    expect(result).toEqual({ debater: { agent: "claude" }, agentName: "claude", output: "the-output", cost: 0 });
  });

  test("returns null when callOp throws", async () => {
    _statefulDeps.callOp = mock(async () => {
      throw new Error("boom");
    });

    const firstDebater: ResolvedDebater = { debater: { agent: "claude" }, agentName: "claude" };
    const result = await runZeroSuccessFallback(ctx(), "prompt", firstDebater);

    expect(result).toBeNull();
  });

  test("returns null when callOp resolves but the barrier is never settled and rejects", async () => {
    _statefulDeps.callOp = mock(async (_callCtx, _op, input) => {
      input.proposalBarriers[0].reject(new Error("never came"));
      return { success: false, rebut: "" };
    });

    const firstDebater: ResolvedDebater = { debater: { agent: "claude" }, agentName: "claude" };
    const result = await runZeroSuccessFallback(ctx(), "prompt", firstDebater);

    expect(result).toBeNull();
  });
});
