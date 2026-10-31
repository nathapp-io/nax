/** A bot `fix-` reply answers a ruling without hiding it from readItemThreads. */
import { describe, expect, test } from "bun:test";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrThread } from "@/forge/pr-types";
import { readItemThreads, settleItemThreads } from "@/workflow/item-thread-state";
import { renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";

const key = "w-D-1.12345678";
const ruling = {
  itemKey: key,
  itemId: "D-1",
  disposition: "confirmed",
  reason: "keep the counter atomic",
  by: "alice",
} as const;
const comment = (id: string, body: string, author = "bot"): PrComment => ({
  id,
  body,
  author,
  kind: "thread",
  createdAt: "2026-01-01T00:00:00Z",
});
const marked = (id: string, body: string, marker: string, author = "bot") =>
  comment(id, withNaxBotMarker(body, marker), author);
const opener = () =>
  marked("1", renderItemOpener({ id: "D-1", kind: "advisor", issue: "read-modify-write on the counter" }), key);
const echo = () => marked("2", renderRulingEcho(ruling), `wr-confirmed-${key}`);
const fix = (id = "3", marker = `fix-${key}`, author = "bot") =>
  marked(id, "Fixed in abc1234: the counter update is atomic", marker, author);
const reply = (id = "4", author = "alice") => comment(id, "confirm", author);
const thread = (...comments: PrComment[]): PrThread => ({
  id: "thread",
  replyTo: "1",
  resolved: false,
  outdated: false,
  comments,
});
const index = () => marked("index", renderItemIndex({ keys: [key] }), "w-index");
const read = (...comments: PrComment[]) => readItemThreads([thread(...comments)], [index()], "bot");
const only = (...comments: PrComment[]) => read(...comments).items[0];

describe("readItemThreads fix-closed derivation", () => {
  test("AC-1 keeps a confirmed ruling and sets no fixClosed when the echo is the last comment", () => {
    const item = only(opener(), echo());
    expect(item?.ruling?.disposition).toBe("confirmed");
    expect(item).not.toHaveProperty("fixClosed");
  });

  test("AC-2 sets fixClosed true when an own fix comment follows the echo", () => {
    const item = only(opener(), echo(), fix());
    expect(item?.ruling?.disposition).toBe("confirmed");
    expect(item?.fixClosed).toBe(true);
  });

  test("AC-3 ignores an own fix comment posted before the echo", () => {
    const item = only(opener(), fix(), echo());
    expect(item?.ruling?.disposition).toBe("confirmed");
    expect(item).not.toHaveProperty("fixClosed");
  });

  test("AC-4 ignores an own fix comment carrying another item key", () => {
    const item = only(opener(), echo(), fix("3", "fix-w-D-2.87654321"));
    expect(item?.ruling?.disposition).toBe("confirmed");
    expect(item).not.toHaveProperty("fixClosed");
  });

  test("AC-5 ignores a fix comment authored by another login", () => {
    const item = only(opener(), echo(), fix("3", `fix-${key}`, "alice"));
    expect(item?.ruling?.disposition).toBe("confirmed");
    expect(item).not.toHaveProperty("fixClosed");
  });

  test("AC-6 returns neither ruling nor fixClosed when an own fix comment has no ruling echo", () => {
    const item = only(opener(), fix());
    expect(item).toBeDefined();
    expect(item?.ruling).toBeUndefined();
    expect(item).not.toHaveProperty("fixClosed");
  });

  test("AC-7 keeps a non-own writer reply posted after the fix comment", () => {
    const after = reply();
    const item = only(opener(), echo(), fix(), after);
    expect(item?.replies).toEqual([after]);
    expect(item?.fixClosed).toBe(true);
  });

  test("AC-8 settleItemThreads keeps that item open with the post-fix writer reply in kept", async () => {
    const after = reply();
    const result = await settleItemThreads(read(opener(), echo(), fix(), after), async () => true);
    expect(result.settled).toEqual([]);
    expect(result.open.map(({ key: itemKey, kept }) => ({ key: itemKey, kept }))).toEqual([{ key, kept: [after] }]);
  });

  test("AC-9 returns empty replies when a non-own reply precedes the later fix comment", () => {
    const item = only(opener(), echo(), reply(), fix());
    expect(item?.replies).toEqual([]);
    expect(item?.fixClosed).toBe(true);
  });

  test("AC-10 settles an item whose writer reply precedes the later fix comment", async () => {
    const result = await settleItemThreads(read(opener(), echo(), reply(), fix()), async () => true);
    expect(result.open).toEqual([]);
    expect(result.settled.map((entry) => entry.key)).toEqual([key]);
  });

  test("AC-11 returns ruling and replies exactly as before for an opener and one echo", () => {
    const source = thread(opener(), echo());
    expect(readItemThreads([source], [index()], "bot").items).toEqual([
      { key, itemId: "D-1", kind: "advisor", thread: source, ruling, replies: [] },
    ]);
  });
});
