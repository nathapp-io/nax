import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { PostReviewInput } from "@/bot";
import * as bot from "@/bot";
import type { PrComment, PrThread } from "@/forge";

const comment: PrComment = { id: "12", kind: "thread", author: "alice", body: "Fix this", createdAt: "" };
const threads: PrThread[] = ["T1", "T2", "T3"].map((id, index) => ({
  id,
  replyTo: String(91 + index),
  resolved: false,
  outdated: false,
  comments: [comment],
}));
const verdicts = [
  { id: "T1", decision: "agree", reason: "Valid" },
  { id: "T2", decision: "handled", reason: "Done" },
] as const;
let input: PostReviewInput;
let stateDir: string;
let failEndpoint: string | undefined;
const run = mock(async (argv: string[], _opts: { cwd: string }) => {
  expect(await Bun.file(join(stateDir, "bot-review.json")).json()).toMatchObject({
    version: 1,
    headSha: "abc1234ffff",
  });
  return argv.includes(failEndpoint ?? "never")
    ? { exitCode: 1, stdout: "", stderr: "write failed" }
    : { exitCode: 0, stdout: '{"id":42}', stderr: "" };
});
const summaryEndpoint = "repos/o/r/issues/7/comments";
const replyEndpoint = (index: number) => `repos/o/r/pulls/7/comments/${91 + index}/replies`;
function summaryBody(): string {
  const argv = run.mock.calls.find(([args]) => args.includes(summaryEndpoint))?.[0];
  return argv?.find((arg) => arg.startsWith("body="))?.slice(5) ?? "";
}
beforeEach(() => {
  stateDir = makeTempDir("bot-post-threads-");
  failEndpoint = undefined;
  run.mockClear();
  input = {
    ref: { forge: "github", host: "github.test", repo: "o/r", number: 7 },
    info: {
      number: 7,
      title: "PR",
      body: "",
      url: "",
      state: "open",
      draft: false,
      author: { login: "a" },
      baseRef: "main",
      headRef: "fix",
      headSha: "abc1234ffff",
      crossRepo: false,
    },
    verdict: {
      intent: "pass",
      quality: "changes",
      findings: [],
      threads: [...verdicts],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    },
    threads,
    comments: [],
    own: [],
    staticMode: false,
    sensitive: [],
    stateDir,
    deps: { run, readText: async () => null },
    cwd: stateDir,
  };
});
afterEach(() => cleanupTempDir(stateDir));

describe("postPrReview thread publication", () => {
  test("AC-1: posts a marked reply to the verdict's thread", async () => {
    await bot.postPrReview(input);
    expect(run.mock.calls[0]?.[0]).toContain(replyEndpoint(0));
    expect(run.mock.calls[0]?.[0]).toContain(`body=${bot.renderThreadReply(verdicts[0])}`);
  });
  test("AC-2: edits only the key matched inside the same thread", async () => {
    await bot.postPrReview({
      ...input,
      own: [
        { key: bot.threadKey("T1"), threadId: "other", comment: { ...comment, id: "98" } },
        { key: bot.threadKey("T1"), threadId: "T1", comment: { ...comment, id: "99" } },
      ],
    });
    expect(run.mock.calls[0]?.[0]).toContain("PATCH");
    expect(run.mock.calls[0]?.[0]).toContain("repos/o/r/pulls/comments/99");
    expect(run.mock.calls[0]?.[0]).toContain(`body=${bot.renderThreadReply(verdicts[0])}`);
  });
  test.each(["other", undefined])("AC-3: key in thread %s cannot redirect an edit", async (threadId) => {
    await bot.postPrReview({ ...input, own: [{ key: bot.threadKey("T1"), threadId, comment }] });
    expect(run.mock.calls[0]?.[0]).toContain(replyEndpoint(0));
  });
  test("AC-4: unanswered and stale ids do not fabricate replies", async () => {
    await bot.postPrReview({
      ...input,
      verdict: {
        ...input.verdict,
        threads: [
          verdicts[0],
          {
            id: "missing",
            decision: "agree",
            reason: "Stale",
          },
        ],
      },
    });
    expect(run.mock.calls).toHaveLength(2);
    expect(run.mock.calls[0]?.[0]).toContain(replyEndpoint(0));
    expect(run.mock.calls.flatMap(([argv]) => argv)).not.toContain(replyEndpoint(2));
  });
  test("AC-5/6/7: failed reply is counted, next thread continues and summary reports failure", async () => {
    failEndpoint = replyEndpoint(0);
    const result = await bot.postPrReview(input);
    expect(result).toMatchObject({ failed: 1, threadsAnswered: 1 });
    expect(run.mock.calls[1]?.[0]).toContain(replyEndpoint(1));
    expect(summaryBody()).toContain("Could not post 1 comments; re-run nax bot review.");
    expect(run.mock.calls).toHaveLength(3);
  });
  test("failed thread edit is isolated without a duplicate reply", async () => {
    failEndpoint = "repos/o/r/pulls/comments/12";
    const result = await bot.postPrReview({ ...input, own: [{ key: bot.threadKey("T1"), threadId: "T1", comment }] });
    expect(result).toMatchObject({ failed: 1, threadsAnswered: 1 });
    expect(run.mock.calls[1]?.[0]).toContain(replyEndpoint(1));
    expect(run.mock.calls.flatMap(([argv]) => argv)).not.toContain(replyEndpoint(0));
  });
  test("AC-8: inline failure is included in the offline summary section", async () => {
    failEndpoint = "repos/o/r/pulls/7/comments";
    const result = await bot.postPrReview({
      ...input,
      verdict: {
        ...input.verdict,
        findings: [
          {
            kind: "quality",
            severity: "important",
            issue: "Leaks fd",
            file: "a.ts",
            line: 3,
          },
        ],
      },
    });
    expect(result.offLine).toBe(1);
    expect(summaryBody()).toContain("### Findings not on a changed line\n- **Important** `a.ts:3` Leaks fd");
  });
  test("AC-9/12/13: summary and outcome count posted and edited threads and comment verdicts", async () => {
    const result = await bot.postPrReview({
      ...input,
      comments: [{ ...comment, kind: "comment" }],
      own: [{ key: bot.threadKey("T1"), threadId: "T1", comment }],
      verdict: { ...input.verdict, comments: [{ id: "12", decision: "disagree", reason: "Out of scope" }] },
    });
    expect(result).toEqual({ inlineFindings: 0, threadsAnswered: 2, commentsAnswered: 1, offLine: 0, failed: 0 });
    expect(summaryBody().split("\n")[3]).toBe("0 inline findings, 2 threads answered, 1 comments answered.");
    expect(summaryBody()).toContain("alice: Disagree — Out of scope");
    expect(run.mock.calls).toHaveLength(3);
  });
  test.each([false, true])("AC-10/11: summary failure (edit=%s) rejects after thread writes", async (edit) => {
    failEndpoint = edit ? "repos/o/r/issues/comments/88" : summaryEndpoint;
    await expect(
      bot.postPrReview({
        ...input,
        own: edit
          ? [
              {
                key: "summary",
                comment: { ...comment, kind: "comment", id: "88" },
              },
            ]
          : [],
      }),
    ).rejects.toThrow("write failed");
    expect(run.mock.calls[0]?.[0]).toContain(replyEndpoint(0));
    expect(run.mock.calls[1]?.[0]).toContain(replyEndpoint(1));
    expect(run.mock.calls.at(-1)?.[0]).toContain(failEndpoint);
  });
  test("AC-14: thread writes still observe artifact-first ordering", async () => {
    await bot.postPrReview(input);
    expect(run.mock.calls[0]?.[0]).toContain(replyEndpoint(0));
    expect(run.mock.calls.at(-1)?.[0]).toContain(summaryEndpoint);
  });
  test("AC-15: distinct posted and edited inline findings still count with no threads", async () => {
    const findings = ["First", "Second"].map((issue) => ({
      kind: "quality" as const,
      severity: "minor" as const,
      issue,
      file: "a.ts",
      line: 3,
    }));
    const result = await bot.postPrReview({
      ...input,
      verdict: { ...input.verdict, threads: [], findings },
      own: [{ key: bot.findingKey(findings[1]), comment }],
    });
    expect(result).toEqual({ inlineFindings: 2, threadsAnswered: 0, commentsAnswered: 0, offLine: 0, failed: 0 });
    expect(run.mock.calls[0]?.[0]).toContain("POST");
    expect(run.mock.calls[1]?.[0]).toContain("PATCH");
  });
});
