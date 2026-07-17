import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import { runOrchestratorE2E } from "@test/helpers";

// Acceptance criterion the recurring finding cites. `AC_QUOTE` is a verbatim
// substring of `AC_TEXT` and contains the file's basename ("store") so it
// clears both the substring check and the locus-keyword check in
// `validateAcQuote` (src/review/ac-quote-validator.ts).
const AC_TEXT = "The session store must expire the window atomically without race conditions.";
const AC_QUOTE = "session store must expire the window atomically";

const PASS_SEMANTIC = () => ({ output: JSON.stringify({ passed: true, findings: [] }) });

// A blocking adversarial finding the reviewer emits every round with the SAME
// fingerprint (file + category + issue prefix — see fingerprintFor in
// src/review/recurrence-demotion.ts). category "assumption" is in
// BLOCKING_CATEGORIES (src/review/ac-structural-counterfactual.ts) so it maps
// to fixTarget "source" and is claimed by autofix-implementer, not the
// test-writer (#1333 routing) — the fix session never actually touches disk
// (scripted agents don't write files), so the SAME finding recurs untouched
// every round. `verifiedBy.observed` is non-empty but the file does not exist
// in the scripted (non-git) temp workdir, so `checkFindingEvidence` reports
// "unreadable" — which `substantiateAdversarialFindings` does NOT downgrade
// (only "unmatched"/"missing-observed" are downgraded) — so the finding stays
// blocking-eligible. Same technique as the test-gap case in
// agent-fix.e2e.test.ts.
const RECURRING_BLOCK = JSON.stringify({
  passed: false,
  inspectedFiles: ["lib/store.ts"],
  findings: [
    {
      severity: "error",
      category: "assumption",
      file: "lib/store.ts",
      line: 10,
      issue: "window expiry is non-atomic and can race under concurrent access",
      suggestion: "wrap the expiry check-and-delete in a single atomic operation",
      acQuote: AC_QUOTE,
      acIndex: 1,
      verifiedBy: { file: "lib/store.ts", observed: "if (Date.now() > entry.expiresAt) delete store[key];" },
    },
  ],
});

const tw = () => ({ output: JSON.stringify({ filesChanged: ["test/a.test.ts"] }) });
const impl = () => ({ output: JSON.stringify({ filesChanged: ["src/a.ts"] }) });

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
const verifier = () => ({ output: PASSING_VERDICT });

describe("E2E: adversarial recurrence demotion (Phase 0)", () => {
  test("a non-test-gap finding recurring past maxBlockingRounds demotes and the story converges", async () => {
    const { result, phaseLog } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      story: { acceptanceCriteria: [AC_TEXT] },
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_SEMANTIC,
        "reviewer-adversarial": () => ({ output: RECURRING_BLOCK }),
      },
      config: {
        review: {
          checks: ["semantic", "adversarial"],
          adversarial: { recurrenceDemotion: { enabled: true, maxBlockingRounds: 2 } },
        },
      } as Partial<NaxConfig>,
    });

    // Round 1 (main loop) and round 2 (first rectification pass) both block —
    // the entry guard (n===1) and prevWasBlocking classify the same fingerprint
    // as blocking. Round 3 crosses maxBlockingRounds(2)+1=3 prior appearances
    // and the finding is demoted to advisory — the story converges (passes).
    expect(result.success).toBe(true);
    expect(phaseLog.filter((p) => p === "adversarial-review").length).toBeGreaterThanOrEqual(3);
  });

  test("with recurrenceDemotion disabled the same finding blocks indefinitely (rectification exhausts)", async () => {
    const { result } = await runOrchestratorE2E({
      strategy: "three-session-tdd",
      story: { acceptanceCriteria: [AC_TEXT] },
      agent: {
        "test-writer": tw,
        implementer: impl,
        verifier,
        "reviewer-semantic": PASS_SEMANTIC,
        "reviewer-adversarial": () => ({ output: RECURRING_BLOCK }),
      },
      config: {
        review: {
          checks: ["semantic", "adversarial"],
          adversarial: { recurrenceDemotion: { enabled: false, maxBlockingRounds: 2 } },
        },
      } as Partial<NaxConfig>,
      rectification: { maxAttempts: 2 },
    });

    expect(result.success).toBe(false);
    expect(result.rectificationExhausted).toBe(true);
  });
});
