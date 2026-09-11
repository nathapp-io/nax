import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentManager } from "@/agents";
import { _clientDeps, _resetNativeClient } from "@/agents/native/client";
import type { AgentFallbackRecord, AgentRunOptions } from "@/agents/manager-types";
import type { RetryStrategy } from "@/agents/retry";
import {
  makeAdversarialReviewConfig,
  makeMockAgentManager,
  makeMockRuntime,
  makeNaxConfig,
  makePRD,
  makeSemanticReviewConfig,
  makeSessionManager,
  makeTestRuntime,
} from "@test/helpers";
import { DEFAULT_CONFIG, pickSelector } from "@/config";
import { agentManagerConfigSelector, precheckConfigSelector } from "@/config/selectors";
import {
  _storyOrchestratorDeps,
  runPhase,
  runRectification,
} from "@/execution";
import type { AnySlot } from "@/execution/story-orchestrator";
import { toReviewDecisionPayload } from "@/execution/story-orchestrator/review-decision";
import { applyReviewsFailedOpen, sumReviewsFailedOpen } from "@/execution/post-run-review-summary";
import type { Finding, FixCycle, FixStrategy } from "@/findings";
import type { CallOpFn, FixCycleContext } from "@/findings/cycle-types";
import { runFixCycle } from "@/findings";
import { NaxError } from "@/errors";
import type { StoryMetrics } from "@/metrics/types";
import { callOp } from "@/operations";
import type { SemanticReviewInput } from "@/operations/semantic-review";
import { semanticReviewOp } from "@/operations/semantic-review";
import type { CallContext, CompleteOperation, RunOperation } from "@/operations/types";
import type { PipelineContext } from "@/pipeline/types";
import { runPrecheck } from "@/precheck";
import { _checkCliDeps } from "@/precheck/checks-cli";
import { checkModelResolution } from "@/precheck/checks-models";
import type { Check } from "@/precheck/types";
import type { NaxRuntime } from "@/runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Shared harness
// ─────────────────────────────────────────────────────────────────────────────

/** Runtimes created by the tests; closed after every test. */
const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

const testSel = pickSelector("dispatch-truth-sel", "routing");
type TestSelConfig = ReturnType<typeof testSel.select>;

/** Run options for the REAL AgentManager loop (mirrors manager-swap-loop.test.ts). */
function makeManagerRunOptions(overrides: Partial<AgentRunOptions> = {}): AgentRunOptions {
  return {
    prompt: "p",
    workdir: "/tmp",
    modelTier: "balanced",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    timeoutSeconds: 60,
    config: agentManagerConfigSelector.select(DEFAULT_CONFIG),
    ...overrides,
  };
}

function makeManagerConfig(fallbackMap: Record<string, string[]> = {}) {
  return makeNaxConfig({
    agent: {
      fallback: {
        enabled: Object.keys(fallbackMap).length > 0,
        map: fallbackMap,
        maxHopsPerStory: 2,
      },
    },
  });
}

/** A minimal run-kind op; individual tests override `parse` / `retry` / `recover`. */
function makeRunOp(
  name: string,
  overrides: Partial<RunOperation<string, string, TestSelConfig>> = {},
): RunOperation<string, string, TestSelConfig> {
  return {
    kind: "run",
    name,
    stage: "run",
    config: testSel,
    session: { role: "implementer", lifetime: "fresh" },
    build: (input) => ({
      role: { id: "role", content: "You echo input.", overridable: false },
      task: { id: "task", content: input, overridable: false },
    }),
    parse: (output) => output.trim(),
    ...overrides,
  };
}

/**
 * An `AgentRunOutcome` (plus the feature's new required `dispatchesCompleted`
 * field) as reported by a stubbed `agentManager.runWithFallback`.
 */
function runOutcome(
  dispatches: number,
  resultOverrides: Record<string, unknown> = {},
  fallbacks: AgentFallbackRecord[] = [],
) {
  return {
    result: {
      success: dispatches > 0,
      exitCode: dispatches > 0 ? 0 : 1,
      output: "",
      rateLimited: false,
      durationMs: 0,
      estimatedCostUsd: 0,
      agentFallbacks: [],
      ...resultOverrides,
    },
    fallbacks,
    dispatchesCompleted: dispatches,
  };
}

/** The complete-kind dispatch outcome analogue. */
function completeOutcome(dispatches: number) {
  return {
    result: {
      output: "",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
    },
    fallbacks: [] as AgentFallbackRecord[],
    dispatchesCompleted: dispatches,
  };
}

function makeCallRuntime(agentManager: ReturnType<typeof makeMockAgentManager>): NaxRuntime {
  const runtime = makeMockRuntime({ agentManager, sessionManager: makeSessionManager() });
  createdRuntimes.push(runtime);
  return runtime;
}

function callContext(runtime: NaxRuntime): CallContext {
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId: "US-001",
  };
}

/** Runs `callOp` and returns whatever it threw, or null when it resolved. */
async function catchCallOp(ctx: CallContext, op: unknown, input: unknown): Promise<unknown> {
  try {
    await callOp(ctx, op as never, input as never);
    return null;
  } catch (err) {
    return err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — AgentManager.runWithFallback counts completed dispatches
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: AgentRunOutcome.dispatchesCompleted (real runWithFallback loop)", () => {
  test("AC-1: runWithFallback with exactly one hop returning a turn reports dispatchesCompleted exactly 1", async () => {
    // Exactly one hop, dispatched through the real runWithFallback loop via an
    // executeHop callback that returns a (successful) turn.
    const m = new AgentManager(makeManagerConfig(), undefined);
    let hopCalls = 0;
    const outcome = await m.runWithFallback({
      runOptions: makeManagerRunOptions({ storyId: "s-ac1" }),
      bundle: undefined,
      executeHop: async (_agentName, bundle) => {
        hopCalls += 1;
        return {
          result: {
            success: true,
            exitCode: 0,
            output: "the turn the agent returned",
            rateLimited: false,
            durationMs: 1,
            estimatedCostUsd: 0,
          },
          bundle,
          prompt: "p",
        };
      },
    });

    expect(hopCalls).toBe(1);
    const dispatches = (outcome as { dispatchesCompleted?: unknown }).dispatchesCompleted;
    expect(typeof dispatches).toBe("number");
    expect(dispatches).toBe(1);
  });

  test("AC-2: every hop (across retries and fallback) ending in an adapter failure with no turn reports dispatchesCompleted 0", async () => {
    // The primary hop and its fallback target both end in a non-retriable
    // adapter failure — no hop ever completed a turn.
    const adapterFailure = {
      category: "availability" as const,
      outcome: "fail-auth" as const,
      retriable: false,
      message: "auth failure",
    };
    const m = new AgentManager(makeManagerConfig({ claude: ["codex"] }), undefined);
    const outcome = await m.runWithFallback({
      runOptions: makeManagerRunOptions({ storyId: "s-ac2" }),
      bundle: undefined,
      executeHop: async (_agentName, bundle) => ({
        result: {
          success: false,
          exitCode: 1,
          output: "",
          rateLimited: false,
          durationMs: 0,
          estimatedCostUsd: 0,
          adapterFailure,
        },
        bundle,
        prompt: "p",
      }),
    });

    expect(outcome.result.success).toBe(false);
    const dispatches = (outcome as { dispatchesCompleted?: unknown }).dispatchesCompleted;
    expect(dispatches).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-001 — callOp raises CALL_OP_NO_DISPATCH ahead of its other exits
// ─────────────────────────────────────────────────────────────────────────────

describe("US-001: callOp zero-dispatch terminal outcome", () => {
  test("AC-3: run-kind op with dispatchesCompleted 0 throws NaxError with code CALL_OP_NO_DISPATCH", async () => {
    const zeroOutcome = runOutcome(0);
    const manager = makeMockAgentManager({ runWithFallbackFn: async () => zeroOutcome });
    const runtime = makeCallRuntime(manager);

    const thrown = await catchCallOp(callContext(runtime), makeRunOp("ac3-op"), "hello");

    expect(thrown).toBeInstanceOf(NaxError);
    expect((thrown as NaxError).code).toBe("CALL_OP_NO_DISPATCH");
  });

  test("AC-4: the zero-dispatch error context carries stage, storyId and agentName", async () => {
    const zeroOutcome = runOutcome(0);
    const manager = makeMockAgentManager({ runWithFallbackFn: async () => zeroOutcome });
    const runtime = makeCallRuntime(manager);

    const thrown = await catchCallOp(callContext(runtime), makeRunOp("ac4-op"), "hello");

    expect(thrown).toBeInstanceOf(NaxError);
    const context = ((thrown as NaxError).context ?? {}) as Record<string, unknown>;
    expect(typeof context.stage).toBe("string");
    expect((context.stage as string).length).toBeGreaterThan(0);
    expect(context.storyId).toBe("US-001");
    // The op pinned no model, so it dispatched to the resolved agent ("claude"):
    // the context must name the agent the dispatch actually targeted.
    expect(context.agentName).toBe("claude");
  });

  test("AC-5: zero-dispatch callOp never invokes the operation's parse function", async () => {
    const zeroOutcome = runOutcome(0);
    const manager = makeMockAgentManager({ runWithFallbackFn: async () => zeroOutcome });
    const runtime = makeCallRuntime(manager);

    const parseSpy = mock((output: string) => output.trim());
    const thrown = await catchCallOp(callContext(runtime), makeRunOp("ac5-op", { parse: parseSpy }), "hello");

    expect((thrown as NaxError).code).toBe("CALL_OP_NO_DISPATCH");
    expect(parseSpy.mock.calls.length).toBe(0);
  });

  test("AC-6: zero-dispatch callOp consults neither retryStrategy.exhaustedFallback nor op.recover", async () => {
    const zeroOutcome = runOutcome(0);
    const manager = makeMockAgentManager({ runWithFallbackFn: async () => zeroOutcome });
    const runtime = makeCallRuntime(manager);

    const exhaustedFallbackSpy = mock((lastOutput: string) => ({ recovered: true, from: lastOutput }));
    const recoverSpy = mock(async () => null);
    // A strategy that declares an exhaustedFallback (exactly what the review ops
    // declare via makeParseRetryStrategy) — the zero-dispatch branch must run
    // ahead of it, so the fallback is never consulted.
    const strategy: RetryStrategy & { exhaustedFallback: (lastOutput: string) => unknown } = {
      shouldRetry: () => ({ retry: false }),
      exhaustedFallback: exhaustedFallbackSpy,
    };
    const op = makeRunOp("ac6-op", {
      retry: () => strategy,
      recover: recoverSpy as unknown as RunOperation<string, string, TestSelConfig>["recover"],
    });

    const thrown = await catchCallOp(callContext(runtime), op, "hello");

    expect((thrown as NaxError).code).toBe("CALL_OP_NO_DISPATCH");
    expect(exhaustedFallbackSpy.mock.calls.length).toBe(0);
    expect(recoverSpy.mock.calls.length).toBe(0);
  });

  test("AC-7: dispatchesCompleted 1 with an empty output string still throws CALL_OP_NO_OUTPUT (not NO_DISPATCH)", async () => {
    // A dispatch that completed and returned an (empty) turn is NOT
    // zero-dispatch — the empty-output exit keeps governing that case.
    const oneDispatchEmptyOutput = runOutcome(1, { output: "" });
    const manager = makeMockAgentManager({ runWithFallbackFn: async () => oneDispatchEmptyOutput });
    const runtime = makeCallRuntime(manager);

    const thrown = await catchCallOp(callContext(runtime), makeRunOp("ac7-op"), "hello");

    expect(thrown).toBeInstanceOf(NaxError);
    const code = (thrown as NaxError).code;
    expect(code).toBe("CALL_OP_NO_OUTPUT");
    expect(code).not.toBe("CALL_OP_NO_DISPATCH");
  });

  test("AC-8: complete-kind op with dispatchesCompleted 0 throws CALL_OP_NO_DISPATCH", async () => {
    const zeroComplete = completeOutcome(0);
    const manager = makeMockAgentManager({ completeAsWithFallbackFn: async () => zeroComplete });
    const runtime = makeCallRuntime(manager);

    const completeOp: CompleteOperation<string, string, TestSelConfig> = {
      kind: "complete",
      name: "ac8-complete-op",
      stage: "run",
      config: testSel,
      build: (input) => ({
        role: { id: "role", content: "echo", overridable: false },
        task: { id: "task", content: input, overridable: false },
      }),
      parse: (output) => output,
    };

    const thrown = await catchCallOp(callContext(runtime), completeOp, "hello");

    expect(thrown).toBeInstanceOf(NaxError);
    expect((thrown as NaxError).code).toBe("CALL_OP_NO_DISPATCH");
  });

  test("AC-9: zero dispatch with an adapterFailure still records the failure and fallback records before throwing", async () => {
    const adapterFailure = {
      category: "availability" as const,
      outcome: "fail-rate-limit" as const,
      retriable: true,
      message: "429 exhausted",
    };
    const fallbackRecord: AgentFallbackRecord = {
      storyId: "US-001",
      priorAgent: "claude",
      newAgent: "codex",
      hop: 1,
      outcome: "fail-rate-limit",
      category: "availability",
      timestamp: new Date(0).toISOString(),
      costUsd: 0,
    };
    const zeroWithFailure = runOutcome(0, { adapterFailure }, [fallbackRecord]);
    const manager = makeMockAgentManager({ runWithFallbackFn: async () => zeroWithFailure });
    const runtime = makeCallRuntime(manager);

    const thrown = await catchCallOp(callContext(runtime), makeRunOp("ac9-op"), "hello");

    // The zero-dispatch throw happened…
    expect(thrown).toBeInstanceOf(NaxError);
    expect((thrown as NaxError).code).toBe("CALL_OP_NO_DISPATCH");
    // …and BOTH per-story stores were already populated — recording happened
    // before the throw, never on a post-throw path.
    expect(runtime.lastAdapterFailure.get("US-001")).toEqual(adapterFailure);
    const storedFallbacks = runtime.agentFallbacks.get("US-001") ?? [];
    expect(storedFallbacks.length).toBe(1);
    expect(storedFallbacks[0]).toEqual(fallbackRecord);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-002 — review gates never produce a verdict from a dispatch that never ran
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal orchestrator op/slot for runPhase — the dispatch itself is stubbed. */
function makeOrchestratorOp(name: string): AnySlot["op"] {
  return {
    name,
    stage: "review",
    kind: "run",
    config: [],
    session: { role: "reviewer-semantic", lifetime: "fresh" },
    build: () => ({
      role: { id: "role", content: "", overridable: false },
      task: { id: "task", content: "", overridable: false },
    }),
    parse: () => ({}),
  };
}

function makeReviewSlot(name: string): AnySlot {
  return { op: makeOrchestratorOp(name), input: {} };
}

function makePhaseCallCtx(): CallContext {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/x",
    agentName: "claude",
    storyId: "US-002",
  };
}

describe("US-002: review phases report zero-dispatch instead of a verdict", () => {
  let origCallOp: typeof _storyOrchestratorDeps.callOp;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
    // The review dispatch seam is stubbed to raise the zero-dispatch code.
    // Entry point is the review phase's own entry point (runPhase).
    _storyOrchestratorDeps.callOp = (async () => {
      throw new NaxError("no dispatch reached a model", "CALL_OP_NO_DISPATCH");
    }) as typeof _storyOrchestratorDeps.callOp;
  });
  afterEach(() => {
    _storyOrchestratorDeps.callOp = origCallOp;
  });

  test("AC-10: the semantic review phase returns a CheckResult with noDispatch true and success false", async () => {
    const output = await runPhase(makePhaseCallCtx(), makeReviewSlot("semantic-review"), {}, {});

    const result = output as { noDispatch?: boolean; success?: boolean };
    expect(result.noDispatch).toBe(true);
    expect(result.success).toBe(false);
  });

  test("AC-11: the semantic no-dispatch CheckResult never carries failOpen true", async () => {
    const output = await runPhase(makePhaseCallCtx(), makeReviewSlot("semantic-review"), {}, {});

    const result = output as { failOpen?: boolean };
    // failOpen is undefined or false — a zero-dispatch result is the absence of
    // a review, never the degraded-pass flag.
    expect(result.failOpen).not.toBe(true);
  });

  test("AC-12: the adversarial review phase catches the zero-dispatch error — no exception, no parse error", async () => {
    // The await resolving at all proves no exception escapes the phase. The
    // pre-feature behaviour surfaced the never-produced turn as an adversarial
    // parse error; the result must not carry that shape.
    const output = await runPhase(makePhaseCallCtx(), makeReviewSlot("adversarial-review"), {}, {});

    const result = output as { noDispatch?: boolean; success?: boolean };
    expect(result.noDispatch).toBe(true);
    expect(result.success).toBe(false);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain("CALL_OP_PARSE");
    expect(serialized).not.toContain("invalid JSON shape");
    expect(serialized).not.toContain("parse failed");
  });

  test("AC-15: with every review phase zero-dispatch, the story-level review decision is passed:false, not a degraded pass", async () => {
    const ctx = makePhaseCallCtx();
    const semOutput = await runPhase(ctx, makeReviewSlot("semantic-review"), {}, {});
    const advOutput = await runPhase(ctx, makeReviewSlot("adversarial-review"), {}, {});

    const semDecision = toReviewDecisionPayload("semantic-review", semOutput);
    const advDecision = toReviewDecisionPayload("adversarial-review", advOutput);

    // Both reviewers report a genuine failure — not a degraded pass — so the
    // story is NOT marked as passing story-level review.
    expect(semDecision).not.toBeNull();
    expect(advDecision).not.toBeNull();
    expect(semDecision?.passed).toBe(false);
    expect(advDecision?.passed).toBe(false);
    expect(semDecision?.failOpen).not.toBe(true);
    expect(advDecision?.failOpen).not.toBe(true);
  });

  test("AC-13: a COMPLETED semantic dispatch returning an unparseable non-empty string still fails open", async () => {
    // Real op + real callOp; only the agent layer is stubbed. The dispatch
    // COMPLETED (dispatchesCompleted: 1) and returned a non-empty string that
    // defeats the parser — the genuine fail-open case, distinct from
    // zero-dispatch.
    const completedDispatchGarbage = runOutcome(1, { output: "this is not json at all {{{" });
    const manager = makeMockAgentManager({ runWithFallbackFn: async () => completedDispatchGarbage });
    const runtime = makeCallRuntime(manager);

    const input: SemanticReviewInput = {
      workdir: "/tmp/wd",
      story: {
        id: "STORY-AC13",
        title: "Add login endpoint",
        description: "Implement POST /login",
        acceptanceCriteria: ["Returns 200 on valid credentials"],
      },
      semanticConfig: makeSemanticReviewConfig(),
      mode: "ref",
      storyGitRef: "abc1234",
      stat: "src/auth.ts | 1 +",
    };

    const result = await callOp(callContext(runtime), semanticReviewOp, input);

    const record = result as { failOpen?: boolean; noDispatch?: boolean };
    expect(record.failOpen).toBe(true);
    expect(record.noDispatch).not.toBe(true);
  });
});

describe("US-002 AC-14: RunResult.reviewsFailedOpen counts only failOpen results", () => {
  test("AC-14: a noDispatch result contributes 0 to the fail-open tally", () => {
    const ctx = {} as Pick<PipelineContext, "reviewsFailedOpen"> as PipelineContext;
    applyReviewsFailedOpen(ctx, {
      "semantic-review": { noDispatch: true, success: false },
      "adversarial-review": { failOpen: true, passed: true, findings: [] },
    });
    // Exactly one of the two results degraded to a fail-open pass; the
    // zero-dispatch result contributes 0 to the tally.
    expect(ctx.reviewsFailedOpen).toBe(1);

    // A story whose only review outcome is zero-dispatch tallies nothing.
    const ctxNoDispatchOnly = {} as Pick<PipelineContext, "reviewsFailedOpen"> as PipelineContext;
    applyReviewsFailedOpen(ctxNoDispatchOnly, {
      "semantic-review": { noDispatch: true, success: false },
    });
    expect(ctxNoDispatchOnly.reviewsFailedOpen).toBeUndefined();

    // RunResult.reviewsFailedOpen sums the per-story tallies.
    const total = sumReviewsFailedOpen([{ reviewsFailedOpen: 1 } as StoryMetrics, {} as StoryMetrics]);
    expect(total).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-003 — the fix cycle routes zero-dispatch into its skip-validate exit
// ─────────────────────────────────────────────────────────────────────────────

function cycleFinding(message: string): Finding {
  return { severity: "error", category: "test", source: "tdd-verifier", message };
}

function makeFixStrategy(
  overrides: Partial<FixStrategy<Finding, unknown, unknown, unknown>> = {},
): FixStrategy<Finding, unknown, unknown, unknown> {
  return {
    name: "strategy",
    appliesTo: () => true,
    fixOp: { name: "rectify-fix-op" } as FixStrategy<Finding, unknown, unknown, unknown>["fixOp"],
    buildInput: () => ({}),
    maxAttempts: 12,
    ...overrides,
  };
}

function makeFixCycle(validate: FixCycle<Finding>["validate"], overrides: Partial<FixCycle<Finding>> = {}): FixCycle<Finding> {
  return {
    findings: [cycleFinding("persisting bug")],
    iterations: [],
    strategies: [makeFixStrategy({ maxAttempts: 1 })],
    validate,
    config: { maxAttemptsTotal: 1, validatorRetries: 1 },
    ...overrides,
  };
}

function makeCycleCtx(storyId: string): FixCycleContext {
  const runtime = makeTestRuntime();
  createdRuntimes.push(runtime);
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp",
    agentName: "claude",
    storyId,
  } as FixCycleContext;
}

/** A callOp stub that always raises the zero-dispatch code. */
function makeNoDispatchCallOp(): CallOpFn {
  return (async (_ctx: unknown, _op: unknown, _input: unknown): Promise<never> => {
    throw new NaxError("no dispatch reached a model", "CALL_OP_NO_DISPATCH");
  }) as CallOpFn;
}

describe("US-003: runFixCycle zero-dispatch exit", () => {
  test("AC-16: strategy dispatch raising CALL_OP_NO_DISPATCH never invokes validate", async () => {
    const ctx = makeCycleCtx("US-016");
    const validateSpy = mock(async () => [cycleFinding("persisting bug")]);
    const cycle = makeFixCycle(validateSpy);

    // The await resolving at all proves the zero-dispatch dispatch is a
    // terminal cycle exit rather than a propagated throw.
    const result = await runFixCycle(cycle, ctx, "ac16", { callOp: makeNoDispatchCallOp(), logger: null });

    expect(result).toBeDefined();
    expect(validateSpy.mock.calls.length).toBe(0);
  });

  test("AC-17: the zero-dispatch exit reason is its own FixCycleExitReason member", async () => {
    const ctx = makeCycleCtx("US-017");
    const cycle = makeFixCycle(async () => [cycleFinding("persisting bug")]);

    const result = await runFixCycle(cycle, ctx, "ac17", { callOp: makeNoDispatchCallOp(), logger: null });

    expect(result.exitReason).toBe("no-dispatch");
    expect(["agent-gave-up", "validate-short-circuit"]).not.toContain(result.exitReason);
  });

  test("AC-18: three consecutive zero-dispatch rectification iterations never reach the no-progress bail", async () => {
    const runtime = makeTestRuntime();
    const ctx = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-018",
    } as CallContext;

    const gateFinding: Finding = {
      source: "test-runner",
      severity: "error",
      category: "",
      message: "the gate is red",
      file: "test/a.test.ts",
      rule: "gate rule",
    };
    const phaseOutputs: Record<string, unknown> = {
      "full-suite-gate": { success: false, passed: false, findings: [gateFinding] },
    };
    const state: Parameters<typeof runRectification>[1] = {
      fullSuiteGate: {
        kind: "full-suite-gate",
        slot: { op: makeOrchestratorOp("full-suite-gate"), input: {} },
      },
      rectification: {
        maxAttempts: 3,
        strategies: [
          {
            name: "strategy",
            appliesTo: () => true,
            fixOp: makeOrchestratorOp("rectify-fix-op"),
            buildInput: () => ({ story: "US-018" }),
            maxAttempts: 12,
          },
        ],
        abortOnIncreasingFailures: false,
        abortOnNoProgress: true,
        consecutiveNoProgressToBail: 3,
      },
    };

    let fixDispatches = 0;
    const origCallOp = _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.callOp = (async (_c: unknown, op: { name: string }) => {
      if (op.name === "rectify-fix-op") {
        fixDispatches += 1;
        throw new NaxError("no dispatch reached a model", "CALL_OP_NO_DISPATCH");
      }
      throw new NaxError("revalidation ran on a zero-dispatch iteration", "CALL_OP_NO_DISPATCH");
    }) as typeof _storyOrchestratorDeps.callOp;

    try {
      await runRectification(ctx, state, {}, phaseOutputs, { skipGateTriage: true });
    } finally {
      _storyOrchestratorDeps.callOp = origCallOp;
    }

    // Three fix dispatches, each finishing its iteration via the zero-dispatch
    // exit, and NO no-progress bail: zero-dispatch iterations are exempt from
    // the abortOnNoProgress streak, so three of them must not bail the cycle.
    const rect = phaseOutputs.rectification as {
      iterationCount?: number;
      exitReason?: string;
      success?: boolean;
    };
    expect(fixDispatches).toBe(3);
    expect(rect.iterationCount).toBe(3);
    expect(rect.exitReason).toBe("no-dispatch");
    expect(rect.exitReason).not.toBe("bail-when");
    expect(rect.success).toBe(false);
  });

  test("AC-19a: a completed zero-edit dispatch (no UNRESOLVED) still runs validate once and keeps the existing exit", async () => {
    const ctx = makeCycleCtx("US-019a");
    const validateSpy = mock(async () => [cycleFinding("persisting bug")]);
    const cycle = makeFixCycle(validateSpy, {
      strategies: [makeFixStrategy({ maxAttempts: 1 })],
      config: { maxAttemptsTotal: 10, validatorRetries: 1 },
    });
    const completedNoEdits = async () => ({ edits: [] });

    const result = await runFixCycle(cycle, ctx, "ac19a", {
      callOp: completedNoEdits as CallOpFn,
      logger: null,
    });

    // The existing no-edit path is unchanged: validate runs for the iteration,
    // and the cycle takes the pre-existing attempt-cap exit.
    expect(validateSpy.mock.calls.length).toBe(1);
    expect(result.exitReason).toBe("max-attempts-per-strategy");
  });

  test("AC-19b: a completed dispatch signalling UNRESOLVED keeps the agent-gave-up exit and skips validate", async () => {
    const ctx = makeCycleCtx("US-019b");
    const validateSpy = mock(async () => [cycleFinding("persisting bug")]);
    const cycle = makeFixCycle(validateSpy, {
      strategies: [
        makeFixStrategy({
          maxAttempts: 3,
          extractApplied: async () => ({ targetFiles: [], summary: "", unresolved: "cannot fix this" }),
        }),
      ],
      config: { maxAttemptsTotal: 10, validatorRetries: 1 },
    });
    const completesNormally = async () => ({ edits: [] });

    const result = await runFixCycle(cycle, ctx, "ac19b", {
      callOp: completesNormally as CallOpFn,
      logger: null,
    });

    expect(result.exitReason).toBe("agent-gave-up");
    expect(validateSpy.mock.calls.length).toBe(0);
  });

  test("AC-20: the zero-dispatch exit result carries the failed dispatch's accumulated spend", async () => {
    const ctx = makeCycleCtx("US-020");
    const validateSpy = mock(async () => [cycleFinding("persisting bug")]);
    const cycle = makeFixCycle(validateSpy);

    // The strategy dispatch records $0.42 of real spend against ITS correlation
    // id (the dispatch context's callId) before raising the zero-dispatch code —
    // exactly what the cost middleware does for a real failing dispatch.
    const spendingNoDispatch = (async (
      dispatchCtx: FixCycleContext,
      _op: unknown,
      _input: unknown,
    ): Promise<never> => {
      dispatchCtx.runtime.costAggregator.record({
        ts: Date.now(),
        runId: dispatchCtx.runtime.runId,
        agentName: "claude",
        model: "test-model",
        callId: dispatchCtx.callId,
        estimatedCostUsd: 0.42,
        exactCostUsd: 0.42,
        costUsd: 0.42,
        confidence: "exact",
        durationMs: 1,
      });
      throw new NaxError("no dispatch reached a model", "CALL_OP_NO_DISPATCH");
    }) as CallOpFn;

    const result = await runFixCycle(cycle, ctx, "ac20", { callOp: spendingNoDispatch, logger: null });

    expect(validateSpy.mock.calls.length).toBe(0);
    // The zero-dispatch exit result reports the failed dispatch's spend (the
    // field is `costUsd` on the existing FixCycleResult shape; `totalCost`
    // accepted equally).
    const reported = (result as { totalCost?: number }).totalCost ?? result.costUsd;
    expect(reported).toBe(0.42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-004 — precheck resolves every configured model id (AC-21..AC-31)
// ─────────────────────────────────────────────────────────────────────────────

/** Fresh git repo with an empty initial commit — a clean tree the precheck git blockers accept. */
function makeCleanGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nax-precheck-ac-"));
  execSync(
    "git init -q && git config user.email test@example.com && git config user.name test && git commit -q --allow-empty -m init",
    { cwd: dir, stdio: "ignore" },
  );
  return dir;
}

describe("US-004: model-resolution precheck", () => {
  let origBuild: typeof _clientDeps.build;
  let buildCalls: number;

  beforeEach(() => {
    origBuild = _clientDeps.build;
    buildCalls = 0;
    _resetNativeClient();
  });
  afterEach(() => {
    _clientDeps.build = origBuild;
    _resetNativeClient();
  });

  /**
   * Stub the native catalog resolver via the documented `_clientDeps.build`
   * seam (the real builder loads the bundled nax-ai catalog, which tests must
   * never do — test/preload.ts installs a sentinel on exactly this seam).
   * `unresolvable` lists bare model ids the fake catalog rejects; every other
   * id resolves. `reject: true` makes the catalog load itself fail.
   */
  function stubCatalog(opts: { unresolvable?: Set<string>; reject?: boolean } = {}): void {
    const unresolvable = opts.unresolvable ?? new Set<string>();
    const fakeClient = {
      model: async (provider: string, id: string) => {
        if (unresolvable.has(id)) {
          throw new Error(`Unknown model "${id}" for provider "${provider}"`);
        }
        return { provider, model: id, contextWindow: 200_000 };
      },
      pricing: () => ({ input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 }),
    };
    _clientDeps.build = (async () => {
      buildCalls += 1;
      if (opts.reject) throw new Error("catalog failed to load");
      return fakeClient;
    }) as typeof _clientDeps.build;
    _resetNativeClient();
  }

  /** Runs the model-resolution check and normalises its result to Check[]. */
  async function runModelCheck(config: NaxConfig): Promise<Check[]> {
    const raw = await (checkModelResolution as (c: unknown) => Promise<Check | Check[]>)(config);
    return Array.isArray(raw) ? raw : [raw];
  }

  test("AC-21: an unresolvable native id at models.native.powerful yields exactly one failing check at tier blocker", async () => {
    stubCatalog({ unresolvable: new Set(["nonexistent-model-xyz"]) });
    const config = makeNaxConfig({
      models: { native: { powerful: "anthropic/nonexistent-model-xyz" } },
    });

    const checks = await runModelCheck(config);

    const failing = checks.filter((c) => !c.passed && c.message.includes("nonexistent-model-xyz"));
    expect(failing.length).toBe(1);
    // Exact tier spelling — "blocker", not nax#1983's proposed "blocking".
    expect(failing[0].tier).toBe("blocker");
    expect(failing[0].passed).toBe(false);
    expect(checks.some((c) => (c.tier as string) === "blocking")).toBe(false);
  });

  test("AC-22: the blocker's message names the config key path, the provider and the id", async () => {
    stubCatalog({ unresolvable: new Set(["nonexistent-model-xyz"]) });
    const config = makeNaxConfig({
      models: { native: { powerful: "anthropic/nonexistent-model-xyz" } },
    });

    const checks = await runModelCheck(config);
    const blocker = checks.find((c) => !c.passed && c.message.includes("nonexistent-model-xyz"));

    expect(blocker).toBeDefined();
    expect(blocker?.message).toContain("models.native.powerful");
    expect(blocker?.message).toContain("anthropic");
    expect(blocker?.message).toContain("nonexistent-model-xyz");
  });

  test("AC-23: an unresolvable id pinned on an acp agent is a warning, never a blocker", async () => {
    stubCatalog({ unresolvable: new Set(["unresolvable-id-123"]) });
    const config = makeNaxConfig({
      review: {
        adversarial: makeAdversarialReviewConfig({
          model: { agent: "acp-agent", model: "unresolvable-id-123" },
        }),
      },
    });

    const checks = await runModelCheck(config);

    const failingForId = checks.filter((c) => !c.passed && c.message.includes("unresolvable-id-123"));
    expect(failingForId.length).toBe(1);
    expect(failingForId[0].tier).toBe("warning");
    expect(checks.filter((c) => c.tier === "blocker" && c.message.includes("unresolvable-id-123")).length).toBe(0);
  });

  test("AC-24: an id declared under agent.native.catalogOverrides produces no failing check", async () => {
    stubCatalog({ unresolvable: new Set(["override-model-1"]) });
    const config = makeNaxConfig({
      models: { native: { powerful: "anthropic/override-model-1" } },
      agent: {
        native: {
          catalogOverrides: [
            {
              provider: "anthropic",
              models: [
                {
                  id: "override-model-1",
                  protocol: "anthropic-messages",
                  contextWindow: 200_000,
                  supportsTools: true,
                  thinkingLevels: ["high"],
                  pricing: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
                },
              ],
            },
          ],
        },
      },
    });

    const checks = await runModelCheck(config);

    expect(checks.filter((c) => !c.passed && c.message.includes("override-model-1")).length).toBe(0);
  });

  test("AC-25: every configured site holding an unresolvable id is named by exactly one failing check", async () => {
    const missing = (n: string) => `anthropic/missing-${n}`;
    stubCatalog({
      unresolvable: new Set([
        "missing-fast",
        "missing-balanced",
        "missing-powerful",
        "missing-sem",
        "missing-adv",
        "missing-plan",
        "missing-acc",
        "missing-route",
        "missing-fallback",
      ]),
    });
    const config = makeNaxConfig({
      models: {
        claude: { fast: missing("fast"), balanced: missing("balanced"), powerful: missing("powerful") },
      },
      review: {
        semantic: { ...makeSemanticReviewConfig(), model: { agent: "claude", model: missing("sem") } },
        adversarial: { ...makeAdversarialReviewConfig(), model: { agent: "claude", model: missing("adv") } },
      },
      plan: { model: missing("plan") },
      acceptance: { model: missing("acc") },
      tdd: { sessionTiers: { testWriter: "fast", verifier: "fast" } },
      routing: { llm: { model: missing("route") } },
      autoMode: { escalation: { tierOrder: [{ tier: "fast", attempts: 2 }] } },
      agent: { fallback: { enabled: true, map: { claude: [{ agent: "claude", model: missing("fallback") }] } } },
    });

    const checks = await runModelCheck(config);
    const failing = checks.filter((c) => !c.passed);
    expect(failing.length).toBeGreaterThanOrEqual(9);

    // Each configured site's key path appears in at least one failing check's
    // message, and each site is named by EXACTLY ONE failing check (no
    // duplicates for the same site).
    const sites: Array<[string, string]> = [
      ["review.semantic", "anthropic/missing-sem"],
      ["review.adversarial", "anthropic/missing-adv"],
      ["plan", "anthropic/missing-plan"],
      ["acceptance", "anthropic/missing-acc"],
      ["tdd.sessionTiers.testWriter", missing("fast")],
      ["tdd.sessionTiers.verifier", missing("fast")],
      ["routing.llm.model", missing("route")],
      ["autoMode.escalation.tierOrder", missing("fast")],
      ["agent.fallback.map", missing("fallback")],
    ];
    for (const [keyPath, id] of sites) {
      const naming = failing.filter((c) => c.message.includes(keyPath) && c.message.includes(id));
      expect(naming.length, `site ${keyPath} (id ${id})`).toBe(1);
    }
  });

  test("AC-26: a rejecting catalog resolver yields exactly one warning and no blocker", async () => {
    stubCatalog({ reject: true });
    const config = makeNaxConfig({
      models: { native: { powerful: "anthropic/nonexistent-model-xyz" } },
    });

    const checks = await runModelCheck(config);

    const failing = checks.filter((c) => !c.passed);
    expect(failing.length).toBe(1);
    expect(failing[0].tier).toBe("warning");
    expect(failing[0].message.length).toBeGreaterThan(0);
    expect(failing[0].message.toLowerCase()).toContain("catalog");
    expect(checks.filter((c) => c.tier === "blocker" && !c.passed).length).toBe(0);
  });

  test("AC-27: a literal pin discarding a priced models entry warns naming the pin key, the id and catalogOverrides", async () => {
    stubCatalog({});
    const config = makeNaxConfig({
      models: {
        native: {
          powerful: {
            provider: "anthropic",
            model: "that-model-id",
            pricing: { inputPer1M: 3, outputPer1M: 15 },
            contextWindow: 200_000,
          },
        },
      },
      review: {
        adversarial: {
          ...makeAdversarialReviewConfig(),
          model: { agent: "native", model: "that-model-id" },
        },
      },
    });

    const checks = await runModelCheck(config);
    const droppedOverrides = checks.filter((c) => c.message.includes("agent.native.catalogOverrides"));

    expect(droppedOverrides.length).toBeGreaterThanOrEqual(1);
    const target = droppedOverrides.find(
      (c) => c.message.includes("review.adversarial") && c.message.includes("that-model-id"),
    );
    expect(target).toBeDefined();
    expect(target?.tier).toBe("warning");
  });

  test("AC-28: the same models entry reached only via its tier name emits no dropped-overrides warning", async () => {
    stubCatalog({});
    const config = makeNaxConfig({
      models: {
        native: {
          powerful: {
            provider: "anthropic",
            model: "that-model-id",
            pricing: { inputPer1M: 3, outputPer1M: 15 },
            contextWindow: 200_000,
          },
        },
      },
      // No literal {agent, model} pin anywhere names that-model-id — it is
      // reachable only through the `powerful` tier route, which honours the
      // configured pricing/contextWindow.
    });

    const checks = await runModelCheck(config);

    expect(checks.filter((c) => c.message.includes("agent.native.catalogOverrides")).length).toBe(0);
  });

  test("AC-29: the precheck config selector exposes all six model-walk slices", () => {
    const slice = precheckConfigSelector.select(makeNaxConfig()) as unknown as Record<string, unknown>;
    for (const key of ["models", "plan", "acceptance", "autoMode", "tdd", "routing"]) {
      expect(Object.prototype.hasOwnProperty.call(slice, key)).toBe(true);
      expect(slice[key]).not.toBeUndefined();
    }
  });

  test("AC-30: runPrecheck reaches the model-resolution check through the stubbed catalog resolver", async () => {
    const workdir = makeCleanGitRepo();
    try {
      stubCatalog({ unresolvable: new Set(["nonexistent-model-xyz"]) });
      const origSpawn = _checkCliDeps.spawn;
      _checkCliDeps.spawn = mock((() => ({ exited: Promise.resolve(0) })) as typeof _checkCliDeps.spawn);
      try {
        const config = makeNaxConfig({
          models: { native: { powerful: "anthropic/nonexistent-model-xyz" } },
        });

        const result = await runPrecheck(config, makePRD(), { workdir, silent: true });

        // (a) The stubbed resolver was actually invoked by the run.
        expect(buildCalls).toBeGreaterThanOrEqual(1);
        // (b) The blockers include the model-resolution check — failing, tier
        // "blocker", naming the configured model id.
        const modelChecks = result.result.blockers.filter((c) => c.name === "model-resolution");
        expect(modelChecks.length).toBeGreaterThanOrEqual(1);
        expect(modelChecks[0].passed).toBe(false);
        expect(modelChecks[0].tier).toBe("blocker");
        expect(modelChecks[0].message).toContain("nonexistent-model-xyz");
      } finally {
        _checkCliDeps.spawn = origSpawn;
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  test("AC-31: runPrecheck with every configured id resolvable reports no model-resolution blocker", async () => {
    const workdir = makeCleanGitRepo();
    try {
      stubCatalog({});
      const origSpawn = _checkCliDeps.spawn;
      _checkCliDeps.spawn = mock((() => ({ exited: Promise.resolve(0) })) as typeof _checkCliDeps.spawn);
      try {
        const result = await runPrecheck(makeNaxConfig(), makePRD(), { workdir, silent: true });

        expect(result.result.blockers.filter((c) => c.name === "model-resolution").length).toBe(0);
      } finally {
        _checkCliDeps.spawn = origSpawn;
      }
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });
});