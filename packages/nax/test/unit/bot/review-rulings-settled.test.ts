import { afterEach, describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { earlierIssue } from "@/bot/post-earlier";
import { readReviewRulings } from "@/bot/review-rulings";
import type { RecordRulingsOutcome, recordPrRulings } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { buildBotPrReviewPrompt } from "@/prompts";

const env = makeBotFixEnv();
const input = {
  ref: env.ref,
  info: { ...env.info, body: NAX_WORKFLOW_PR_MARKER },
  login: "bot",
  threads: [],
  comments: [],
  deps: env.forge,
  cwd: "/repo",
  staticMode: false,
  ctx: env.ctx,
};
function outcome(
  body = "Open item **_run:cv1** (cannot-verify): Live job-log availability",
  sha?: string,
): RecordRulingsOutcome {
  return {
    recorded: [],
    open: [],
    asked: 0,
    failed: 0,
    settled: [
      {
        key: "w-key",
        itemId: "_run:cv1",
        kind: "cannot-verify",
        replies: [],
        thread: {
          id: "t",
          replyTo: "t",
          resolved: false,
          outdated: false,
          comments: [{ id: "c", author: "bot", body, kind: "thread", createdAt: "" }],
        },
        ruling: {
          itemKey: "w-key",
          itemId: "_run:cv1",
          disposition: "verified",
          reason: "ran live calls",
          by: "writer",
          ...(sha ? { sha } : {}),
        },
      },
    ],
  };
}
afterEach(() => resetLogger());
describe("readReviewRulings settled projection", () => {
  test("AC-11 projects settled identity, issue and ruling", async () => {
    const result = await readReviewRulings(input, async () => outcome());
    expect(result.settled).toEqual([
      {
        id: "_run:cv1",
        kind: "cannot-verify",
        issue: "Live job-log availability",
        disposition: "verified",
        reason: "ran live calls",
      },
    ]);
  });
  test("AC-12 falls back to earlierIssue and preserves sha", async () => {
    const result = outcome("Legacy opener", "abc1234");
    expect(await readReviewRulings(input, async () => result)).toMatchObject({
      settled: [{ issue: earlierIssue(result.settled[0].thread), sha: "abc1234" }],
    });
  });
  test("AC-13/14 static mode never records or projects settled", async () => {
    const record = mock<typeof recordPrRulings>(async () => outcome());
    expect(await readReviewRulings({ ...input, staticMode: true }, record)).toEqual({});
    expect(record).not.toHaveBeenCalled();
  });
  test("AC-17 recorder failure returns empty result with no prompt section", async () => {
    initLogger({ level: "silent" });
    const result = await readReviewRulings(input, async () => {
      throw new Error("recorder unavailable");
    });
    expect(result).toEqual({});
    expect(
      buildBotPrReviewPrompt({
        packagePath: "/diff",
        range: "base..HEAD",
        pr: { number: 1, title: "PR", body: "", author: "writer" },
        issues: [],
        threads: [],
        comments: [],
        staticMode: false,
        ...result,
      }),
    ).not.toContain("## Settled rulings");
  });
});
