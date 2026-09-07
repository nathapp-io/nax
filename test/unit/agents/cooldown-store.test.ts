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
});
