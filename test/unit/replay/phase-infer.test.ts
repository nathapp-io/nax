/**
 * inferPhases — Pure phase inference from log entries (US-002)
 *
 * AC-1: @/replay exposes `inferPhases` as a callable function.
 * AC-2: returns `{ name: "implementer", status: "pass" }` for "Phase passed: implementer".
 * AC-3: returns phase names `["test-writer", "implementer"]` in log order for two passes.
 * AC-4: returns `{ name: "full-suite-gate", status: "fail" }` for "Phase failed: full-suite-gate".
 * AC-5: returns a non-empty `escalations` list when an agent-manager entry contains "fail-stale".
 *
 * Each AC carries a success-path test plus, where AC wording permits, a
 * boundary test (storyId mismatch, empty entries, etc.).
 */

import { describe, expect, test } from "bun:test";
import { inferPhases } from "@/replay";
import type { LogEntry } from "@/logger/types";

function entry(partial: Partial<LogEntry>): LogEntry {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    stage: partial.stage ?? "story-orchestrator",
    message: partial.message ?? "",
    ...(partial.storyId !== undefined ? { storyId: partial.storyId } : {}),
    ...(partial.sessionRole !== undefined ? { sessionRole: partial.sessionRole } : {}),
    ...(partial.data !== undefined ? { data: partial.data } : {}),
  };
}

function phaseEntry(storyId: string, result: "pass" | "fail", opName: string): LogEntry {
  return entry({
    stage: "story-orchestrator",
    message: `Phase ${result === "pass" ? "passed" : "failed"}: ${opName}`,
    storyId,
    data: { storyId, phase: opName },
  });
}

// ---------------------------------------------------------------------------
// AC-1: @/replay exposes inferPhases as a callable function
// ---------------------------------------------------------------------------

describe("inferPhases — barrel export", () => {
  test("AC1: is exported from @/replay as a callable function", () => {
    expect(typeof inferPhases).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-2: returns implementer/pass for a "Phase passed: implementer" entry
// ---------------------------------------------------------------------------

describe("inferPhases — AC2: phase pass signal", () => {
  test("AC2: returns a phase with name 'implementer' and status 'pass'", () => {
    const entries: LogEntry[] = [
      phaseEntry("US-002", "pass", "implementer"),
    ];

    const result = inferPhases(entries, "US-002");

    expect(result.phases.some((p) => p.name === "implementer" && p.status === "pass")).toBe(true);
  });

  test("AC2 boundary: ignores 'Phase passed: implementer' for a different storyId", () => {
    const entries: LogEntry[] = [
      phaseEntry("US-OTHER", "pass", "implementer"),
    ];

    const result = inferPhases(entries, "US-002");

    expect(result.phases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-3: preserves log order across multiple phase pass lines
// ---------------------------------------------------------------------------

describe("inferPhases — AC3: phase order", () => {
  test("AC3: returns ['test-writer', 'implementer'] for two passes in that order", () => {
    const entries: LogEntry[] = [
      phaseEntry("US-002", "pass", "test-writer"),
      phaseEntry("US-002", "pass", "implementer"),
    ];

    const result = inferPhases(entries, "US-002");

    expect(result.phases.map((p) => p.name)).toEqual(["test-writer", "implementer"]);
  });

  test("AC3: status for each preserved-phase pass is 'pass'", () => {
    const entries: LogEntry[] = [
      phaseEntry("US-002", "pass", "test-writer"),
      phaseEntry("US-002", "pass", "implementer"),
    ];

    const result = inferPhases(entries, "US-002");

    expect(result.phases.every((p) => p.status === "pass")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC-4: phase fail signal surfaces as a PhaseStep with status "fail"
// ---------------------------------------------------------------------------

describe("inferPhases — AC4: phase fail signal", () => {
  test("AC4: returns a phase with name 'full-suite-gate' and status 'fail'", () => {
    const entries: LogEntry[] = [
      phaseEntry("US-002", "fail", "full-suite-gate"),
    ];

    const result = inferPhases(entries, "US-002");

    expect(result.phases.some((p) => p.name === "full-suite-gate" && p.status === "fail")).toBe(true);
  });

  test("AC4 boundary: empty entries returns an empty phase list (no false positives)", () => {
    const result = inferPhases([], "US-002");

    expect(result.phases).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC-5: fail-stale escalation marker surfaces in escalations[]
// ---------------------------------------------------------------------------

describe("inferPhases — AC5: escalation signal", () => {
  test("AC5: returns non-empty escalations for an agent-manager 'fail-stale' entry", () => {
    const entries: LogEntry[] = [
      entry({
        stage: "agent-manager",
        message: "fail-stale: immediate same-agent retry",
        storyId: "US-002",
        data: { storyId: "US-002" },
      }),
    ];

    const result = inferPhases(entries, "US-002");

    expect(result.escalations.length).toBeGreaterThan(0);
  });

  test("AC5 boundary: escalations list is empty when no fail-stale markers are present", () => {
    const entries: LogEntry[] = [
      phaseEntry("US-002", "pass", "implementer"),
    ];

    const result = inferPhases(entries, "US-002");

    expect(result.escalations).toEqual([]);
  });
});
