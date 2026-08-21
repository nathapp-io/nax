/**
 * Flake-Triage Skip Telemetry (#1657)
 *
 * The counter that decides whether the `repo-scoped-test-fix` fallthrough
 * (#1656) needs to be gated on `flakeTriageRan`. Every skip path must emit
 * exactly one event carrying the reason tag and the candidate count.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type LogEntry, addSink, initLogger, resetLogger } from "@/logger";
import { FLAKE_TRIAGE_SKIP_EVENT, logFlakeTriageSkip } from "@/verification";

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
    expect(entry?.data?.candidateCount).toBe(9);
    expect(entry?.data?.candidateBasis).toBe("probe-eligible");
    expect(entry?.data?.maxProbesPerGate).toBe(5);
    expect(entry?.data?.storyId).toBe("US-004");
  });

  test("omits optional fields that were not supplied", () => {
    logFlakeTriageSkip({ reason: "framework-undetected", candidateCount: 2, candidateBasis: "gate-findings" });

    const data = entries[0]?.data ?? {};
    expect("maxProbesPerGate" in data).toBe(false);
    expect("error" in data).toBe(false);
    expect("storyId" in data).toBe(false);
  });

  test("carries the error text on the context-error path", () => {
    logFlakeTriageSkip({
      reason: "context-error",
      candidateCount: 1,
      candidateBasis: "gate-findings",
      error: "resolveQualityTestCommands exploded",
    });

    expect(entries[0]?.data?.error).toBe("resolveQualityTestCommands exploded");
  });

  test("never throws when no logger is initialized", () => {
    resetLogger();
    expect(() =>
      logFlakeTriageSkip({ reason: "no-test-command", candidateCount: 0, candidateBasis: "gate-findings" }),
    ).not.toThrow();
  });
});
