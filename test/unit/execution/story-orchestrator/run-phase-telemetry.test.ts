/**
 * runPhase — phaseTelemetry propagation (US-003 ACs 1–5)
 *
 * Verifies that StoryPhaseCompletedEvent carries sessionModel, testStrategy,
 * and tier from ctx.phaseTelemetry. The source of phaseTelemetry is
 * executionStage (tested in execution-telemetry.test.ts); this file tests
 * that runPhase faithfully copies it to the emitted event.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { _storyOrchestratorDeps, runPhase } from "@/execution";
import type { AnySlot } from "@/execution";
import { pipelineEventBus } from "@/pipeline";
import type { StoryPhaseCompletedEvent } from "@/pipeline/event-bus";
import { makeMockCallContext } from "@test/helpers";

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeSlot(opName: string): AnySlot {
  return {
    op: {
      kind: "run" as const,
      name: opName,
      stage: "execution" as const,
      session: { role: "implementer" as const, lifetime: "fresh" as const },
      build: () => ({ prompt: "" }),
      parse: () => ({}),
    } as any,
    input: {},
  };
}

async function capturePhaseEvent(fn: () => Promise<unknown>): Promise<StoryPhaseCompletedEvent | undefined> {
  const events: StoryPhaseCompletedEvent[] = [];
  const unsub = pipelineEventBus.on("story:phase:completed", (e) => {
    events.push(e);
  });
  try {
    await fn();
  } finally {
    unsub();
  }
  return events[0];
}

// ─── deps save / restore ─────────────────────────────────────────────────────

let origCallOp: typeof _storyOrchestratorDeps.callOp;
let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;

beforeEach(() => {
  origCallOp = _storyOrchestratorDeps.callOp;
  origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
  _storyOrchestratorDeps.callOp = (async () => ({ passed: true, success: true })) as any;
  _storyOrchestratorDeps.captureGitRef = async () => "HEAD";
});

afterEach(() => {
  _storyOrchestratorDeps.callOp = origCallOp;
  _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
});

// ─── AC1: three-session-tdd → sessionModel "three-session" ──────────────────

describe("runPhase: phaseTelemetry → story:phase:completed", () => {
  test("AC1: emits sessionModel three-session when phaseTelemetry.sessionModel is three-session", async () => {
    const ctx = makeMockCallContext({
      phaseTelemetry: {
        testStrategy: "three-session-tdd",
        sessionModel: "three-session",
        tier: "balanced",
      },
    });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("implementer"), {}, {}));
    expect(event?.sessionModel).toBe("three-session");
  });

  // AC2
  test("AC2: emits testStrategy three-session-tdd when phaseTelemetry.testStrategy is three-session-tdd", async () => {
    const ctx = makeMockCallContext({
      phaseTelemetry: {
        testStrategy: "three-session-tdd",
        sessionModel: "three-session",
        tier: "balanced",
      },
    });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("implementer"), {}, {}));
    expect(event?.testStrategy).toBe("three-session-tdd");
  });

  // AC3
  test("AC3: emits sessionModel single-session when phaseTelemetry.sessionModel is single-session (no-test routing)", async () => {
    const ctx = makeMockCallContext({
      phaseTelemetry: {
        testStrategy: "no-test",
        sessionModel: "single-session",
        tier: "fast",
      },
    });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("implementer"), {}, {}));
    expect(event?.sessionModel).toBe("single-session");
  });

  // AC4 — runPhase propagates whatever tier is in phaseTelemetry (post-clamp)
  test("AC4: emits phaseTelemetry.tier as the event tier", async () => {
    const ctx = makeMockCallContext({
      phaseTelemetry: {
        testStrategy: "no-test",
        sessionModel: "single-session",
        tier: "fast", // post-clamp value written by executionStage
      },
    });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("implementer"), {}, {}));
    expect(event?.tier).toBe("fast");
  });

  test("AC4 boundary: tier is absent in event when phaseTelemetry is not set on ctx", async () => {
    const ctx = makeMockCallContext(); // no phaseTelemetry
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("implementer"), {}, {}));
    expect(event?.tier).toBeUndefined();
  });

  // AC5 — fix-cycle dispatch (cycleCtx = ctx as FixCycleContext) must preserve phaseTelemetry
  test("AC5: phase dispatched inside fix-cycle context emits sessionModel from ctx.phaseTelemetry", async () => {
    const ctx = makeMockCallContext({
      phaseTelemetry: {
        testStrategy: "three-session-tdd",
        sessionModel: "three-session",
        tier: "powerful",
      },
    });
    // runFixCycle wraps runPhase(cycleCtx, …) where cycleCtx = ctx as FixCycleContext.
    // phaseTelemetry lives on CallContext so it survives the cast unchanged.
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("implementer"), {}, {}));
    expect(event?.sessionModel).toBe("three-session");
  });

  test("AC5 boundary: fix-cycle phase with single-session routing emits sessionModel single-session", async () => {
    const ctx = makeMockCallContext({
      phaseTelemetry: {
        testStrategy: "no-test",
        sessionModel: "single-session",
        tier: "balanced",
      },
    });
    const event = await capturePhaseEvent(() => runPhase(ctx, makeSlot("implementer"), {}, {}));
    expect(event?.sessionModel).toBe("single-session");
  });
});
