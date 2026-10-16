import { describe, expect, test } from "bun:test";
import { CooldownStore } from "@/agents/cooldown-store";
import type { AdapterFailure } from "@/context/engine";

const failure = (outcome: AdapterFailure["outcome"], retryAfterSeconds?: number): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

/** A clock the test advances by hand, so nothing waits in real time. */
function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("CooldownStore", () => {
  test("a rate-limited agent cools down and recovers when the clock passes the expiry", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-rate-limit"));

    expect(store.isCooling("claude")).toBe(true);
    clock.advance(30_000);
    expect(store.isCooling("claude")).toBe(true);
    clock.advance(31_000);
    expect(store.isCooling("claude")).toBe(false);
  });

  test("a fail-auth cooldown never expires", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-auth"));

    clock.advance(3_600_000);
    expect(store.isCooling("claude")).toBe(true);
  });

  test("the provider's retryAfterSeconds overrides the table constant", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-rate-limit", 300));

    clock.advance(120_000);
    expect(store.isCooling("claude")).toBe(true);
    clock.advance(181_000);
    expect(store.isCooling("claude")).toBe(false);
  });

  test("a negative retryAfterSeconds falls back to the table constant", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-rate-limit", -5));

    clock.advance(30_000);
    expect(store.isCooling("claude")).toBe(true);
    clock.advance(31_000);
    expect(store.isCooling("claude")).toBe(false);
  });

  test("a fail-timeout never cools the agent down at all", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-timeout"));
    expect(store.isCooling("claude")).toBe(false);
  });

  test("sweepTransient clears expiring entries and keeps run-long ones", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-rate-limit"));
    store.mark("codex", failure("fail-auth"));

    store.sweepTransient();

    expect(store.isCooling("claude")).toBe(false);
    expect(store.isCooling("codex")).toBe(true);
  });

  test("failureFor returns the recorded failure while the agent is cooling", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-rate-limit"));
    expect(store.failureFor("claude")?.outcome).toBe("fail-rate-limit");
  });

  test("clear removes everything, including run-long entries", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("claude", failure("fail-auth"));
    store.clear();
    expect(store.isCooling("claude")).toBe(false);
  });

  test("a model-scoped cooldown recorded with no tier does not blanket the agent", () => {
    const store = new CooldownStore(fakeClock().now);
    // Pre-fix, runWithFallback recorded the primary hop with no tier at all, so the bare
    // agent key doubled as "the whole agent is down" for every tier-less lookup (nax#1966).
    store.mark("native", failure("fail-rate-limit"), undefined, "minimax/MiniMax-M3");

    expect(store.isCooling("native", undefined, "minimax/MiniMax-M3")).toBe(true);
    expect(store.isCooling("native", undefined, "openrouter/z-ai/glm-5.3-flash[high]")).toBe(false);
  });

  test("fail-quota on a native provider cools only that provider, for the whole run", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("native", failure("fail-quota"), "balanced", "minimax/MiniMax-M3");

    expect(store.isCooling("native", "balanced", "minimax/MiniMax-M3")).toBe(true);
    expect(store.isCooling("native", "fast", "minimax/MiniMax-M2.7")).toBe(true); // same provider
    expect(store.isCooling("native", "powerful", "opencode-go/deepseek-v4.1-flash")).toBe(false); // other provider
    clock.advance(24 * 3_600_000);
    expect(store.isCooling("native", "balanced", "minimax/MiniMax-M3")).toBe(true);
    store.sweepTransient();
    expect(store.isCooling("native", "balanced", "minimax/MiniMax-M3")).toBe(true); // run-long survives the sweep
  });

  test("fail-quota with no provider in the model id falls back to agent-wide", () => {
    const clock = fakeClock();
    const store = new CooldownStore(clock.now);
    store.mark("claude", failure("fail-quota"), "balanced", "sonnet");
    expect(store.isCooling("claude", "fast", "haiku")).toBe(true);
  });

  // M1: an auth stamp and a provider-scoped fault (fail-quota) write the SAME
  // key, because the narrowed probe in `_live` and the release path both find
  // the provider's cooldown by it. An unstamped mark therefore must not erase
  // the stamp: `authCooldowns()` would stop reporting the provider and a later
  // re-login could never release it — the run-long park this store's recovery
  // path exists to undo.
  test("a later fail-quota for the same provider keeps the stored auth stamp", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("native", failure("fail-auth"), "balanced", "openai-codex/gpt-6.1-sol", {
      providerId: "openai-codex",
      fingerprint: "aaa",
    });
    // A parallel story's in-flight hop reports the exhausted quota after the
    // auth cooldown was written.
    store.mark("native", failure("fail-quota"), "balanced", "openai-codex/gpt-6.1-sol");

    expect(store.authCooldowns()).toEqual([
      {
        key: "native::provider::openai-codex",
        agent: "native",
        auth: { providerId: "openai-codex", fingerprint: "aaa" },
      },
    ]);
    expect(store.isCooling("native", "fast", "openai-codex/gpt-6.1-sol")).toBe(true);
    // The slot is the provider's, so releasing it on a credential change frees
    // the provider for every tier that reaches it.
    expect(store.release("native::provider::openai-codex")).toBe(true);
    expect(store.isCooling("native", "balanced", "openai-codex/gpt-6.1-sol")).toBe(false);
  });

  test("the merged entry still records the newest failure", () => {
    const store = new CooldownStore(fakeClock().now);
    store.mark("native", failure("fail-auth"), "balanced", "openai-codex/gpt-6.1-sol", { providerId: "openai-codex" });
    store.mark("native", failure("fail-quota"), "balanced", "openai-codex/gpt-6.1-sol");
    expect(store.failureFor("native", "balanced", "openai-codex/gpt-6.1-sol")?.outcome).toBe("fail-quota");
  });
});
