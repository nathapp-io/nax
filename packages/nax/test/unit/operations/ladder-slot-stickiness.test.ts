import { describe, expect, test } from "bun:test";
import { makeMockCallContext } from "@test/helpers";
import type { ModelsConfig, ResolvedConfiguredModel } from "@/config/schema-types";
import { ladderSlotFor, recordLadderSlot, resolveDispatchTarget } from "@/operations/call-resolvers";
import type { CallContext } from "@/operations/types";

const MODELS: ModelsConfig = {
  native: { balanced: "minimax/MiniMax-M3", powerful: "opencode-go/deepseek-v4-flash[high]" },
};

function ctx(): CallContext {
  return makeMockCallContext({ agentName: "native", storyId: "US-1" });
}

const resolved: ResolvedConfiguredModel = {
  agent: "native",
  modelDef: { provider: "unknown", model: "minimax/MiniMax-M3" },
  modelTier: "balanced",
};

describe("ladder slot stickiness", () => {
  test("a swap is recorded and read back at the same role", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    expect(ladderSlotFor(c, "balanced", "implementer")).toEqual({
      target: { agent: "native", tier: "powerful" },
      depth: 1,
    });
  });

  test("another role does not see it", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    expect(ladderSlotFor(c, "balanced", "reviewer-semantic")).toBeUndefined();
  });

  test("a different tier does not see it (escalation resets the ladder)", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    expect(ladderSlotFor(c, "powerful", "implementer")).toBeUndefined();
  });

  test("nothing is recorded when no swap happened", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, false, "balanced", "implementer");
    expect(ladderSlotFor(c, "balanced", "implementer")).toBeUndefined();
  });

  test("a later op of the same role dispatches the sticky endpoint and its depth", () => {
    const c = ctx();
    recordLadderSlot(c, { agent: "native", tier: "powerful" }, 1, true, "balanced", "implementer");
    const out = resolveDispatchTarget(c, resolved, MODELS, "balanced", "native", "implementer");
    expect(out.agent).toBe("native");
    expect(out.modelDef.model).toBe("opencode-go/deepseek-v4-flash[high]");
    expect(out.startDepth).toBe(1);
  });

  test("with no slot, the op's own resolution wins at depth 0", () => {
    const out = resolveDispatchTarget(ctx(), resolved, MODELS, "balanced", "native", "implementer");
    expect(out.modelDef.model).toBe("minimax/MiniMax-M3");
    expect(out.startDepth).toBe(0);
  });
});
