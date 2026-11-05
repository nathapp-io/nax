/**
 * US-013 AC-18..AC-20 — the per-model catalog context-window cache on its own.
 *
 * The cache was lifted out of `chat-host.ts` unchanged, so these pin the three
 * behaviours the host relied on: one lookup per model string, the provider and
 * model taken from the model's `<provider>/<name>` split, and a failing lookup
 * that leaves the window unknown rather than failing the caller.
 */

import { describe, expect, mock, test } from "bun:test";
import { createContextWindowCache } from "@/chat/context-window-cache";

type Lookup = (provider: string, model: string) => Promise<number | undefined>;

describe("createContextWindowCache", () => {
  test("AC-18 primes through the lookup's provider and model split, and get returns its result", async () => {
    const lookup = mock<Lookup>(async () => 200_000);
    const cache = createContextWindowCache(() => lookup);

    await cache.prime("openai/gpt-x");

    expect(lookup).toHaveBeenCalledWith("openai", "gpt-x");
    expect(cache.get("openai/gpt-x")).toBe(200_000);
  });

  test("AC-19 a second prime of the same model reads no window again", async () => {
    const lookup = mock<Lookup>(async () => 100_000);
    const cache = createContextWindowCache(() => lookup);

    await cache.prime("openai/gpt-x");
    await cache.prime("openai/gpt-x");

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(cache.get("openai/gpt-x")).toBe(100_000);
  });

  test("AC-20 a rejecting lookup leaves prime resolved and the window unknown", async () => {
    const lookup = mock<Lookup>(async () => {
      throw new Error("catalog unavailable");
    });
    const cache = createContextWindowCache(() => lookup);

    await expect(cache.prime("openai/gpt-x")).resolves.toBeUndefined();

    expect(cache.get("openai/gpt-x")).toBeUndefined();
  });

  test("a model string with no provider prefix is recorded without a lookup", async () => {
    const lookup = mock<Lookup>(async () => 200_000);
    const cache = createContextWindowCache(() => lookup);

    await cache.prime("test-model");

    expect(lookup).not.toHaveBeenCalled();
    expect(cache.get("test-model")).toBeUndefined();
    await cache.prime("test-model");
    expect(lookup).not.toHaveBeenCalled();
  });

  test("an ACP model is recorded without a lookup: the agent owns its context window", async () => {
    const lookup = mock<Lookup>(async () => 200_000);
    const cache = createContextWindowCache(() => lookup);

    await cache.prime("acp:codex/gpt-5.5");

    expect(lookup).not.toHaveBeenCalled();
    expect(cache.get("acp:codex/gpt-5.5")).toBeUndefined();
  });

  test("a model never primed reads as a cache miss", () => {
    const cache = createContextWindowCache(() => mock<Lookup>(async () => 1));

    expect(cache.get("openai/unseen")).toBeUndefined();
  });

  test("the lookup getter is read per prime, so a seam replaced after construction is the one called", async () => {
    const first = mock<Lookup>(async () => 1);
    const second = mock<Lookup>(async () => 2);
    let lookup: Lookup = first;
    const cache = createContextWindowCache(() => lookup);

    await cache.prime("openai/a");
    lookup = second;
    await cache.prime("openai/b");

    expect(first).toHaveBeenCalledWith("openai", "a");
    expect(second).toHaveBeenCalledWith("openai", "b");
    expect(cache.get("openai/b")).toBe(2);
  });

  test("an effort suffix never reaches the lookup, and get is keyed by the full model", async () => {
    const lookup = mock<Lookup>(async () => 1_000_000);
    const cache = createContextWindowCache(() => lookup);

    await cache.prime("opencode-go/deepseek-v4.1-flash[high]");

    expect(lookup).toHaveBeenCalledWith("opencode-go", "deepseek-v4.1-flash");
    expect(cache.get("opencode-go/deepseek-v4.1-flash[high]")).toBe(1_000_000);
  });

  test("a rejecting lookup on an effort-qualified model leaves its window unknown", async () => {
    const lookup = mock<Lookup>(async () => {
      throw new Error("catalog unavailable");
    });
    const cache = createContextWindowCache(() => lookup);

    await cache.prime("opencode-go/deepseek-v4.1-flash[high]");

    expect(cache.get("opencode-go/deepseek-v4.1-flash[high]")).toBeUndefined();
  });
});
