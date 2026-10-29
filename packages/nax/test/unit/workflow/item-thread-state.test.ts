import { describe, expect, mock, test } from "bun:test";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrThread } from "@/forge/pr-types";
import type { ItemThread, ReadItemThreads } from "@/workflow/item-thread-state";
import { readItemThreads, settleItemThreads, unindexedItemKeys } from "@/workflow/item-thread-state";
import {
  renderItemIndex,
  renderItemOpener,
  renderItemReopened,
  renderRulingEcho,
  reopenKey,
} from "@/workflow/item-threads";

const key = "w-B3.12345678";
const head = "a".repeat(40);
const ruling = { itemKey: key, itemId: "B3", disposition: "waived", reason: "ok", by: "alice" } as const;
const comment = (id: string, body: string, author = "bot"): PrComment => ({
  id,
  body,
  author,
  kind: "thread",
  createdAt: "2026-01-01T00:00:00Z",
});
const marked = (id: string, body: string, marker: string, author = "bot") =>
  comment(id, withNaxBotMarker(body, marker), author);
const opener = (author = "bot") =>
  marked("1", renderItemOpener({ id: "B3", kind: "finding", issue: "x" }), key, author);
const echo = () => marked("2", renderRulingEcho(ruling), `wr-waived-${key}`);
const thread = (...comments: PrComment[]): PrThread => ({
  id: "thread",
  replyTo: "1",
  resolved: false,
  outdated: false,
  comments,
});
const index = (author = "bot") => marked("index", renderItemIndex({ keys: [key] }), "w-index", author);
const item = (replies: readonly PrComment[] = [], ruled = true): ItemThread => ({
  key,
  itemId: "B3",
  kind: "finding",
  thread: thread(opener()),
  replies,
  ...(ruled ? { ruling } : {}),
});
const read = (entry: ItemThread): ReadItemThreads => ({ index: { keys: [key] }, items: [entry] });
const fixedRuling = { ...ruling, disposition: "fixed", sha: head } as const;
const fixedEcho = () => marked("2", renderRulingEcho(fixedRuling), `wr-fixed-${key}`);
const reopened = () => marked("notice", renderItemReopened(head), reopenKey(key));

describe("reopen notice", () => {
  test("pending invalidation holds the observed echo but permits a later durable ruling", async () => {
    const pending = marked(
      "index",
      renderItemIndex({ keys: [key], pendingReopens: [{ key, commentId: "2" }] }),
      "w-index",
    );
    const held = readItemThreads([thread(opener(), fixedEcho())], [pending], "bot");
    expect((await settleItemThreads(held, async () => false)).open).toHaveLength(1);
    const newer = marked("3", renderRulingEcho(fixedRuling), `wr-fixed-${key}`);
    const reread = readItemThreads([thread(opener(), fixedEcho(), newer)], [pending], "bot");
    expect((await settleItemThreads(reread, async () => false)).settled).toHaveLength(1);
  });
  test("AC-4 a last-own reopen notice leaves a previously fixed item without a ruling", () => {
    const ruled = readItemThreads([thread(opener(), fixedEcho())], [index()], "bot");
    expect(ruled.items[0]?.ruling?.disposition).toBe("fixed");
    const result = readItemThreads([thread(opener(), fixedEcho(), reopened())], [index()], "bot");
    expect(result.items.map((entry) => entry.key)).toEqual([key]);
    expect(result.items[0]?.ruling).toBeUndefined();
  });
  test("AC-5 replies contain only the comments after the reopen notice", () => {
    const superseded = comment("early", "waive", "alice");
    const after = comment("late", "still broken", "alice");
    const source = thread(opener(), fixedEcho(), superseded, reopened(), after);
    expect(readItemThreads([source], [index()], "bot").items[0]?.replies).toEqual([after]);
  });
  test("AC-6 settleItemThreads puts a re-raised item in open", async () => {
    const reRaised = readItemThreads([thread(opener(), fixedEcho(), reopened())], [index()], "bot");
    expect(await settleItemThreads(reRaised, async () => true)).toEqual({
      settled: [],
      open: [{ ...reRaised.items[0], kept: [] }],
    });
  });
  test("AC-7 an unparseable opener yields no item even with a later reopen marker", () => {
    const malformed = marked("1", "Open item **B3** (unknown): x", key);
    expect(readItemThreads([thread(malformed, reopened())], [index()], "bot").items).toEqual([]);
  });
});

describe("readItemThreads", () => {
  test("AC-1 ignores a marked opener from another login", async () => {
    expect(readItemThreads([thread(opener("other"))], [index()], "bot").items).toEqual([]);
  });
  test("AC-2 reads the own w-index comment", async () => {
    const own = index();
    expect(readItemThreads([], [own], "bot")).toEqual({
      index: { keys: [key] },
      indexComment: own,
      items: [],
    });
  });
  test("AC-3 ignores another login's index", async () => {
    expect(readItemThreads([], [index("other")], "bot")).toEqual({ items: [] });
  });
  test("AC-4 reads only the last own echo", async () => {
    const earlier = marked("old", renderRulingEcho({ ...ruling, reason: "old" }), `wr-waived-${key}`);
    const source = thread(opener(), earlier, echo());
    const result = readItemThreads([source], [index()], "bot");
    expect(result.items).toEqual([{ key, itemId: "B3", kind: "finding", thread: source, ruling, replies: [] }]);
  });
  test("AC-5 keeps non-own replies after the last own comment including the same login unmarked", async () => {
    const sameLogin = comment("3", "actually reconsider");
    const other = marked("4", "human marked reply", "note", "alice");
    const source = thread(opener(), comment("early", "waive", "alice"), echo(), sameLogin, other);
    expect(readItemThreads([source], [index()], "bot").items[0]?.replies).toEqual([sameLogin, other]);
  });
  test.each(["wq-w-B3.12345678-3", "wc-w-B3.12345678"])("last own %s comment is not a ruling", async (marker) => {
    const result = readItemThreads([thread(opener(), echo(), marked("3", "notice", marker))], [index()], "bot");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.ruling).toBeUndefined();
  });
  test("retains unindexed owned threads for publish and ignores empty or malformed threads", async () => {
    const result = readItemThreads(
      [thread(), thread(comment("x", "unmarked")), thread(marked("x", "invalid", key)), thread(opener())],
      [],
      "bot",
    );
    expect(result.items.map((entry) => entry.key)).toEqual([key]);
  });
  test.each(["bad echo", renderRulingEcho(ruling)])(
    "invalid or mismatched echo body %s does not rule",
    async (body) => {
      const result = readItemThreads(
        [thread(opener(), marked("2", body, "wr-waived-w-B4.12345678"))],
        [index()],
        "bot",
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0]?.ruling).toBeUndefined();
    },
  );
});

describe("unindexedItemKeys", () => {
  test.each([false, true])("unindexed thread holds even when forge resolved is %s or a ruling exists", (resolved) => {
    const source = { ...thread(opener(), echo()), resolved };
    const read = readItemThreads([source], [marked("index", renderItemIndex({ keys: [] }), "w-index")], "bot");
    expect(unindexedItemKeys(read, "bot")).toEqual([key]);
    expect(unindexedItemKeys({ ...read, index: { keys: [key] } }, "bot")).toEqual([]);
  });
  test.each(["bot", "other"])("only own durable closure explains an omitted thread (%s)", (author) => {
    const closed = marked("closed", "No longer open", `wc-${key}`, author);
    const read = readItemThreads([thread(opener(), closed)], [], "bot");
    expect(unindexedItemKeys(read, "bot")).toEqual(author === "bot" ? [] : [key]);
  });
});

describe("settleItemThreads", () => {
  test("AC-6 settles a ruled item without replies", async () => {
    const entry = item();
    const canRule = mock(async () => true);
    expect(await settleItemThreads(read(entry), canRule)).toEqual({ settled: [{ ...entry, ruling }], open: [] });
    expect(canRule).not.toHaveBeenCalled();
  });
  test("AC-7 rejected replies do not reopen a ruling", async () => {
    const reply = comment("3", "reconsider", "outsider");
    const entry = item([reply]);
    const canRule = mock(async () => false);
    expect(await settleItemThreads(read(entry), canRule)).toEqual({ settled: [{ ...entry, ruling }], open: [] });
    expect(canRule).toHaveBeenCalledWith(reply);
  });
  test("AC-8 accepted reply reopens a ruled item and enters kept", async () => {
    const reply = comment("3", "reconsider", "alice");
    const entry = item([reply]);
    expect(await settleItemThreads(read(entry), async () => true)).toEqual({
      settled: [],
      open: [{ ...entry, kept: [reply] }],
    });
  });
  test("AC-9 unruled item is open with only accepted replies", async () => {
    const accepted = comment("4", "waive", "alice");
    const entry = item([comment("3", "ignore", "outsider"), accepted], false);
    expect(await settleItemThreads(read(entry), async (reply) => reply.author === "alice")).toEqual({
      settled: [],
      open: [{ ...entry, kept: [accepted] }],
    });
  });
  test("AC-10 permission throws deny only that reply and preserve an existing ruling", async () => {
    const failed = comment("3", "reconsider", "unknown");
    const entry = item([failed]);
    const canRule = async (reply: PrComment) => {
      if (reply === failed) throw new Error("lookup unavailable");
      return true;
    };
    expect(await settleItemThreads(read(entry), canRule)).toEqual({ settled: [{ ...entry, ruling }], open: [] });
    const accepted = comment("4", "waive", "alice");
    const unruled = item([failed, accepted], false);
    expect(await settleItemThreads(read(unruled), canRule)).toEqual({
      settled: [],
      open: [{ ...unruled, kept: [accepted] }],
    });
  });
  test("ignores unindexed threads and follows index order", async () => {
    const first = item([], false);
    const second = { ...first, key: "w-B4.12345678", itemId: "B4" };
    const canRule = mock(async () => true);
    expect(await settleItemThreads({ items: [item([comment("3", "waive")])] }, canRule)).toEqual({
      settled: [],
      open: [],
    });
    expect(canRule).not.toHaveBeenCalled();
    const result = await settleItemThreads(
      { index: { keys: [second.key, key] }, items: [first, second, { ...first, key: "unindexed" }] },
      canRule,
    );
    expect(result.open.map((entry) => entry.key)).toEqual([second.key, key]);
  });
  test("resolved without a reply does not rule", async () => {
    const entry = { ...item([], false), thread: { ...thread(opener()), resolved: true } };
    expect(await settleItemThreads(read(entry), async () => true)).toEqual({
      settled: [],
      open: [{ ...entry, kept: [] }],
    });
  });
});

test("settlement checks independent items concurrently and returns index order", async () => {
  const first = item([comment("a", "confirm", "alice")], false);
  const second = { ...item([comment("b", "confirm", "bob")], false), key: "w-B4.12345678", itemId: "B4" };
  const calls: string[] = [];
  const finish: (() => void)[] = [];
  const pending = settleItemThreads({ index: { keys: [first.key, second.key] }, items: [first, second] }, (reply) => {
    calls.push(reply.author);
    return new Promise<boolean>((resolve) => finish.push(() => resolve(true)));
  });
  expect(calls).toEqual(["alice", "bob"]);
  for (const resolve of finish.reverse()) resolve();
  expect((await pending).open.map((item) => item.itemId)).toEqual(["B3", "B4"]);
});
