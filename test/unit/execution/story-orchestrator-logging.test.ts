import { describe, expect, test } from "bun:test";
import { buildPhaseOutcomeLogData, formatPhaseResultMessage } from "@/execution";

describe("formatPhaseResultMessage — stage-aware messaging", () => {
  test("returns 'Phase passed' for a non-rectification op with success=true", () => {
    expect(formatPhaseResultMessage("verifier", true)).toBe("Phase passed: verifier");
  });

  test("returns 'Phase failed' for a non-rectification op with success=false", () => {
    expect(formatPhaseResultMessage("verifier", false)).toBe("Phase failed: verifier");
  });

  test("returns 'Phase skipped' when a deterministic phase reports status=skipped", () => {
    expect(formatPhaseResultMessage("lint-check", true, undefined, "skipped")).toBe("Phase skipped: lint-check");
  });

  test("returns 'Rectification strategy completed' for a rectification-stage op regardless of success flag", () => {
    expect(formatPhaseResultMessage("autofix-implementer", false, "rectification")).toBe(
      "Rectification strategy completed: autofix-implementer",
    );
    expect(formatPhaseResultMessage("autofix-test-writer", true, "rectification")).toBe(
      "Rectification strategy completed: autofix-test-writer",
    );
  });

  test("keeps the greenfield-gate carve-out", () => {
    expect(formatPhaseResultMessage("greenfield-gate", true)).toBe(
      "Greenfield-gate: pre-existing tests detected (not greenfield) — proceeding with normal TDD",
    );
    expect(formatPhaseResultMessage("greenfield-gate", false)).toBe(
      "Greenfield-gate: no pre-existing tests — greenfield run, pausing TDD test-writer",
    );
  });
});

describe("buildPhaseOutcomeLogData — verdict detail surfacing", () => {
  test("returns null for non-object output", () => {
    expect(buildPhaseOutcomeLogData("US-001", "verifier", null, 100)).toBeNull();
    expect(buildPhaseOutcomeLogData("US-001", "verifier", undefined, 100)).toBeNull();
    expect(buildPhaseOutcomeLogData("US-001", "verifier", "string", 100)).toBeNull();
  });

  test("counts normalizedFindings (verifier shape), not legacy findings", () => {
    const output = {
      success: false,
      normalizedFindings: [{ source: "tdd-verifier" }],
      failureCategory: "tests-failing",
      reviewReason: "1 story-scoped test failed",
    };
    const built = buildPhaseOutcomeLogData("US-001", "verifier", output, 956428);
    expect(built).not.toBeNull();
    expect(built?.success).toBe(false);
    expect(built?.data).toMatchObject({
      storyId: "US-001",
      phase: "verifier",
      durationMs: 956428,
      findingsCount: 1,
      failureCategory: "tests-failing",
      reviewReason: "1 story-scoped test failed",
    });
  });

  test("falls back to legacy findings array when normalizedFindings absent", () => {
    const built = buildPhaseOutcomeLogData("US-001", "lint-check", { passed: false, findings: [{}, {}] }, 50);
    expect(built?.data.findingsCount).toBe(2);
  });

  test("omits findingsCount/failureCategory/reviewReason when not present", () => {
    const built = buildPhaseOutcomeLogData("US-001", "full-suite-gate", { success: true, status: "passed" }, 200);
    expect(built?.success).toBe(true);
    expect(built?.data).toEqual({ storyId: "US-001", phase: "full-suite-gate", durationMs: 200, status: "passed" });
    expect(built?.data).not.toHaveProperty("findingsCount");
    expect(built?.data).not.toHaveProperty("failureCategory");
  });

  test("storyId is the first key (parallel-log correlation)", () => {
    const built = buildPhaseOutcomeLogData("US-001", "verifier", { success: false, normalizedFindings: [] }, 10);
    expect(Object.keys(built!.data)[0]).toBe("storyId");
  });

  test("preserves status=skipped so log formatting can avoid false 'passed' wording", () => {
    const built = buildPhaseOutcomeLogData("US-001", "lint-check", { success: true, status: "skipped", findings: [] }, 10);
    expect(built?.success).toBe(true);
    expect(built?.data.status).toBe("skipped");
  });
});

// ─── finding identities on a failing phase (#1392) ───────────────────────────
//
// The log recorded how MANY findings a failing phase produced and never WHICH:
// `{"message":"Phase failed: full-suite-gate","data":{"findingsCount":1,"status":"failed"}}`
// is close to useless when the first thing you want is the failing test's name.
// #1388 fixed this for the nbf rollback path, where the evidence was also
// unrecoverable afterwards; this covers every other gate failure.

describe("buildPhaseOutcomeLogData — finding identities (#1392)", () => {
  const testFinding = (file: string, rule: string) => ({
    source: "test-runner",
    category: "failed-test",
    severity: "error",
    message: "boom",
    file,
    rule,
  });

  test("names the findings of a FAILING phase as file::rule identities", () => {
    const output = { success: false, findings: [testFinding("test/unit/a.test.ts", "renders empty state")] };
    const built = buildPhaseOutcomeLogData("US-001", "full-suite-gate", output, 42920);
    expect(built?.data.findingIdentities).toEqual(["test/unit/a.test.ts::renders empty state"]);
    expect(built?.data.findingsCount).toBe(1);
  });

  test("emits nothing extra for a PASSING phase", () => {
    // extractPhaseFindings yields [] on success, so a green phase stays as terse as before.
    const built = buildPhaseOutcomeLogData("US-001", "full-suite-gate", { success: true, findings: [] }, 200);
    expect(built?.data).not.toHaveProperty("findingIdentities");
  });

  test("reads the verifier's normalizedFindings shape too", () => {
    const output = { success: false, normalizedFindings: [testFinding("test/unit/b.test.ts", "t-b")] };
    const built = buildPhaseOutcomeLogData("US-001", "verifier", output, 10);
    expect(built?.data.findingIdentities).toEqual(["test/unit/b.test.ts::t-b"]);
  });

  test("caps the sample but leaves findingsCount carrying the true magnitude", () => {
    // An all-red suite must not produce a JSONL line that dwarfs every other record.
    const findings = Array.from({ length: 25 }, (_, i) => testFinding(`test/unit/f${i}.test.ts`, `t${i}`));
    const built = buildPhaseOutcomeLogData("US-001", "full-suite-gate", { success: false, findings }, 10);
    expect((built?.data.findingIdentities as string[]).length).toBe(10);
    expect(built?.data.findingsCount).toBe(25);
  });

  test("tolerates findings with no file or rule", () => {
    // Execution-failure synth findings carry neither; they must not crash or vanish.
    const output = {
      success: false,
      findings: [{ source: "test-runner", category: "execution-failed", severity: "error", message: "exit 1" }],
    };
    const built = buildPhaseOutcomeLogData("US-001", "full-suite-gate", output, 10);
    expect(built?.data.findingIdentities).toEqual(["::"]);
  });

  test("storyId stays the first key", () => {
    const output = { success: false, findings: [testFinding("a.test.ts", "t")] };
    const built = buildPhaseOutcomeLogData("US-001", "full-suite-gate", output, 10);
    expect(Object.keys(built!.data)[0]).toBe("storyId");
  });
});
