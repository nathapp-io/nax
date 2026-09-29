/**
 * US-006 — `AgentManager.completeAsWithFallback` carries the credential
 * identity off the adapter's `CompleteResult` onto the event it emits, and
 * therefore onto the cost row a subscriber records from that event.
 *
 * This is the end-to-end wiring for the complete path: the adapter's `auth` →
 * `completeResultProvenance(result)` in the manager → `buildCompleteEvent` →
 * `CompleteDispatchEvent` → `attachCostSubscriber` → `CostEvent.auth`.
 *
 * Acceptance criteria covered: AC13, AC14.
 */

import { describe, expect, mock, test } from "bun:test";
import { makeAgentAdapter, makeAgentRegistry, makeNaxConfig } from "@test/helpers";
import { AgentManager } from "@/agents/manager";
import type { AuthStamp } from "@/agents/session-types";
import type { CompleteOptions, CompleteResult } from "@/agents/types";
import type { CostEvent, ICostAggregator } from "@/runtime/cost-aggregator";
import { createNoOpCostAggregator } from "@/runtime/cost-aggregator";
import type { CompleteDispatchEvent } from "@/runtime/dispatch-events";
import { DispatchEventBus } from "@/runtime/dispatch-events";
import { attachCostSubscriber } from "@/runtime/middleware/cost";

const STAMP: AuthStamp = { fingerprint: "0123456789ab", source: "file" };

const OPTS: CompleteOptions = {
  modelDef: { provider: "anthropic", model: "claude-haiku" },
  workdir: "/tmp/us006",
  storyId: "US-006",
};

/** A manager whose only adapter returns a `CompleteResult` carrying `auth`. */
function managerWith(bus: DispatchEventBus): AgentManager {
  const adapter = makeAgentAdapter({
    complete: mock(
      async (): Promise<CompleteResult> => ({
        output: "ok",
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        estimatedCostUsd: 0.001,
        auth: STAMP,
      }),
    ),
  });
  return new AgentManager(
    makeNaxConfig({ agent: { default: "claude" } }),
    makeAgentRegistry({ getAgent: () => adapter }),
    {
      dispatchEvents: bus,
    },
  );
}

describe("AgentManager.completeAsWithFallback — auth provenance (US-006)", () => {
  // AC13 (success): the emitted complete event carries the adapter's stamp.
  test("AC13: emits a CompleteDispatchEvent whose auth equals the adapter's CompleteResult.auth", async () => {
    const bus = new DispatchEventBus();
    const events: CompleteDispatchEvent[] = [];
    bus.onDispatch((event) => {
      if (event.kind === "complete") events.push(event);
    });

    await managerWith(bus).completeAsWithFallback("claude", "hi", OPTS);

    expect(events).toHaveLength(1);
    expect(events[0].auth).toEqual(STAMP);
  });

  // AC14 (success): a bus with the cost subscriber attached records the row with
  // the same identity, which is the observable end of the story — the cost row
  // now says which credential paid.
  test("AC14: a bus with attachCostSubscriber attached records a CostEvent whose auth equals the adapter's stamp", async () => {
    const bus = new DispatchEventBus();
    const recorded: CostEvent[] = [];
    const agg: ICostAggregator = { ...createNoOpCostAggregator(), record: (event: CostEvent) => recorded.push(event) };
    attachCostSubscriber(bus, agg, "run-006");

    await managerWith(bus).completeAsWithFallback("claude", "hi", OPTS);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].auth).toEqual(STAMP);
  });

  // AC14 boundary: the same path with an adapter that stamp nothing (every ACP
  // adapter) records a row with no `auth` key, so the new field never appears as
  // an explicit `undefined`.
  test("AC14 boundary: an adapter result carrying no auth records a CostEvent with no auth key", async () => {
    const bus = new DispatchEventBus();
    const recorded: CostEvent[] = [];
    const agg: ICostAggregator = { ...createNoOpCostAggregator(), record: (event: CostEvent) => recorded.push(event) };
    attachCostSubscriber(bus, agg, "run-006");
    const adapter = makeAgentAdapter({
      complete: mock(
        async (): Promise<CompleteResult> => ({
          output: "ok",
          tokenUsage: { inputTokens: 10, outputTokens: 5 },
          estimatedCostUsd: 0.001,
        }),
      ),
    });
    const manager = new AgentManager(
      makeNaxConfig({ agent: { default: "claude" } }),
      makeAgentRegistry({ getAgent: () => adapter }),
      { dispatchEvents: bus },
    );

    await manager.completeAsWithFallback("claude", "hi", OPTS);

    expect(recorded).toHaveLength(1);
    expect("auth" in recorded[0]).toBe(false);
  });
});
