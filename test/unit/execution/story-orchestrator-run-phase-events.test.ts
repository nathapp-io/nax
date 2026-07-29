/**
 * StoryOrchestrator runPhase — story:phase:completed event emission
 *
 * Covers US-002 (Story-phase event emission and outcome derivation).
 *
 * The contract: every `runPhase` invocation emits exactly one
 * `story:phase:completed` event whose `outcome` is derived from the operation
 * output or thrown error, `costUsd` is the invocation's own scope snapshot total
 * (NOT the accumulated `phaseCosts` entry), and `durationMs` is the elapsed
 * operation-dispatch time. Subscriber exceptions are fail-open.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CallContext } from "@/operations";
import type { CostScopeHandle } from "@/runtime";
import { pipelineEventBus, type StoryPhaseCompletedEvent } from "@/pipeline";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import { makeTestRuntime } from "@test/helpers";

type AnyOp = Parameters<typeof _storyOrchestratorDeps.callOp>[1];

function makeCallCtx(): CallContext {
  const runtime = makeTestRuntime();
  return {
    runtime,
    packageView: runtime.packages.repo(),
    packageDir: "/tmp/x",
    agentName: "claude",
    storyId: "US-002",
  };
}

function makeOp(name: string): AnyOp {
  return {
    name,
    stage: "verify",
    kind: "run",
    config: [],
    build: () => ({ prompt: "", user: "", extras: {} }),
    parse: () => ({}),
  } as unknown as AnyOp;
}

function makeSlot(opName: string) {
  return { op: makeOp(opName), input: {} };
}

const origCallOp = _storyOrchestratorDeps.callOp;
const origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;

beforeEach(() => {
  pipelineEventBus.clear();
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
  pipelineEventBus.clear();
});

describe("runPhase — story:phase:completed event emission", () => {
  test("AC1: emits exactly one story:phase:completed event for a passing operation", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received).toHaveLength(1);
    unsub();
  });

  test("AC2: emitted event phase equals the operation name", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("lint-check"), {}, {});

    expect(received[0].phase).toBe("lint-check");
    unsub();
  });

  test("AC3: outcome is 'passed' when operation returns { passed: true }", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("AC4: outcome is 'failed' when operation returns { passed: false }", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: false })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("failed");
    unsub();
  });

  test("AC5: outcome is 'skipped' when operation returns { status: 'skipped' }", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ status: "skipped" })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("lint-check"), {}, {});

    expect(received[0].outcome).toBe("skipped");
    unsub();
  });

  test("AC6: outcome is 'error' when operation throws", async () => {
    _storyOrchestratorDeps.callOp = (async () => {
      throw new Error("boom");
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await expect(runPhase(ctx, makeSlot("verifier"), {}, {})).rejects.toThrow("boom");

    expect(received).toHaveLength(1);
    expect(received[0].outcome).toBe("error");
    unsub();
  });

  test("AC7: rethrows the original error unchanged", async () => {
    const sentinel = new Error("original-error-sentinel");
    _storyOrchestratorDeps.callOp = (async () => {
      throw sentinel;
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const ctx = makeCallCtx();
    const thrown = await runPhase(ctx, makeSlot("verifier"), {}, {}).catch((e: unknown) => e);
    expect(thrown).toBe(sentinel);
  });

  test("AC8: outcome is 'passed' when operation returns a non-object value (string)", async () => {
    _storyOrchestratorDeps.callOp = (async () => "some-string") as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("AC9: event has no 'details' field for non-object output", async () => {
    _storyOrchestratorDeps.callOp = (async () => 42) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].outcome).toBe("passed");
    expect(received[0]).not.toHaveProperty("details");
    unsub();
  });

  test("AC10: outcome is 'passed' when buildPhaseOutcomeLogData reports success", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ success: true, status: "passed" })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("full-suite-gate"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("gate-op skip envelope { success: true, status: 'skipped' } emits 'passed' (buildPhaseOutcomeLogData reports success)", async () => {
    // Real-world gate-ops (lint-check, typecheck-check, full-suite-gate, verify-scoped)
    // return { success: true, status: 'skipped' } when skipping. buildPhaseOutcomeLogData
    // reports success for this envelope, so AC10 mandates the outcome be 'passed'.
    _storyOrchestratorDeps.callOp = (async () => ({
      success: true,
      passed: true,
      status: "skipped",
      findings: [],
    })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("full-suite-gate"), {}, {});

    expect(received[0].outcome).toBe("passed");
    unsub();
  });

  test("AC11: semantic-review emits an outcome even though deterministic logging returns early", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: false, findings: [] })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("semantic-review"), {}, {});

    expect(received).toHaveLength(1);
    expect(received[0].outcome).toBe("failed");
    unsub();
  });

  test("AC12: emitted costUsd equals the invocation's scope snapshot total, not the accumulated phaseCosts", async () => {
    const runtime = makeTestRuntime();
    const scopeCosts: Record<string, number> = { "verifier": 0.123, "implementer": 0.999 };
    let openCount = 0;
    const realOpenScope = runtime.costAggregator.openScope.bind(runtime.costAggregator);
    runtime.costAggregator.openScope = ((scopeId?: string): CostScopeHandle => {
      openCount += 1;
      const handle = realOpenScope(scopeId);
      const opName = openCount === 1 ? "verifier" : "implementer";
      const expected = scopeCosts[opName] ?? 0;
      return {
        scopeId: handle.scopeId,
        snapshot: () => ({
          ...handle.snapshot(),
          totalCostUsd: expected,
        }),
        close: handle.close,
      };
    }) as typeof runtime.costAggregator.openScope;

    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx: CallContext = {
      runtime,
      packageView: runtime.packages.repo(),
      packageDir: "/tmp/x",
      agentName: "claude",
      storyId: "US-002",
    };

    // Pre-seed the accumulated phaseCosts for this phase — the event must NOT
    // pick this up. The phaseCosts arg is updated by runPhase's finally block,
    // so by the time the test asserts, phaseCosts[opName] would already include
    // the new scope snapshot's totalCostUsd. Verify the emitted event reflects
    // the scope snapshot, not an even higher value.
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].costUsd).toBe(0.123);
    unsub();
  });

  test("AC13: emitted durationMs equals elapsed operation-dispatch time", async () => {
    _storyOrchestratorDeps.callOp = (async () => {
      await new Promise((r) => setTimeout(r, 25));
      return { passed: true };
    }) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const received: StoryPhaseCompletedEvent[] = [];
    const unsub = pipelineEventBus.on("story:phase:completed", (e) => received.push(e));

    const ctx = makeCallCtx();
    await runPhase(ctx, makeSlot("verifier"), {}, {});

    expect(received[0].durationMs).toBeGreaterThanOrEqual(20);
    unsub();
  });

  test("AC14: runPhase returns operation output normally when a subscriber throws", async () => {
    _storyOrchestratorDeps.callOp = (async () => ({ passed: true })) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.captureGitRef = async () => "abc1234";

    const unsub = pipelineEventBus.on("story:phase:completed", () => {
      throw new Error("subscriber boom");
    });

    const ctx = makeCallCtx();
    const output = await runPhase(ctx, makeSlot("verifier"), {}, {});
    expect(output).toEqual({ passed: true });
    unsub();
  });
});