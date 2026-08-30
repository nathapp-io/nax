import { describe, expect, test } from "bun:test";
import { type CostErrorEvent, type CostEvent, createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { CompleteDispatchEvent, DispatchErrorEvent, SessionTurnDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachCostSubscriber, COST_ROW_SCHEMA_VERSION } from "@/runtime/middleware/cost";

const PERMS = { mode: "approve-reads" as const };

function makeSessionTurnEvent(overrides: Partial<SessionTurnDispatchEvent> = {}): SessionTurnDispatchEvent {
  return {
    kind: "session-turn",
    sessionName: "nax-abc-feat-s1-main",
    sessionRole: "main",
    prompt: "hello",
    response: "world",
    agentName: "claude",
    stage: "run",
    storyId: "s-1",
    resolvedPermissions: PERMS,
    turn: 1,
    protocolIds: { sessionId: "sess-1" },
    origin: "runAsSession",
    durationMs: 200,
    timestamp: 1000,
    tokenUsage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
    exactCostUsd: 0.006,
    ...overrides,
  };
}

function makeCompleteEvent(overrides: Partial<CompleteDispatchEvent> = {}): CompleteDispatchEvent {
  return {
    kind: "complete",
    sessionName: "nax-abc-feat-s1-plan",
    sessionRole: "plan",
    prompt: "plan this",
    response: "planned",
    agentName: "claude",
    stage: "plan",
    storyId: "s-1",
    resolvedPermissions: PERMS,
    durationMs: 80,
    timestamp: 2000,
    ...overrides,
  };
}

function makeErrorEvent(overrides: Partial<DispatchErrorEvent> = {}): DispatchErrorEvent {
  return {
    kind: "error",
    origin: "runAsSession",
    agentName: "claude",
    stage: "run",
    storyId: "s-1",
    errorCode: "SESSION_ERROR",
    errorMessage: "failed",
    durationMs: 50,
    timestamp: 3000,
    resolvedPermissions: PERMS,
    ...overrides,
  };
}

describe("attachCostSubscriber", () => {
  test("records CostEvent with token usage and exactCostUsd on session-turn", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded).toHaveLength(1);
    expect(recorded[0].tokens.input).toBe(100);
    expect(recorded[0].tokens.output).toBe(50);
    expect(recorded[0].tokens.cacheRead).toBe(10);
    expect(recorded[0].tokens.cacheWrite).toBe(5);
    expect(recorded[0].exactCostUsd).toBe(0.006);
    expect(recorded[0].costUsd).toBe(0.006);
    expect(recorded[0].confidence).toBe("exact");
    expect(recorded[0].durationMs).toBe(200);
    // Falls back to "unknown" only because this fixture event carries no model;
    // see the #1433 block below for the attributed case.
    expect(recorded[0].model).toBe("unknown");
    expect(recorded[0].storyId).toBe("s-1");
    expect(recorded[0].stage).toBe("run");
    expect(recorded[0].runId).toBe("r-001");
  });

  test("records estimated confidence when no exactCostUsd", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ exactCostUsd: undefined }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].confidence).toBe("estimated");
    expect(recorded[0].costUsd).toBe(0);
    expect(recorded[0].estimatedCostUsd).toBe(0);
  });

  test("skips emit when no tokenUsage and no exactCostUsd", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeCompleteEvent());

    expect(recorded).toHaveLength(0);
  });

  test("records CostEvent for complete event with exactCostUsd", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeCompleteEvent({ exactCostUsd: 0.003 }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].exactCostUsd).toBe(0.003);
    expect(recorded[0].confidence).toBe("exact");
    expect(recorded[0].tokens.input).toBe(0);
    expect(recorded[0].tokens.output).toBe(0);
  });

  test("records CostErrorEvent on dispatch error", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent());

    expect(errors).toHaveLength(1);
    expect(errors[0].agentName).toBe("claude");
    expect(errors[0].errorCode).toBe("SESSION_ERROR");
    expect(errors[0].durationMs).toBe(50);
    expect(errors[0].storyId).toBe("s-1");
  });

  test("copies callId and scopeId from dispatch error to CostErrorEvent", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent({ callId: "call-err", scopeId: "scope-err" }));

    expect(errors).toHaveLength(1);
    expect(errors[0].callId).toBe("call-err");
    expect(errors[0].scopeId).toBe("scope-err");
  });

  test("unsubscribe stops recording", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    const unsub = attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());
    expect(recorded).toHaveLength(1);

    unsub();
    bus.emitDispatch(makeSessionTurnEvent());
    expect(recorded).toHaveLength(1);
  });

  test("normalizes exactCostUsd to estimatedCostUsd when undefined", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ exactCostUsd: undefined, estimatedCostUsd: 0.005 }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].exactCostUsd).toBe(0.005);
    expect(recorded[0].costUsd).toBe(0.005);
    expect(recorded[0].confidence).toBe("estimated");
  });

  test("sets confidence to exact when exactCostUsd is present", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ exactCostUsd: 0.007 }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].confidence).toBe("exact");
  });

  test("costUsd always equals exactCostUsd after normalization", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ exactCostUsd: undefined, estimatedCostUsd: 0.004 }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].costUsd).toBe(recorded[0].exactCostUsd);
  });

  test("normalizes exactCostUsd with zero estimatedCostUsd fallback", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ exactCostUsd: undefined, estimatedCostUsd: undefined }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].exactCostUsd).toBe(0);
    expect(recorded[0].costUsd).toBe(0);
    expect(recorded[0].confidence).toBe("estimated");
  });

  // --- AC2: callId/scopeId copying ---
  test("copies callId from dispatch event to CostEvent", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ callId: "call-abc" }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].callId).toBe("call-abc");
  });

  test("copies scopeId from dispatch event to CostEvent", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ scopeId: "scope-xyz" }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].scopeId).toBe("scope-xyz");
  });

  test("leaves callId undefined on CostEvent when dispatch event has no callId", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ callId: undefined }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].callId).toBeUndefined();
  });

  test("leaves scopeId undefined on CostEvent when dispatch event has no scopeId", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ scopeId: undefined }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0].scopeId).toBeUndefined();
  });

  // ── #1433: model / role attribution ──────────────────────────────────────
  //
  // These fields all existed on the dispatch event (or were resolvable) and were
  // dropped by this middleware. Over July 2026, `model` was the literal string
  // "unknown" on 100% of 6,433 rows and `sessionRole` was absent on all of them,
  // which made per-model and per-sub-stage cost attribution impossible.

  test("#1433: records the model the dispatch actually ran on", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: "haiku", modelTier: "fast" }));

    expect(recorded[0].model).toBe("haiku");
    expect(recorded[0].modelTier).toBe("fast");
  });

  test('#1433: model falls back to "unknown" only when the event carries none', () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: undefined }));

    expect(recorded[0].model).toBe("unknown");
    expect(recorded[0].modelTier).toBeUndefined();
  });

  test("#1433: omits modelTier for a pinned model rather than inventing one", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // A `{ agent, model }` pin bypasses tier resolution — recording a tier here
    // would claim a tier that never selected the model.
    bus.emitDispatch(makeSessionTurnEvent({ model: "sonnet", modelTier: undefined }));

    expect(recorded[0].model).toBe("sonnet");
    expect("modelTier" in recorded[0]).toBe(false);
  });

  test("#1433: carries sessionRole so sub-stage spend is attributable", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // `stage` collapses 23 session roles into 6 buckets; without the role,
    // "how much of rectification is test-writing?" has no answer.
    bus.emitDispatch(makeSessionTurnEvent({ stage: "rectification", sessionRole: "test-writer" }));

    expect(recorded[0].stage).toBe("rectification");
    expect(recorded[0].sessionRole).toBe("test-writer");
  });

  test("#1433: carries featureName when the dispatch has one", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ featureName: "kv-cache" }));

    expect(recorded[0].featureName).toBe("kv-cache");
  });

  test("#1433: complete-kind dispatches are attributed too", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(
      makeCompleteEvent({ model: "sonnet", modelTier: "balanced", sessionRole: "judge", exactCostUsd: 0.02 }),
    );

    expect(recorded[0].model).toBe("sonnet");
    expect(recorded[0].modelTier).toBe("balanced");
    expect(recorded[0].sessionRole).toBe("judge");
  });

  test("#1433: rows carry a schemaVersion so pre-fix rows stay distinguishable", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: "haiku" }));

    expect(recorded[0].schemaVersion).toBe(COST_ROW_SCHEMA_VERSION);
    expect(COST_ROW_SCHEMA_VERSION).toBeGreaterThan(1);
  });

  test("#1433: error rows are discriminable from genuine zero-cost rows", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatchError(makeErrorEvent());

    // Error rows carry no cost/token fields. Without the discriminator a reader
    // cannot tell them from a real row that cost nothing.
    expect(errors[0].kind).toBe("error");
    expect(errors[0].schemaVersion).toBe(COST_ROW_SCHEMA_VERSION);
  });

  test("#1433: records the active run profile", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // Profiles repoint agent/model per stage and appear nowhere else in run
    // artifacts, so a Sonnet-priced row under a "fast" config is indistinguishable
    // from a tier bug without this.
    bus.emitDispatch(makeSessionTurnEvent({ model: "sonnet", profile: "cc-acceptance" }));

    expect(recorded[0].profile).toBe("cc-acceptance");
  });

  test("#1433: omits profile when the dispatch carries none", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ profile: undefined }));

    expect("profile" in recorded[0]).toBe(false);
  });

  // ── #1433 item 6: pricingSource ──────────────────────────────────────────
  //
  // `confidence` says whether a wire cost existed. It does NOT say what an
  // estimate was built from. estimateCostFromTokenUsage silently applies a
  // generic $3/$15-per-1M card to any model absent from MODEL_PRICING, so a
  // minimax/* or gpt-5.6-* row was priced with Sonnet-shaped rates and looked
  // identical to a correctly-priced one.

  test("#1433: wire-exact rows record pricingSource=wire", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: "haiku", exactCostUsd: 0.006 }));

    expect(recorded[0].confidence).toBe("exact");
    expect(recorded[0].pricingSource).toBe("wire");
  });

  test("#1433: estimated rows for a known model record model-rates", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: "haiku", exactCostUsd: undefined, estimatedCostUsd: 0.01 }));

    expect(recorded[0].confidence).toBe("estimated");
    expect(recorded[0].pricingSource).toBe("model-rates");
  });

  test("#1433: estimated rows for a model absent from the table record fallback-rates", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    // A real model with no MODEL_PRICING entry — this class was the 60% of
    // review spend and 63% of plan spend priced on guessed rates. `MiniMax-M2.7`
    // stood here until it was given a card (it is priced identically to M3).
    bus.emitDispatch(
      makeSessionTurnEvent({ model: "opencode-go/hy3", exactCostUsd: undefined, estimatedCostUsd: 0.01 }),
    );

    expect(recorded[0].pricingSource).toBe("fallback-rates");
  });

  test("#1433: rows with no resolved model record unknown-model", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: undefined, exactCostUsd: undefined, estimatedCostUsd: 0.01 }));

    expect(recorded[0].model).toBe("unknown");
    expect(recorded[0].pricingSource).toBe("unknown-model");
  });

  test("#1433: stamps projectKey so a row survives being lifted from its directory", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001", "demo-app");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded[0].projectKey).toBe("demo-app");
  });

  test("#1433: omits projectKey when none is supplied", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect("projectKey" in recorded[0]).toBe(false);
  });

  test("#1433: error rows carry projectKey too", () => {
    const errors: CostErrorEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), recordError: (e: CostErrorEvent) => errors.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001", "demo-app");

    bus.emitDispatchError(makeErrorEvent());

    expect(errors[0].projectKey).toBe("demo-app");
  });

  // ── #1464: effort as a dispatch dimension + schema v3 ────────────────────

  test("#1464: copies effort onto the cost row when the dispatch carries one", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: "gpt-5.6-luna", effort: "high" }));

    expect(recorded[0].model).toBe("gpt-5.6-luna");
    expect(recorded[0].effort).toBe("high");
  });

  test("#1464: omits effort when the dispatch carries none", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent({ model: "haiku", effort: undefined }));

    expect("effort" in recorded[0]).toBe(false);
  });

  test("#1464: rows carry schemaVersion 3", () => {
    const recorded: CostEvent[] = [];
    const agg = { ...createNoOpCostAggregator(), record: (e: CostEvent) => recorded.push(e) };
    const bus = new DispatchEventBus();
    attachCostSubscriber(bus, agg, "r-001");

    bus.emitDispatch(makeSessionTurnEvent());

    expect(recorded[0].schemaVersion).toBe(3);
    expect(COST_ROW_SCHEMA_VERSION).toBe(3);
  });
});
