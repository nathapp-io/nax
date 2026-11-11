import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotReviewDeps, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import { COVERAGE_RECORD_KEY, parseCoverageRecord, renderCoverageRecord } from "@/bot/coverage-record";
import { _postDeps, postPrReview } from "@/bot/post";
import { _botReviewDeps, runBotReview } from "@/bot/review-run";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import {
  type ForgeDeps,
  type ForgeRunResult,
  NAX_WORKFLOW_PR_MARKER,
  type PrComment,
  type PrInfo,
  parseNaxBotMarker,
  withNaxBotMarker,
} from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import type { PrReviewVerdict } from "@/operations";

const original = { ..._botReviewDeps };
const config = makeNaxConfig();
const review_ = { dir: "/repo", pr: 7, profiles: [], interactive: false };
/** The reviewed head; a full sha, as the forge reports it. */
const head = "a".repeat(40);
const reviewedBase = "b".repeat(40);
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
let logger: ReturnType<typeof initLogger>;
let info: PrInfo;
let issueComments: PrComment[];
let calls: string[][];
let refuse: (argv: string[]) => boolean;
let outcome: RecordRulingsOutcome;
const review = mock<typeof _botReviewDeps.runPrReview>(async () => ({ ran: true, verdict }));
const record = mock<typeof recordPrRulings>(async () => outcome);
const ancestor = mock(async (_dir: string, _ancestor: string, _head: string) => true);
/** The review artifact is written by a later story's concern; keep it off the disk here. */
const originalArtifact = _postDeps.writeArtifact;
const writeArtifact = mock(async () => 1);
const forge: ForgeDeps = {
  async run(argv, options): Promise<ForgeRunResult> {
    expect(options.cwd).toBe("/repo");
    calls.push(argv);
    return refuse(argv)
      ? { exitCode: 1, stdout: "", stderr: "forge refused the write" }
      : { exitCode: 0, stdout: '{"id":99}', stderr: "" };
  },
  readText: async () => null,
};
/** The real post step, with a recording forge in place of gh/glab. */
const post = mock<typeof _botReviewDeps.postPrReview>(async (postInput) => postPrReview({ ...postInput, deps: forge }));

beforeEach(() => {
  logger = initLogger({ level: "silent" });
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
  issueComments = [];
  calls = [];
  refuse = () => false;
  outcome = { recorded: [], settled: [], open: [], asked: 0, failed: 0 };
  runtime = makeTestRuntime({ config });
  for (const fn of [review, record, ancestor, post, writeArtifact]) fn.mockClear();
  review.mockImplementation(async () => ({ ran: true, verdict }));
  record.mockImplementation(async () => outcome);
  ancestor.mockImplementation(async () => true);
  _postDeps.writeArtifact = writeArtifact;
  Object.assign(_botReviewDeps, {
    ...makeBotReviewDeps({ config, runtime, info: () => info }),
    listPrComments: async () => issueComments,
    isAncestor: ancestor,
    recordPrRulings: record,
    runPrReview: review,
    postPrReview: post,
    writeJson: async () => {},
  });
});
afterEach(async () => {
  Object.assign(_botReviewDeps, original);
  _postDeps.writeArtifact = originalArtifact;
  await runtime.close();
  resetLogger();
});

function bodyOf(argv: readonly string[]): string {
  const arg = argv.find((value) => value.startsWith("body="));
  return arg === undefined ? "" : arg.slice("body=".length);
}

/** Every forge write whose body reads back as a coverage record, in the order they were made. */
function coverageWrites(): string[][] {
  return calls.filter((argv) => parseCoverageRecord(bodyOf(argv)) !== null);
}

function coverageRecords(): ReturnType<typeof parseCoverageRecord>[] {
  return coverageWrites().map((argv) => parseCoverageRecord(bodyOf(argv)));
}

function posted(): string[][] {
  return calls.filter((argv) => argv.includes("POST"));
}

function summaryBody(): string {
  const body = calls.map(bodyOf).find((candidate) => parseNaxBotMarker(candidate)?.key === "summary");
  if (body === undefined) throw new Error("no summary comment was written");
  return body;
}

function unreadLines(body: string): string[] {
  return body.split("\n").filter((line) => line.startsWith("Not read by the review:"));
}

/** An existing coverage record the bot posted on an earlier review. */
function existingRecord(): PrComment {
  return {
    id: "55",
    kind: "comment",
    author: "bot",
    body: withNaxBotMarker(
      renderCoverageRecord({ headSha: reviewedBase, uncovered: ["src/old.ts"] }),
      COVERAGE_RECORD_KEY,
    ),
    createdAt: "yesterday",
  };
}

describe("runBotReview coverage record", () => {
  test("AC-7 a workflow PR posts the record of what the review did not read", async () => {
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    expect(await runBotReview(review_)).toMatchObject({ outcome: "posted" });
    expect(coverageRecords()).toEqual([{ headSha: head, uncovered: ["src/a.ts"] }]);
  });

  test("AC-8 an existing record is edited in place and no new one is posted", async () => {
    issueComments = [existingRecord()];
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    await runBotReview(review_);
    expect(coverageWrites()).toHaveLength(1);
    expect(coverageWrites()[0]).toContain("PATCH");
    expect(posted().filter((argv) => parseCoverageRecord(bodyOf(argv)) !== null)).toEqual([]);
    expect(coverageRecords()).toEqual([{ headSha: head, uncovered: ["src/a.ts"] }]);
  });

  test("AC-9 a PR without the workflow marker gets no record", async () => {
    info = { ...info, body: "Closes #7" };
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    expect(await runBotReview(review_)).toMatchObject({ outcome: "posted" });
    expect(coverageWrites()).toEqual([]);
    // The summary still posts, so the marker is what suppressed the record and not a failed run.
    expect(summaryBody()).toContain("Not read by the review: `src/a.ts`");
  });

  test("AC-10 a conversation-only run posts no record", async () => {
    outcome = {
      index: { reviewedHead: head, reviewedBase, keys: [] },
      recorded: [],
      settled: [],
      open: [],
      asked: 0,
      failed: 0,
    };
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    expect(await runBotReview(review_)).toMatchObject({ outcome: "posted" });
    // The premise: this really is the conversation-only scope, with unread files to record.
    expect(post.mock.calls[0]?.[0].scope).toBe("conversation-only");
    expect(coverageWrites()).toEqual([]);
  });

  test("the brief's static-mode arm: an untrusted review posts no record", async () => {
    _botReviewDeps.classifyPrTrust = async () => ({ trusted: false, headSha: head, reasons: ["fork"] });
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    expect(await runBotReview(review_)).toMatchObject({ outcome: "posted", staticMode: true });
    // The premise: a static review of a workflow PR, with unread files it could have recorded.
    expect(post.mock.calls[0]?.[0]).toMatchObject({ staticMode: true, unreadFiles: ["src/a.ts"] });
    expect(coverageWrites()).toEqual([]);
  });

  test("AC-11 a rejected post is warned once and the review still reads as posted", async () => {
    const warn = spyOn(logger, "warn");
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    refuse = (argv) => argv.includes("POST") && parseCoverageRecord(bodyOf(argv)) !== null;
    expect(await runBotReview(review_)).toMatchObject({ outcome: "posted" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("bot-post", expect.any(String), expect.objectContaining({ pr: 7 }));
  });

  test("AC-12 a rejected edit is warned once and the review still reads as posted", async () => {
    const warn = spyOn(logger, "warn");
    issueComments = [existingRecord()];
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts"] }));
    refuse = (argv) => argv.includes("PATCH") && parseCoverageRecord(bodyOf(argv)) !== null;
    expect(await runBotReview(review_)).toMatchObject({ outcome: "posted" });
    expect(coverageWrites()).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("bot-post", expect.any(String), expect.objectContaining({ pr: 7 }));
  });

  test("AC-13 the summary's unread lines and the record's uncovered list agree", async () => {
    review.mockImplementation(async () => ({ ran: true, verdict, unreadFiles: ["src/a.ts", "src/b.ts"] }));
    await runBotReview(review_);
    const lines = unreadLines(summaryBody());
    expect(lines).toHaveLength(2);
    expect(coverageRecords()).toEqual([{ headSha: head, uncovered: ["src/a.ts", "src/b.ts"] }]);
    expect(coverageRecords()[0]?.uncovered).toHaveLength(lines.length);
  });

  test("AC-13 a review that read everything writes the empty record and no unread lines", async () => {
    await runBotReview(review_);
    expect(unreadLines(summaryBody())).toEqual([]);
    expect(coverageRecords()).toEqual([{ headSha: head, uncovered: [] }]);
  });
});
