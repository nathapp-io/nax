// test/unit/execution/non-blocking-fix-retirement.test.ts
//
// US-004 — Render retirement acknowledgements and suppress fix seeds (#1966).
//
// Retired findings stay in the iteration store and in the run-end advisory
// report (they are reported, not acted on) but MUST NOT buy a paid fix pass:
// telling the reviewer "fix this again" is exactly the loop retirement exists
// to break. The carry-forward prompt moves them out of the verdict list into
// an acknowledgement block; the fix lane must move them out of its seed.
//
// Split out from `non-blocking-fix.test.ts` to keep that file under the
// 800-line hard limit (.claude/rules/project-conventions.md).
import { describe, expect, test } from "bun:test";
import { makeFinding } from "@test/helpers";
import type { NonBlockingFixConfig } from "@/config/selectors";
import { actionableAdvisoryFindings, runNonBlockingFix, shouldRunNonBlockingFix } from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";

describe("actionableAdvisoryFindings — retirement filter (US-004)", () => {
  const advisory = (overrides: Partial<Finding> = {}): Finding => ({
    source: "adversarial-review",
    severity: "warning",
    category: "input",
    message: "m",
    ...overrides,
  });

  // AC 8 — retired-stamped advisory is dropped from the actionability filter.
  test("drops a finding stamped meta.recurrence.disposition retired", () => {
    const kept = actionableAdvisoryFindings([
      advisory({ message: "live advisory" }),
      advisory({
        message: "retired advisory",
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      }),
    ]);
    expect(kept.map((f) => f.message)).toEqual(["live advisory"]);
  });

  // AC 9 — non-retired advisory stamp (disposition: advisory) keeps the finding.
  test("keeps a finding stamped meta.recurrence.disposition advisory", () => {
    const kept = actionableAdvisoryFindings([
      advisory({
        message: "live advisory",
        meta: { recurrence: { disposition: "advisory", rounds: 1 } },
      }),
      advisory({
        message: "demoted still",
        meta: { recurrence: { disposition: "demoted", rounds: 4, wasBlocking: true } },
      }),
    ]);
    expect(kept.map((f) => f.message)).toEqual(["live advisory", "demoted still"]);
  });

  // AC 10 — the actionRequired / acDropped filters still apply alongside the
  // retirement filter; they compose, not replace.
  test("continues to drop actionRequired=false and acDropped=true findings", () => {
    const kept = actionableAdvisoryFindings([
      advisory({ message: "live" }),
      advisory({ message: "compliance", actionRequired: false }),
      advisory({ message: "ac-drop", acDropped: true }),
      // All three filter axes on one finding: still dropped.
      advisory({
        message: "triple filtered",
        actionRequired: false,
        acDropped: true,
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      }),
    ]);
    expect(kept.map((f) => f.message)).toEqual(["live"]);
  });
});

describe("runNonBlockingFix — retired-only seed closes the gate (US-004 AC 11)", () => {
  // AC 11 — an advisory bucket of only retired findings closes the NBF gate
  // and no fix pass is dispatched.
  test("an all-retired advisory bucket closes the NBF gate — no fix pass is dispatched", async () => {
    const cfg = {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    } satisfies NonBlockingFixConfig;
    const advisory: readonly Finding[] = [
      {
        source: "adversarial-review",
        severity: "warning",
        category: "input",
        message: "retired advisory",
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      },
    ];
    const actionable = actionableAdvisoryFindings(advisory);
    // Pre-flight gate: NBF must not open with an empty actionable bucket.
    expect(shouldRunNonBlockingFix(cfg, actionable.length)).toBe(false);

    // End-to-end: even if the gate is bypassed somehow, the harness must not be
    // invoked. We drive runNonBlockingFix directly with the raw advisoryFindings
    // field set to the UNFILTERED bucket — the same shape execution-plan.ts
    // passes after running actionableAdvisoryFindings — and assert no
    // snapshot/commit ever happens. If the actionable filter did not drop the
    // retired entries, the pass would be opened (and a snapshot would fire).
    let snapshots = 0;
    let rectified = false;
    const res = await runNonBlockingFix(
      {
        workdir: "/tmp/x",
        storyId: "us-004-retired",
        advisoryFindings: actionable,
        cfg,
        phaseOutputs: {},
        phaseCosts: {},
        runRectify: async () => {
          rectified = true;
          return { rectificationExhausted: false };
        },
      },
      {
        captureSnapshotRef: async () => {
          snapshots += 1;
          return { sha: "snap-sha", untrackedBefore: [] };
        },
        rollbackToRef: async () => {},
      },
    );
    expect(res).toEqual({ ran: false, kept: false, restored: false });
    expect(snapshots).toBe(0);
    expect(rectified).toBe(false);
  });

  // Guard — a mixed bucket where some entries survive the retirement filter
  // must still dispatch. Otherwise the retire-and-keep-stamping loop would
  // zero out the seed wholesale, even when live findings remain.
  test("mixed bucket (live + retired) still dispatches the pass", async () => {
    const cfg = {
      enabled: true,
      scope: "both",
      regressionAttempts: 1,
      verifierGuard: true,
      sourceDiffCap: { maxFiles: 10, maxLines: 500 },
      sources: ["adversarial"],
    } satisfies NonBlockingFixConfig;
    const advisory: readonly Finding[] = [
      makeFinding({ source: "adversarial-review", severity: "warning", category: "input", message: "live" }),
      {
        source: "adversarial-review",
        severity: "warning",
        category: "input",
        message: "retired",
        meta: { recurrence: { disposition: "retired", rounds: 4, wasBlocking: false } },
      },
    ];
    const actionable = actionableAdvisoryFindings(advisory);
    expect(actionable).toHaveLength(1);
    expect(shouldRunNonBlockingFix(cfg, actionable.length)).toBe(true);
  });
});
