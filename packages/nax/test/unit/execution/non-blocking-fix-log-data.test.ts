/**
 * Characterisation for the NBF log payloads nothing else pins — written before
 * the complexity drain moves `runNonBlockingFix`'s keep-gauntlet into phase
 * functions (docs/plans/STATUS-complexity-drain.md, batch A11).
 *
 * The mirror suites assert the rejection log's `kind` / `cause` / `files`
 * (US-004 AC9 in `non-blocking-fix-scoped-review.test.ts`) and every keep /
 * restore RESULT, but two outputs had no assertion at all:
 *
 * - the contradiction rejection log's `acIndex` / `file` fields — the AC9
 *   boundary test passes a verdict WITH an `acIndex` but never asserts the
 *   logged value, and no test verdict ever sets `file`, so that branch never
 *   even executed with a defined value;
 * - the keep log itself ("best-effort fix kept") — its payload is unasserted
 *   anywhere.
 *
 * Pinned here so the extraction cannot silently drop them (the A3 lesson: a
 * log-only regression no functional test catches). The blocked-worktree warn
 * message is pinned too — its test asserted the result and the skipped
 * snapshot, never the message.
 */
import { describe, expect, test } from "bun:test";
import { makeFinding, withInfoSpy, withWarnSpy } from "@test/helpers";
import type { NonBlockingFixConfig } from "@/config/selectors";
import type { NonBlockingFixArgs, NonBlockingFixDeps, SourceDiffMetrics } from "@/execution/non-blocking-fix";
import { runNonBlockingFix } from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";
import type { FixReviewVerdict } from "@/review/fix-review";

const SNAPSHOT_SHA = "nbf-log-data-snapshot-sha";

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
    message: "log-data characterisation seed",
  }),
];

const PASS: FixReviewVerdict = { kind: "pass", reviewed: true, reason: "no contradiction" };
const WITHIN_CAP: SourceDiffMetrics = { fileCount: 1, sourceLineCount: 10 };

interface Recorder {
  rollbacks: string[];
  reviewRefs: string[];
}

function makeRecorder(): Recorder {
  return { rollbacks: [], reviewRefs: [] };
}

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
    listCommitsSince: async () => [],
    measureSourceDiff: async () => metrics,
    ...overrides,
  };
}

function reviewingFix(record: Recorder, verdict: FixReviewVerdict): NonBlockingFixDeps["reviewFix"] {
  return async (ref: string) => {
    record.reviewRefs.push(ref);
    return verdict;
  };
}

function makeArgs(overrides: Partial<NonBlockingFixArgs> = {}): NonBlockingFixArgs {
  return {
    workdir: "/tmp/x",
    storyId: "us-001",
    advisoryFindings: SEED,
    cfg: CFG,
    phaseOutputs: { "full-suite-gate": { success: true } },
    phaseCosts: {},
    runRectify: async () => ({ rectificationExhausted: false }),
    ...overrides,
  };
}

describe("runNonBlockingFix — log payloads nothing else pins (A11 characterisation)", () => {
  test("a contradiction rejection log carries the acIndex and file it names", async () => {
    const record = makeRecorder();
    const contradiction: FixReviewVerdict = {
      kind: "fail",
      cause: "contradiction",
      reason: "adds mkdir to removeApprovals; AC 4 forbids creating directories",
      acIndex: 4,
      file: "src/cli/approvals.ts",
    };

    const data = await withInfoSpy(async (infoSpy) => {
      const result = await runNonBlockingFix(
        makeArgs(),
        makeDeps(record, { reviewFix: reviewingFix(record, contradiction) }),
      );
      expect(result).toEqual({ ran: true, kept: false, restored: true });
      const call = infoSpy.mock.calls.find((c) => c[1] === "fix review rejected the pass — restoring");
      return call?.[2];
    });

    expect(data?.storyId).toBe("us-001");
    expect(data?.kind).toBe("fail");
    expect(data?.cause).toBe("contradiction");
    expect(data?.reason).toBe("adds mkdir to removeApprovals; AC 4 forbids creating directories");
    expect(data?.acIndex).toBe(4);
    expect(data?.file).toBe("src/cli/approvals.ts");
    // Structured-log convention: storyId is the FIRST key so parallel-mode runs
    // stay correlatable (.claude/rules/project-conventions.md).
    expect(Object.keys(data ?? {})[0]).toBe("storyId");
  });

  test("a kept pass logs the keep at info with the story id", async () => {
    const record = makeRecorder();

    const data = await withInfoSpy(async (infoSpy) => {
      const result = await runNonBlockingFix(makeArgs(), makeDeps(record, { reviewFix: reviewingFix(record, PASS) }));
      expect(result).toEqual({ ran: true, kept: true, restored: false });
      const call = infoSpy.mock.calls.find((c) => c[1] === "best-effort fix kept");
      return call?.[2];
    });

    expect(data).toEqual({ storyId: "us-001" });
  });

  test("the blocked-worktree skip warns with the story id and workdir", async () => {
    const record = makeRecorder();

    const data = await withWarnSpy(async (warnSpy) => {
      const result = await runNonBlockingFix(makeArgs({ blockedWorktrees: new Set(["/tmp/x"]) }), makeDeps(record));
      expect(result).toEqual({ ran: false, kept: false, restored: false });
      const call = warnSpy.mock.calls.find(
        (c) => c[1] === "skipping best-effort pass — worktree may hold an unreverted mutation",
      );
      return call?.[2];
    });

    expect(data).toEqual({ storyId: "us-001", workdir: "/tmp/x" });
  });
});
