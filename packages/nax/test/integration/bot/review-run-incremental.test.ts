import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotReviewDeps, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import { _reviewStepDeps, type runPrReview } from "@/bot/review-step";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, type PrInfo } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import type { PrReviewVerdict } from "@/operations";
import { _workflowDeps } from "@/workflow/step-context";

const original = { ..._botReviewDeps };
const workflow = { ..._workflowDeps };
const step = { ..._reviewStepDeps };
const config = makeNaxConfig({ bot: { models: { rulings: "balanced" } } });
const input = { dir: "/repo", pr: 7, profiles: [], interactive: false };
const verdict: PrReviewVerdict = {
  intent: "pass",
  quality: "approved",
  findings: [],
  threads: [],
  comments: [],
  cannotVerify: [],
  inspectedFiles: [],
};
let runtime: ReturnType<typeof makeTestRuntime>;
let info: PrInfo;
let outcome: RecordRulingsOutcome;
const head = "a".repeat(40);
const base = "b".repeat(40);
const ancestor = mock(async (_dir: string, _ancestor: string, _head: string) => true);
const record = mock<typeof recordPrRulings>(async () => {
  return outcome;
});
const review = mock<typeof runPrReview>(async () => {
  return { ran: true, verdict };
});
const post = mock<typeof _botReviewDeps.postPrReview>(async () => ({
  earlierAnswered: 0,
  inlineFindings: 0,
  threadsAnswered: 0,
  commentsAnswered: 0,
  offLine: 0,
  failed: 0,
}));

beforeEach(() => {
  initLogger({ level: "silent" });
  outcome = {
    index: { reviewedHead: head, reviewedBase: base, keys: [] },
    recorded: [],
    settled: [],
    open: [],
    asked: 0,
    failed: 0,
  };
  ancestor.mockClear();
  ancestor.mockImplementation(async () => true);
  info = {
    number: 7,
    title: "PR",
    body: NAX_WORKFLOW_PR_MARKER,
    url: "url",
    state: "open",
    draft: true,
    author: { login: "writer" },
    baseRef: "main",
    headRef: "topic",
    headSha: "a".repeat(40),
    crossRepo: false,
  };
  runtime = makeTestRuntime({ config });
  record.mockClear();
  record.mockImplementation(async () => {
    return outcome;
  });
  review.mockClear();
  post.mockClear();
  Object.assign(_botReviewDeps, {
    isAncestor: ancestor,
    ...makeBotReviewDeps({ config, runtime, info: () => info }),
    recordPrRulings: record,
    runPrReview: review,
    postPrReview: post,
    writeJson: async () => {},
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  Object.assign(_workflowDeps, workflow);
  Object.assign(_reviewStepDeps, step);
  await runtime.close();
  resetLogger();
});

function configureFallback(reason: string): void {
  if (reason === "head") ancestor.mockImplementation(async () => false);
  if (reason === "base") ancestor.mockImplementation(async (_dir, sha) => sha !== base);
  if (reason === "throw")
    ancestor.mockImplementation(async () => {
      throw new Error("git failed");
    });
  if (reason === "none") outcome = { ...outcome, index: { keys: [] } };
  if (reason === "missing") outcome = { ...outcome, index: undefined };
  if (reason === "missing base") outcome = { ...outcome, index: { reviewedHead: head, keys: [] } };
  if (reason === "malformed head")
    outcome = { ...outcome, index: { reviewedHead: "bad", reviewedBase: base, keys: [] } };
  if (reason === "newline head")
    outcome = { ...outcome, index: { reviewedHead: `${head}\n`, reviewedBase: base, keys: [] } };
  if (reason === "malformed base")
    outcome = { ...outcome, index: { reviewedHead: head, reviewedBase: "bad", keys: [] } };
  if (reason === "unmarked") info = { ...info, body: "ordinary" };
  if (reason === "fork" || reason === "no write access")
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: head, reasons: [reason] });
}

describe("runBotReview incremental workflow review", () => {
  test("AC-1 same head uses conversation only after checking both ancestry pairs", async () => {
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1]).toMatchObject({ conversationOnly: true });
    expect(ancestor.mock.calls).toEqual([
      ["/checkout", head, head],
      ["/checkout", base, "merge"],
    ]);
  });
  test("AC-2 later head uses reviewed head after checking both ancestry pairs", async () => {
    info = { ...info, headSha: "c".repeat(40) };
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1]).toMatchObject({ rangeBase: head });
    expect(review.mock.calls[0]?.[1].conversationOnly).not.toBe(true);
    expect(ancestor.mock.calls).toEqual([
      ["/checkout", head, info.headSha],
      ["/checkout", base, "merge"],
    ]);
  });
  test.each([
    "head",
    "base",
    "throw",
    "none",
    "missing",
    "missing base",
    "malformed head",
    "newline head",
    "malformed base",
    "unmarked",
    "fork",
    "no write access",
  ])("full review fallback: %s", async (reason) => {
    configureFallback(reason);
    await runBotReview(input);
    expect(review.mock.calls[0]?.[1]).toMatchObject({ rangeBase: "merge" });
    expect(review.mock.calls[0]?.[1].conversationOnly).not.toBe(true);
    if (["unmarked", "fork", "no write access"].includes(reason)) {
      expect(record).not.toHaveBeenCalled();
      expect(ancestor).not.toHaveBeenCalled();
    }
    if (["fork", "no write access"].includes(reason)) expect(review.mock.calls[0]?.[1].staticMode).toBe(true);
  });
});
