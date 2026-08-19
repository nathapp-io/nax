import { afterEach, describe, test, expect, mock } from "bun:test";
import { callOp, shouldKeepSessionOpen } from "@/operations";
import type { CompleteOperation, RunOperation } from "@/operations";
import { pickSelector } from "@/config";
import { makeMockAgentManager, makeSessionManager, makeTestRuntime } from "@test/helpers";
import { DEFAULT_CONFIG } from "@/config";
import type { CompleteResult, TurnResult } from "@/agents/types";
import type { RetryPreset } from "@/agents/retry";
import type { NaxRuntime } from "@/runtime";
import type { AgentRunRequest } from "@/agents/manager-types";

let runtime: NaxRuntime | undefined;
afterEach(async () => { await runtime?.close(); });

const testSel = pickSelector("routing-op-test", "routing");
const implementerGateSel = pickSelector("routing-op-test-with-gates", "routing", "review", "execution");

const echoOp: CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "complete",
  name: "echo-test",
  stage: "run",
  config: testSel,
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

const timedEchoOp: CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  ...echoOp,
  name: "timed-echo-test",
  timeoutMs: () => 123_000,
};

const runEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  kind: "run",
  name: "run-echo-test",
  stage: "run",
  config: testSel,
  session: { role: "implementer", lifetime: "fresh" },
  build: (input) => ({
    role: { id: "role", content: "You echo text.", overridable: false },
    task: { id: "task", content: input.text, overridable: false },
  }),
  parse: (output) => output.trim(),
};

const timedRunEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  ...runEchoOp,
  name: "timed-run-echo-test",
  timeoutMs: () => 123_000,
};

const warmImplementerOp: RunOperation<
  { text: string },
  string,
  Pick<typeof DEFAULT_CONFIG, "routing" | "review" | "execution">
> = {
  ...runEchoOp,
  name: "implementer",
  config: implementerGateSel,
  session: { role: "implementer", lifetime: "warm" },
  keepOpen: (_input, ctx) => shouldKeepSessionOpen(ctx.config, "implementer"),
};

const warmAutofixOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  ...runEchoOp,
  name: "autofix-implementer",
  stage: "rectification",
  session: { role: "implementer", lifetime: "warm" },
};

const invalidTimedEchoOp: CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  ...echoOp,
  name: "invalid-timed-echo-test",
  timeoutMs: () => 0,
};

const invalidTimedRunEchoOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
  ...runEchoOp,
  name: "invalid-timed-run-echo-test",
  timeoutMs: () => Number.NaN,
};

describe("callOp — kind:complete", () => {
  test("calls agentManager.completeAs with composed prompt", async () => {
    const completeResult: CompleteResult = { output: "echoed", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    const agentManager = makeMockAgentManager({ completeAsFn: async () => completeResult });
    runtime = makeTestRuntime({ agentManager });

    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
    };

    const result = await callOp(ctx, echoOp, { text: "hello world" });

    expect(agentManager.completeAs).toHaveBeenCalledTimes(1);
    expect(result).toBe("echoed");
  });

  test("passes op timeoutMs to completeAs", async () => {
    const completeResult: CompleteResult = { output: "echoed", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    const agentManager = makeMockAgentManager({ completeAsFn: async () => completeResult });
    runtime = makeTestRuntime({ agentManager });

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
      },
      timedEchoOp,
      { text: "hello world" },
    );

    const completeArgs = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls[0]?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(completeArgs?.timeoutMs).toBe(123_000);
  });

  test("throws CALL_OP_INVALID_TIMEOUT on non-positive timeoutMs", async () => {
    const completeResult: CompleteResult = { output: "echoed", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    const agentManager = makeMockAgentManager({ completeAsFn: async () => completeResult });
    runtime = makeTestRuntime({ agentManager });

    await expect(
      callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "claude",
        },
        invalidTimedEchoOp,
        { text: "hello world" },
      ),
    ).rejects.toThrow("invalid timeoutMs");
  });
});

describe("callOp — kind:run (ADR-019 §5)", () => {
  test("dispatches via agentManager.runWithFallback with executeHop callback", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: { success: true, exitCode: 0, output: "ran via fallback", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "opencode",
        storyId: "US-001",
      },
      runEchoOp,
      { text: "hello world" },
    );

    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as { executeHop?: unknown; runOptions: { storyId?: string } };
    expect(reqArg.executeHop).toBeTypeOf("function");
    expect(reqArg.runOptions.storyId).toBe("US-001");
    expect(result).toBe("ran via fallback");
  });

  test("noFallback ops still dispatch via real runWithFallback with noFallback:true flag", async () => {
    // Post-C1 fix: noFallback no longer routes through wrapAdapterAsManager.
    // It calls the real agentManager.runWithFallback with `noFallback: true`,
    // which short-circuits the swap branch (manager.ts) but preserves the
    // middleware envelope. This test pins the dispatch path.
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => ({
        result: { success: true, exitCode: 0, output: "single-agent output", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
        fallbacks: [],
        // Surface req fields for assertion via the mock's call records below.
        ...({ _req: req } as Record<string, unknown>),
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const noFallbackOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      noFallback: true,
    };

    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      noFallbackOp,
      { text: "hello" },
    );

    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as { noFallback?: boolean };
    expect(reqArg.noFallback).toBe(true);
    expect(result).toBe("single-agent output");
  });

  test("keepOpen: disabled when review+rectification off; enabled when rectification on; autofix always warm", async () => {
    const makeManager = () => makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: { success: true, exitCode: 0, output: "single-agent output", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
        fallbacks: [],
      }),
    });
    const offConfig = { ...DEFAULT_CONFIG, review: { ...DEFAULT_CONFIG.review, enabled: false }, execution: { ...DEFAULT_CONFIG.execution, rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: false } } };
    const onConfig = { ...DEFAULT_CONFIG, execution: { ...DEFAULT_CONFIG.execution, rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: true } } };

    const am1 = makeManager();
    runtime = makeTestRuntime({ agentManager: am1, sessionManager: makeSessionManager(), config: offConfig });
    await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" }, warmImplementerOp, { text: "hello" });
    expect(((am1.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as { runOptions: { keepOpen?: boolean } }).runOptions.keepOpen).toBeUndefined();
    await runtime.close(); runtime = undefined;

    const am2 = makeManager();
    runtime = makeTestRuntime({ agentManager: am2, sessionManager: makeSessionManager(), config: onConfig });
    await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" }, warmImplementerOp, { text: "hello" });
    expect(((am2.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as { runOptions: { keepOpen?: boolean } }).runOptions.keepOpen).toBe(true);
    await runtime.close(); runtime = undefined;

    const am3 = makeManager();
    runtime = makeTestRuntime({ agentManager: am3, sessionManager: makeSessionManager(), config: offConfig });
    await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" }, warmAutofixOp, { text: "hello" });
    expect(((am3.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as { runOptions: { keepOpen?: boolean } }).runOptions.keepOpen).toBe(true);
  });

  test("throws CALL_OP_NO_OUTPUT when run returns no output", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: { success: false, exitCode: 1, output: "", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    let thrown: Error | null = null;
    try {
      await callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "opencode",
          storyId: "US-001",
        },
        runEchoOp,
        { text: "hello world" },
      );
    } catch (err) {
      thrown = err as Error;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toContain("agent returned no output");
  });

  test("uses op timeoutMs for run timeoutSeconds", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ran via fallback",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "opencode",
        storyId: "US-001",
      },
      timedRunEchoOp,
      { text: "hello world" },
    );

    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | { runOptions?: { timeoutSeconds?: number } }
      | undefined;
    expect(reqArg?.runOptions?.timeoutSeconds).toBe(123);
  });

  test("throws CALL_OP_INVALID_TIMEOUT on non-finite run timeoutMs", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ran via fallback",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    await expect(
      callOp(
        {
          runtime,
          packageView: runtime.packages.repo(),
          packageDir: "/tmp",
          agentName: "opencode",
          storyId: "US-001",
        },
        invalidTimedRunEchoOp,
        { text: "hello world" },
      ),
    ).rejects.toThrow("invalid timeoutMs");
  });
});

// Issue #725 — RunOperation.model / CompleteOperation.model accept either a
// literal ConfiguredModel or a resolver `(input, ctx) => ConfiguredModel`. The
// resolver form is what unblocks per-call tier selection from input config
// (e.g. semanticReviewOp reads `input.semanticConfig.model`). Without these
// tests a future refactor could silently drop the resolver path and we'd be
// back to "balanced is hardcoded".
describe("callOp — op.model resolver (issue #725)", () => {
  test("CompleteOperation: literal model is forwarded to completeAs.model", async () => {
    const completeResult: CompleteResult = { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    const agentManager = makeMockAgentManager({ completeAsFn: async () => completeResult });
    runtime = makeTestRuntime({ agentManager });

    const opWithLiteralModel: CompleteOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...echoOp,
      name: "literal-model-op",
      model: "fast",
    };

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      opWithLiteralModel,
      { text: "hi" },
    );

    const completeArgs = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls[0]?.[2] as
      | { modelDef?: { model?: string } }
      | undefined;
    // The fast tier of the default models config resolves to a real ModelDef.model — assert
    // that something was passed (the exact id depends on DEFAULT_CONFIG.models, not on our
    // resolver). What we want to pin is that the resolver fired and produced a definition.
    expect(typeof completeArgs?.modelDef?.model).toBe("string");
    expect(completeArgs?.modelDef?.model).not.toBe("");
  });

  test("CompleteOperation: resolver function is invoked with input and resolves to ConfiguredModel", async () => {
    const completeResult: CompleteResult = { output: "ok", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 };
    const agentManager = makeMockAgentManager({ completeAsFn: async () => completeResult });
    runtime = makeTestRuntime({ agentManager });

    const resolverCalls: Array<{ text: string }> = [];
    const opWithResolver: CompleteOperation<
      { text: string; pickFast: boolean },
      string,
      Pick<typeof DEFAULT_CONFIG, "routing">
    > = {
      ...echoOp,
      name: "resolver-model-op",
      model: (input) => {
        resolverCalls.push({ text: input.text });
        return input.pickFast ? "fast" : "powerful";
      },
    };

    await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude" },
      opWithResolver,
      { text: "case-1", pickFast: true },
    );

    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]).toEqual({ text: "case-1" });
    // Sanity: the chosen tier flows downstream (agentManager.completeAs got *some* model id).
    const completeArgs = (agentManager.completeAs as ReturnType<typeof mock>).mock.calls[0]?.[2] as
      | { modelDef?: { model?: string } }
      | undefined;
    expect(typeof completeArgs?.modelDef?.model).toBe("string");
  });

  test("RunOperation: resolver returning undefined falls back to 'balanced'", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ran",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithUndefinedResolver: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      name: "undefined-resolver-op",
      model: () => undefined,
    };

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      opWithUndefinedResolver,
      { text: "hi" },
    );

    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | { runOptions?: { modelTier?: string } }
      | undefined;
    expect(reqArg?.runOptions?.modelTier).toBe("balanced");
  });

  test("RunOperation: resolver tier flows into runOptions.modelTier", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: {
          success: true,
          exitCode: 0,
          output: "ran",
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
        },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithFastResolver: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      ...runEchoOp,
      name: "fast-resolver-op",
      model: () => "fast",
    };

    await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      opWithFastResolver,
      { text: "hi" },
    );

    const reqArg = (agentManager.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as
      | { runOptions?: { modelTier?: string } }
      | undefined;
    expect(reqArg?.runOptions?.modelTier).toBe("fast");
  });
});

describe("callOp — op.hopBody + op.retry compose (US-004)", () => {
  test("RunOperation with both hopBody and retry succeeds — no error thrown, one dispatch", async () => {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: { success: true, exitCode: 0, output: "composed result", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
        fallbacks: [],
      }),
    });
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const opWithBoth: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run",
      name: "compose-op",
      stage: "run",
      config: testSel,
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "Echo text.", overridable: false },
        task: { id: "task", content: input.text, overridable: false },
      }),
      parse: (output) => output.trim(),
      hopBody: async (_initialPrompt, _ctx): Promise<TurnResult> => (
        { output: "from hopBody", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0, internalRoundTrips: 0 }
      ),
      retry: { preset: "transient-network" as const, maxAttempts: 3, baseDelayMs: 500 } as RetryPreset,
    };

    // op.hopBody and op.retry now compose — should not throw
    const result = await callOp(
      {
        runtime,
        packageView: runtime.packages.repo(),
        packageDir: "/tmp",
        agentName: "claude",
        storyId: "US-001",
      },
      opWithBoth,
      { text: "hello" },
    );

    expect(result).toBe("composed result");
    expect(agentManager.runWithFallback).toHaveBeenCalledTimes(1);
  });

  test("allows RunOperation with only hopBody, only retry, or neither — all dispatch once", async () => {
    const makeSuccessManager = (output: string) => makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({ result: { success: true, exitCode: 0, output, rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }),
    });

    const hopBodyOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run", name: "hopbody-only-op", stage: "run", config: testSel, session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({ role: { id: "role", content: "Echo text.", overridable: false }, task: { id: "task", content: input.text, overridable: false } }),
      parse: (output) => output.trim(),
      hopBody: async (_initialPrompt, _ctx): Promise<TurnResult> => ({ output: "from hopBody", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0, internalRoundTrips: 0 }),
    };
    const am1 = makeSuccessManager("hopbody works");
    runtime = makeTestRuntime({ agentManager: am1, sessionManager: makeSessionManager() });
    expect(await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" }, hopBodyOp, { text: "hello" })).toBe("hopbody works");
    expect(am1.runWithFallback).toHaveBeenCalledTimes(1);
    await runtime.close(); runtime = undefined;

    const retryOp: RunOperation<{ text: string }, string, Pick<typeof DEFAULT_CONFIG, "routing">> = {
      kind: "run", name: "retry-only-op", stage: "run", config: testSel, session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({ role: { id: "role", content: "Echo text.", overridable: false }, task: { id: "task", content: input.text, overridable: false } }),
      parse: (output) => output.trim(),
      retry: { preset: "transient-network" as const, maxAttempts: 3, baseDelayMs: 500 } as RetryPreset,
    };
    const am2 = makeSuccessManager("ran");
    runtime = makeTestRuntime({ agentManager: am2, sessionManager: makeSessionManager() });
    expect(await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" }, retryOp, { text: "hello" })).toBe("ran");
    expect(am2.runWithFallback).toHaveBeenCalledTimes(1);
    await runtime.close(); runtime = undefined;

    const am3 = makeSuccessManager("ran");
    runtime = makeTestRuntime({ agentManager: am3, sessionManager: makeSessionManager() });
    expect(await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" }, runEchoOp, { text: "hello" })).toBe("ran");
    expect(am3.runWithFallback).toHaveBeenCalledTimes(1);
  });
});

describe("callOp — kind:run — interactionBridge threading (AC3/AC4/AC8)", () => {
  test("interactionBridge threaded when set; maxInteractionTurns threaded when set; bridge key absent when not set", async () => {
    const makeRunManager = () => makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({ result: { success: true, exitCode: 0, output: "ran", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] }, fallbacks: [] }),
    });
    const bridge = { detectQuestion: async (_: string) => false, onQuestionDetected: async (_: string) => "answer" };

    const am1 = makeRunManager();
    runtime = makeTestRuntime({ agentManager: am1, sessionManager: makeSessionManager() });
    await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001", interactionBridge: bridge }, runEchoOp, { text: "hello" });
    expect(((am1.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as AgentRunRequest).runOptions.interactionBridge).toBe(bridge);
    await runtime.close(); runtime = undefined;

    const am2 = makeRunManager();
    runtime = makeTestRuntime({ agentManager: am2, sessionManager: makeSessionManager() });
    await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001", maxInteractionTurns: 7 }, runEchoOp, { text: "hello" });
    expect(((am2.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as AgentRunRequest).runOptions.maxInteractionTurns).toBe(7);
    await runtime.close(); runtime = undefined;

    const am3 = makeRunManager();
    runtime = makeTestRuntime({ agentManager: am3, sessionManager: makeSessionManager() });
    await callOp({ runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" }, runEchoOp, { text: "hello" });
    expect("interactionBridge" in ((am3.runWithFallback as ReturnType<typeof mock>).mock.calls[0]?.[0] as AgentRunRequest).runOptions).toBe(false);
  });
});

describe("callOp — run-kind op.recover invocation on retry exhaustion (#993)", () => {
  // A run-kind op whose parse() always throws to simulate unparseable agent output.
  function makeStrictRunOp(overrides: Partial<RunOperation<{ id: string }, { value: string }, Pick<typeof DEFAULT_CONFIG, "routing">>> = {}): RunOperation<{ id: string }, { value: string }, Pick<typeof DEFAULT_CONFIG, "routing">> {
    return {
      kind: "run",
      name: "strict-parse-op",
      stage: "plan",
      config: testSel,
      session: { role: "plan", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "", overridable: false },
        task: { id: "task", content: input.id, overridable: false },
      }),
      parse: (_output) => { throw new Error("parse always throws"); },
      retry: {
        shouldRetry: (_failure, attempt) =>
          attempt < 2 ? { retry: true, delayMs: 0, nextPrompt: "retry" } : { retry: false },
      },
      ...overrides,
    };
  }

  // Builds an agentManager that actually invokes req.executeHop so sendWithParseRetry
  // runs and sets lastRetryTurn. Necessary for testing (b), (c), (d) which depend on
  // lastRetryTurn / retryFallback being set inside the retry loop closure.
  function makeHopInvokingAgentManager() {
    return makeMockAgentManager({
      runAsSessionFn: async () => ({
        output: "File already valid.",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        internalRoundTrips: 0,
      }),
      runWithFallbackFn: async (req) => {
        const result = await req.executeHop!("claude", undefined, { kind: "primary" }, req.runOptions);
        return {
          result: { success: true, exitCode: 0, rateLimited: false, durationMs: 1, output: result.result.output, estimatedCostUsd: result.result.estimatedCostUsd ?? 0, agentFallbacks: [] },
          fallbacks: [],
        };
      },
    });
  }

  // For tests (a) and (e), the mock doesn't need to invoke executeHop because
  // op.recover is called from the catch block regardless of lastRetryTurn.
  function makeChatAckAgentManager() {
    return makeMockAgentManager({
      runWithFallbackFn: async (_req) => ({
        result: { success: true, exitCode: 0, output: "File already valid.", rateLimited: false, durationMs: 1, estimatedCostUsd: 0, agentFallbacks: [] },
        fallbacks: [],
      }),
    });
  }

  test("(a) op.recover defined and returns non-null — returns recovered value, not TurnResult", async () => {
    const agentManager = makeChatAckAgentManager();
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const recovered = { value: "from-disk" };
    const op = makeStrictRunOp({ recover: async () => recovered });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      op,
      { id: "f1" },
    );

    expect(result).toBe(recovered);
  });


  test("(c) both exhaustedFallback and op.recover — exhaustedFallback wins", async () => {
    // Uses hop-invoking mock so sendWithParseRetry runs and retryFallback is set.
    const agentManager = makeHopInvokingAgentManager();
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const recoverCalled: boolean[] = [];
    const op = makeStrictRunOp({
      retry: {
        shouldRetry: (_failure, attempt) =>
          attempt < 2
            ? { retry: true, delayMs: 0, nextPrompt: "retry" }
            : { retry: false, fallback: { value: "from-exhausted-fallback" } },
      },
      recover: async () => { recoverCalled.push(true); return { value: "from-recover" }; },
    });

    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      op,
      { id: "f1" },
    );

    // exhaustedFallback value wins; recover never called
    expect((result as { value: string }).value).toBe("from-exhausted-fallback");
    expect(recoverCalled).toHaveLength(0);
  });

  test.each([
    ["(b) op.recover undefined — falls through to envelope passthrough", makeStrictRunOp()],
    ["(d) op.recover returns null — falls through to envelope passthrough", makeStrictRunOp({ recover: async () => null })],
  ] as const)("%s", async (_label, op) => {
    const agentManager = makeHopInvokingAgentManager();
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });
    const result = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
      op,
      { id: "f1" },
    ) as unknown as { output: string };
    expect(typeof result).toBe("object");
    expect("output" in result).toBe(true);
  });

  test("(e) op.recover throws — error propagates out of callOp", async () => {
    const agentManager = makeChatAckAgentManager();
    const sessionManager = makeSessionManager();
    runtime = makeTestRuntime({ agentManager, sessionManager });

    const op = makeStrictRunOp({ recover: async () => { throw new Error("disk-read-error"); } });

    await expect(
      callOp(
        { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "US-001" },
        op,
        { id: "f1" },
      ),
    ).rejects.toThrow("disk-read-error");
  });
});

