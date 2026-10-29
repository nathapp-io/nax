import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { assertDefined, makeLogger } from "@test/helpers";
import { _rulingsDeps, type RecordRulingsInput, recordPrRulings } from "@/bot/rulings";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrInfo, PrThread } from "@/forge/pr-types";
import type { BotRulingReadInput, BotRulingReadVerdict } from "@/operations/bot-ruling-read";
import { renderItemIndex, renderItemOpener } from "@/workflow/item-threads";

const key = (id: string) => `w-${id}.12345678`;
const comment = (id: string, body: string, author = "alice"): PrComment => ({
  id,
  body,
  author,
  kind: "thread",
  createdAt: "2026-01-01T00:00:00Z",
});
const owned = (id: string, body: string, marker: string) => comment(id, withNaxBotMarker(body, marker), "bot");
const thread = (id: string, body = "This is acceptable.\n Product agrees."): PrThread => ({
  id,
  replyTo: `${id}-open`,
  resolved: false,
  outdated: false,
  comments: [
    owned(`${id}-open`, renderItemOpener({ id, kind: "ruling", issue: "question" }), key(id)),
    comment(`${id}-reply`, body),
  ],
});
const info: PrInfo = {
  number: 1,
  title: "PR",
  body: "",
  url: "https://example/pr/1",
  state: "open",
  draft: true,
  author: { login: "alice" },
  baseRef: "main",
  headRef: "feature",
  headSha: "a".repeat(40),
  crossRepo: false,
};
type Entry = BotRulingReadVerdict["rulings"][number];
const entry = (extra: Partial<Entry> = {}): Entry => ({
  id: "B1",
  disposition: "waived",
  reason: "product agrees",
  quote: "acceptable. Product agrees.",
  ...extra,
});
const verdict = (extra: Partial<Entry> = {}): BotRulingReadVerdict => ({ rulings: [entry(extra)] });
const original = { ..._rulingsDeps };
const logger = makeLogger();
const post = mock(async (..._args: Parameters<typeof _rulingsDeps.replyToThread>) => ({ id: "posted" }));
const resolve = mock(async () => {});
const tick = mock(original.tickChecklist);
const run = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const readModel = mock(async (_input: BotRulingReadInput): Promise<BotRulingReadVerdict | null> => verdict());
function input(threads = [thread("B1")], ids = threads.map((t) => t.id)): RecordRulingsInput {
  return {
    ref: { forge: "github", host: "github.com", repo: "org/repo", number: 1 },
    info,
    login: "bot",
    threads,
    comments: [owned("index", renderItemIndex({ keys: ids.map(key) }), "w-index")],
    deps: { run, readText: async () => null },
    cwd: "/checkout",
    readModel,
  };
}
beforeEach(() => {
  logger.reset();
  for (const fn of [post, resolve, tick, run, readModel]) fn.mockClear();
  post.mockImplementation(async () => ({ id: "posted" }));
  resolve.mockImplementation(async () => {});
  readModel.mockImplementation(async () => verdict());
  Object.assign(_rulingsDeps, {
    editComment: async () => {},
    hasWriteAccess: async () => true,
    replyToThread: post,
    resolveThread: resolve,
    tickChecklist: tick,
    readPrInfo: async () => ({ ...info, body: "- [ ] **B1** (ruling): question" }),
    getLogger: () => logger,
  });
});
afterEach(() => Object.assign(_rulingsDeps, original));

describe("recordPrRulings model replies", () => {
  test("AC-1 newest nonkeyword is read instead of older waive", async () => {
    readModel.mockImplementation(async () => null);
    const t = thread("B1", "please reconsider");
    const opener = t.comments[0];
    const newest = t.comments[1];
    assertDefined(opener);
    assertDefined(newest);
    const out = await recordPrRulings(input([{ ...t, comments: [opener, comment("old", "waive: x"), newest] }]));
    expect(readModel.mock.calls[0]?.[0].items[0]?.reply.body).toBe("please reconsider");
    expect(out.recorded).toEqual([]);
    expect(out.open).toHaveLength(1);
  });
  test("AC-2 batches eligible replies in index order, excluding empty and keyword items", async () => {
    readModel.mockImplementation(async () => null);
    const empty = thread("B4");
    await recordPrRulings(
      input(
        [thread("B1"), thread("B2"), thread("B3", "confirm"), { ...empty, comments: empty.comments.slice(0, 1) }],
        ["B2", "B4", "B3", "B1"],
      ),
    );
    expect(readModel).toHaveBeenCalledTimes(1);
    expect(readModel.mock.calls[0]?.[0].items).toEqual(
      ["B2", "B1"].map((id) => ({
        id,
        kind: "ruling",
        issue: "question",
        reply: { id: `${id}-reply`, author: "alice", body: "This is acceptable.\n Product agrees." },
      })),
    );
  });
  test("AC-3 grounded collapsed quote attributes author, echoes before resolve and ticks advisor", async () => {
    const order: string[] = [];
    post.mockImplementation(async () => {
      order.push("echo");
      return { id: "posted" };
    });
    resolve.mockImplementation(async () => {
      order.push("resolve");
    });
    const out = await recordPrRulings(input());
    expect(out.recorded).toEqual([
      { itemKey: key("B1"), itemId: "B1", disposition: "waived", reason: "product agrees", by: "alice" },
    ]);
    expect(order).toEqual(["echo", "resolve"]);
    expect(post.mock.calls[0]?.[2]).toContain(`key=wr-waived-${key("B1")}`);
    expect(out.open).toEqual([]);
    expect(tick).toHaveBeenCalledWith(expect.any(String), [
      { id: "B1", kind: "advisor", disposition: "waived", reason: "product agrees" },
    ]);
  });
  test("AC-4/5 ungrounded quote stays open and posts exact marked ask", async () => {
    readModel.mockImplementation(async () => verdict({ quote: "invented" }));
    const value = input();
    const out = await recordPrRulings(value);
    expect(out.recorded).toEqual([]);
    expect(out.open).toHaveLength(1);
    expect(out.asked).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      value.ref,
      value.threads[0],
      withNaxBotMarker(
        "I could not read a ruling from that reply. Start a reply with fixed <sha>, waive: <reason>, confirm, override: <reason> or verified.",
        `wq-${key("B1")}-B1-reply`,
      ),
      value.deps,
      value.cwd,
    );
  });
  test.each([
    ["AC-6", { disposition: "fixed", sha: "abc1234" }],
    ["AC-7", { disposition: "none" }],
    ["empty reason", { reason: "" }],
    ["multiline reason", { reason: "two\nlines" }],
    ["empty quote", { quote: "  " }],
    ["empty sha", { disposition: "fixed", sha: "" }],
  ] satisfies [string, Partial<Entry>][])("%s rejects invalid evidence and asks", async (_name, extra) => {
    readModel.mockImplementation(async () => verdict(extra));
    const out = await recordPrRulings(input());
    expect(readModel).toHaveBeenCalledTimes(1);
    expect(out.recorded).toEqual([]);
    expect(out.asked).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
  });
  test.each(["bot", "outsider"])("AC-8 deduplicates only owned asks (%s)", async (author) => {
    readModel.mockImplementation(async () => verdict({ disposition: "none" }));
    const t = thread("B1");
    const opener = t.comments[0];
    const reply = t.comments[1];
    assertDefined(opener);
    assertDefined(reply);
    const ask = comment("ask", withNaxBotMarker("ask", `wq-${key("B1")}-B1-reply`), author);
    const out = await recordPrRulings(input([{ ...t, comments: [opener, ask, reply] }]));
    expect(readModel).toHaveBeenCalledTimes(1);
    expect(out.asked).toBe(author === "bot" ? 0 : 1);
    expect(post).toHaveBeenCalledTimes(author === "bot" ? 0 : 1);
  });
  test.each(["null", "throws"])("AC-9/10 model %s preserves keyword without asks", async (mode) => {
    readModel.mockImplementation(async () => {
      if (mode === "throws") throw new Error("model unavailable");
      return null;
    });
    const out = await recordPrRulings(input([thread("B1"), thread("B2", "confirm")]));
    expect(readModel).toHaveBeenCalledTimes(1);
    expect(out.recorded.map((r) => r.itemId)).toEqual(["B2"]);
    expect(out.asked).toBe(0);
    expect(post).toHaveBeenCalledTimes(1);
    expect(out.open.map((i) => i.itemId)).toEqual(["B1"]);
    if (mode === "throws")
      expect(logger.warn).toHaveBeenCalledWith(
        "bot-rulings",
        expect.any(String),
        expect.objectContaining({ error: "model unavailable" }),
      );
  });
  test("AC-11 reads only first 20 of 21 in index order and leaves overflow open", async () => {
    const ids = Array.from({ length: 21 }, (_, i) => `B${21 - i}`);
    readModel.mockImplementation(async ({ items }) => ({ rulings: items.map(({ id }) => entry({ id })) }));
    const out = await recordPrRulings(
      input(
        [...ids].reverse().map((id) => thread(id)),
        ids,
      ),
    );
    expect(readModel).toHaveBeenCalledTimes(1);
    expect(readModel.mock.calls[0]?.[0].items.map((i) => i.id)).toEqual(ids.slice(0, 20));
    expect(out.recorded).toHaveLength(20);
    expect(out.open.map((i) => i.itemId)).toEqual(["B1"]);
    expect(out.asked).toBe(0);
  });
  test.each(["12345", "abc12", "#4f9a2c1", "a".repeat(41)])(
    "rejects grounded but non-durable fixed sha %s",
    async (sha) => {
      readModel.mockImplementation(async () => verdict({ disposition: "fixed", sha, quote: `build ${sha}` }));
      const out = await recordPrRulings(input([thread("B1", `Resolved in build ${sha}`)]));
      expect(out.recorded).toEqual([]);
      expect(out.open).toHaveLength(1);
      expect(out.asked).toBe(1);
      expect(resolve).not.toHaveBeenCalled();
      expect(tick).not.toHaveBeenCalled();
    },
  );
  test("normalizes padded fixed sha and preserves its echo on the next run", async () => {
    readModel.mockImplementation(async () =>
      verdict({ disposition: "fixed", sha: " abc1234 ", quote: "commit abc1234" }),
    );
    const t = thread("B1", "Resolved in commit abc1234");
    const out = await recordPrRulings(input([t]));
    expect(out.recorded[0]).toMatchObject({ disposition: "fixed", sha: "abc1234" });
    expect(tick).toHaveBeenCalledWith(expect.any(String), [expect.objectContaining({ sha: "abc1234" })]);
    const body = post.mock.calls[0]?.[2];
    assertDefined(body);
    const next = await recordPrRulings(input([{ ...t, comments: [...t.comments, comment("echo", body, "bot")] }]));
    expect(next.open).toEqual([]);
    expect(next.settled[0]?.ruling).toMatchObject({ disposition: "fixed", sha: "abc1234" });
    expect(next.recorded).toEqual([]);
    expect(readModel).toHaveBeenCalledTimes(1);
  });
  test("grounded fixed sha is recorded and ticked", async () => {
    readModel.mockImplementation(async () =>
      verdict({ disposition: "fixed", sha: "abc1234", quote: "commit abc1234" }),
    );
    const out = await recordPrRulings(input([thread("B1", "Resolved in commit abc1234")]));
    expect(out.recorded[0]).toMatchObject({ disposition: "fixed", sha: "abc1234", by: "alice" });
    expect(tick).toHaveBeenCalledWith(expect.any(String), [
      expect.objectContaining({ disposition: "fixed", sha: "abc1234" }),
    ]);
  });
});
