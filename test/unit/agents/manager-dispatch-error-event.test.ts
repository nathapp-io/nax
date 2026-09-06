import { describe, expect, mock, test } from "bun:test";
import { SessionTurnError } from "@/agents";
import { AgentManager } from "@/agents/manager";
import { buildDispatchErrorEvent } from "@/agents/manager-dispatch";
import type { SessionHandle } from "@/agents/types";
import { DEFAULT_CONFIG } from "@/config";
import type { ResolvedPermissions } from "@/config/permissions";
import { resolvePermissions } from "@/config/permissions";
import type { DispatchErrorEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";

const PERMS: ResolvedPermissions = resolvePermissions(DEFAULT_CONFIG, "run");

function makeHandle(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return { id: "ses-001", agentName: "claude", ...overrides };
}

function makeSessionTurnErrorWithUsage(
  overrides: {
    cancelled?: boolean;
    retryable?: boolean;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    };
    estimatedCostUsd?: number;
    exactCostUsd?: number;
  } = {},
): SessionTurnError {
  return new SessionTurnError(
    "queue owner disconnected",
    overrides.cancelled ?? false,
    overrides.retryable ?? true,
    overrides.tokenUsage ?? { inputTokens: 100, outputTokens: 50 },
    overrides.estimatedCostUsd ?? 0.005,
    overrides.exactCostUsd ?? 0.007,
  );
}

describe("buildDispatchErrorEvent (AC1-3)", () => {
  test("AC1: copies tokenUsage from a SessionTurnError carrying tokenUsage, estimatedCostUsd, and exactCostUsd", () => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    const error = makeSessionTurnErrorWithUsage({
      tokenUsage: usage,
      estimatedCostUsd: 0.005,
      exactCostUsd: 0.007,
    });

    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error,
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
    });

    expect(event.tokenUsage).toBeDefined();
    expect(event.tokenUsage?.inputTokens).toBe(100);
    expect(event.tokenUsage?.outputTokens).toBe(50);
  });

  test("AC2: copies estimatedCostUsd from a SessionTurnError carrying it", () => {
    const error = makeSessionTurnErrorWithUsage({ estimatedCostUsd: 0.0123 });

    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error,
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
    });

    expect(event.estimatedCostUsd).toBe(0.0123);
  });

  test("AC3: copies exactCostUsd from a SessionTurnError carrying it", () => {
    const error = makeSessionTurnErrorWithUsage({ exactCostUsd: 0.0099 });

    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error,
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
    });

    expect(event.exactCostUsd).toBe(0.0099);
  });
});

describe("buildDispatchErrorEvent boundaries (AC4-5)", () => {
  test("AC4: a plain Error leaves tokenUsage, estimatedCostUsd, and exactCostUsd undefined", () => {
    const error = new Error("network blip");

    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error,
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
    });

    // None of the SessionTurnError fields can leak in via a plain Error.
    expect(event.tokenUsage).toBeUndefined();
    expect(event.estimatedCostUsd).toBeUndefined();
    expect(event.exactCostUsd).toBeUndefined();
    // errorCode and errorMessage are still populated from the throwable.
    expect(event.errorCode).toBe("DISPATCH_ERROR");
    expect(event.errorMessage).toBe("network blip");
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("AC5: a SessionTurnError without tokenUsage leaves tokenUsage undefined and keeps errorCode / durationMs populated", () => {
    // No tokenUsage / cost arguments — the BUG-57 carrier slots are undefined.
    const error = new SessionTurnError("adapter closed early", false, true);

    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error,
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
    });

    expect(event.tokenUsage).toBeUndefined();
    // durationMs comes from Date.now() - startedAt; we don't pin the value but
    // assert it's a non-negative number, and that errorCode stays populated.
    expect(event.errorCode).toBe("DISPATCH_ERROR");
    expect(event.errorMessage).toContain("adapter closed early");
    expect(typeof event.durationMs).toBe("number");
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("buildDispatchErrorEvent dispatchOptions plumbing (AC6-7)", () => {
  test("AC6: dispatchOptions.sessionRole, storyId, callId, scopeId all reach the event", () => {
    const error = makeSessionTurnErrorWithUsage();
    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error,
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
      dispatchOptions: {
        storyId: "US-001",
        callId: "call-42",
        scopeId: "scope-eu",
        sessionRole: "implementer",
      },
    });

    expect(event.sessionRole).toBe("implementer");
    expect(event.storyId).toBe("US-001");
    expect(event.callId).toBe("call-42");
    expect(event.scopeId).toBe("scope-eu");
  });

  test("AC7: dispatchOptions without sessionRole leaves sessionRole undefined", () => {
    const error = makeSessionTurnErrorWithUsage();
    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error,
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
      dispatchOptions: {
        storyId: "US-001",
        // sessionRole intentionally omitted.
      },
    });

    expect(event.sessionRole).toBeUndefined();
    expect(event.storyId).toBe("US-001");
  });
});

describe("AgentManager.runAsSession failed SessionTurnError (AC14)", () => {
  test("AC14: sendPrompt throwing a SessionTurnError emits a DispatchErrorEvent carrying that tokenUsage and exactCostUsd, then rethrows", async () => {
    const carriedUsage = { inputTokens: 200, outputTokens: 80 };
    const carriedExactCost = 0.0142;
    const bus = new DispatchEventBus();

    // Make the manager throw a SessionTurnError from sendPrompt — the carrier
    // slots hold the burned tokens and wire-exact cost (BUG-57 contract).
    const sessionTurnError = makeSessionTurnErrorWithUsage({
      tokenUsage: carriedUsage,
      exactCostUsd: carriedExactCost,
    });

    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => {
        throw sessionTurnError;
      }),
      dispatchEvents: bus,
    });

    const receivedErrors: DispatchErrorEvent[] = [];
    bus.onDispatchError((e) => receivedErrors.push(e));

    // The throw must propagate unchanged.
    await expect(
      manager.runAsSession("claude", makeHandle(), "do the thing", {
        pipelineStage: "run",
        storyId: "US-001",
        sessionRole: "implementer",
      }),
    ).rejects.toBe(sessionTurnError);

    // Exactly one DispatchErrorEvent must have been emitted, carrying the
    // tokenUsage and exactCostUsd the SessionTurnError carried.
    expect(receivedErrors).toHaveLength(1);
    const event = receivedErrors[0];
    expect(event?.tokenUsage).toBeDefined();
    expect(event?.tokenUsage?.inputTokens).toBe(200);
    expect(event?.tokenUsage?.outputTokens).toBe(80);
    expect(event?.exactCostUsd).toBe(carriedExactCost);
    // sessionRole forwarded from the runAsSession options so cost rows can
    // attribute the failure to the same role that produced successful spend.
    expect(event?.sessionRole).toBe("implementer");
    // The legacy field stays populated too — call sites still rely on it.
    expect(event?.storyId).toBe("US-001");
  });
});
