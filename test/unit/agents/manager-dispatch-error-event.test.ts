import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeNaxConfig } from "@test/helpers";
import { SessionTurnError } from "@/agents";
import { AgentManager } from "@/agents/manager";
import { buildDispatchErrorEvent } from "@/agents/manager-dispatch";
import type { CompleteOptions, SessionHandle } from "@/agents/types";
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
  test("uses the role resolved from the handle when options omit sessionRole", async () => {
    const bus = new DispatchEventBus();
    const sessionTurnError = makeSessionTurnErrorWithUsage();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => {
        throw sessionTurnError;
      }),
      dispatchEvents: bus,
    });
    const receivedErrors: DispatchErrorEvent[] = [];
    bus.onDispatchError((event) => receivedErrors.push(event));

    await expect(
      manager.runAsSession("claude", makeHandle({ role: "verifier" }), "do the thing", {
        pipelineStage: "run",
      }),
    ).rejects.toBe(sessionTurnError);

    expect(receivedErrors).toHaveLength(1);
    expect(receivedErrors[0]?.sessionRole).toBe("verifier");
  });

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

  // Adversarial review (manager.ts:507): the wiring that forwards
  // handle.modelDef to the error event was unverified. AC5/AC6 only cover
  // buildDispatchErrorEvent directly, and the AC14 tests above pass a handle
  // without modelDef, so a regression that removed `modelDef: handle.modelDef`
  // from the runAsSession catch would leave every AC test green while
  // production error rows silently lost model attribution. This test pins
  // the wiring end-to-end through the manager.
  test("AC6 (wiring): runAsSession forwards handle.modelDef onto the emitted DispatchErrorEvent.model", async () => {
    const bus = new DispatchEventBus();
    const sessionTurnError = makeSessionTurnErrorWithUsage();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, {
      sendPrompt: mock(async () => {
        throw sessionTurnError;
      }),
      dispatchEvents: bus,
    });
    const receivedErrors: DispatchErrorEvent[] = [];
    bus.onDispatchError((e) => receivedErrors.push(e));

    // Pin a modelDef on the handle — runAsSession must read it off the
    // handle (not the opts) and forward it to buildDispatchErrorEvent via
    // dispatchOptions. parseModelSpec then decomposes the bare id (no
    // [effort] suffix in this fixture) so the recorded model is exactly the
    // modelDef.model string.
    await expect(
      manager.runAsSession(
        "claude",
        makeHandle({ modelDef: { provider: "anthropic", model: "anthropic/claude-sonnet-5" } }),
        "do the thing",
        { pipelineStage: "run", storyId: "US-001" },
      ),
    ).rejects.toBe(sessionTurnError);

    expect(receivedErrors).toHaveLength(1);
    expect(receivedErrors[0]?.model).toBe("anthropic/claude-sonnet-5");
  });
});

// AC14's runAsSession coverage stops at the session transport. The story
// describes the same error-event reshaping for completeAsWithFallback,
// which mirrors the runAsSession catch block. Without this test the
// call-site reshaping has no failing test guarding it.
describe("AgentManager.completeAsWithFallback dispatch-error path", () => {
  // AGENT_NOT_FOUND is the only path inside completeWithFallback that throws
  // (all adapter exceptions are caught and converted to result.adapterFailure),
  // so the only reliable way to drive the outer catch in completeAsWithFallback
  // is to ask for an agent name that the registry cannot resolve.
  test("emits a DispatchErrorEvent with origin:completeAs carrying dispatchOptions.{storyId,callId,scopeId,sessionRole} and rethrows on AGENT_NOT_FOUND", async () => {
    const bus = new DispatchEventBus();
    const manager = new AgentManager(DEFAULT_CONFIG, undefined, { dispatchEvents: bus });
    const receivedErrors: DispatchErrorEvent[] = [];
    bus.onDispatchError((e) => receivedErrors.push(e));

    const options: CompleteOptions = {
      modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
      workdir: "/tmp",
      storyId: "US-001",
      callId: "call-42",
      scopeId: "scope-eu",
      sessionRole: "synthesis",
      pipelineStage: "complete",
    };

    // The throw must propagate unchanged — the catch only re-emits, never
    // swallows. AGENT_NOT_FOUND is the specific error code that
    // completeWithFallback throws for an unresolved agent.
    await expect(manager.completeAsWithFallback("nonexistent-agent", "do the thing", options)).rejects.toThrow(
      'Agent "nonexistent-agent" not found in registry',
    );

    // Exactly one DispatchErrorEvent must have been emitted, carrying the
    // dispatchOptions fields the catch block forwards onto it.
    expect(receivedErrors).toHaveLength(1);
    const event = receivedErrors[0];
    // Origin discriminates the dispatch boundary that produced the event.
    expect(event?.origin).toBe("completeAs");
    // errorCode / errorMessage carry the NaxError that escaped completeWithFallback.
    expect(event?.errorCode).toBe("AGENT_NOT_FOUND");
    expect(event?.errorMessage).toContain("nonexistent-agent");
    // stage defaults to options.pipelineStage when the caller supplies it.
    expect(event?.stage).toBe("complete");
    // agentName is the resolved primary (the one the dispatch tried to call).
    expect(event?.agentName).toBe("nonexistent-agent");
    // dispatchOptions.{storyId,callId,scopeId,sessionRole} are the only fields
    // that survive from CompleteOptions onto the DispatchErrorEvent — the
    // call site reshapes these so cost rows can attribute the failure to the
    // same role that produced successful spend.
    expect(event?.storyId).toBe("US-001");
    expect(event?.callId).toBe("call-42");
    expect(event?.scopeId).toBe("scope-eu");
    expect(event?.sessionRole).toBe("synthesis");
  });

  test("attributes a missing fallback dispatch error to the fallback agent and its resolved model", async () => {
    const bus = new DispatchEventBus();
    const receivedErrors: DispatchErrorEvent[] = [];
    bus.onDispatchError((event) => receivedErrors.push(event));
    const primary = makeAgentAdapter({
      complete: mock(async () => ({
        output: "",
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        estimatedCostUsd: 0,
        adapterFailure: {
          outcome: "fail-quota" as const,
          category: "availability" as const,
          retriable: false,
          message: "primary quota exhausted",
        },
      })),
    });
    const manager = new AgentManager(
      makeNaxConfig({
        agent: {
          default: "claude",
          fallback: {
            enabled: true,
            map: { claude: ["codex"] },
            maxHopsPerStory: 2,
            onQualityFailure: false,
            rebuildContext: true,
          },
        },
      }),
      makeAgentRegistry({ getAgent: (name) => (name === "claude" ? primary : undefined) }),
      { dispatchEvents: bus },
    );

    await expect(
      manager.completeAsWithFallback("claude", "do the thing", {
        modelDef: { provider: "anthropic", model: "claude-haiku-4-5" },
        modelDefFor: (name) => (name === "codex" ? { provider: "openai", model: "gpt-5.6-luna" } : undefined),
        workdir: "/tmp",
        pipelineStage: "complete",
      }),
    ).rejects.toThrow('Agent "codex" not found in registry');

    expect(receivedErrors).toHaveLength(1);
    expect(receivedErrors[0]?.agentName).toBe("codex");
    expect(receivedErrors[0]?.model).toBe("gpt-5.6-luna");
  });
});
