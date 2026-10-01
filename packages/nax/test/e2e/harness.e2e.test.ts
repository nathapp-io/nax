import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";

/** Minimal valid VerifierVerdict that the verifier op's parse/coerce accepts as passing. */
const PASSING_VERDICT = JSON.stringify({
  version: 1,
  approved: true,
  tests: { allPassing: true, passCount: 3, failCount: 0 },
  testModifications: { detected: false, files: [], legitimate: true, reasoning: "no modifications" },
  acceptanceCriteria: { allMet: true, criteria: [] },
  quality: { rating: "good", issues: [] },
  fixes: [],
  reasoning: "All tests pass",
});

describe("E2E: harness", () => {
  test("runs a three-session happy path and records an ordered phase log", async () => {
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) }),
        implementer: () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) }),
        verifier: () => ({ output: PASSING_VERDICT }),
        "reviewer-semantic": () => ({ output: JSON.stringify({ passed: true, findings: [] }) }),
        "reviewer-adversarial": () => ({ output: JSON.stringify({ passed: true, findings: [] }) }),
      },
    });

    expect(result.success).toBe(true);
    expect(phaseLog).toContain("implementer");
    expect(phaseLog.indexOf("implementer")).toBeLessThan(phaseLog.indexOf("verifier"));
  });
});
