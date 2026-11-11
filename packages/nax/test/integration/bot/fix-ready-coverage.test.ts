/** US-014: the bot's own coverage record for the current head holds a workflow draft ready step. */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDeps, makeBotFixDraftEnv, makeTestRuntime } from "@test/helpers";
import { COVERAGE_RECORD_KEY, type CoverageRecord, renderCoverageRecord } from "@/bot/coverage-record";
import { _fixReportDeps } from "@/bot/fix-report";
import { _botFixDeps, runBotFix } from "@/bot/fix-run";
import type { RecordRulingsOutcome } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, withNaxBotMarker } from "@/forge";

const HEAD = "abcdef1234567890abcdef1234567890abcdef12";
const OTHER_HEAD = "fedcba0987654321fedcba0987654321fedcba09";
const BOT = "bot";
const green = { outcome: "green", detail: "passed" } as const;

const thread = { id: "1", replyTo: "1", resolved: false, outdated: false, comments: [] };
const item = { key: "w-B3.12345678", itemId: "B3", kind: "finding", thread, replies: [] };
const empty: RecordRulingsOutcome = { index: { keys: [] }, recorded: [], settled: [], open: [], asked: 0, failed: 0 };
const complete: RecordRulingsOutcome = {
  ...empty,
  index: { keys: [item.key] },
  settled: [
    {
      ...item,
      ruling: {
        itemKey: item.key,
        itemId: item.itemId,
        disposition: "fixed" as const,
        reason: "done",
        sha: "abcdef12",
        by: "writer",
      },
    },
  ],
};

const original = { ..._botFixDeps };
const reportOriginal = { ..._fixReportDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];

afterEach(async () => {
  Object.assign(_botFixDeps, original);
  Object.assign(_fixReportDeps, reportOriginal);
  mock.restore();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

/** A forge-marked top-level comment carrying a coverage record for `headSha`. */
function coverageComment(author: string, headSha: string, uncovered: string[]): PrComment {
  const record: CoverageRecord = { headSha, uncovered };
  return {
    id: "c1",
    kind: "comment",
    author,
    body: withNaxBotMarker(renderCoverageRecord(record), COVERAGE_RECORD_KEY),
    createdAt: "",
  };
}

/**
 * The ready-only run of a draft workflow PR, with `workflowReadyHold` and `readyStep` real: only the
 * forge reads the step performs are stubbed.
 */
function fixture(comments: PrComment[] = []) {
  const base = makeBotFixDraftEnv({ body: NAX_WORKFLOW_PR_MARKER });
  const env = { ...base, info: { ...base.info, headSha: HEAD } };
  const runtime = makeTestRuntime({ config: env.config });
  runtimes.push(runtime);
  Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), { recordPrRulings: async () => empty });

  spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
  spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
  spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
  const notes = spyOn(_fixReportDeps, "listPrComments").mockResolvedValue(comments);
  spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue(complete);
  spyOn(_fixReportDeps, "readHeadGateNames").mockResolvedValue([]);
  spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
  const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(green);
  spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
  spyOn(_fixReportDeps, "editComment").mockImplementation(async () => {});
  spyOn(_botFixDeps.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  return { env, notes, wait };
}

/** Run the ready-only path and return the fix state it ended in. */
async function readyOnly() {
  const result = await runBotFix({ dir: "/repo", pr: 42, profiles: [], interactive: false, readyOnly: true });
  if (result.outcome === "refused") throw new Error(`refused: ${result.reason}`);
  return result;
}

describe("bot fix ready-only with a coverage record", () => {
  test("AC-8 the bot's own record naming an unread file at the head holds the draft", async () => {
    const f = fixture([coverageComment(BOT, HEAD, ["src/a.ts"])]);
    const result = await readyOnly();
    expect(result.markedReady).toBe(false);
    expect(result.readyHeld).toStartWith("bot review did not read 1 required file(s)");
    expect(result.readyHeld).toContain("src/a.ts");
    expect(f.wait).not.toHaveBeenCalled();
  });

  test("AC-9 a w-coverage comment that does not parse holds nothing", async () => {
    const body = withNaxBotMarker("Review coverage, honestly", COVERAGE_RECORD_KEY);
    const f = fixture([{ id: "c1", kind: "comment", author: BOT, body, createdAt: "" }]);
    const result = await readyOnly();
    expect(result.markedReady).toBe(true);
    expect(result.readyHeld).toBeUndefined();
    expect(f.wait).toHaveBeenCalledTimes(1);
  });

  test("AC-10 another author's w-coverage comment is ignored", async () => {
    const f = fixture([coverageComment("mallory", HEAD, ["src/a.ts"])]);
    const result = await readyOnly();
    expect(result.markedReady).toBe(true);
    expect(result.readyHeld).toBeUndefined();
    expect(f.wait).toHaveBeenCalledTimes(1);
  });

  test("a record published only after CI still holds, so the reread reads it too", async () => {
    const f = fixture([]);
    f.notes.mockResolvedValueOnce([]).mockResolvedValue([coverageComment(BOT, HEAD, ["src/a.ts", "src/b.ts"])]);
    const result = await readyOnly();
    expect(result.markedReady).toBe(false);
    expect(result.readyHeld).toStartWith("bot review did not read 2 required file(s)");
    expect(f.wait).toHaveBeenCalledTimes(1);
  });

  test("a record for another head holds nothing", async () => {
    const f = fixture([coverageComment(BOT, OTHER_HEAD, ["src/a.ts"])]);
    const result = await readyOnly();
    expect(result.markedReady).toBe(true);
    expect(f.wait).toHaveBeenCalledTimes(1);
  });
});
