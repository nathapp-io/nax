import { describe, expect, test } from "bun:test";
import { CooldownStore } from "@/agents/cooldown-store";
import { resolveFallbackModelId } from "@/agents/fallback-model-identity";
import type { AdapterFailure } from "@/context/engine";

const quota: AdapterFailure = {
  category: "availability",
  outcome: "fail-quota",
  retriable: true,
  message: "",
};

// Real resolver output: literal pins come back as "unknown/<pin>" for non-claude/gpt/gemini names.
const models = { native: { fast: { provider: "minimax", model: "minimax/MiniMax-M3" } } } as never;
const idOf = (tier: string | undefined, pin?: string, agent = "native") =>
  resolveFallbackModelId(models, agent, tier, agent, pin);

describe("provider cooldown key over real resolver ids", () => {
  const tierId = idOf("fast");
  const minimaxPin = idOf(undefined, "minimax/MiniMax-M3");
  const otherPin = idOf(undefined, "opencode-go/deepseek-v4.1-flash[high]");

  test("a quota mark on the tier-mapped minimax model cools the minimax literal pin, not another provider", () => {
    const store = new CooldownStore(() => 1_000);
    store.mark("native", quota, "fast", tierId);
    expect(store.isCooling("native", undefined, minimaxPin)).toBe(true);
    expect(store.isCooling("native", undefined, otherPin)).toBe(false);
  });

  test("a quota mark on the minimax literal pin cools the tier-mapped minimax model", () => {
    const store = new CooldownStore(() => 1_000);
    store.mark("native", quota, undefined, minimaxPin);
    expect(store.isCooling("native", "fast", tierId)).toBe(true);
    expect(store.isCooling("native", undefined, otherPin)).toBe(false);
  });

  test("an advisor-style lookup by pin sees a quota mark recorded via tier", () => {
    const store = new CooldownStore(() => 1_000);
    store.mark("native", quota, "fast", tierId);
    expect(store.isCooling("native", undefined, "minimax/MiniMax-M3")).toBe(true);
  });

  test("claude sonnet names no provider, so quota degrades to agent-wide", () => {
    const store = new CooldownStore(() => 1_000);
    store.mark("claude", quota, undefined, idOf(undefined, "sonnet", "claude"));
    expect(store.isCooling("claude", "fast", idOf(undefined, "haiku", "claude"))).toBe(true);
  });
});
