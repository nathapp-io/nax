import { describe, expect, test } from "bun:test";
import { failurePolicyFor } from "@/agents/retry/failure-policy";
import type { AdapterFailure } from "@/context/engine";

const ALL_OUTCOMES: ReadonlyArray<AdapterFailure["outcome"]> = [
  "fail-quota",
  "fail-service-down",
  "fail-auth",
  "fail-rate-limit",
  "fail-aborted",
  "fail-stale",
  "fail-timeout",
  "fail-adapter-error",
  "fail-quality",
  "fail-unknown",
];

describe("failurePolicyFor", () => {
  test("returns a fully populated policy for every outcome", () => {
    for (const outcome of ALL_OUTCOMES) {
      const policy = failurePolicyFor(outcome);
      expect(policy.sameAgentRetry).toBeDefined();
      expect(policy.swap).toBeDefined();
      expect(policy.cooldown).toBeDefined();
      expect(typeof policy.terminalBackoff).toBe("boolean");
    }
  });

  test("fail-timeout swaps after its retry lane and never prunes", () => {
    const policy = failurePolicyFor("fail-timeout");
    expect(policy.swap).toBe("after-retry-lane");
    expect(policy.cooldown).toBe("none");
    expect(policy.sameAgentRetry).toBe("timeout");
  });

  test("fail-service-down gets the adapter-error lane and a terminal backoff", () => {
    const policy = failurePolicyFor("fail-service-down");
    expect(policy.sameAgentRetry).toBe("adapter-error");
    expect(policy.terminalBackoff).toBe(true);
  });

  test.each(["fail-auth", "fail-quota"] as const)("%s cools down for the whole run", (outcome) => {
    expect(failurePolicyFor(outcome).cooldown).toBe("run");
  });

  test("fail-aborted never swaps", () => {
    expect(failurePolicyFor("fail-aborted").swap).toBe("never");
  });

  test.each(["fail-quality", "fail-unknown"] as const)("%s stays quality-gated", (outcome) => {
    expect(failurePolicyFor(outcome).swap).toBe("quality-gated");
  });

  test("fail-rate-limit cools down for a finite positive duration", () => {
    const cooldown = failurePolicyFor("fail-rate-limit").cooldown;
    expect(typeof cooldown).toBe("object");
    const ms = (cooldown as { ms: number }).ms;
    expect(Number.isFinite(ms)).toBe(true);
    expect(ms).toBeGreaterThan(0);
  });
});

import { resolveCooldownExpiry } from "@/agents/retry/failure-policy";

const failure = (outcome: AdapterFailure["outcome"], retryAfterSeconds?: number): AdapterFailure => ({
  category: "availability",
  outcome,
  retriable: true,
  message: "",
  ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
});

describe("resolveCooldownExpiry", () => {
  test("returns null when the policy says never prune", () => {
    expect(resolveCooldownExpiry(failure("fail-timeout"), 1_000)).toBeNull();
  });

  test("returns the run sentinel for a permanent failure", () => {
    expect(resolveCooldownExpiry(failure("fail-auth"), 1_000)).toBe("run");
  });

  test("uses the table constant when the provider said nothing", () => {
    expect(resolveCooldownExpiry(failure("fail-rate-limit"), 1_000)).toBe(61_000);
  });

  test("prefers the provider's retryAfterSeconds over the constant", () => {
    expect(resolveCooldownExpiry(failure("fail-rate-limit", 300), 1_000)).toBe(301_000);
  });

  test.each([-5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back to the constant for an invalid retryAfterSeconds (%p)",
    (bad) => {
      expect(resolveCooldownExpiry(failure("fail-rate-limit", bad), 1_000)).toBe(61_000);
    },
  );
});
