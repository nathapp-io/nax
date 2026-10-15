/** What the story loop says in the run log (nax#2491 P2): step labels, review verdicts, fix rounds. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { addSink, initLogger, type LogEntry, resetLogger } from "@/logger";
import { defaultWorkflowAdvisor } from "@/workflow/advisor";
import { newStoryRecord } from "@/workflow/result";
import { runStoryLoop, type StoryLoopEnv } from "@/workflow/story-loop";
import type { GateRunResult, ReReviewVerdict, StoryReviewVerdict } from "@/workflow/types";

const GREEN: GateRunResult = { red: false, states: { lint: "green" }, findings: [] };
const DONE = {
  reply: { status: "DONE" as const, commits: [], testSummary: "", interrupted: false },
  autoCommitted: false,
};
const finding = (issue: string) => ({ kind: "spec" as const, severity: "important" as const, issue });
const review = (...issues: string[]): StoryReviewVerdict => ({
  spec: issues.length > 0 ? "fail" : "pass",
  quality: issues.length > 0 ? "changes" : "approved",
  findings: issues.map(finding),
  cannotVerify: [],
  inspectedFiles: [],
});

let logs: LogEntry[] = [];
beforeEach(() => {
  resetLogger();
  logs = [];
  initLogger({ level: "silent" });
  addSink((entry) => logs.push(entry));
});
afterEach(() => resetLogger());

function envFor(verdict: StoryReviewVerdict, reReviews: ReReviewVerdict[]): StoryLoopEnv {
  const queue = [...reReviews];
  let record = newStoryRecord("US-003", 5, "t");
  return {
    storyId: "US-003",
    maxFixRounds: 5,
    advisor: defaultWorkflowAdvisor,
    resume: null,
    sink: {
      update: async (patch) => {
        record = { ...record, ...patch };
      },
      ledger: async () => {},
    },
    steps: {
      implement: async () => DONE,
      gates: async () => GREEN,
      fullSuite: async () => GREEN,
      storyReview: async () => ({ ran: true, verdict }),
      reReview: async () => ({ ran: true, verdict: queue.shift() ?? { verdicts: [], newFindings: [] } }),
      head: async () => "h",
      uncommitted: async () => [],
      costExceeded: () => false,
    },
  };
}

const lines = () => logs.filter((e) => e.stage === "workflow").map((e) => e.message);

describe("story loop run log", () => {
  test("labels each step and logs the review verdict with its finding count", async () => {
    await runStoryLoop(envFor(review("gap one", "gap two", "gap three"), []));
    const out = lines();
    expect(out).toContain("US-003 implementer start");
    expect(out).toContain("US-003 story-review start");
    const verdict = out.find((l) => l.startsWith("US-003 story-review: "));
    expect(verdict).toMatch(
      /^US-003 story-review: spec fail, quality changes - 3 important \(F1 gap one, F2 gap two, F3 gap three\) {2}/,
    );
  });

  test("a clean review is one line saying so", async () => {
    await runStoryLoop(envFor(review(), []));
    expect(lines().find((l) => l.startsWith("US-003 story-review: "))).toMatch(
      /^US-003 story-review: spec pass, quality approved - no findings {2}/,
    );
  });

  test("fix rounds and re-reviews are labelled with their round and the per-finding result", async () => {
    const reReviews: ReReviewVerdict[] = [
      {
        verdicts: [
          { id: "F1", addressed: true, note: "" },
          { id: "F2", addressed: false, note: "" },
        ],
        newFindings: [],
      },
      {
        verdicts: [{ id: "F2", addressed: true, note: "" }],
        newFindings: [],
      },
    ];
    await runStoryLoop(envFor(review("a", "b"), reReviews));
    const out = lines();
    expect(out).toContain("US-003 fix r1 start");
    expect(out).toContain("US-003 re-review r1 start");
    expect(out.find((l) => l.startsWith("US-003 re-review r1: "))).toMatch(
      /^US-003 re-review r1: F1 addressed, F2 NOT addressed {2}/,
    );
    expect(out.find((l) => l.startsWith("US-003 re-review r2: "))).toMatch(/^US-003 re-review r2: F2 addressed {2}/);
    expect(out.some((l) => l.startsWith("US-003 fix r2"))).toBe(true);
  });

  // US-004 (nax#2524): a residual verdict says PARTIAL, on the same line and in the same shape as before.
  test("a PARTIAL verdict on the re-review line names the verdict (AC-20)", async () => {
    await runStoryLoop(
      envFor(review("a"), [
        {
          verdicts: [{ id: "F1", addressed: false, note: "", residual: { issue: "still open" } }],
          newFindings: [],
        },
      ]),
    );
    expect(lines().find((l) => l.startsWith("US-003 re-review r1: "))).toMatch(/^US-003 re-review r1: F1 PARTIAL {2}/);
  });

  test("every line carries storyId as its first data key", async () => {
    await runStoryLoop(envFor(review("a"), [{ verdicts: [{ id: "F1", addressed: true, note: "" }], newFindings: [] }]));
    const workflow = logs.filter((e) => e.stage === "workflow");
    expect(workflow.length).toBeGreaterThan(0);
    for (const e of workflow) expect(Object.keys(e.data ?? {})[0]).toBe("storyId");
  });

  describe("one line per fact (M4)", () => {
    test("a skipped review and the story close reach the ledger without the log mirroring them", async () => {
      const env = envFor(review(), []);
      const ledgerCalls: { text: string; mirror: boolean | undefined }[] = [];
      const run: StoryLoopEnv = {
        ...env,
        sink: {
          ...env.sink,
          ledger: async (text, options) => void ledgerCalls.push({ text, mirror: options?.mirror }),
        },
        steps: { ...env.steps, storyReview: async () => ({ ran: false, why: "timeout" }) },
      };
      await runStoryLoop(run);
      const skipped = ledgerCalls.find((c) => c.text.startsWith("review-skipped"));
      const end = ledgerCalls.find((c) => c.text.startsWith("complete"));
      expect(skipped?.mirror).toBe(false);
      expect(end?.mirror).toBe(false);
    });
  });
});
