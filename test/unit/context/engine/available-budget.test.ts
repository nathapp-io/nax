import { describe, expect, test } from "bun:test";
import { estimateAvailableBudgetTokens } from "@/context";

describe("estimateAvailableBudgetTokens", () => {
  test("returns 0 (numeric) when existing prompt leaves non-positive remaining context room", () => {
    // claude profile: maxContextTokens = 200_000.
    // A prompt long enough to consume the entire remaining room (minus reserved + safety)
    // should drive the remainder to <= 0. We send a huge prompt (~1MB) which is well over
    // the agent's maxContextTokens, so remaining room is definitely non-positive.
    const hugePrompt = "x".repeat(1_000_000);
    const result = estimateAvailableBudgetTokens("claude", hugePrompt);
    expect(result).toBe(0);
    // Spec contract: 0 is a real ceiling — not undefined, not negative.
    expect(typeof result).toBe("number");
  });

  test("returns a positive value smaller than the agent profile's maxContextTokens when called with a short prompt", () => {
    const result = estimateAvailableBudgetTokens("claude", "hello");
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThan(0);
    // Must not be greater than the agent's full context window — it is a remainder.
    expect(result).toBeLessThan(200_000);
  });
});
