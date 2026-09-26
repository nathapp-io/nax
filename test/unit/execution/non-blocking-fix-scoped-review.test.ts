/**
 * US-004 — the scoped fix review at the non-blocking fix (NBF) keep gate.
 *
 * `runNonBlockingFix` gained the optional `reviewFix` dep (ADR-033): after the
 * `sourceDiffCap` block and before the pass is committed, a pass that would
 * otherwise be kept is handed to the scoped fix review. Only `kind: "pass"`
 * keeps it; any other verdict restores the adversarial-passed snapshot.
 *
 * The keep/restore matrix is asserted through `runNonBlockingFix`'s observable
 * outputs — the returned `{ ran, kept, restored }`, whether `rollbackToRef` ran
 * and with which sha, whether `reviewFix` was consulted at all — plus the
 * info-level log the restore emits. Split out of `non-blocking-fix.test.ts`
 * (already past the ~650-line split threshold) by concern.
 */
import { describe, expect, test } from "bun:test";
import { makeFinding, withInfoSpy } from "@test/helpers";
import type { NonBlockingFixConfig } from "@/config/selectors";
import type { NonBlockingFixArgs, NonBlockingFixDeps, SourceDiffMetrics } from "@/execution/non-blocking-fix";
import { runNonBlockingFix } from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";
import type { FixReviewVerdict } from "@/review/fix-review";

/** The sha `captureSnapshotRef` returns — also the ref `reviewFix` must receive. */
const SNAPSHOT_SHA = "nbf-snapshot-sha";

const CFG: NonBlockingFixConfig = {
  enabled: true,
  scope: "both",
  regressionAttempts: 1,
  verifierGuard: true,
  sourceDiffCap: { maxFiles: 10, maxLines: 500 },
  sources: ["adversarial"],
};

const SEED: readonly Finding[] = [
  makeFinding({
    source: "adversarial-review",
    severity: "warning",
    category: "input",
    message: "the empty path skips",
  }),
];

const PASS: FixReviewVerdict = { kind: "pass", reviewed: true, reason: "no contradiction" };
const WITHIN_CAP: SourceDiffMetrics = { fileCount: 1, sourceLineCount: 10 };

/** Observers every test asserts on: the rollback refs and the refs `reviewFix` saw. */
interface Recorder {
  rollbacks: string[];
  reviewRefs: string[];
}

function makeRecorder(): Recorder {
  return { rollbacks: [], reviewRefs: [] };
}

/**
 * Deps with git-backed capture/rollback and the source-diff measurement faked, so
 * the only real decision under test is the review's. `reviewFix` is supplied per
 * test (AC8's boundary is the dep being absent altogether).
 */
function makeDeps(
  record: Recorder,
  overrides: Partial<NonBlockingFixDeps> = {},
  metrics: SourceDiffMetrics = WITHIN_CAP,
): Partial<NonBlockingFixDeps> {
  return {
    captureSnapshotRef: async () => ({ sha: SNAPSHOT_SHA, untrackedBefore: [] }),
    rollbackToRef: async (_workdir, ref) => {
      record.rollbacks.push(ref);
    },
    measureSourceDiff: async () => metrics,
    ...overrides,
  };
}

/** A `reviewFix` that records the ref it was handed and resolves `verdict`. */
function reviewingFix(record: Recorder, verdict: FixReviewVerdict): NonBlockingFixDeps["reviewFix"] {
  return async (ref: string) => {
    record.reviewRefs.push(ref);
    return verdict;
  };
}

function makeArgs(overrides: Partial<NonBlockingFixArgs> = {}): NonBlockingFixArgs {
  return {
    workdir: "/tmp/x",
    storyId: "us-004",
    advisoryFindings: SEED,
    cfg: CFG,
    phaseOutputs: { "full-suite-gate": { success: true } },
    phaseCosts: {},
    runRectify: async () => ({ rectificationExhausted: false }),
    ...overrides,
  };
}

describe("runNonBlockingFix — the scoped fix review (US-004 AC1)", () => {
  test("US-004 AC1: a reviewFix pass keeps the pass and never rolls back", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, PASS) }));

    expect(result).toEqual({ ran: true, kept: true, restored: false });
    expect(record.rollbacks).toEqual([]);
  });

  test("US-004 AC1 boundary: a not-reviewed pass verdict is still a keep", async () => {
    // The runner reports `reviewed: false` when it decided without an LLM call
    // (fixReview disabled, or the fix changed no path). Only `kind` governs the
    // keep decision, so that verdict must keep the pass too.
    const record = makeRecorder();
    const notReviewed: FixReviewVerdict = { kind: "pass", reviewed: false, reason: "no paths changed by the fix" };

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, { reviewFix: reviewingFix(record, notReviewed) }),
    );

    expect(result).toEqual({ ran: true, kept: true, restored: false });
    expect(record.rollbacks).toEqual([]);
  });
});

describe("runNonBlockingFix — a rejected pass restores (US-004 AC2)", () => {
  test("US-004 AC2: a scope fail restores the adversarial-passed snapshot", async () => {
    const record = makeRecorder();
    const scopeFail: FixReviewVerdict = {
      kind: "fail",
      cause: "scope",
      files: ["src/utils/path-file-lock.ts"],
      reason: "fix touches files outside the story's declared scope",
    };

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, { reviewFix: reviewingFix(record, scopeFail) }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });

  test("US-004 AC2 boundary: a scope fail naming no file still restores", async () => {
    const record = makeRecorder();
    const emptyScopeFail: FixReviewVerdict = { kind: "fail", cause: "scope", files: [], reason: "out of scope" };

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, { reviewFix: reviewingFix(record, emptyScopeFail) }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });
});

describe("runNonBlockingFix — a contradiction restores to the snapshot sha (US-004 AC3)", () => {
  test("US-004 AC3: a contradiction rolls the tree back to the snapshot's sha", async () => {
    const record = makeRecorder();
    const contradiction: FixReviewVerdict = {
      kind: "fail",
      cause: "contradiction",
      reason: "adds mkdir to removeApprovals; AC 4 forbids creating directories",
      acIndex: 4,
      file: "src/approvals/remove.ts",
    };

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, { reviewFix: reviewingFix(record, contradiction) }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });

  test("US-004 AC3 boundary: a contradiction naming no acceptance criterion restores the same way", async () => {
    const record = makeRecorder();
    const proseContradiction: FixReviewVerdict = {
      kind: "fail",
      cause: "contradiction",
      reason: "neither the data file nor its parent directory is created",
    };

    await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, proseContradiction) }));

    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });
});

describe("runNonBlockingFix — a review error restores (US-004 AC4)", () => {
  test("US-004 AC4: an error verdict restores rather than keeping an unreviewed pass", async () => {
    const record = makeRecorder();
    const errorVerdict: FixReviewVerdict = { kind: "error", reason: "snapshot failed: git write-tree failed" };

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, { reviewFix: reviewingFix(record, errorVerdict) }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });

  test("US-004 AC4 boundary: an unparseable-response error restores too", async () => {
    const record = makeRecorder();
    const unparseable: FixReviewVerdict = { kind: "error", reason: "unparseable fix-review response: I could not" };

    await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, unparseable) }));

    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });
});

describe("runNonBlockingFix — the ref the review is consulted with (US-004 AC5)", () => {
  test("US-004 AC5: a pass within the cap consults reviewFix exactly once, with the snapshot sha", async () => {
    const record = makeRecorder();

    await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, PASS) }));

    expect(record.reviewRefs).toEqual([SNAPSHOT_SHA]);
  });

  test("US-004 AC5 boundary: the ref is the captured snapshot's sha, not a fixed value", async () => {
    // Guards against a hardcoded "HEAD" (or any other ref): the review must judge
    // the diff from the pass's entry snapshot.
    const record = makeRecorder();
    const otherSha = "a-different-snapshot-sha";

    await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, {
        captureSnapshotRef: async () => ({ sha: otherSha, untrackedBefore: [] }),
        reviewFix: reviewingFix(record, PASS),
      }),
    );

    expect(record.reviewRefs).toEqual([otherSha]);
  });
});

describe("runNonBlockingFix — the review runs only on a pass that clears the cap (US-004 AC6)", () => {
  test("US-004 AC6: a pass already restored by the sourceDiffCap check is not reviewed", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(
      makeArgs(),
      makeDeps(record, { reviewFix: reviewingFix(record, PASS) }, { fileCount: 1, sourceLineCount: 900 }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.reviewRefs).toEqual([]);
  });

  test("US-004 AC6 boundary: a source-diff measurement that throws is not reviewed either", async () => {
    // The measurement's fail-safe is "restore", which happens before the review
    // — a review of a pass that is already discarded would be a wasted session.
    const record = makeRecorder();
    const deps = makeDeps(record, { reviewFix: reviewingFix(record, PASS) });
    deps.measureSourceDiff = async () => {
      throw new Error("git diff --numstat failed");
    };

    const result = await runNonBlockingFix(makeArgs(), deps);

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.reviewRefs).toEqual([]);
  });

  test("US-004 AC6 boundary: a kept-tree gate regression is not reviewed", async () => {
    // ADR-024 §3's restore is decided before the review; the gate red alone is
    // reason enough to discard the pass.
    const record = makeRecorder();

    const result = await runNonBlockingFix(
      makeArgs({
        keptTreeRegressed: () => ({
          regressed: true,
          regressedKeys: ["broke.test.ts::renders empty state"],
          memoExcludedKeys: [],
          baselineKeySize: 0,
          keyless: false,
        }),
      }),
      makeDeps(record, { reviewFix: reviewingFix(record, PASS) }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.reviewRefs).toEqual([]);
  });
});

describe("runNonBlockingFix — the review runs only on a resolved pass (US-004 AC7)", () => {
  test("US-004 AC7: an exhausted pass is not reviewed", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(
      makeArgs({ runRectify: async () => ({ rectificationExhausted: true }) }),
      makeDeps(record, { reviewFix: reviewingFix(record, PASS) }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.reviewRefs).toEqual([]);
  });

  test("US-004 AC7 boundary: a rectify pass that threw is not reviewed", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(
      makeArgs({
        runRectify: async () => {
          throw new Error("best-effort pass blew up");
        },
      }),
      makeDeps(record, { reviewFix: reviewingFix(record, PASS) }),
    );

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.reviewRefs).toEqual([]);
  });
});

describe("runNonBlockingFix — no reviewFix dep keeps today's behaviour (US-004 AC8)", () => {
  test("US-004 AC8: without a reviewFix dep a pass that clears the cap is kept", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(makeArgs(), makeDeps(record));

    expect(result).toEqual({ ran: true, kept: true, restored: false });
    expect(record.rollbacks).toEqual([]);
  });

  test("US-004 AC8 boundary: without a reviewFix dep the cap still restores", async () => {
    const record = makeRecorder();

    const result = await runNonBlockingFix(makeArgs(), makeDeps(record, {}, { fileCount: 99, sourceLineCount: 10 }));

    expect(result).toEqual({ ran: true, kept: false, restored: true });
    expect(record.rollbacks).toEqual([SNAPSHOT_SHA]);
  });
});

describe("runNonBlockingFix — the rejection is logged (US-004 AC9)", () => {
  test("US-004 AC9: a scope fail logs the restore at info with the verdict's kind", async () => {
    const record = makeRecorder();
    const scopeFail: FixReviewVerdict = {
      kind: "fail",
      cause: "scope",
      files: ["src/utils/path-file-lock.ts"],
      reason: "fix touches files outside the story's declared scope",
    };

    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, scopeFail) }));
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("fix review rejected the pass — restoring"));
      return call?.[2] as Record<string, unknown> | undefined;
    });

    expect(data).toBeDefined();
    expect(data?.kind).toBe("fail");
    expect(data?.cause).toBe("scope");
    expect(data?.reason).toBe("fix touches files outside the story's declared scope");
    expect(data?.files).toEqual(["src/utils/path-file-lock.ts"]);
    // Structured-log convention: storyId is the FIRST key so parallel-mode runs
    // stay correlatable (.claude/rules/project-conventions.md).
    expect(Object.keys(data ?? {})[0]).toBe("storyId");
  });

  test("US-004 AC9: an error verdict logs kind error", async () => {
    const record = makeRecorder();

    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(
        makeArgs(),
        makeDeps(record, { reviewFix: reviewingFix(record, { kind: "error", reason: "dispatch failed" }) }),
      );
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("fix review rejected the pass — restoring"));
      return call?.[2] as Record<string, unknown> | undefined;
    });

    expect(data?.kind).toBe("error");
    expect(data?.reason).toBe("dispatch failed");
  });

  test("US-004 AC9 boundary: a contradiction is logged with its kind", async () => {
    const record = makeRecorder();
    const contradiction: FixReviewVerdict = {
      kind: "fail",
      cause: "contradiction",
      reason: "adds mkdir to removeApprovals; AC 4 forbids creating directories",
      acIndex: 4,
    };

    const data = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, contradiction) }));
      const call = infoSpy.mock.calls.find((c) => String(c[1]).includes("fix review rejected the pass — restoring"));
      return call?.[2] as Record<string, unknown> | undefined;
    });

    expect(data?.kind).toBe("fail");
    expect(data?.cause).toBe("contradiction");
  });

  test("US-004 AC9 boundary: a kept pass logs no rejection", async () => {
    const record = makeRecorder();

    const logged = await withInfoSpy(async (infoSpy) => {
      await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, PASS) }));
      return infoSpy.mock.calls.some((c) => String(c[1]).includes("fix review rejected the pass — restoring"));
    });

    expect(logged).toBe(false);
  });
});
