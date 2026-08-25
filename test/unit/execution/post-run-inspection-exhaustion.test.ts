/**
 * Post-Run Inspection — rectification-exhaustion routing.
 *
 * Split from post-run-inspection.test.ts (file-size limit). Covers how
 * decideStageAction routes an EXHAUSTED rectification cycle: mechanical-only and
 * advisory-only leftovers proceed; any blocking leftover escalates. Shared
 * fixtures live in ./_post-run-fixtures.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { _postRunDeps, applyPostRunInspection, decideStageAction } from "@/execution";
import { fullSuiteGateOp, implementerOp, testWriterOp, verifierOp } from "@/operations";
import { makeTestContext } from "@test/helpers";
import {
  ADVISORY_LEFTOVER_FINDING,
  LINT_FINDING,
  SEMANTIC_REVIEW_FINDING,
  TEST_RUNNER_FINDING,
  TYPECHECK_FINDING,
  makeInspectionOpts,
  makePlanResult,
} from "./_post-run-fixtures";

describe("AC7: mechanicalFailedOnly — all lint/typecheck unfixed → continue action", () => {
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("AC7: rectificationExhausted + all-lint unfixed → decideStageAction returns continue", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [LINT_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("continue");
  });

  test("AC7: rectificationExhausted + all-typecheck unfixed → decideStageAction returns continue", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TYPECHECK_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("continue");
  });

  test("AC7: rectificationExhausted + mixed lint+typecheck unfixed → decideStageAction returns continue", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [LINT_FINDING, TYPECHECK_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("continue");
  });
});

describe("AC8: mechanicalFailedOnly — non-mechanical source present → escalate action", () => {
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("AC8: rectificationExhausted + test-runner finding → decideStageAction returns escalate", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("AC8: rectificationExhausted + mixed lint+test-runner → escalate (not continue)", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [LINT_FINDING, TEST_RUNNER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("rectificationExhausted + semantic-review finding returns explicit exhaustion reason", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [SEMANTIC_REVIEW_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    if (result.action !== "escalate") {
      throw new Error(`Expected escalate action, got ${result.action}`);
    }
    expect(result.reason).toBe("Rectification exhausted with unfixed findings");
  });

  test("rectificationExhausted + unresolvedDetail → escalation reason carries the agent's diagnosis", async () => {
    // Point 2 (US-002): when the implementer signals UNRESOLVED, the cycle exits
    // agent-gave-up and threads unresolvedDetail through to the escalation reason so
    // the powerful-tier agent's priorErrors explains WHY rectification gave up — not a
    // generic "exhausted" line. Guards post-run.ts:374-376 against regression.
    const ctx = makeTestContext();
    const detail =
      "AC5/AC6 pass relative loginUrl '/login' to OAuthModule.registerAsync; assertAuthorizeConfig rejects relative URLs (new URL('/login') throws)";
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
      unresolvedDetail: detail,
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    if (result.action !== "escalate") {
      throw new Error(`Expected escalate action, got ${result.action}`);
    }
    expect(result.reason).toBe(`Rectification exhausted: ${detail}`);
  });

  test("rectificationExhausted + semantic-review finding in TDD mode bypasses pause routing", async () => {
    const ctx = makeTestContext();
    const rollbackCalls: Array<{ workdir: string; ref: string }> = [];
    const origRollback = _postRunDeps.rollbackToRef;
    _postRunDeps.rollbackToRef = mock(async (workdir: string, ref: string) => {
      rollbackCalls.push({ workdir, ref });
    }) as typeof _postRunDeps.rollbackToRef;

    try {
      const planResult = makePlanResult({
        success: false,
        rectificationExhausted: true,
        unfixedFindings: [SEMANTIC_REVIEW_FINDING],
        phaseOutputs: {
          [testWriterOp.name]: { success: true },
          [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
          [fullSuiteGateOp.name]: { success: true, passed: true, findings: [] },
          [verifierOp.name]: { success: true },
          "semantic-review": { passed: false, findings: [SEMANTIC_REVIEW_FINDING] },
        },
      });
      const opts = makeInspectionOpts({
        tddMode: { isLite: false, rollbackEnabled: true },
        initialRef: "abc123",
      });
      const inspection = await applyPostRunInspection(ctx, planResult, opts);
      const result = await decideStageAction(ctx, planResult, inspection, opts);

      if (result.action !== "escalate") {
        throw new Error(`Expected escalate action, got ${result.action}`);
      }
      expect(result.reason).toBe("Rectification exhausted with unfixed findings");
      expect(rollbackCalls).toHaveLength(0);
    } finally {
      _postRunDeps.rollbackToRef = origRollback;
    }
  });

  test("rectificationExhausted does not bypass TDD isolation rollback", async () => {
    const ctx = makeTestContext();
    const rollbackCalls: Array<{ workdir: string; ref: string; untrackedBefore: string[] }> = [];
    const origRollback = _postRunDeps.rollbackToRef;
    _postRunDeps.rollbackToRef = mock(async (workdir: string, ref: string, untrackedBefore: string[]) => {
      rollbackCalls.push({ workdir, ref, untrackedBefore });
    }) as typeof _postRunDeps.rollbackToRef;

    try {
      const planResult = makePlanResult({
        success: false,
        rectificationExhausted: true,
        unfixedFindings: [TEST_RUNNER_FINDING],
        phaseOutputs: {
          [testWriterOp.name]: { success: true },
          [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
          [verifierOp.name]: { success: false, failureCategory: "isolation-violation" },
        },
      });
      const opts = makeInspectionOpts({
        tddMode: { isLite: false, rollbackEnabled: true },
        initialRef: "def456",
        // BUG-07: the snapshot taken at phase start flows through to rollbackToRef.
        untrackedBefore: [".env"],
      });
      const inspection = await applyPostRunInspection(ctx, planResult, opts);
      const result = await decideStageAction(ctx, planResult, inspection, opts);

      expect(result.action).toBe("escalate");
      expect(rollbackCalls).toEqual([{ workdir: ctx.workdir, ref: "def456", untrackedBefore: [".env"] }]);
    } finally {
      _postRunDeps.rollbackToRef = origRollback;
    }
  });

  test("rectificationExhausted TDD isolation rollback passes untrackedBefore through as null (BUG-07: unknown baseline is never treated as empty)", async () => {
    const ctx = makeTestContext();
    const rollbackCalls: Array<{ untrackedBefore: string[] | null }> = [];
    const origRollback = _postRunDeps.rollbackToRef;
    _postRunDeps.rollbackToRef = mock(async (_workdir: string, _ref: string, untrackedBefore: string[] | null) => {
      rollbackCalls.push({ untrackedBefore });
    }) as typeof _postRunDeps.rollbackToRef;

    try {
      const planResult = makePlanResult({
        success: false,
        rectificationExhausted: true,
        unfixedFindings: [TEST_RUNNER_FINDING],
        phaseOutputs: {
          [testWriterOp.name]: { success: true },
          [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
          [verifierOp.name]: { success: false, failureCategory: "isolation-violation" },
        },
      });
      const opts = makeInspectionOpts({
        tddMode: { isLite: false, rollbackEnabled: true },
        initialRef: "def456",
        untrackedBefore: null,
      });
      const inspection = await applyPostRunInspection(ctx, planResult, opts);
      await decideStageAction(ctx, planResult, inspection, opts);

      // null propagates unchanged — rollbackToRef itself skips the untracked
      // sweep on a null baseline. Coercing to [] here would make an unknown
      // baseline look empty and let the sweep delete pre-existing files.
      expect(rollbackCalls).toEqual([{ untrackedBefore: null }]);
    } finally {
      _postRunDeps.rollbackToRef = origRollback;
    }
  });

  test("rectificationExhausted preserves TDD failure category for downstream escalation", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [TEST_RUNNER_FINDING],
      phaseOutputs: {
        [testWriterOp.name]: { success: true },
        [implementerOp.name]: { success: true, estimatedCostUsd: 0, durationMs: 50 },
        [verifierOp.name]: { success: false, failureCategory: "verifier-rejected" },
      },
    });
    const opts = makeInspectionOpts({
      tddMode: { isLite: false, rollbackEnabled: true },
      initialRef: "ghi789",
    });
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);

    expect(result.action).toBe("escalate");
    expect(ctx.tddFailureCategory).toBe("verifier-rejected");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Advisory-only rectification exhaustion → continue (not escalate/fail).
// A green story (all gates passed) must not be failed on leftover findings that
// are below the run's blocking threshold — e.g. a `source:"plugin"` advisory that
// no fix strategy can claim, which drives a `no-strategy` cycle exit. Regression
// guard for the event-bus-idempotency-dlq US-004 failure (that one was a
// `source:"autofix"` declaration diagnostic; #1327 removed those at the mint
// site, but other unclaimed sources keep this escape necessary).
// ─────────────────────────────────────────────────────────────────────────────

describe("advisory-only rectification exhaustion → continue", () => {
  let origAutoCommit: typeof _postRunDeps.autoCommitIfDirty;
  let origDetect: typeof _postRunDeps.detectMergeConflict;
  let origFailClose: typeof _postRunDeps.failAndClose;

  beforeEach(() => {
    origAutoCommit = _postRunDeps.autoCommitIfDirty;
    origDetect = _postRunDeps.detectMergeConflict;
    origFailClose = _postRunDeps.failAndClose;
    _postRunDeps.autoCommitIfDirty = mock(async () => undefined) as typeof _postRunDeps.autoCommitIfDirty;
    _postRunDeps.detectMergeConflict = mock(() => false) as typeof _postRunDeps.detectMergeConflict;
    _postRunDeps.failAndClose = mock(async () => undefined) as typeof _postRunDeps.failAndClose;
  });

  afterEach(() => {
    _postRunDeps.autoCommitIfDirty = origAutoCommit;
    _postRunDeps.detectMergeConflict = origDetect;
    _postRunDeps.failAndClose = origFailClose;
  });

  test("rectificationExhausted + only advisory unclaimed finding → continue", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [ADVISORY_LEFTOVER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("continue");
  });

  test("rectificationExhausted + advisory unclaimed + blocking semantic finding → escalate", async () => {
    const ctx = makeTestContext();
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [ADVISORY_LEFTOVER_FINDING, SEMANTIC_REVIEW_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("rectificationExhausted + finding with missing severity → treated as blocking → escalate", async () => {
    const ctx = makeTestContext();
    // No `severity` field: must default to "error" (blocking) so a real defect is
    // never silently swallowed by the advisory-only escape.
    // Deliberately missing `severity` — makePlanResult's `overrides` bag is
    // untyped (Record<string, unknown>), so this doesn't need a cast to reach
    // decideStageAction; the point of the test is that the real read site
    // (post-run.ts) treats an absent severity as "error", not what TS's
    // static `Finding` type says is possible.
    const noSeverityFinding = {
      source: "plugin",
      message: "unknown-severity finding",
      category: "unknown",
      fixTarget: "source",
    };
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [noSeverityFinding],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });

  test("advisory-only escape respects a stricter blockingThreshold:'info'", async () => {
    // Under blockingThreshold "info" every finding blocks (info < warning < error),
    // so a "warning" advisory is now blocking → escalate, not continue.
    const ctx = makeTestContext();
    ctx.config = {
      ...ctx.config,
      review: { ...ctx.config.review, blockingThreshold: "info" },
    } as typeof ctx.config;
    const planResult = makePlanResult({
      success: false,
      rectificationExhausted: true,
      unfixedFindings: [ADVISORY_LEFTOVER_FINDING],
    });
    const opts = makeInspectionOpts();
    const inspection = await applyPostRunInspection(ctx, planResult, opts);
    const result = await decideStageAction(ctx, planResult, inspection, opts);
    expect(result.action).toBe("escalate");
  });
});
