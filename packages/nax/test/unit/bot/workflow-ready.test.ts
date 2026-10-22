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
