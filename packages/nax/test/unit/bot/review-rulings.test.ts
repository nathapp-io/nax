import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig } from "@test/helpers";
import { CallerRecordingError } from "@/bot/caller-rulings";
import type { PrCheckout } from "@/bot/checkout";
import type { PatchEquivalent } from "@/bot/review-rebase";
import { readReviewRulings, reviewRange } from "@/bot/review-rulings";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { resolveWorkflowConfig } from "@/config";
import { NAX_WORKFLOW_PR_MARKER } from "@/forge";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import type { PrStepContext } from "@/workflow/branch-step-context";

const config = makeNaxConfig();
let ctx: PrStepContext;
const ruling = {
  itemKey: "w-_run:cv1.12345678",
  itemId: "_run:cv1",
  disposition: "verified",
  reason: "checked",
  by: "alice",
} as const;
const settled = {
  key: ruling.itemKey,
  itemId: ruling.itemId,
  kind: "cannot-verify",
  ruling,
  replies: [],
  thread: { id: "T1", replyTo: "C1", resolved: true, outdated: false, comments: [] },
};
const outcome: RecordRulingsOutcome = {
  recorded: [ruling],
  settled: [settled],
  index: { keys: [ruling.itemKey] },
  open: [],
  asked: 0,
  failed: 0,
};
function input(): Parameters<typeof readReviewRulings>[0] {
  return {
    ctx,
    staticMode: false,
    ref: { forge: "github", host: "test", repo: "o/r", number: 7 } as const,
    info: {
      number: 7,
      title: "PR",
      body: NAX_WORKFLOW_PR_MARKER,
      url: "url",
      state: "open",
      draft: true,
      author: { login: "alice" },
      baseRef: "main",
      headRef: "topic",
      headSha: "a".repeat(40),
      crossRepo: false,
    } as const,
    login: "bot",
    threads: [],
    comments: [],
    cwd: "/repo",
    deps: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      readText: async () => "",
    },
  };
}
beforeEach(() => {
  initLogger({ level: "silent" });
  ctx = {
    config,
    workflow: resolveWorkflowConfig(config),
    callCtx: makeMockCallContext(),
    feature: "demo",
    projectDir: "/repo",
    runDir: "/artifacts",
    reportPath: "/report",
    packageDirs: [],
    dryRun: false,
    pr: { forge: "github", number: 7, base: "base", head: "head" },
  };
});
afterEach(async () => {
  await ctx.callCtx.runtime.close();
  resetLogger();
});

describe("readReviewRulings", () => {
  test("US-007 AC-1 maps recorded rulings and indexed settlement counts", async () => {
    const record = mock<typeof recordPrRulings>(async () => outcome);
    expect(await readReviewRulings(input(), record)).toMatchObject({
      itemStatus: {
        recorded: [{ id: "_run:cv1", disposition: "verified", by: "alice" }],
        open: 0,
        total: 1,
      },
    });
    expect(record).toHaveBeenCalledTimes(1);
  });
  test("counts only settled keys in the index, once", async () => {
    const record = mock<typeof recordPrRulings>(async () => ({
      ...outcome,
      index: { keys: [ruling.itemKey, "missing"] },
      settled: [settled, settled, { ...settled, key: "unindexed" }],
    }));
    expect(await readReviewRulings(input(), record)).toMatchObject({ itemStatus: { open: 1, total: 2 } });
  });
  test("US-007 AC-2 omits status without an index", async () => {
    const { index: _index, ...noIndex } = outcome;
    expect(await readReviewRulings(input(), async () => noIndex)).not.toHaveProperty("itemStatus");
  });
  test("US-007 AC-12 returns no invented counts on recorder failure", async () => {
    expect(
      await readReviewRulings(input(), async () => {
        throw new Error("recorder unavailable");
      }),
    ).toEqual({});
  });
  test("static mode skips the recorder", async () => {
    const record = mock<typeof recordPrRulings>(async () => outcome);
    expect(await readReviewRulings({ ...input(), staticMode: true }, record)).toEqual({});
    expect(record).not.toHaveBeenCalled();
  });

  describe("caller rulings", () => {
    const file = {
      version: 1 as const,
      headSha: "a".repeat(40),
      rulings: [{ item: "D-1", ruling: "confirm", by: "orch", at: "2026-01-02T00:00:00Z" }],
    };
    test("an untrusted PR ignores the whole file and never records", async () => {
      const record = mock<typeof recordPrRulings>(async () => outcome);
      const result = await readReviewRulings({ ...input(), staticMode: true, callerRulings: file }, record);
      expect(result).toEqual({ callerRulings: { applied: [], skipped: [], ignored: "untrusted-pr" } });
      expect(record).not.toHaveBeenCalled();
    });
    test("a head mismatch applies nothing but still records thread rulings", async () => {
      const record = mock<typeof recordPrRulings>(async () => outcome);
      const stale = { ...file, headSha: "b".repeat(40) };
      const result = await readReviewRulings({ ...input(), callerRulings: stale }, record);
      expect(result.callerRulings).toEqual({ applied: [], skipped: [], ignored: "head-mismatch" });
      expect(record.mock.calls[0]?.[0]).not.toHaveProperty("callerRulings");
      expect(result.itemStatus).toBeDefined();
    });
    test("a matching head passes the entries to the recorder and returns its report", async () => {
      const report = { applied: [{ item: "D-1", disposition: "confirmed" as const }], skipped: [] };
      const record = mock<typeof recordPrRulings>(async () => ({ ...outcome, callerRulings: report }));
      const result = await readReviewRulings({ ...input(), callerRulings: file }, record);
      expect(record.mock.calls[0]?.[0].callerRulings).toEqual(file.rulings);
      expect(result.callerRulings).toEqual(report);
    });
    test("a PR without the workflow marker skips every entry", async () => {
      const base = input();
      const plain = { ...base, info: { ...base.info, body: "plain" }, callerRulings: file };
      const result = await readReviewRulings(
        plain,
        mock<typeof recordPrRulings>(async () => outcome),
      );
      expect(result.callerRulings).toEqual({ applied: [], skipped: [{ item: "D-1", reason: "unknown-item" }] });
    });
    test("omits the report entirely without a file", async () => {
      const result = await readReviewRulings(
        input(),
        mock<typeof recordPrRulings>(async () => outcome),
      );
      expect(result).not.toHaveProperty("callerRulings");
    });
    test("a recorder failure without progress marks every entry recorder-failed", async () => {
      const result = await readReviewRulings({ ...input(), callerRulings: file }, async () => {
        throw new Error("down");
      });
      expect(result.callerRulings?.skipped).toEqual([{ item: "D-1", reason: "recorder-failed" }]);
    });
    test("a recorder failure keeps the progress the recorder reported", async () => {
      const progress = { applied: [{ item: "D-1", disposition: "confirmed" as const }], skipped: [] };
      const result = await readReviewRulings({ ...input(), callerRulings: file }, async () => {
        throw new CallerRecordingError(new Error("down"), progress);
      });
      expect(result.callerRulings).toEqual(progress);
    });
  });
});

const REVIEWED_HEAD = "a".repeat(40);
const REVIEWED_BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const checkout: PrCheckout = {
  worktree: "/checkout",
  baseSha: "base",
  mergeBase: "d".repeat(40),
  snapshotDir: "/snapshot",
  hasBaseNax: true,
  changedFiles: [],
  dispose: async () => {},
};
const index = { keys: [], reviewedHead: REVIEWED_HEAD, reviewedBase: REVIEWED_BASE };
/** The head no longer descends from the reviewed head, but the reviewed base is contained. */
const rebasedAncestry = async (_dir: string, ancestor: string): Promise<boolean> => ancestor === REVIEWED_BASE;
const full = { rangeBase: checkout.mergeBase };

describe("reviewRange", () => {
  test("AC-1 conversation-only rebased range when the patch is unchanged", async () => {
    const equivalent = mock<PatchEquivalent>(async () => true);
    expect(await reviewRange({ index, checkout, head: HEAD }, rebasedAncestry, equivalent)).toEqual({
      rangeBase: checkout.mergeBase,
      conversationOnly: true,
      rebasedFrom: REVIEWED_HEAD,
    });
  });

  test("AC-2 compares the reviewed range with this head's own range", async () => {
    const equivalent = mock<PatchEquivalent>(async () => true);
    await reviewRange({ index, checkout, head: HEAD }, rebasedAncestry, equivalent);
    expect(equivalent).toHaveBeenCalledTimes(1);
    expect(equivalent.mock.calls[0]).toEqual([
      checkout.worktree,
      { base: REVIEWED_BASE, head: REVIEWED_HEAD },
      { base: checkout.mergeBase, head: HEAD },
    ]);
  });

  test("AC-3 a changed patch keeps the full range and names no rebase", async () => {
    const result = await reviewRange({ index, checkout, head: HEAD }, rebasedAncestry, async () => false);
    expect(result).toEqual(full);
    expect(Object.hasOwn(result, "rebasedFrom")).toBe(false);
  });

  test("AC-4 a reviewed base outside the merge base reviews everything and compares no patch", async () => {
    const equivalent = mock<PatchEquivalent>(async () => true);
    expect(await reviewRange({ index, checkout, head: HEAD }, async () => false, equivalent)).toEqual(full);
    expect(equivalent).not.toHaveBeenCalled();
  });

  test("AC-5 a rejected patch comparison warns and keeps the full range", async () => {
    const warnings: LogEntry[] = [];
    const stop = addSink((entry) => warnings.push(entry));
    try {
      const result = await reviewRange({ index, checkout, head: HEAD }, rebasedAncestry, async () => {
        throw new Error("git diff failed");
      });
      expect(result).toEqual(full);
    } finally {
      stop();
    }
    expect(warnings.some((entry) => entry.level === "warn" && entry.message.includes("patch"))).toBe(true);
  });

  test("AC-6 two arguments never compare patches and keep the full range", async () => {
    expect(await reviewRange({ index, checkout, head: HEAD }, rebasedAncestry)).toEqual(full);
  });

  test("AC-7 a head that descends from the reviewed head stays incremental and compares no patch", async () => {
    const equivalent = mock<PatchEquivalent>(async () => true);
    expect(await reviewRange({ index, checkout, head: HEAD }, async () => true, equivalent)).toEqual({
      rangeBase: REVIEWED_HEAD,
    });
    expect(equivalent).not.toHaveBeenCalled();
  });

  test("AC-20 an ancestry check that throws reviews everything", async () => {
    expect(
      await reviewRange({ index, checkout, head: HEAD }, async () => {
        throw new Error("missing object HEAD~1");
      }),
    ).toEqual(full);
  });
});
