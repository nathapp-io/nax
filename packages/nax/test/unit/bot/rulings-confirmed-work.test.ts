import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { _rulingsDeps, type RecordRulingsInput, recordPrRulings } from "@/bot/rulings";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrInfo, PrThread } from "@/forge/pr-types";
import { renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";

const key = "w-D-1.12345678";
const ruling = { itemKey: key, itemId: "D-1", disposition: "confirmed", reason: "change X", by: "alice" } as const;
const comment = (id: string, body: string, author = "bot"): PrComment => ({
  id,
  body,
  author,
  authorId: 7,
  kind: "thread",
  createdAt: "2026-01-01T00:00:00Z",
});
const marked = (id: string, body: string, marker: string) => comment(id, withNaxBotMarker(body, marker));
const opener = (kind: Parameters<typeof renderItemOpener>[0]["kind"] = "advisor") =>
  marked("opener", renderItemOpener({ id: "D-1", kind, issue: "x" }), key);
const reply = (body = "confirm: change X") => comment("reply", body, "alice");
const echo = () => marked("echo", renderRulingEcho(ruling), `wr-confirmed-${key}`);
const fix = () => marked("fix", "Fixed in abc1234567", `fix-${key}`);
const thread = (...comments: PrComment[]): PrThread => ({
  id: "thread",
  replyTo: "opener",
  resolved: false,
  outdated: false,
  comments,
});
const info: PrInfo = {
  number: 1,
  title: "PR",
  body: "- [ ] **D-1** (advisor): x",
  url: "https://example/pr/1",
  state: "open",
  draft: true,
  author: { login: "alice" },
  baseRef: "main",
  headRef: "feature",
  headSha: "a".repeat(40),
  crossRepo: false,
};
const original = { ..._rulingsDeps };
const logger = makeLogger();
const post = mock(async (..._args: Parameters<typeof _rulingsDeps.replyToThread>) => ({ id: "posted" }));
const resolve = mock(async () => {});
const edit = mock(async (..._args: Parameters<typeof _rulingsDeps.editComment>) => {});
const read = mock(async () => info);
const run = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const input = (item = thread(opener(), reply())): RecordRulingsInput => ({
  ref: { forge: "github", host: "github.com", repo: "org/repo", number: 1 },
  info,
  login: "bot",
  threads: [item],
  // Start with a stale settled count to exercise the outstanding-work refresh.
  comments: [marked("index", renderItemIndex({ keys: [key] }, 1), "w-index")],
  deps: { run, readText: async () => null },
  cwd: "/checkout",
  readModel: async () => null,
});

beforeEach(() => {
  logger.reset();
  for (const fn of [post, resolve, edit, read, run]) fn.mockClear();
  post.mockImplementation(async () => ({ id: "posted" }));
  resolve.mockImplementation(async () => {});
  Object.assign(_rulingsDeps, {
    hasWriteAccess: async () => true,
    replyToThread: post,
    resolveThread: resolve,
    editComment: edit,
    readPrInfo: read,
    getLogger: () => logger,
  });
});
afterEach(() => Object.assign(_rulingsDeps, original));

describe("recordPrRulings confirmed advisor work", () => {
  test("AC-1 posts exactly one confirmed echo", async () => {
    const value = input();
    await recordPrRulings(value);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      value.ref,
      value.threads[0],
      withNaxBotMarker(renderRulingEcho(ruling), `wr-confirmed-${key}`),
      value.deps,
      value.cwd,
    );
  });
  test("AC-2 leaves newly confirmed work unresolved", async () => {
    await recordPrRulings(input());
    expect(resolve).not.toHaveBeenCalled();
  });
  test("AC-3 exposes the item identity and confirmation reason", async () => {
    const out = await recordPrRulings(input());
    expect(out).toHaveProperty("confirmedWork", [expect.objectContaining({ itemId: "D-1", ruling })]);
  });
  test("AC-4 excludes newly confirmed work from settled and open", async () => {
    const out = await recordPrRulings(input());
    expect(out.settled).toEqual([]);
    expect(out.open).toEqual([]);
  });
  test("AC-5 includes the successfully posted confirmation in recorded", async () => {
    expect((await recordPrRulings(input())).recorded).toEqual([ruling]);
  });
  test("AC-6/7/8 rereads its posted echo without reposting or resolving", async () => {
    const value = input();
    await recordPrRulings(value);
    const body = post.mock.calls[0]?.[2];
    expect(body).toBeDefined();
    post.mockClear();
    resolve.mockClear();
    const out = await recordPrRulings(input(thread(opener(), reply(), comment("posted", body ?? ""))));
    expect(out).toHaveProperty("confirmedWork", [expect.objectContaining({ itemId: "D-1", ruling })]);
    expect(post).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(out.recorded).toEqual([]);
  });
  test("AC-9/10 settles and resolves a confirmation answered by an own fix comment", async () => {
    const out = await recordPrRulings(input(thread(opener(), echo(), fix())));
    expect(out.settled).toEqual([expect.objectContaining({ itemId: "D-1", ruling, fixClosed: true })]);
    expect(out).not.toHaveProperty("confirmedWork");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
  test.each([
    ["fixed abc1234567", "fixed"],
    ["waive: accepted", "waived"],
    ["override: accepted", "overridden"],
    ["verified", "verified"],
  ])("AC-11/12 preserves advisor settlement for %s", async (body, disposition) => {
    const out = await recordPrRulings(input(thread(opener(), reply(body))));
    expect(out.settled).toEqual([expect.objectContaining({ ruling: expect.objectContaining({ disposition }) })]);
    expect(out).not.toHaveProperty("confirmedWork");
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  test.each(["cannot-verify", "finding", "ruling", "gate", "story", "ci", "reason"] as const)(
    "AC-13/14 preserves confirmed settlement for non-advisor %s",
    async (kind) => {
      const out = await recordPrRulings(input(thread(opener(kind), reply())));
      expect(out.settled).toEqual([expect.objectContaining({ kind, ruling })]);
      expect(out).not.toHaveProperty("confirmedWork");
      expect(resolve).toHaveBeenCalledTimes(1);
    },
  );
  test("AC-15/16 retains outstanding work even when an older recorder resolved it", async () => {
    const out = await recordPrRulings(input({ ...thread(opener(), echo()), resolved: true }));
    expect(out).toHaveProperty("confirmedWork", [expect.objectContaining({ itemId: "D-1", ruling })]);
    expect(out.settled).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
  test("AC-17/18 failed confirmation echo stays open without confirmedWork", async () => {
    post.mockImplementation(async () => {
      throw new Error("echo failed");
    });
    const out = await recordPrRulings(input());
    expect(out.open.map((item) => item.itemId)).toEqual(["D-1"]);
    expect(out.failed).toBe(1);
    expect(out).not.toHaveProperty("confirmedWork");
    expect(out.recorded).toEqual([]);
    expect(out.settled).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  });
  test("AC-19 never edits the body for outstanding confirmed work", async () => {
    await recordPrRulings(input());
    expect(read).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-20 refreshes the index count excluding outstanding work and including fix-closed work", async () => {
    const value = input(thread(opener(), echo()));
    await recordPrRulings(value);
    const body = withNaxBotMarker(renderItemIndex({ keys: [key] }, 0), "w-index");
    expect(edit).toHaveBeenCalledWith(value.ref, value.comments[0], body, value.deps, value.cwd);
    edit.mockClear();
    const closed = { ...input(thread(opener(), echo(), fix())), comments: [comment("index", body)] };
    await recordPrRulings(closed);
    expect(edit).toHaveBeenCalledWith(
      closed.ref,
      closed.comments[0],
      withNaxBotMarker(renderItemIndex({ keys: [key] }, 1), "w-index"),
      closed.deps,
      closed.cwd,
    );
  });
  test("AC-21 writer fixed reply supersedes a fix-closed confirmation", async () => {
    const out = await recordPrRulings(input(thread(opener(), echo(), fix(), reply("fixed abc1234567"))));
    expect(out.settled).toEqual([
      expect.objectContaining({ ruling: expect.objectContaining({ disposition: "fixed", sha: "abc1234567" }) }),
    ]);
    expect(out).not.toHaveProperty("confirmedWork");
    expect(post).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  test("AC-22 resolution failure logs without undoing a closed item's recorded settlement", async () => {
    resolve.mockImplementation(async () => {
      throw new Error("resolve failed");
    });
    const out = await recordPrRulings(input(thread(opener(), reply("waive: accepted"))));
    expect(out.settled[0]?.ruling.disposition).toBe("waived");
    expect(out.recorded).toEqual([out.settled[0]?.ruling]);
    expect(out.failed).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot-rulings",
      "[bot-rulings] Could not resolve settled item",
      expect.objectContaining({ itemId: "D-1", threadId: "thread", error: "resolve failed" }),
    );
  });
  test("a newly echoed confirmation starts a new cycle despite an older fix marker", async () => {
    const out = await recordPrRulings(input(thread(opener(), echo(), fix(), reply())));
    expect(out).toHaveProperty("confirmedWork", [expect.objectContaining({ ruling })]);
    expect(out.settled).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});
