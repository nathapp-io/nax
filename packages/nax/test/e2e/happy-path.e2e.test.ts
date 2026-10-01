import { describe, expect, test } from "bun:test";
import { runOrchestratorE2E } from "@test/helpers";

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

const PASS_REVIEW = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });
const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });
const verifier = () => ({ output: PASSING_VERDICT });

describe("E2E: happy path", () => {
  test("three-session runs all phases in canonical order", async () => {
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
    });
    expect(result.success).toBe(true);
    // observed 2026-06-14; see story-orchestrator-flow.md §2
    expect(phaseLog).toEqual([
      "test-writer",
      "greenfield-gate",
      "implementer",
      "full-suite-gate",
      "verifier",
      "lint-check",
      "typecheck-check",
      "semantic-review",
      "adversarial-review",
    ]);
  });

  test("single-session (test-after) excludes test-writer/greenfield/verifier and includes verify-scoped", async () => {
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "test-after",
      agent: {
        implementer: impl,
        "reviewer-semantic": PASS_REVIEW,
        "reviewer-adversarial": PASS_REVIEW,
      },
    });
    expect(result.success).toBe(true);
    expect(phaseLog).not.toContain("test-writer");
    expect(phaseLog).not.toContain("greenfield-gate");
    expect(phaseLog).not.toContain("verifier");
    expect(phaseLog).toContain("verify-scoped");
  });
});
