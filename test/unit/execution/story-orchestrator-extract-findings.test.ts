/**
 * AC6: extractPhaseFindings exported from story-orchestrator reads normalizedFindings
 *
 * extractPhaseFindings must be exported with JSDoc ("Exported for unit testing;
 * not for external callers — use runPhase") and must return Finding[] from
 * a VerifierOutput whose normalizedFindings field is set.
 */

import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings/types";

const F1: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "tests-failed",
  message: "2 tests failed",
  fixTarget: "source",
};

const F2: Finding = {
  source: "tdd-verifier",
  severity: "error",
  category: "illegitimate-test-edits",
  message: "test file edited",
  fixTarget: "test",
};

function makeVerifierOutput(normalizedFindings: Finding[]) {
  return {
    success: false,
    filesChanged: [] as string[],
    estimatedCostUsd: 0,
    durationMs: 0,
    output: "",
    normalizedFindings,
  };
}

describe("AC6: extractPhaseFindings exported from story-orchestrator", () => {
  test("AC6: extractPhaseFindings is a named export of story-orchestrator", async () => {
    const mod = await import("@/execution/story-orchestrator");
    expect(typeof mod.extractPhaseFindings).toBe("function");
  });

  test("AC6: returns F1 and F2 when normalizedFindings is [F1, F2]", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const output = makeVerifierOutput([F1, F2]);
    const findings = extractPhaseFindings(output);

    expect(findings).toContain(F1);
    expect(findings).toContain(F2);
  });

  test("AC6: returned array length equals normalizedFindings length", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const output = makeVerifierOutput([F1, F2]);
    const findings = extractPhaseFindings(output);

    expect(findings.length).toBe(2);
  });

  test("AC6: returns empty array when normalizedFindings is []", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const output = makeVerifierOutput([]);
    const findings = extractPhaseFindings(output);

    expect(findings.length).toBe(0);
  });

  test("AC6: returns empty array when output is null", async () => {
    const { extractPhaseFindings } = await import("@/execution/story-orchestrator");

    const findings = extractPhaseFindings(null);

    expect(findings.length).toBe(0);
  });
});
