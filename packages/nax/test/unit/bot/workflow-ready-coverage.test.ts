/** US-014: the bot review's own coverage record for the current head holds a workflow draft. */
import { describe, expect, test } from "bun:test";
import type { CoverageRecord } from "@/bot/coverage-record";
import type { RecordRulingsOutcome } from "@/bot/rulings";
import { type WorkflowPrReadiness, workflowPrReadiness } from "@/bot/workflow-ready";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const HEAD7 = HEAD.slice(0, 7);
const OTHER_HEAD = "fedcba0987654321fedcba0987654321fedcba09";

const thread = { id: "1", replyTo: "1", resolved: false, outdated: false, comments: [] };
const item = { key: "w-B3.12345678", itemId: "B3", kind: "finding", thread, replies: [] };
const settled = {
  ...item,
  ruling: {
    itemKey: item.key,
    itemId: item.itemId,
    disposition: "fixed" as const,
    reason: "done",
    sha: "abcdef12",
    by: "writer",
  },
};
const empty: RecordRulingsOutcome = { index: { keys: [] }, recorded: [], settled: [], open: [], asked: 0, failed: 0 };
const complete: RecordRulingsOutcome = { ...empty, index: { keys: [item.key] }, settled: [settled] };
const green = { outcome: "green" as const, detail: "passed" };
const failed = { outcome: "failed" as const, detail: "test red" };

function record(uncovered: readonly string[], headSha = HEAD): CoverageRecord {
  return { headSha, uncovered };
}

function reasonOf(result: WorkflowPrReadiness): string {
  return result.ready ? "" : result.reason;
}

describe("workflowPrReadiness with a current-head coverage record", () => {
  test("AC-1 holds naming the unread count, the short head and the files", () => {
    const result = workflowPrReadiness({
      outcome: complete,
      ci: green,
      headSha: HEAD,
      coverage: record(["a.ts", "b.ts"]),
    });
    expect(result.ready).toBe(false);
    expect(reasonOf(result)).toStartWith(`bot review did not read 2 required file(s) at ${HEAD7}: a.ts, b.ts`);
  });

  test("AC-2 the hold names the next step", () => {
    const result = workflowPrReadiness({ outcome: complete, ci: green, headSha: HEAD, coverage: record(["a.ts"]) });
    expect(reasonOf(result)).toEndWith("run nax bot review");
  });

  test("AC-3 lists the first five files and counts the rest", () => {
    const uncovered = ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts", "f6.ts", "f7.ts"];
    const result = workflowPrReadiness({ outcome: complete, ci: green, headSha: HEAD, coverage: record(uncovered) });
    const reason = reasonOf(result);
    expect(reason).toStartWith(
      `bot review did not read 7 required file(s) at ${HEAD7}: f1.ts, f2.ts, f3.ts, f4.ts, f5.ts, +2 more`,
    );
    expect(reason).not.toContain("f6.ts");
    expect(reason).not.toContain("f7.ts");
  });

  test("AC-3 five files are all listed, with no remainder note", () => {
    const uncovered = ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"];
    const result = workflowPrReadiness({ outcome: complete, ci: green, headSha: HEAD, coverage: record(uncovered) });
    const reason = reasonOf(result);
    expect(reason).toStartWith(
      `bot review did not read 5 required file(s) at ${HEAD7}: f1.ts, f2.ts, f3.ts, f4.ts, f5.ts`,
    );
    expect(reason).not.toContain("more");
  });

  test("AC-4 a record for another head does not hold", () => {
    const result = workflowPrReadiness({
      outcome: complete,
      ci: green,
      headSha: HEAD,
      coverage: record(["a.ts"], OTHER_HEAD),
    });
    expect(result).toEqual({ ready: true });
  });

  test("AC-5 a record naming no unread file does not hold", () => {
    const result = workflowPrReadiness({ outcome: complete, ci: green, headSha: HEAD, coverage: record([]) });
    expect(result).toEqual({ ready: true });
  });

  test("AC-6 an open item is named ahead of the coverage", () => {
    const open = { ...item, kept: [] };
    const outcome: RecordRulingsOutcome = { ...empty, index: { keys: [item.key] }, open: [open] };
    const result = workflowPrReadiness({ outcome, ci: green, headSha: HEAD, coverage: record(["a.ts"]) });
    expect(result).toEqual({ ready: false, reason: "1 open item(s): B3" });
  });

  test("AC-7 the coverage reason comes before a failed CI", () => {
    const result = workflowPrReadiness({
      outcome: complete,
      ci: failed,
      headSha: HEAD,
      coverage: record(["a.ts", "b.ts"]),
    });
    expect(reasonOf(result)).toStartWith(`bot review did not read 2 required file(s) at ${HEAD7}: a.ts, b.ts`);
    expect(reasonOf(result)).not.toContain("CI failed");
  });
});
