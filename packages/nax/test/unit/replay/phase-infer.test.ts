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
import type { LogEntry } from "@/logger/types";
import { indexEvents, inferPhases, storyInputs } from "@/replay";

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

/** A phase record whose nested `data.storyId` disagrees with its top-level `storyId`. */
function phaseEntryWithNested(topId: string, result: "pass" | "fail", opName: string, nestedId: string): LogEntry {
  return entry({
    stage: "story-orchestrator",
    message: `Phase ${result === "pass" ? "passed" : "failed"}: ${opName}`,
    storyId: topId,
    data: { storyId: nestedId, phase: opName },
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
    const entries: LogEntry[] = [phaseEntry("US-002", "pass", "implementer")];

    const result = inferPhases(entries, "US-002");

    expect(result.phases.some((p) => p.name === "implementer" && p.status === "pass")).toBe(true);
  });

  test("AC2 boundary: ignores 'Phase passed: implementer' for a different storyId", () => {
    const entries: LogEntry[] = [phaseEntry("US-OTHER", "pass", "implementer")];

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
    const entries: LogEntry[] = [phaseEntry("US-002", "fail", "full-suite-gate")];

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
    const entries: LogEntry[] = [phaseEntry("US-002", "pass", "implementer")];

    const result = inferPhases(entries, "US-002");

    expect(result.escalations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// US-006 AC-3: top-level and nested story IDs may differ — match either
// ---------------------------------------------------------------------------

describe("indexEvents — AC3: top-level and nested story IDs may differ", () => {
  test("AC3: a record naming US-001 top-level and US-003 nested contributes to both stories", () => {
    const index = indexEvents([
      entry({
        stage: "story-orchestrator",
        message: "Phase passed: implementer",
        storyId: "US-001",
        data: { storyId: "US-003" },
      }),
    ]);

    expect(storyInputs(index, "US-001").phases).toEqual([{ name: "implementer", status: "pass" }]);
    expect(storyInputs(index, "US-003").phases).toEqual([{ name: "implementer", status: "pass" }]);
  });

  test("AC3: inferPhases matches the nested ID when the top-level ID names another story", () => {
    const entries = [phaseEntryWithNested("US-001", "fail", "full-suite-gate", "US-003")];

    expect(inferPhases(entries, "US-003").phases).toEqual([{ name: "full-suite-gate", status: "fail" }]);
    expect(inferPhases(entries, "US-001").phases).toEqual([{ name: "full-suite-gate", status: "fail" }]);
  });

  test("AC3 boundary: a record with only a nested story ID is indexed under that ID", () => {
    const index = indexEvents([
      entry({ stage: "story-orchestrator", message: "Phase passed: test-writer", data: { storyId: "US-004" } }),
    ]);

    expect(storyInputs(index, "US-004").phases).toEqual([{ name: "test-writer", status: "pass" }]);
  });

  test("AC3 boundary: agreeing top-level and nested IDs fold the record once, not twice", () => {
    const index = indexEvents([
      entry({ stage: "findings.cycle", message: "cycle", storyId: "US-001", data: { storyId: "US-001" } }),
    ]);

    expect(storyInputs(index, "US-001").fixCycles).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// US-006 AC-4: degraded story discovery still prefers the top-level ID
// ---------------------------------------------------------------------------

describe("indexEvents — AC4: degraded story discovery prefers the top-level ID", () => {
  test("AC4: discovery lists the top-level ID when a record names a different nested ID", () => {
    const index = indexEvents([
      entry({
        stage: "story-orchestrator",
        message: "Phase passed: implementer",
        storyId: "US-001",
        data: { storyId: "US-003" },
      }),
    ]);

    expect([...index.storyIds]).toEqual(["US-001"]);
  });

  test("AC4: discovery falls back to the nested ID only when a record has no top-level ID", () => {
    const index = indexEvents([
      entry({ stage: "story-orchestrator", message: "Phase passed: implementer" }),
      entry({ stage: "story-orchestrator", message: "Phase passed: implementer", storyId: "US-002" }),
      entry({ stage: "story-orchestrator", message: "Phase passed: test-writer", data: { storyId: "US-004" } }),
    ]);

    expect([...index.storyIds]).toEqual(["US-002", "US-004"]);
  });

  test("AC4: each discovered ID appears once, in first-seen order", () => {
    const index = indexEvents([
      entry({ stage: "story-orchestrator", message: "Phase passed: a", storyId: "US-002" }),
      entry({ stage: "story-orchestrator", message: "Phase passed: b", storyId: "US-001" }),
      entry({ stage: "story-orchestrator", message: "Phase passed: c", storyId: "US-002" }),
    ]);

    expect([...index.storyIds]).toEqual(["US-002", "US-001"]);
  });
});

// ---------------------------------------------------------------------------
// US-006 AC-1 (accumulation level): interleaved run-level and multi-story
// records accumulate per story, in phase order, with run-level context kept.
// ---------------------------------------------------------------------------

describe("indexEvents — AC1: interleaved run-level and multi-story records", () => {
  test("AC1: phases accumulate per story in log order across interleaved stories", () => {
    const index = indexEvents([
      entry({ stage: "run.start", message: "Starting", data: { naxVersion: "0.94.2" } }),
      phaseEntry("US-001", "pass", "test-writer"),
      phaseEntry("US-002", "pass", "test-writer"),
      entry({ stage: "runner", message: "run-level note with no story" }),
      phaseEntry("US-002", "fail", "implementer"),
      phaseEntry("US-001", "pass", "implementer"),
      entry({
        stage: "agent-manager",
        message: "fail-stale: immediate same-agent retry",
        storyId: "US-002",
        data: { storyId: "US-002" },
      }),
      entry({ stage: "findings.cycle", message: "cycle 1", storyId: "US-002", data: { storyId: "US-002" } }),
      entry({ stage: "findings.cycle", message: "cycle 2", storyId: "US-002", data: { storyId: "US-002" } }),
    ]);

    expect(storyInputs(index, "US-001")).toEqual({
      phases: [
        { name: "test-writer", status: "pass" },
        { name: "implementer", status: "pass" },
      ],
      escalations: [],
      fixCycles: 0,
    });
    expect(storyInputs(index, "US-002")).toEqual({
      phases: [
        { name: "test-writer", status: "pass" },
        { name: "implementer", status: "fail" },
      ],
      escalations: ["fail-stale: immediate same-agent retry"],
      fixCycles: 2,
    });
    expect(index.naxVersion).toBe("0.94.2");
  });

  test("AC1: run-level records create no story bucket and no discovery entry", () => {
    const index = indexEvents([
      entry({ stage: "run.start", message: "Starting", data: { naxVersion: "0.94.2" } }),
      entry({ stage: "runner", message: "run-level note" }),
    ]);

    expect([...index.storyIds]).toEqual([]);
    expect(index.buckets.size).toBe(0);
  });

  test("AC1 boundary: the first run.start version wins, as before", () => {
    const index = indexEvents([
      entry({ stage: "run.start", message: "Starting", data: { naxVersion: "0.94.2" } }),
      entry({ stage: "run.start", message: "Restarted", data: { naxVersion: "9.9.9" } }),
    ]);

    expect(index.naxVersion).toBe("0.94.2");
  });

  test("AC1 boundary: an unknown story yields empty inputs without mutating the index", () => {
    const index = indexEvents([phaseEntry("US-001", "pass", "implementer")]);

    expect(storyInputs(index, "US-404")).toEqual({ phases: [], escalations: [], fixCycles: 0 });
    expect(index.buckets.has("US-404")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// US-006 AC-2 (unit level): one inspection per record, never one per story
// ---------------------------------------------------------------------------

describe("indexEvents — record inspection count", () => {
  test("counts one inspection per record even when a record names two stories", () => {
    const index = indexEvents([
      phaseEntry("US-001", "pass", "implementer"),
      phaseEntryWithNested("US-001", "pass", "test-writer", "US-003"),
      entry({ stage: "runner", message: "run-level note" }),
    ]);

    expect(index.recordsInspected).toBe(3);
  });

  test("inspection count grows with records, not with records times stories", () => {
    const entries: LogEntry[] = [];
    for (let i = 0; i < 500; i++) {
      entries.push(phaseEntry(`US-${String(i % 100)}`, "pass", "implementer"));
    }

    const index = indexEvents(entries);

    expect(index.recordsInspected).toBe(500);
  });
});
