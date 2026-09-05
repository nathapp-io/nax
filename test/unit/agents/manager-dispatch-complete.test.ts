/**
 * `buildCompleteEvent` and `buildSessionTurnEvent` pure builder tests.
 *
 * US-002: the complete dispatch event must carry the adapter-supplied
 * `sessionId` so the audit subscriber can stamp it on the prompt-audit entry.
 * One-shot completes have no record id or turn id, so it travels as a plain
 * field on the event rather than inside the sibling `protocolIds` object.
 *
 * US-004: both event builders must forward the producer-supplied
 * `pricingSource` (catalog-rates or config-override on the native adapter's
 * `CompleteResult` / `TurnResult`) so the cost subscriber can prefer it over
 * the model-derived default.
 */

import { describe, expect, test } from "bun:test";
import { buildCompleteEvent, buildSessionTurnEvent } from "@/agents/manager-dispatch";
import type { CompleteOptions, ResolvedCompleteOptions, SessionHandle, TurnResult } from "@/agents/types";
import { DEFAULT_CONFIG } from "@/config";
import { resolvePermissions } from "@/config/permissions";

const PERMS = resolvePermissions(DEFAULT_CONFIG, "complete");

function makeOptions(): ResolvedCompleteOptions {
  return {
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-6" },
    workdir: "/tmp",
    resolvedPermissions: PERMS,
  };
}

describe("buildCompleteEvent — sessionId plumbing", () => {
  test("US-002 AC4: sessionId supplied on options reaches the returned event", () => {
    // AC 4 calls buildCompleteEvent's `input.sessionId` — the story describes
    // it as a plain field on the dispatcher event, so we exercise the build
    // path that would surface an adapter-supplied id.
    const startedAt = 1_000;
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      startedAt,
      sessionId: "nax-abc12345",
    });

    expect(event.kind).toBe("complete");
    expect(event.sessionId).toBe("nax-abc12345");
  });

  test("US-002 AC5: no sessionId on input means the returned event has no sessionId property", () => {
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      startedAt: 1_000,
    });

    expect(event.kind).toBe("complete");
    // The exact invariant the AC names: no sessionId property at all.
    expect("sessionId" in event).toBe(false);
  });
});

// US-004: the dispatch-event builders forward the producer-supplied
// pricingSource from the adapter's result so the cost subscriber can prefer
// it over the model-derived default.
describe("buildSessionTurnEvent — pricingSource plumbing (US-004)", () => {
  test("US-004 AC7: TurnResult.pricingSource catalog-rates reaches the returned event", () => {
    const handle: SessionHandle = {
      id: "nax-test-handle",
      agentName: "native",
      modelDef: { provider: "openai", model: "gpt-5.6-terra" },
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      exactCostUsd: 0.001,
      internalRoundTrips: 1,
      pricingSource: "catalog-rates",
    };
    const event = buildSessionTurnEvent({
      handle,
      sessionRole: "main",
      prompt: "do the thing",
      result,
      agentName: "native",
      stage: "run",
      opts: { pipelineStage: "run", storyId: "US-004" },
      resolvedPermissions: PERMS,
      startedAt: 1_000,
    });

    expect(event.kind).toBe("session-turn");
    expect(event.pricingSource).toBe("catalog-rates");
  });

  test("TurnResult without pricingSource means the returned event has no pricingSource property", () => {
    // The exact invariant the AC names for the no-value case: omitted (not
    // undefined) so the cost subscriber's "in" check distinguishes "no report"
    // from "explicitly unknown".
    const handle: SessionHandle = {
      id: "nax-test-handle",
      agentName: "claude",
    };
    const result: TurnResult = {
      output: "ok",
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      internalRoundTrips: 1,
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

    expect(event.kind).toBe("session-turn");
    expect("pricingSource" in event).toBe(false);
  });
});

describe("buildCompleteEvent — pricingSource plumbing (US-004)", () => {
  test("buildCompleteEvent forwards pricingSource from the producer result", () => {
    const event = buildCompleteEvent({
      sessionName: "nax-abc-feat-s1-plan",
      prompt: "do the thing",
      response: "done",
      agentName: "claude",
      stage: "complete",
      options: { ...makeOptions(), sessionName: "nax-abc-feat-s1-plan" } as CompleteOptions,
      resolvedPermissions: PERMS,
      tokenUsage: { inputTokens: 10, outputTokens: 5 },
      estimatedCostUsd: 0.001,
      exactCostUsd: 0.001,
      startedAt: 1_000,
      // The producer-supplied rate card lives on CompleteResult / TurnResult
      // (US-003); US-004 forwards it onto the dispatch event via the builder.
      // We simulate that by passing the value through buildCompleteEvent's
      // pricingSource input.
      pricingSource: "catalog-rates",
    });

    expect(event.kind).toBe("complete");
    expect(event.pricingSource).toBe("catalog-rates");
  });
});
