/**
 * US-001 (Cost ledger records existing dispatch attribution) — model resolution
 * for the failed-dispatch path.
 *
 * Covers the in-scope acceptance criterion 5: `buildDispatchErrorEvent` must
 * resolve the model the dispatch *would have run on* via `modelAttribution()`
 * and stamp it onto the returned `DispatchErrorEvent.model`. Without this, a
 * failed dispatch (SessionTurnError, AGENT_NOT_FOUND) leaves no model in the
 * audit row, even when the dispatch was pinned to one before it threw.
 *
 * The companion in-scope criteria live in:
 *   - test/unit/runtime/middleware/cost-roundtrip-attribution.test.ts (AC1-4, 6-13)
 *   - test/unit/agents/manager-dispatch-error-event.test.ts        (prior US-001)
 */

import { describe, expect, test } from "bun:test";
import { buildDispatchErrorEvent } from "@/agents/manager-dispatch";
import { DEFAULT_CONFIG } from "@/config";
import type { ResolvedPermissions } from "@/config/permissions";
import { resolvePermissions } from "@/config/permissions";
import type { ModelDef, ModelTier } from "@/config/schema";

const PERMS: ResolvedPermissions = resolvePermissions(DEFAULT_CONFIG, "run");

function makeModelDef(model: string, provider: string = "anthropic"): ModelDef {
  return { provider, model };
}

function makeTier(name: "fast" | "balanced" | "powerful"): ModelTier {
  return name;
}

describe("buildDispatchErrorEvent — model attribution (AC5)", () => {
  test("AC5: buildDispatchErrorEvent stamps the model resolved by modelAttribution() onto DispatchErrorEvent.model", () => {
    const modelDef = makeModelDef("anthropic/claude-sonnet-5");
    const modelTier = makeTier("balanced");

    // Pass modelDef + modelTier via dispatchOptions so modelAttribution() can
    // see them. parseModelSpec decomposes the bare id (no [effort] suffix),
    // so the recorded `model` is exactly the input string.
    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error: new Error("queue owner disconnected"),
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
      dispatchOptions: {
        storyId: "US-001",
        modelDef,
        modelTier,
      },
    });

    expect(event.model).toBe("anthropic/claude-sonnet-5");
  });

  test("AC5: buildDispatchErrorEvent decomposes a model with [effort] suffix (matches parseModelSpec)", () => {
    // nax profiles name models with a trailing [effort] (e.g. codex reasoning
    // effort). modelAttribution() decomposes the composite into a bare model
    // + effort pair; the error event must carry the bare id, not the
    // composite, so rate-card keys on the bare id match.
    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "codex",
      stage: "run",
      error: new Error("adapter closed early"),
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
      dispatchOptions: {
        storyId: "US-001",
        modelDef: makeModelDef("gpt-5.6-luna[high]"),
      },
    });

    // Bare id only — the suffix is recorded separately via effort.
    expect(event.model).toBe("gpt-5.6-luna");
    expect(event.effort).toBe("high");
  });

  test("AC5: buildDispatchErrorEvent leaves model undefined when no modelDef was supplied", () => {
    // No modelDef / modelTier → modelAttribution() returns {} → the event
    // carries no model at all, so a consumer reading the row can tell
    // "no model was attributed" apart from a real (or guessed) one.
    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error: new Error("no model resolved"),
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
      dispatchOptions: { storyId: "US-001" },
    });

    expect("model" in event).toBe(false);
    expect(event.model).toBeUndefined();
  });

  test("AC5: buildDispatchErrorEvent stamps modelTier when one was supplied", () => {
    const event = buildDispatchErrorEvent({
      origin: "runAsSession",
      agentName: "claude",
      stage: "run",
      error: new Error("network blip"),
      resolvedPermissions: PERMS,
      startedAt: Date.now(),
      dispatchOptions: {
        storyId: "US-001",
        modelDef: makeModelDef("haiku"),
        modelTier: makeTier("fast"),
      },
    });

    expect(event.model).toBe("haiku");
    expect(event.modelTier).toBe("fast");
  });
});
