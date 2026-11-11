/**
 * US-011 (branch-review-coverage): the recorder stamps the PR head on a `verified` ruling recorded for
 * an item whose opener lists files, so the approval names the commit it covered. A ruling on an item
 * with no file list, and every other disposition, is recorded sha-less.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import type { CallerRuling } from "@/bot/caller-rulings";
import { _rulingsDeps, type RecordRulingsInput, recordPrRulings } from "@/bot/rulings";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrInfo, PrThread } from "@/forge/pr-types";
import type { BotRulingReadInput, BotRulingReadVerdict } from "@/operations/bot-ruling-read";
import { renderItemIndex, renderItemOpener } from "@/workflow/item-threads";
import type { OpenItem } from "@/workflow/types";

const head = `c0ffee1${"b".repeat(33)}`;
const short = head.slice(0, 7);
const key = "w-B3.12345678";
const coverageItem: OpenItem = { id: "B3", kind: "reason", issue: "Unread: a.ts, b.ts", files: ["a.ts", "b.ts"] };
const plainItem: OpenItem = { id: "B3", kind: "reason", issue: "Unread: a.ts, b.ts" };
const comment = (id: string, body: string, author = "bot"): PrComment => ({
  id,
  body,
  author,
  authorId: 7,
  kind: "thread",
  createdAt: "2026-01-01T00:00:00Z",
});
const opener = (item: OpenItem) => comment("1", withNaxBotMarker(renderItemOpener(item), key));
const reply = (body: string, author = "alice") => comment("2", body, author);
const thread = (...comments: PrComment[]): PrThread => ({
  id: "thread",
  replyTo: "1",
  resolved: false,
  outdated: false,
  comments,
});
const info: PrInfo = {
  number: 1,
  title: "PR",
  body: "stale",
  url: "https://example/pr/1",
  state: "open",
  draft: true,
  author: { login: "alice" },
  baseRef: "main",
  headRef: "feature",
  headSha: head,
  crossRepo: false,
};
const original = { ..._rulingsDeps };
const logger = makeLogger();
const post = mock(async (_ref: unknown, _thread: unknown, _body: string) => ({ id: "posted" }));
const run = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const readModel = mock(async (_input: BotRulingReadInput): Promise<BotRulingReadVerdict | null> => null);
/** The echo text inside the `withNaxBotMarker` envelope `replyToThread` receives. */
const unwrap = (body: string): string => body.split("\n").slice(2, -2).join("\n");
const posted = (): string => post.mock.calls[0]?.[2] ?? "";
const caller = (over: Partial<CallerRuling> = {}): CallerRuling => ({
  item: "B3",
  ruling: "verified",
  by: "orch:alice",
  at: "2026-01-02T00:00:00Z",
  ...over,
});
function input(threads: PrThread[], callerRulings?: CallerRuling[]): RecordRulingsInput {
  return {
    ref: { forge: "github", host: "github.com", repo: "org/repo", number: 1 },
    info,
    login: "bot",
    threads,
    comments: [comment("index", withNaxBotMarker(renderItemIndex({ keys: [key] }), "w-index"))],
    deps: { run, readText: async () => null },
    cwd: "/checkout",
    readModel,
    ...(callerRulings === undefined ? {} : { callerRulings }),
  };
}

beforeEach(() => {
  logger.reset();
  for (const fn of [post, run, readModel]) fn.mockClear();
  post.mockImplementation(async () => ({ id: "posted" }));
  readModel.mockImplementation(async () => null);
  Object.assign(_rulingsDeps, {
    editComment: mock(async () => {}),
    hasWriteAccess: mock(async () => true),
    replyToThread: post,
    resolveThread: mock(async () => {}),
    readPrInfo: mock(async () => ({ ...info, body: "- [ ] **B3** (reason): Unread: a.ts, b.ts" })),
    getLogger: () => logger,
  });
});
afterEach(() => Object.assign(_rulingsDeps, original));

describe("recordPrRulings: verified ruling head (US-011)", () => {
  test("AC-7 stamps the PR head on a verified reply to a file-carrying item", async () => {
    const out = await recordPrRulings(input([thread(opener(coverageItem), reply("verified"))]));
    expect(out.recorded).toHaveLength(1);
    expect(out.recorded[0]).toMatchObject({ disposition: "verified", sha: head, by: "alice" });
    expect(out.settled[0]?.ruling.sha).toBe(head);
  });

  test("AC-8 the echo names the abbreviated head it covered", async () => {
    await recordPrRulings(input([thread(opener(coverageItem), reply("verified"))]));
    expect(post).toHaveBeenCalledTimes(1);
    expect(posted()).toContain(`wr-verified-${key}`);
    expect(unwrap(posted()).startsWith(`Recorded: verified in ${short} — `)).toBe(true);
  });

  test("AC-9 an item with no file list records a verified ruling with no sha", async () => {
    const out = await recordPrRulings(input([thread(opener(plainItem), reply("verified"))]));
    expect(out.recorded).toHaveLength(1);
    expect(out.recorded[0]).not.toHaveProperty("sha");
    expect(unwrap(posted()).startsWith("Recorded: verified — ")).toBe(true);
  });

  test("AC-9 an opener whose Files block is empty records no sha", async () => {
    const out = await recordPrRulings(input([thread(opener({ ...plainItem, files: [] }), reply("verified"))]));
    expect(out.recorded[0]).not.toHaveProperty("sha");
  });

  test("AC-10 a caller's verified ruling records the same head", async () => {
    const out = await recordPrRulings(input([thread(opener(coverageItem))], [caller()]));
    expect(out.recorded).toHaveLength(1);
    expect(out.recorded[0]).toMatchObject({ disposition: "verified", sha: head, by: null, callerBy: "orch:alice" });
    expect(unwrap(posted()).startsWith(`Recorded: verified in ${short} — `)).toBe(true);
  });

  test("AC-11 a waived reply on a file-carrying item records no sha", async () => {
    const out = await recordPrRulings(input([thread(opener(coverageItem), reply("waive: accepted risk"))]));
    expect(out.recorded[0]).toMatchObject({ disposition: "waived", reason: "accepted risk" });
    expect(out.recorded[0]).not.toHaveProperty("sha");
    expect(unwrap(posted()).startsWith("Recorded: waived — ")).toBe(true);
  });

  test("a model-read verified ruling is stamped the same way", async () => {
    readModel.mockImplementation(async () => ({
      rulings: [{ id: "B3", disposition: "verified", reason: "read all", quote: "read both files" }],
    }));
    const out = await recordPrRulings(input([thread(opener(coverageItem), reply("I read both files, all good"))]));
    expect(out.recorded[0]).toMatchObject({ disposition: "verified", reason: "read all", sha: head });
    expect(unwrap(posted()).startsWith(`Recorded: verified in ${short} — `)).toBe(true);
  });

  test("a model-read verified ruling on an item with no files stays sha-less", async () => {
    readModel.mockImplementation(async () => ({
      rulings: [{ id: "B3", disposition: "verified", reason: "read all", quote: "read both files" }],
    }));
    const out = await recordPrRulings(input([thread(opener(plainItem), reply("I read both files, all good"))]));
    expect(out.recorded[0]).not.toHaveProperty("sha");
  });

  test("a fixed reply keeps its own sha instead of the head", async () => {
    const out = await recordPrRulings(input([thread(opener(coverageItem), reply("fixed abc1234 — gone"))]));
    expect(out.recorded[0]).toMatchObject({ disposition: "fixed", sha: "abc1234" });
    expect(unwrap(posted()).startsWith("Recorded: fixed in abc1234 — ")).toBe(true);
  });

  test("a head the echo could not carry back is not stamped", async () => {
    const value = { ...input([thread(opener(coverageItem), reply("verified"))]), info: { ...info, headSha: "head" } };
    const out = await recordPrRulings(value);
    expect(out.recorded[0]).toMatchObject({ disposition: "verified" });
    expect(out.recorded[0]).not.toHaveProperty("sha");
    expect(unwrap(posted()).startsWith("Recorded: verified — ")).toBe(true);
  });
});
