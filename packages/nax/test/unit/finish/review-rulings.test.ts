import { afterEach, describe, expect, test } from "bun:test";
import { emptyJudged, type FinishAdvisor } from "@/finish";
import { reconcileBefore } from "@/finish/review-rulings";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";

afterEach(() => resetLogger());

describe("reconcileBefore", () => {
  test("a rulingsInForce failure is logged and treated as no rulings", async () => {
    const warns: LogEntry[] = [];
    initLogger({ level: "info", headless: true, useChalk: false });
    addSink((entry) => warns.push(entry));
    const advise: FinishAdvisor = {
      judgedEnabled: false,
      approvalEnabled: false,
      judged: async () => emptyJudged(),
      approval: async () => ({ action: "approve", rationale: "r" }),
      commitLedger: async () => {},
      rulingsInForce: async () => {
        throw new Error("ledger unreadable");
      },
      reconcile: async () => ({ result: emptyJudged(), asked: 0 }),
    };
    const merged = { toFix: [], judged: [], contradictions: [] };
    const out = await reconcileBefore({ advise, assertNotAborted: () => {} }, merged);
    expect(out.merged).toEqual(merged);
    expect(out.asked).toBe(0);
    expect(warns.some((w) => w.level === "warn" && w.message.includes("rulings in force"))).toBe(true);
  });
});
