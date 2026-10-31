import { describe, expect, mock, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { readReviewRulings, rulingEarlier } from "@/bot/review-rulings";
import type { RecordRulingsOutcome } from "@/bot/rulings";
import { NAX_WORKFLOW_PR_MARKER, withNaxBotMarker } from "@/forge";

const env = makeBotFixEnv();
const key = "w-D-1.12345678";
const comment = (id: string, author: string, body = id) => ({
  id,
  author,
  body,
  kind: "thread" as const,
  createdAt: "",
});
const confirmed = {
  key,
  itemId: "D-1",
  kind: "advisor",
  replies: [],
  thread: {
    id: "D",
    replyTo: "opener",
    resolved: false,
    outdated: false,
    comments: [
      comment("opener", "bot", withNaxBotMarker("Open item **D-1** (advisor): change required", key)),
      comment("writer", "writer", "confirm: change X"),
      comment("echo", "bot", withNaxBotMarker("confirmed", `wr-confirmed-${key}`)),
      comment("foreign", "reader"),
    ],
  },
  ruling: { itemKey: key, itemId: "D-1", disposition: "confirmed" as const, reason: "change X", by: "writer" },
};
const outcome: RecordRulingsOutcome = {
  index: { keys: [key, "closed"] },
  recorded: [confirmed.ruling],
  confirmedWork: [confirmed],
  settled: [{ ...confirmed, key: "closed", itemId: "D-2", fixClosed: true }],
  open: [],
  asked: 0,
  failed: 0,
};
const input = {
  ctx: env.ctx,
  ref: env.ref,
  info: { ...env.info, body: NAX_WORKFLOW_PR_MARKER },
  login: "bot",
  threads: [],
  comments: [],
  deps: env.forge,
  cwd: "/repo",
  staticMode: false,
};

describe("readReviewRulings confirmed work", () => {
  test("AC-1/2 projects the reason and only opener plus own comments", async () => {
    const result = await readReviewRulings(input, async () => outcome);
    expect(result).toHaveProperty("itemConfirmed", [
      {
        reason: "change X",
        thread: { ...confirmed.thread, comments: [confirmed.thread.comments[0], confirmed.thread.comments[2]] },
      },
    ]);
  });
  test("AC-3 omits confirmed items when absent or empty", async () => {
    const { confirmedWork: _confirmed, ...absent } = outcome;
    expect(await readReviewRulings(input, async () => absent)).not.toHaveProperty("itemConfirmed");
    expect(await readReviewRulings(input, async () => ({ ...absent, confirmedWork: [] }))).not.toHaveProperty(
      "itemConfirmed",
    );
  });
  test("AC-4 static mode skips recording", async () => {
    const record = mock(async () => outcome);
    expect(await readReviewRulings({ ...input, staticMode: true }, record)).toEqual({});
    expect(record).not.toHaveBeenCalled();
  });
  test("AC-5 lists confirmed advisor work as settled context", async () => {
    expect((await readReviewRulings(input, async () => outcome)).settled).toContainEqual({
      id: "D-1",
      kind: "advisor",
      issue: "change required",
      disposition: "confirmed",
      reason: "change X",
    });
  });
  test("AC-6 preserves recorded status and counts outstanding work", async () => {
    expect((await readReviewRulings(input, async () => outcome)).itemStatus).toEqual({
      open: 1,
      total: 2,
      recorded: [{ id: "D-1", disposition: "confirmed", by: "writer" }],
    });
  });
  test("AC-7 adds confirmed work to other open rulings", async () => {
    const open = [{ ...confirmed, kept: [] }];
    expect((await readReviewRulings(input, async () => ({ ...outcome, open }))).rulings?.open).toBe(2);
  });
  test("AC-8 does not widen rulingEarlier to advisors", () => {
    expect(rulingEarlier({ ...outcome, open: [{ ...confirmed, kept: [] }] }, "bot")).toEqual([]);
  });
});
