/**
 * nax-ai error kinds to nax's failure taxonomy.
 *
 * Five of seven kinds file "availability". A blanket quality/fail-unknown once
 * made every transient failure terminal for exactly these complete-kind ops;
 * this table is what stops that returning. The category tag is observability
 * only — swap behaviour comes from the policy table by outcome (nax#1883).
 */

import { describe, expect, test } from "bun:test";
import { type NativeProtocolError, NativeSessionUnsupportedError, toAdapterFailure } from "@nathapp/nax-agent/internal";
import { failurePolicyFor } from "@/agents/retry/failure-policy";
import { decideSwap } from "@/agents/swap-decision";
import type { AdapterFailure } from "@/context/engine";
import { NaxError } from "@/errors";

const CASES: Array<[kind: string, category: "availability" | "quality", outcome: AdapterFailure["outcome"]]> = [
  ["rate-limit", "availability", "fail-rate-limit"],
  ["auth", "availability", "fail-auth"],
  ["overloaded", "availability", "fail-service-down"],
  ["transport", "availability", "fail-service-down"],
  ["bad-request", "quality", "fail-adapter-error"],
  ["context-overflow", "availability", "fail-adapter-error"],
  ["unknown", "quality", "fail-unknown"],
];

describe("toAdapterFailure", () => {
  test.each(CASES)("maps %s to %s/%s", (kind, category, outcome) => {
    const failure = toAdapterFailure({ kind });
    expect(failure.category).toBe(category);
    expect(failure.outcome).toBe(outcome);
  });

  test("keeps five of seven kinds swappable", () => {
    const kinds = ["rate-limit", "auth", "overloaded", "transport", "bad-request", "context-overflow", "unknown"];
    const availability = kinds.filter((k) => toAdapterFailure({ kind: k }).category === "availability");
    expect(availability).toHaveLength(5);
  });

  test("does not mark an overflow retriable: the same agent would rebuild the same oversized request", () => {
    expect(toAdapterFailure({ kind: "context-overflow" }).retriable).toBe(false);
  });

  test("says the prompt outgrew the window, not that the request was malformed", () => {
    const message = toAdapterFailure({ kind: "context-overflow" }).message;
    expect(message).toContain("context window");
    expect(message).not.toContain("malformed");
  });

  test("treats an unrecognised kind as unknown rather than throwing", () => {
    expect(toAdapterFailure({ kind: "something-new" }).outcome).toBe("fail-unknown");
  });
});

describe("retryAfterSeconds", () => {
  test("carries the provider's retryAfter onto the failure", () => {
    expect(toAdapterFailure({ kind: "rate-limit", retryAfter: 30 }).retryAfterSeconds).toBe(30);
  });

  test("omits the field when the provider supplied none", () => {
    expect(toAdapterFailure({ kind: "rate-limit" }).retryAfterSeconds).toBeUndefined();
  });

  test("carries it for any kind, not just rate-limit", () => {
    expect(toAdapterFailure({ kind: "overloaded", retryAfter: 5 }).retryAfterSeconds).toBe(5);
  });

  test("an unrecognised kind still degrades to unknown, and still carries retryAfter", () => {
    const failure = toAdapterFailure({ kind: "brand-new-kind", retryAfter: 9 });
    expect(failure.outcome).toBe("fail-unknown");
    expect(failure.retryAfterSeconds).toBe(9);
  });

  test("the shared table entries are not mutated across calls", () => {
    expect(toAdapterFailure({ kind: "rate-limit", retryAfter: 30 }).retryAfterSeconds).toBe(30);
    expect(toAdapterFailure({ kind: "rate-limit" }).retryAfterSeconds).toBeUndefined();
  });
});

/**
 * The mapping only matters through the gate it feeds. Assert outcomes through
 * decideSwap as well as pinning the policy table, so routing regressions surface.
 */
describe("failure policy", () => {
  test("keeps adapter-error retry and cooldown fields while swapping after its retry lane", () => {
    expect(failurePolicyFor("fail-adapter-error")).toMatchObject({
      swap: "after-retry-lane",
      sameAgentRetry: "adapter-error",
      cooldown: "none",
      cooldownScope: "model",
    });
  });

  test.each(["fail-quality", "fail-unknown"] as const)("keeps %s quality-gated", (outcome) => {
    expect(failurePolicyFor(outcome).swap).toBe("quality-gated");
  });
});

describe("swap eligibility, through the real gate", () => {
  const fallback = { enabled: true, onQualityFailure: false, maxHopsPerStory: 2 };

  test("an overflow swaps after the retry lane without quality swaps enabled", () => {
    expect(decideSwap(toAdapterFailure({ kind: "context-overflow" }), 0, fallback)).toEqual({ swap: true });
  });

  test("a malformed request swaps after the retry lane without quality swaps enabled", () => {
    expect(decideSwap(toAdapterFailure({ kind: "bad-request" }), 0, fallback)).toEqual({ swap: true });
  });

  test("a fail-quality failure remains declined without quality swaps enabled", () => {
    expect(
      decideSwap(
        { category: "quality", outcome: "fail-quality", retriable: false, message: "gate failed" },
        0,
        fallback,
      ),
    ).toEqual({ swap: false, reason: "quality-failure-declined" });
  });

  test("declines adapter-error swaps when fallback is disabled", () => {
    expect(decideSwap(toAdapterFailure({ kind: "bad-request" }), 0, { ...fallback, enabled: false })).toEqual({
      swap: false,
      reason: "fallback-disabled",
    });
  });

  test("declines adapter-error swaps at the hop cap", () => {
    expect(decideSwap(toAdapterFailure({ kind: "bad-request" }), 2, fallback)).toEqual({
      swap: false,
      reason: "hop-cap-reached",
    });
  });
});

describe("NativeSessionUnsupportedError", () => {
  test("names the method and the phase that will add it", () => {
    const err = new NativeSessionUnsupportedError("openSession");
    expect(err.message).toContain("openSession");
    expect(err.message).toContain("Phase B");
  });
});

/**
 * US-005 — a credential-store fault, mapped to the auth entry.
 *
 * nax-ai's `classifyThrown` files every status-less throw as protocol kind
 * `transport`, so the kind cannot tell a broken helper from a stalled socket.
 * The store's own code survives on the cause chain (pinned in
 * errors-credential-fault.test.ts), and these tests pin the mapping it drives.
 */

function credentialNaxError(code: string): NaxError {
  return new NaxError(`[credentials] ${code}`, code, { stage: "credentials" });
}

/** The store's throw as pi-ai relays it: protocol error -> Error -> NaxError. */
function wrappedStoreFault(kind: string, code: string): NativeProtocolError {
  return { kind, cause: new Error("models error", { cause: credentialNaxError(code) }) };
}

describe("toAdapterFailure -- credential faults", () => {
  test("US-005 AC5: returns outcome fail-auth for a transport error whose cause chain holds CREDENTIAL_CHANGED", () => {
    expect(toAdapterFailure(wrappedStoreFault("transport", "CREDENTIAL_CHANGED")).outcome).toBe("fail-auth");
  });

  test("US-005 AC5: files the credential fault under category availability, like any auth failure", () => {
    expect(toAdapterFailure(wrappedStoreFault("transport", "CREDENTIAL_CHANGED")).category).toBe("availability");
  });

  test("US-005 AC6: returns retriable false for a transport error whose cause chain holds CREDENTIAL_CHANGED", () => {
    expect(toAdapterFailure(wrappedStoreFault("transport", "CREDENTIAL_CHANGED")).retriable).toBe(false);
  });

  test("US-005 AC7: names CREDENTIAL_CHANGED in the message, replacing the transport one", () => {
    const { message } = toAdapterFailure(wrappedStoreFault("transport", "CREDENTIAL_CHANGED"));
    expect(message).toContain("CREDENTIAL_CHANGED");
    expect(message).not.toContain("transport retries exhausted");
  });

  test("US-005 AC8: returns outcome fail-auth for a kind unknown error whose cause chain holds CREDENTIAL_FILE_UNREADABLE", () => {
    expect(toAdapterFailure(wrappedStoreFault("unknown", "CREDENTIAL_FILE_UNREADABLE")).outcome).toBe("fail-auth");
  });

  test("US-005 AC9: returns outcome fail-service-down for a transport error with no credential fault in its cause chain", () => {
    const fault: NativeProtocolError = { kind: "transport", cause: new Error("socket closed") };
    expect(toAdapterFailure(fault).outcome).toBe("fail-service-down");
  });

  test("US-005 AC9: a non-credential NaxError in the cause chain leaves the transport mapping alone", () => {
    const fault: NativeProtocolError = {
      kind: "transport",
      cause: new Error("models error", {
        cause: new NaxError("agent missing", "AGENT_NOT_FOUND", { stage: "registry" }),
      }),
    };
    const failure = toAdapterFailure(fault);
    expect(failure.outcome).toBe("fail-service-down");
    expect(failure.retriable).toBe(true);
  });
});
