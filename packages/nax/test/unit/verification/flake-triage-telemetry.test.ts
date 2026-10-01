/**
 * Flake-Triage Skip Telemetry (#1657)
 *
 * The counter that decides whether the `repo-scoped-test-fix` fallthrough
 * (#1656) needs to be gated on `flakeTriageRan`. Every skip path must emit
 * exactly one event carrying the reason tag and the candidate count.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { FLAKE_TRIAGE_RAN_EVENT, FLAKE_TRIAGE_SKIP_EVENT, logFlakeTriageRan, logFlakeTriageSkip } from "@/verification";

describe("logFlakeTriageSkip", () => {
  let entries: LogEntry[];
  let unsubscribe: () => void;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "silent" });
    entries = [];
    unsubscribe = addSink((entry) => entries.push(entry));
  });

  afterEach(() => {
    unsubscribe();
    resetLogger();
  });

  test("emits one greppable event tagged with reason, count, and basis", () => {
    logFlakeTriageSkip({
      reason: "max-probes-per-gate",
      scope: "blocking-gate",
      candidateCount: 9,
      candidateBasis: "probe-eligible",
      storyId: "US-004",
      maxProbesPerGate: 5,
    });

    expect(entries.length).toBe(1);
    const entry = entries[0];
    expect(entry?.stage).toBe("flake-triage");
    expect(entry?.data?.event).toBe(FLAKE_TRIAGE_SKIP_EVENT);
    expect(entry?.data?.reason).toBe("max-probes-per-gate");
    expect(entry?.data?.scope).toBe("blocking-gate");
    expect(entry?.data?.candidateCount).toBe(9);
    expect(entry?.data?.candidateBasis).toBe("probe-eligible");
    expect(entry?.data?.maxProbesPerGate).toBe(5);
    expect(entry?.data?.storyId).toBe("US-004");
  });

  test("omits optional fields that were not supplied", () => {
    logFlakeTriageSkip({
      reason: "framework-undetected",
      scope: "nbf",
      candidateCount: 2,
      candidateBasis: "gate-findings",
    });

    const data = entries[0]?.data ?? {};
    expect("maxProbesPerGate" in data).toBe(false);
    expect("error" in data).toBe(false);
    expect("storyId" in data).toBe(false);
  });

  test("carries the error text on the context-error path", () => {
    logFlakeTriageSkip({
      reason: "context-error",
      scope: "regression",
      candidateCount: 1,
      candidateBasis: "gate-findings",
      error: "resolveQualityTestCommands exploded",
    });

    expect(entries[0]?.data?.error).toBe("resolveQualityTestCommands exploded");
  });

  test("never throws when no logger is initialized", () => {
    resetLogger();
    expect(() =>
      logFlakeTriageSkip({
        reason: "no-test-command",
        scope: "blocking-gate",
        candidateCount: 0,
        candidateBasis: "gate-findings",
      }),
    ).not.toThrow();
  });
});

describe("logFlakeTriageRan", () => {
  let entries: LogEntry[];
  let unsubscribe: () => void;

  beforeEach(() => {
    resetLogger();
    initLogger({ level: "silent" });
    entries = [];
    unsubscribe = addSink((entry) => entries.push(entry));
  });

  afterEach(() => {
    unsubscribe();
    resetLogger();
  });

  // Without a denominator, #1657 §3's "meaningful rate" has no rate at all.
  test("emits the denominator counter at debug, so it costs no console lines", () => {
    logFlakeTriageRan({ scope: "blocking-gate", candidateCount: 4, quarantinedCount: 1, storyId: "US-002" });

    expect(entries.length).toBe(1);
    expect(entries[0]?.level).toBe("debug");
    expect(entries[0]?.data?.event).toBe(FLAKE_TRIAGE_RAN_EVENT);
    expect(entries[0]?.data?.scope).toBe("blocking-gate");
    expect(entries[0]?.data?.candidateCount).toBe(4);
    expect(entries[0]?.data?.quarantinedCount).toBe(1);
    expect(entries[0]?.data?.storyId).toBe("US-002");
  });

  test("never throws when no logger is initialized", () => {
    resetLogger();
    expect(() => logFlakeTriageRan({ scope: "regression", candidateCount: 0, quarantinedCount: 0 })).not.toThrow();
  });
});
