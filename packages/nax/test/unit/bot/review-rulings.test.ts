import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig } from "@test/helpers";
import { CallerRecordingError } from "@/bot/caller-rulings";
import { readReviewRulings } from "@/bot/review-rulings";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { resolveWorkflowConfig } from "@/config";
import { NAX_WORKFLOW_PR_MARKER } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
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
