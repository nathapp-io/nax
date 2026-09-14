/**
 * US-002 — `DispatchEvent` carries `rates` as a passenger from the
 * adapter-supplied `CompleteResult.rates` / `TurnResult.rates` so the cost
 * subscriber can stamp the same effective numbers onto the row.
 *
 * Acceptance criteria covered:
 *   AC9 — When a `DispatchEvent` is built from a result carrying `rates`,
 *          the event's `rates` field exposes the same four rate values.
 *   AC10 — When a `DispatchEvent` is built from a result carrying NO
 *          `rates`, the event OMITS the `rates` field rather than exposing
 *          it as undefined.
 *
 * The two ACs are a property of the event builders (`buildCompleteEvent`,
 * `buildSessionTurnEvent`) and the `DispatchEvent` interface: the builders
 * must propagate `rates` when present and omit it (not set it to
 * `undefined`) when absent — "no field" is a deliberate contract with the
 * cost subscriber, who can distinguish "no report" from "explicitly unknown".
 *
 * The tests build the dispatch events directly through the `build*Event`
 * helpers and assert on the resulting event shape. The AC is a contract
 * about what reaches downstream — pinning it at the builder boundary pins
 * it for every caller without reaching into the manager adapter.
 */

import { describe, expect, test } from "bun:test";
import type { ResolvedRates } from "@/agents/cost";
import { buildCompleteEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { CompleteOptions, SessionHandle, TurnResult } from "@/agents/types";
import { DEFAULT_CONFIG } from "@/config";
import { resolvePermissions } from "@/config/permissions";

const PERMS = resolvePermissions(DEFAULT_CONFIG, "complete");

function makeOptions(): CompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    workdir: "/tmp",
    resolvedPermissions: PERMS,
  };
}

describe("buildCompleteEvent — rates passenger (US-002 AC9, AC10)", () => {
  // AC9 (success): when the CompleteResult carries `rates`, the event
  // exposes the same four rate values.
  test("AC9: CompleteResult.rates (4 fields) reaches the DispatchEvent.rates", () => {
    const rates: ResolvedRates = {
      inputPer1M: 2,
      outputPer1M: 10,
      cacheReadPer1M: 0.2,
      cacheCreationPer1M: 2.5,
    };
    const options = makeOptions();
    options.sessionName = "nax-ac9";
    const event = buildCompleteEvent({
      sessionName: "nax-ac9",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0,
      startedAt: 1_000,
      rates,
    });

    expect(event.rates).toEqual(rates);
    expect(event.rates?.inputPer1M).toBe(2);
    expect(event.rates?.outputPer1M).toBe(10);
    expect(event.rates?.cacheReadPer1M).toBe(0.2);
    expect(event.rates?.cacheCreationPer1M).toBe(2.5);
  });

  // AC10 (boundary): when the CompleteResult has NO `rates` (e.g. native path
  // that always stamps vs ACP that stamps only when nonzero-usage guard let
  // pricing run), the event OMITS the field entirely. The AC explicitly
  // says "omits... rather than exposing it as undefined" — the "no field"
  // contract is what lets a downstream subscriber distinguish "no report"
  // from "explicitly unknown".
  test("AC10: CompleteResult without rates means the returned event has no rates property", () => {
    const options = makeOptions();
    options.sessionName = "nax-ac10";
    const event = buildCompleteEvent({
      sessionName: "nax-ac10",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      startedAt: 1_000,
      // No `rates` supplied — the builder must NOT set event.rates to
      // undefined, must NOT set it to a zeroed object: it must omit it.
    });

    expect("rates" in event).toBe(false);
  });
});

describe("buildSessionTurnEvent — rates passenger (US-002 AC9, AC10)", () => {
  // AC9 (success, sendTurn path): TurnResult.rates propagates onto the
  // session-turn event's `rates`.
  test("AC9: TurnResult.rates (4 fields) reaches the DispatchEvent.rates", () => {
    const rates: ResolvedRates = {
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 3,
      cacheCreationPer1M: 3,
    };
    const handle: SessionHandle = {
      id: "nax-ac9-handle",
      agentName: "claude",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
      rates,
    };
    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "claude",
      stage: "run",
      opts: { pipelineStage: "run", storyId: "US-002" },
      resolvedPermissions: PERMS,
      startedAt: 1_000,
    });

    expect(event.rates).toEqual(rates);
    expect(event.rates?.inputPer1M).toBe(3);
    expect(event.rates?.outputPer1M).toBe(15);
  });

  // AC10 (boundary, sendTurn path): when TurnResult has no `rates`, the
  // event omits the field.
  test("AC10: TurnResult without rates means the returned event has no rates property", () => {
    const handle: SessionHandle = {
      id: "nax-ac10-handle",
      agentName: "claude",
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      internalRoundTrips: 1,
      // No `rates` — the builder must omit it.
    };
    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "claude",
      stage: "run",
      opts: { pipelineStage: "run" },
      resolvedPermissions: PERMS,
      startedAt: 1_000,
    });

    expect("rates" in event).toBe(false);
  });
});
