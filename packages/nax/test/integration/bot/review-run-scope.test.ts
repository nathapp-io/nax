import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeBotReviewDeps, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { _postDeps, type BotReviewArtifact, postPrReview as botPostPrReview } from "@/bot";
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
const full = { ...input, full: true };
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
/** The reviewed head the item index names; the checkout's merge base is "merge". */
const head = "a".repeat(40);
const base = "b".repeat(40);
const later = "c".repeat(40);
const ancestor = mock(async (_dir: string, _ancestor: string, _head: string) => true);
const record = mock<typeof recordPrRulings>(async () => outcome);
const review = mock<typeof runPrReview>(async () => ({ ran: true, verdict }));
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
    headSha: head,
    crossRepo: false,
  };
  runtime = makeTestRuntime({ config });
  record.mockClear();
  record.mockImplementation(async () => outcome);
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

function reviewInput(): Parameters<typeof runPrReview>[1] {
  const called = review.mock.calls[0]?.[1];
  if (called === undefined) throw new Error("runPrReview was not called");
  return called;
}

function postInput(): Parameters<typeof _botReviewDeps.postPrReview>[0] {
  const called = post.mock.calls[0]?.[0];
  if (called === undefined) throw new Error("postPrReview was not called");
  return called;
}

describe("runBotReview review scope", () => {
  test("AC-3 full reviews from the merge base even when the index names an ancestor head", async () => {
    info = { ...info, headSha: later };
    await runBotReview(full);
    expect(reviewInput().rangeBase).toBe("merge");
    expect(reviewInput().mergeBase).toBe("merge");
  });
  test("AC-4 full never asks whether the reviewed head is an ancestor", async () => {
    info = { ...info, headSha: later };
    await runBotReview(full);
    expect(ancestor).not.toHaveBeenCalled();
  });
  test("AC-5 full overrides the same-head conversation-only shortcut", async () => {
    await runBotReview(full);
    expect(reviewInput().conversationOnly).not.toBe(true);
    expect(reviewInput().rangeBase).toBe("merge");
  });
  test("AC-6 an incremental review posts its scope and the reviewed head as the since sha", async () => {
    info = { ...info, headSha: later };
    await runBotReview(input);
    expect(postInput()).toMatchObject({ scope: "incremental", incrementalSince: head });
  });
  test("AC-7 a full review posts scope full and no since sha", async () => {
    info = { ...info, headSha: later };
    await runBotReview(full);
    expect(postInput().scope).toBe("full");
    expect(Object.hasOwn(postInput(), "incrementalSince")).toBe(false);
  });
  test("AC-8 a same-head review posts the conversation-only scope", async () => {
    await runBotReview(input);
    expect(postInput().scope).toBe("conversation-only");
  });
});

describe("runBotReview reported quality (US-001)", () => {
  const writeArtifact = _postDeps.writeArtifact;
  const artifacts: BotReviewArtifact[] = [];
  /** The real post step, so the artifact and the summary read the same quality. */
  function realPost(): void {
    Object.assign(_botReviewDeps, {
      forge: { run: async () => ({ exitCode: 0, stdout: '{"id":1}', stderr: "" }), readText: async () => null },
      postPrReview: botPostPrReview,
    });
  }
  beforeEach(() => {
    artifacts.length = 0;
    _postDeps.writeArtifact = async (_path, artifact) => {
      artifacts.push(artifact);
      return 0;
    };
  });
  afterEach(() => {
    _postDeps.writeArtifact = writeArtifact;
  });
  test("AC-16/17 a conversation-only review writes and reports not-reviewed", async () => {
    realPost();
    const result = await runBotReview(input);
    if (result.outcome !== "posted") throw new Error(`not posted: ${result.reason}`);
    expect(artifacts.map((artifact) => artifact.quality)).toEqual(["not-reviewed"]);
    expect(result.quality).toBe("not-reviewed");
  });
  test("AC-18 a full review keeps the verdict's own quality", async () => {
    realPost();
    info = { ...info, headSha: later };
    const result = await runBotReview(full);
    if (result.outcome !== "posted") throw new Error(`not posted: ${result.reason}`);
    expect(artifacts.map((artifact) => artifact.quality)).toEqual(["approved"]);
    expect(result.quality).toBe("approved");
  });
});
