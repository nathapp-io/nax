import { describe, expect, test } from "bun:test";
import type { RecordRulingsOutcome } from "@/bot/rulings";
import { workflowPrReadiness } from "@/bot/workflow-ready";

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

describe("workflowPrReadiness", () => {
  test.each([
    ["AC-1 absent", undefined, "rulings could not be read"],
    ["AC-2 no index", { ...empty, index: undefined }, "no nax item index on this PR"],
    ["AC-3 missing", { ...empty, index: { keys: ["w-_run:cv2.12345678"] } }, "1 item(s) without a thread: _run:cv2"],
    ["AC-4 open", { ...empty, index: { keys: [item.key] }, open: [{ ...item, kept: [] }] }, "1 open item(s): B3"],
  ])("%s", (_name, outcome, reason) => {
    expect(workflowPrReadiness({ outcome, ci: green })).toEqual({ ready: false, reason });
  });
  test("AC-5 settled but failed CI", () => {
    expect(workflowPrReadiness({ outcome: complete, ci: { outcome: "failed", detail: "test red" } })).toEqual({
      ready: false,
      reason: "CI failed: test red",
    });
  });
  test.each([
    ["AC-6 settled", complete],
    ["AC-7 empty", empty],
  ])("%s", (_name, outcome) => {
    expect(workflowPrReadiness({ outcome, ci: green })).toEqual({ ready: true });
  });
});

const advisorThread = { id: "2", replyTo: "2", resolved: false, outdated: false, comments: [] };

/** A confirmed advisor item still awaiting its `fix-<key>` reply — neither settled nor open. */
function confirmedWorkItem(itemId: string) {
  const key = `w-${itemId}.12345678`;
  return {
    key,
    itemId,
    kind: "advisor",
    thread: advisorThread,
    replies: [],
    ruling: { itemKey: key, itemId, disposition: "confirmed" as const, reason: "change X", by: "writer" },
  };
}

const d1 = confirmedWorkItem("D-1");
const d2 = confirmedWorkItem("D-2");
const HELD = "run nax bot review, then nax bot fix";

describe("workflowPrReadiness with confirmed advisor work", () => {
  test("AC-1 holds naming the outstanding confirmed item and the next step", () => {
    const outcome: RecordRulingsOutcome = { ...empty, index: { keys: [d1.key] }, confirmedWork: [d1] };
    expect(workflowPrReadiness({ outcome, ci: green })).toEqual({
      ready: false,
      reason: `1 confirmed advisor item(s) awaiting a fix: D-1; ${HELD}`,
    });
  });

  test("AC-2 names every confirmed item in confirmedWork order", () => {
    const outcome: RecordRulingsOutcome = { ...empty, index: { keys: [d1.key, d2.key] }, confirmedWork: [d1, d2] };
    expect(workflowPrReadiness({ outcome, ci: green })).toEqual({
      ready: false,
      reason: `2 confirmed advisor item(s) awaiting a fix: D-1, D-2; ${HELD}`,
    });
  });

  test("AC-2 keeps confirmedWork order rather than sorting the ids", () => {
    const outcome: RecordRulingsOutcome = { ...empty, index: { keys: [d1.key, d2.key] }, confirmedWork: [d2, d1] };
    expect(workflowPrReadiness({ outcome, ci: green })).toEqual({
      ready: false,
      reason: `2 confirmed advisor item(s) awaiting a fix: D-2, D-1; ${HELD}`,
    });
  });

  test("AC-3 keeps the open item reason when an item is also open", () => {
    const openItem = { ...item, key: "w-F-1.12345678", itemId: "F-1", kept: [] };
    const outcome: RecordRulingsOutcome = {
      ...empty,
      index: { keys: [d1.key, openItem.key] },
      open: [openItem],
      confirmedWork: [d1],
    };
    expect(workflowPrReadiness({ outcome, ci: green })).toEqual({ ready: false, reason: "1 open item(s): F-1" });
  });

  test("AC-4 holds on confirmed work rather than reporting a failing CI", () => {
    const outcome: RecordRulingsOutcome = { ...empty, index: { keys: [d1.key] }, confirmedWork: [d1] };
    expect(workflowPrReadiness({ outcome, ci: { outcome: "failed", detail: "test red" } })).toEqual({
      ready: false,
      reason: `1 confirmed advisor item(s) awaiting a fix: D-1; ${HELD}`,
    });
  });

  test("AC-5 counts a confirmedWork key as a thread and never reports it missing", () => {
    const outcome: RecordRulingsOutcome = {
      ...empty,
      index: { keys: [item.key, d1.key] },
      settled: [settled],
      confirmedWork: [d1],
    };
    const result = workflowPrReadiness({ outcome, ci: green });
    expect(result).toEqual({ ready: false, reason: `1 confirmed advisor item(s) awaiting a fix: D-1; ${HELD}` });
    expect(result.ready ? "" : result.reason).not.toContain("without a thread");
  });

  test("AC-6 readies when no confirmed work is outstanding", () => {
    const other = { key: "w-B4.87654321", itemId: "B4", kind: "finding", thread, replies: [] };
    const otherSettled = { ...other, ruling: { ...settled.ruling, itemKey: other.key, itemId: "B4" } };
    const outcome: RecordRulingsOutcome = {
      ...empty,
      index: { keys: [item.key, other.key] },
      settled: [settled, otherSettled],
    };
    expect(outcome.confirmedWork).toBeUndefined();
    expect(workflowPrReadiness({ outcome, ci: green })).toEqual({ ready: true });
  });
});
