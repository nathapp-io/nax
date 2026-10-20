import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { BotReviewArtifact, PostReviewInput } from "@/bot";
import * as bot from "@/bot";
import type { PrComment, PrThread } from "@/forge";
import type { WorkflowFindingDraft } from "@/operations/workflow-types";

const finding: WorkflowFindingDraft = {
  kind: "quality",
  severity: "important",
  issue: "Leaks fd",
  file: "a.ts",
  line: 3,
  suggestion: "Close it",
};
const comment: PrComment = { id: "12", kind: "comment", author: "alice", body: "Please fix", createdAt: "" };
const thread: PrThread = {
  id: "T1",
  replyTo: "91",
  path: "a.ts",
  line: 3,
  resolved: false,
  outdated: false,
  comments: [comment],
};
let stateDir: string;
let input: PostReviewInput;
let artifacts: BotReviewArtifact[];
const run = mock(async (_argv: string[], _options: { cwd: string }) => {
  artifacts.push(await Bun.file(join(stateDir, "bot-review.json")).json());
  return { exitCode: 0, stdout: '{"id":42}', stderr: "" };
});
async function artifact(): Promise<BotReviewArtifact> {
  return Bun.file(join(stateDir, "bot-review.json")).json();
}
beforeEach(() => {
  stateDir = makeTempDir("bot-post-");
  artifacts = [];
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
      diffRefs: { baseSha: "base", startSha: "start", headSha: "abc1234ffff" },
    },
    verdict: {
      intent: "pass",
      quality: "changes",
      findings: [finding],
      threads: [],
      comments: [],
      cannotVerify: [],
      inspectedFiles: [],
    },
    threads: [thread],
    comments: [comment],
    own: [],
    staticMode: false,
    sensitive: [],
    stateDir,
    deps: { run, readText: async () => null },
    cwd: stateDir,
  };
});
afterEach(() => {
  cleanupTempDir(stateDir);
});

describe("postPrReview", () => {
  test("an off-line finding does not consume the inline dedupe key", async () => {
    const outcome = await bot.postPrReview({
      ...input,
      verdict: { ...input.verdict, findings: [{ ...finding, line: undefined }, finding] },
    });
    expect(outcome).toMatchObject({ offLine: 1, inlineFindings: 1 });
  });
  test("artifact storage failure prevents every forge mutation", async () => {
    const blocker = join(stateDir, "not-a-directory");
    await Bun.write(blocker, "file");
    await expect(bot.postPrReview({ ...input, stateDir: blocker })).rejects.toMatchObject({
      code: "BOT_REVIEW_WRITE_FAILED",
    });
    expect(run.mock.calls).toHaveLength(0);
  });
  test("failed own inline edits propagate rather than create duplicate comments", async () => {
    const failing = mock(async (_argv: string[], _opts: { cwd: string }) => ({
      exitCode: 1,
      stdout: "",
      stderr: "edit failed",
    }));
    await expect(
      bot.postPrReview({
        ...input,
        deps: { ...input.deps, run: failing },
        own: [{ key: bot.findingKey(finding), comment: { ...comment, kind: "thread" } }],
      }),
    ).rejects.toThrow("edit failed");
    expect(failing.mock.calls).toHaveLength(1);
    expect((await artifact()).agreed).toHaveLength(1);
  });
  test("AC-1: persists artifact before the first forge write", async () => {
    await bot.postPrReview(input);
    expect(artifacts[0]).toMatchObject({
      version: 1,
      pr: input.ref,
      headSha: input.info.headSha,
      trusted: true,
      intent: "pass",
      quality: "changes",
    });
    expect(run.mock.calls[0]?.[1]).toEqual({ cwd: stateDir });
  });
  test("AC-2: preserves every severity and duplicate finding in artifact order", async () => {
    const findings = [finding, ...(["critical", "minor"] as const).map((severity) => ({ ...finding, severity }))];
    await bot.postPrReview({ ...input, verdict: { ...input.verdict, findings } });
    expect((await artifact()).agreed).toEqual(
      findings.map(({ severity, issue, file, line, suggestion }) => ({
        key: bot.findingKey(finding),
        kind: "finding",
        severity,
        issue,
        file,
        line,
        suggestion,
      })),
    );
  });
  test("AC-3/4: records agreeing threads with original body and targets, not disagreements", async () => {
    await bot.postPrReview({
      ...input,
      threads: [thread, { ...thread, id: "T2" }],
      verdict: {
        ...input.verdict,
        findings: [],
        threads: [
          { id: "T1", decision: "agree", reason: "Valid" },
          { id: "T2", decision: "disagree", reason: "No" },
        ],
      },
    });
    expect((await artifact()).agreed).toEqual([
      {
        key: bot.threadKey("T1"),
        kind: "thread",
        issue: comment.body,
        reason: "Valid",
        threadId: "T1",
        replyTo: "91",
        file: "a.ts",
        line: 3,
      },
    ]);
  });
  test("AC-5: records only agreeing comments using commentKey", async () => {
    await bot.postPrReview({
      ...input,
      comments: [comment, { ...comment, id: "13" }],
      verdict: {
        ...input.verdict,
        findings: [],
        comments: [
          { id: "12", decision: "agree", reason: "Valid" },
          { id: "13", decision: "handled", reason: "Done" },
        ],
      },
    });
    expect((await artifact()).agreed).toEqual([
      { key: bot.commentKey("12"), kind: "comment", issue: comment.body, reason: "Valid" },
    ]);
  });
  test("AC-6: static review is untrusted", async () => {
    await bot.postPrReview({ ...input, staticMode: true });
    expect((await artifact()).trusted).toBe(false);
  });
  test("AC-7: posts inline with head SHA, path, line and marked body", async () => {
    await bot.postPrReview(input);
    expect(run.mock.calls[0]?.[0]).toEqual([
      "gh",
      "api",
      "--hostname",
      "github.test",
      "-X",
      "POST",
      "repos/o/r/pulls/7/comments",
      "-f",
      `body=${bot.renderFindingComment(finding)}`,
      "-f",
      "commit_id=abc1234ffff",
      "-f",
      "path=a.ts",
      "-F",
      "line=3",
      "-f",
      "side=RIGHT",
    ]);
  });
  test("AC-7: forwards GitLab diff refs to inline posting", async () => {
    const gitlabRun = mock(async (_argv: string[], _opts: { cwd: string }) => ({
      exitCode: 0,
      stdout: '{"id":42,"notes":[{"id":43}]}',
      stderr: "",
    }));
    await bot.postPrReview({
      ...input,
      ref: { ...input.ref, forge: "gitlab" },
      deps: { ...input.deps, run: gitlabRun },
    });
    const endpoint = gitlabRun.mock.calls[0]?.[0][6] ?? "";
    expect(endpoint).toContain("position%5Bbase_sha%5D=base");
    expect(endpoint).toContain("position%5Bstart_sha%5D=start");
    expect(endpoint).toContain("position%5Bhead_sha%5D=abc1234ffff");
  });
  test("AC-8: edits the matching own inline comment", async () => {
    await bot.postPrReview({
      ...input,
      own: [{ key: bot.findingKey(finding), comment: { ...comment, id: "99", kind: "thread" }, threadId: "T1" }],
    });
    expect(run.mock.calls[0]?.[0]).toContain("PATCH");
    expect(run.mock.calls[0]?.[0]).toContain("repos/o/r/pulls/comments/99");
  });
  test("AC-9: only the first duplicate finding is posted", async () => {
    await bot.postPrReview({
      ...input,
      verdict: { ...input.verdict, findings: [finding, { ...finding, line: 10, suggestion: "Later" }] },
    });
    expect(run.mock.calls).toHaveLength(2);
    expect(run.mock.calls[0]?.[0]).toContain("line=3");
    expect(run.mock.calls[0]?.[0]).not.toContain("line=10");
  });
  test("AC-10: rejected inline post falls back offline without retry", async () => {
    const rejected = mock(async (argv: string[], opts: { cwd: string }) =>
      argv.includes("repos/o/r/pulls/7/comments")
        ? { exitCode: 1, stdout: "", stderr: "not in diff" }
        : run(argv, opts),
    );
    const result = await bot.postPrReview({ ...input, deps: { ...input.deps, run: rejected } });
    expect(result).toMatchObject({ inlineFindings: 0, offLine: 1 });
    expect(rejected.mock.calls).toHaveLength(2);
  });
  test.each(["line", "file"] as const)("AC-11/12: missing %s never posts inline and counts offline", async (field) => {
    const incomplete = { ...finding, [field]: undefined };
    const result = await bot.postPrReview({ ...input, verdict: { ...input.verdict, findings: [incomplete] } });
    expect(result.offLine).toBe(1);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0]?.[0]).toContain("repos/o/r/issues/7/comments");
  });
  test("AC-13/15: posts summary last, ignoring a thread-local summary marker", async () => {
    await bot.postPrReview({ ...input, own: [{ key: "summary", comment, threadId: "T1" }] });
    expect(run.mock.calls).toHaveLength(2);
    expect(run.mock.calls.at(-1)?.[0]).toContain("repos/o/r/issues/7/comments");
    expect(run.mock.calls.at(-1)?.[0].join(" ")).toContain("key=summary");
  });
  test("AC-14: edits the top-level own summary", async () => {
    await bot.postPrReview({ ...input, own: [{ key: "summary", comment: { ...comment, id: "88" } }] });
    expect(run.mock.calls.at(-1)?.[0]).toContain("PATCH");
    expect(run.mock.calls.at(-1)?.[0]).toContain("repos/o/r/issues/comments/88");
  });
  test("AC-16: returns counts for posted and edited findings", async () => {
    const second = { ...finding, issue: "Other" };
    const result = await bot.postPrReview({
      ...input,
      verdict: {
        ...input.verdict,
        findings: [finding, second],
        comments: [{ id: "12", decision: "agree", reason: "Yes" }],
      },
      own: [{ key: bot.findingKey(second), comment: { ...comment, kind: "thread" } }],
    });
    expect(result).toEqual({ inlineFindings: 2, threadsAnswered: 0, commentsAnswered: 1, offLine: 0, failed: 0 });
  });
  test("summary failure propagates after artifact and inline writes", async () => {
    const failing = mock(async (argv: string[], opts: { cwd: string }) =>
      argv.includes("repos/o/r/issues/7/comments")
        ? { exitCode: 1, stdout: "", stderr: "summary failed" }
        : run(argv, opts),
    );
    await expect(bot.postPrReview({ ...input, deps: { ...input.deps, run: failing } })).rejects.toThrow(
      "summary failed",
    );
    expect((await artifact()).headSha).toBe(input.info.headSha);
    expect(failing.mock.calls).toHaveLength(2);
  });
});
