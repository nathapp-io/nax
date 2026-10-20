import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import type { PostReviewInput } from "@/bot";
import * as bot from "@/bot";
import type { PrComment, PrThread } from "@/forge";
import { NAX_BOT_HEADER, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";

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
    version: 2,
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
    expect(result).toEqual({
      earlierAnswered: 0,
      inlineFindings: 0,
      threadsAnswered: 2,
      commentsAnswered: 1,
      offLine: 0,
      failed: 0,
    });
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
    expect(result).toEqual({
      earlierAnswered: 0,
      inlineFindings: 2,
      threadsAnswered: 0,
      commentsAnswered: 0,
      offLine: 0,
      failed: 0,
    });
    expect(run.mock.calls[0]?.[0]).toContain("POST");
    expect(run.mock.calls[1]?.[0]).toContain("PATCH");
  });
});

describe("postPrReview earlier findings", () => {
  const key = "f-earlier";
  const earlier: PrThread = {
    ...threads[0],
    path: "old.ts",
    line: 17,
    comments: [{ ...comment, author: "bot", body: withNaxBotMarker("**Minor** (quality): Leak", key) }],
  };
  async function agreed() {
    const artifact: bot.BotReviewArtifact = await Bun.file(join(stateDir, "bot-review.json")).json();
    return artifact.agreed;
  }
  beforeEach(() => {
    input = {
      ...input,
      login: "bot",
      earlier: [earlier],
      verdict: {
        ...input.verdict,
        threads: [],
        earlier: [{ id: "T1", status: "open", reason: "Still leaks" }],
      },
    };
  });
  test("US-008 AC-1/2/3/4/5: retains the marked open finding and location without a thread write", async () => {
    await bot.postPrReview(input);
    expect(await agreed()).toEqual([
      { kind: "finding", key, issue: "**Minor** (quality): Leak", severity: "minor", file: "old.ts", line: 17 },
    ]);
    expect(run.mock.calls).toHaveLength(1);
    expect(run.mock.calls[0]?.[0]).toContain(summaryEndpoint);
  });
  test.each(["Plain issue", "**Important** Issue", "**Critical** Issue"])(
    "US-008 AC-6: severity for %s",
    async (body) => {
      await bot.postPrReview({
        ...input,
        earlier: [{ ...earlier, comments: [{ ...earlier.comments[0], body: withNaxBotMarker(body, key) }] }],
      });
      expect(await agreed()).toMatchObject([{ severity: body.startsWith("**Critical**") ? "critical" : "important" }]);
    },
  );
  test.each([{ earlier: undefined }, { earlier: [] }])(
    "US-008 AC-7: omitted verdict remains open (%j)",
    async (extra) => {
      await bot.postPrReview({ ...input, verdict: { ...input.verdict, ...extra } });
      expect(await agreed()).toMatchObject([{ key, kind: "finding" }]);
      expect(run.mock.calls).toHaveLength(1);
    },
  );
  test.each(["open", "fixed", "withdrawn"] as const)(
    "US-008 AC-8/9/10: re-raised finding overrides %s",
    async (status) => {
      const finding = { kind: "quality", severity: "important", issue: "Leak", file: "old.ts", line: 17 } as const;
      const findingMarker = bot.findingKey(finding);
      const first = { ...earlier.comments[0], body: bot.renderFindingComment(finding) };
      await bot.postPrReview({
        ...input,
        earlier: [{ ...earlier, comments: [first] }],
        own: [{ key: findingMarker, threadId: earlier.id, comment: first }],
        verdict: { ...input.verdict, findings: [finding], earlier: [{ id: "T1", status, reason: "Done" }] },
      });
      expect(await agreed()).toHaveLength(1);
      expect((await agreed())[0]?.key).toBe(findingMarker);
      expect(run.mock.calls).toHaveLength(2);
      expect(run.mock.calls[0]?.[0]).toContain("PATCH");
      expect(run.mock.calls[1]?.[0]).toContain(summaryEndpoint);
    },
  );
  test.each(["fixed", "withdrawn"] as const)("US-008 AC-11/12/13: %s replies before resolving", async (status) => {
    const verdict = { id: "T1", status, reason: "Corrected" };
    await bot.postPrReview({ ...input, verdict: { ...input.verdict, earlier: [verdict] } });
    expect(run.mock.calls[0]?.[0]).toContain(replyEndpoint(0));
    expect(run.mock.calls[0]?.[0]).toContain(`body=${bot.renderEarlierReply(verdict, "T1")}`);
    expect(bot.renderEarlierReply(verdict, "T1").replace(`${NAX_BOT_HEADER}\n\n`, "")).toStartWith(
      status === "fixed" ? "Fixed: " : "Withdrawn: ",
    );
    expect(run.mock.calls[1]?.[0]).toContain("id=T1");
    expect(run.mock.calls[2]?.[0]).toContain(summaryEndpoint);
    expect(await agreed()).toEqual([]);
  });
  test("US-008 AC-14: edits an own earlier reply only in the same thread", async () => {
    await bot.postPrReview({
      ...input,
      own: [
        { key: bot.earlierKey("T1"), threadId: "other", comment: { ...comment, id: "98" } },
        { key: bot.earlierKey("T1"), threadId: "T1", comment: { ...comment, id: "99" } },
      ],
      verdict: { ...input.verdict, earlier: [{ id: "T1", status: "fixed", reason: "Done" }] },
    });
    expect(run.mock.calls[0]?.[0]).toContain("PATCH");
    expect(run.mock.calls[0]?.[0]).toContain("repos/o/r/pulls/comments/99");
    expect(run.mock.calls[1]?.[0]).toContain("id=T1");
  });
  test.each(["reply", "resolve"])("US-008 AC-15/16/17/20/21: failed %s counts once and warns", async (stage) => {
    const logger = initLogger({ level: "silent" });
    const warn = spyOn(logger, "warn");
    try {
      failEndpoint = stage === "reply" ? replyEndpoint(0) : "id=T1";
      const result = await bot.postPrReview({
        ...input,
        verdict: { ...input.verdict, earlier: [{ id: "T1", status: "fixed", reason: "Done" }] },
      });
      expect(result.failed).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        "bot-post",
        expect.stringContaining(stage),
        expect.objectContaining({ threadId: "T1", error: expect.any(String) }),
      );
      expect(run.mock.calls).toHaveLength(stage === "reply" ? 2 : 3);
      if (stage === "reply") expect(run.mock.calls.flatMap(([args]) => args)).not.toContain("id=T1");
    } finally {
      warn.mockRestore();
      resetLogger();
    }
  });
  test("US-008 AC-18: counts every earlier thread including open and failed", async () => {
    const result = await bot.postPrReview({ ...input, earlier: [earlier, { ...earlier, id: "T2" }] });
    expect(result.earlierAnswered).toBe(2);
  });
  test("retains all 51 findings when only the first 50 have reviewer verdicts", async () => {
    const many = Array.from({ length: 51 }, (_, index) => ({
      ...earlier,
      id: `E${index}`,
      comments: [{ ...earlier.comments[0], body: withNaxBotMarker("Leak", `f-${index}`) }],
    }));
    const result = await bot.postPrReview({
      ...input,
      earlier: many,
      verdict: {
        ...input.verdict,
        earlier: many.slice(0, 50).map(({ id }) => ({ id, status: "open", reason: "Still open" })),
      },
    });
    expect(await agreed()).toHaveLength(51);
    expect((await agreed())[50]?.key).toBe("f-50");
    expect(result.earlierAnswered).toBe(51);
    expect(run.mock.calls).toHaveLength(1);
  });
  test("never resolves foreign openers or unmarked threads", async () => {
    await bot.postPrReview({
      ...input,
      earlier: [
        { ...earlier, comments: [{ ...earlier.comments[0], author: "human" }] },
        { ...earlier, comments: [comment] },
      ],
      verdict: { ...input.verdict, earlier: [{ id: "T1", status: "fixed", reason: "Done" }] },
    });
    expect(run.mock.calls).toHaveLength(1);
    expect(await agreed()).toEqual([]);
  });
  test("discovers the authenticated user's earlier reply inside the thread", async () => {
    await bot.postPrReview({
      ...input,
      earlier: [
        {
          ...earlier,
          comments: [
            ...earlier.comments,
            { ...comment, id: "99", author: "bot", body: withNaxBotMarker("Fixed: old reason", bot.earlierKey("T1")) },
          ],
        },
      ],
      verdict: { ...input.verdict, earlier: [{ id: "T1", status: "fixed", reason: "Done" }] },
    });
    expect(run.mock.calls[0]?.[0]).toContain("repos/o/r/pulls/comments/99");
    expect(run.mock.calls[1]?.[0]).toContain("id=T1");
  });
  test("US-008 AC-19: defaults earlierAnswered to zero", async () => {
    const result = await bot.postPrReview({ ...input, earlier: undefined });
    expect(result.earlierAnswered).toBe(0);
  });
});
