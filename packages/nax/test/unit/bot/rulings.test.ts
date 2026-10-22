import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { _rulingsDeps, type RecordRulingsInput, recordPrRulings } from "@/bot/rulings";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrInfo, PrThread } from "@/forge/pr-types";
import { renderItemIndex, renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";
import { tickChecklist } from "@/workflow/promote";

const key = "w-B3.12345678";
const ruling = { itemKey: key, itemId: "B3", disposition: "waived", reason: "ok", by: "alice" } as const;
const comment = (id: string, body: string, author = "bot"): PrComment => ({
  id,
  body,
  author,
  authorId: 7,
  kind: "thread",
  createdAt: "2026-01-01T00:00:00Z",
});
const marked = (id: string, body: string, marker: string) => comment(id, withNaxBotMarker(body, marker));
const opener = (kind: "finding" | "ruling" = "finding") =>
  marked("1", renderItemOpener({ id: "B3", kind, issue: "x" }), key);
const reply = (body = "waive: ok", author = "alice") => comment("2", body, author);
const echo = () => marked("echo", renderRulingEcho(ruling), `wr-waived-${key}`);
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
  headSha: "a".repeat(40),
  crossRepo: false,
};
const original = { ..._rulingsDeps };
const logger = makeLogger();
const access = mock(async (..._args: Parameters<typeof _rulingsDeps.hasWriteAccess>) => true);
const post = mock(async () => ({ id: "posted" }));
const resolve = mock(async () => {});
const read = mock(async () => ({ ...info, body: "- [ ] **B3** (finding): x\n- [ ] **B30** untouched" }));
const tick = mock(tickChecklist);
const run = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const readModel = mock(async () => null);
const input = (threads = [thread(opener(), reply())]): RecordRulingsInput => ({
  ref: { forge: "github", host: "github.com", repo: "org/repo", number: 1 },
  info,
  login: "bot",
  threads,
  comments: [marked("index", renderItemIndex({ keys: [key], reviewedHead: "a".repeat(40) }), "w-index")],
  deps: { run, readText: async () => null },
  cwd: "/checkout",
  readModel,
});

beforeEach(() => {
  logger.reset();
  for (const fn of [access, post, resolve, read, tick, run, readModel]) fn.mockClear();
  access.mockImplementation(async () => true);
  post.mockImplementation(async () => ({ id: "posted" }));
  resolve.mockImplementation(async () => {});
  read.mockImplementation(async () => ({ ...info, body: "- [ ] **B3** (finding): x\n- [ ] **B30** untouched" }));
  run.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  Object.assign(_rulingsDeps, {
    hasWriteAccess: access,
    replyToThread: post,
    resolveThread: resolve,
    readPrInfo: read,
    tickChecklist: tick,
    getLogger: () => logger,
  });
});
afterEach(() => Object.assign(_rulingsDeps, original));

describe("recordPrRulings", () => {
  test("AC-1 newest kept keyword posts one owned echo attributed to its author", async () => {
    const value = input([thread(opener(), reply("confirm"), reply())]);
    const out = await recordPrRulings(value);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      value.ref,
      value.threads[0],
      withNaxBotMarker(renderRulingEcho(ruling), `wr-waived-${key}`),
      value.deps,
      "/checkout",
    );
    expect(out.recorded).toEqual([ruling]);
    expect(out.asked).toBe(0);
    expect(out.failed).toBe(0);
    expect(readModel).not.toHaveBeenCalled();
  });
  test("AC-2 resolves once after the echo", async () => {
    const order: string[] = [];
    post.mockImplementation(async () => {
      order.push("echo");
      return { id: "posted" };
    });
    resolve.mockImplementation(async () => {
      order.push("resolve");
    });
    const value = input();
    await recordPrRulings(value);
    expect(order).toEqual(["echo", "resolve"]);
    expect(resolve).toHaveBeenCalledWith(value.ref, value.threads[0], value.deps, "/checkout");
  });
  test("AC-3 denied replies produce no echo or reopening", async () => {
    access.mockImplementation(async () => false);
    const out = await recordPrRulings(input([thread(opener(), echo(), reply())]));
    expect(post).not.toHaveBeenCalled();
    expect(out.open).toHaveLength(0);
    expect(out.settled).toHaveLength(1);
  });
  test("US-004 AC-9/AC-10 access failure denies the reply and preserves the warning route", async () => {
    access.mockImplementation(async () => {
      throw new Error("permission unavailable");
    });
    const out = await recordPrRulings(input());
    expect(post).not.toHaveBeenCalled();
    expect(out.open).toHaveLength(1);
    expect(out.open[0]?.kept).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot-rulings",
      "[bot-rulings] Could not check ruling permission",
      expect.objectContaining({ login: "alice", error: "permission unavailable" }),
    );
  });
  test("AC-5 memoizes concurrent permission checks by login, separately on each call", async () => {
    const value = input([thread(opener(), reply("confirm"), reply())]);
    await recordPrRulings(value);
    expect(access).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledWith(value.ref, { login: "alice", id: 7 }, value.deps, value.cwd);
    await recordPrRulings(value);
    expect(access).toHaveBeenCalledTimes(2);
  });
  test("AC-6 ignores threads outside the index", async () => {
    const out = await recordPrRulings({
      ...input(),
      comments: [marked("index", renderItemIndex({ keys: ["w-other.12345678"] }), "w-index")],
    });
    expect(out.settled).toEqual([]);
    expect(out.open).toEqual([]);
    expect(access).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  test("AC-7 echo failure leaves item open, counts failure and skips resolve", async () => {
    post.mockImplementation(async () => {
      throw new Error("echo failed");
    });
    const out = await recordPrRulings(input());
    expect(out.open.map((item) => item.key)).toEqual([key]);
    expect(out.settled).toEqual([]);
    expect(out.recorded).toEqual([]);
    expect(out.failed).toBe(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-8 resolve failure keeps successful echo settled and warns", async () => {
    resolve.mockImplementation(async () => {
      throw new Error("resolve failed");
    });
    const out = await recordPrRulings(input());
    expect(out.settled[0]?.ruling).toEqual(ruling);
    expect(out.open).toEqual([]);
    expect(out.recorded).toEqual([ruling]);
    expect(out.failed).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot-rulings",
      expect.any(String),
      expect.objectContaining({ threadId: "thread", error: "resolve failed" }),
    );
  });
  test("AC-9 retries resolution of previously settled unresolved thread without echo", async () => {
    const out = await recordPrRulings(input([thread(opener(), echo())]));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
    expect(out.recorded).toEqual([]);
    expect(out.settled).toHaveLength(1);
  });
  test("AC-10 rereads current body then ticks matching settled entries only", async () => {
    const value = input();
    await recordPrRulings(value);
    expect(read).toHaveBeenCalledWith(value.ref, value.deps, value.cwd);
    expect(tick).toHaveBeenCalledWith("- [ ] **B3** (finding): x\n- [ ] **B30** untouched", [
      { id: "B3", kind: "finding", disposition: "waived", reason: "ok" },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      ["gh", "pr", "edit", info.url, "--body", "- [x] **B3** (finding): x — waived: ok\n- [ ] **B30** untouched"],
      { cwd: "/checkout" },
    );
  });
  test("AC-10 ticks multiple previously settled items but excludes an absent checklist id", async () => {
    const extra = (id: string): PrThread => {
      const itemKey = `w-${id}.12345678`;
      return {
        ...thread(
          marked(`${id}-open`, renderItemOpener({ id, kind: "gate", issue: "gate" }), itemKey),
          marked(`${id}-echo`, renderRulingEcho({ ...ruling, itemId: id, itemKey }), `wr-waived-${itemKey}`),
        ),
        id,
      };
    };
    read.mockImplementation(async () => ({ ...info, body: "- [ ] **B3** x\n- [ ] **B4** y" }));
    const out = await recordPrRulings({
      ...input([thread(opener(), echo()), extra("B4"), extra("B5")]),
      comments: [marked("index", renderItemIndex({ keys: [key, "w-B4.12345678", "w-B5.12345678"] }), "w-index")],
    });
    expect(out.settled).toHaveLength(3);
    expect(tick).toHaveBeenCalledWith("- [ ] **B3** x\n- [ ] **B4** y", [
      { id: "B3", kind: "finding", disposition: "waived", reason: "ok" },
      { id: "B4", kind: "gate", disposition: "waived", reason: "ok" },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });
  test("AC-11 ruling kind maps to advisor and fixed retains sha", async () => {
    await recordPrRulings(input([thread(opener("ruling"), reply("fixed abc1234567 — gone"))]));
    expect(tick).toHaveBeenCalledWith(expect.any(String), [
      { id: "B3", kind: "advisor", disposition: "fixed", reason: "gone", sha: "abc1234567" },
    ]);
  });
  test("AC-12 unchanged current body is not edited", async () => {
    read.mockImplementation(async () => ({ ...info, body: "- [x] **B3** already ticked" }));
    await recordPrRulings(input());
    expect(read).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });
  test.each(["throws", "nonzero"])("AC-13 body edit %s warns without discarding outcome", async (mode) => {
    run.mockImplementation(async () => {
      if (mode === "throws") throw new Error("edit failed");
      return { exitCode: 1, stdout: "", stderr: "edit failed" };
    });
    const out = await recordPrRulings(input());
    expect(out.settled).toHaveLength(1);
    expect(out.recorded).toEqual([ruling]);
    expect(logger.warn).toHaveBeenCalled();
  });
  test("AC-14 preserves index including reviewed head", async () => {
    const out = await recordPrRulings(input());
    expect(out.index).toEqual({ keys: [key], reviewedHead: "a".repeat(40) });
  });
  test("newest kept nonkeyword does not fall back to an older keyword when model is unavailable", async () => {
    const out = await recordPrRulings(input([thread(opener(), reply(), reply("please reconsider"))]));
    expect(post).not.toHaveBeenCalled();
    expect(out.open).toHaveLength(1);
    expect(readModel).toHaveBeenCalledTimes(1);
  });
  test("ignores newest nonwriter reply and uses newest writer reply", async () => {
    access.mockImplementation(async (...args) => args[1].login === "alice");
    const out = await recordPrRulings(input([thread(opener(), reply(), reply("confirm", "outsider"))]));
    expect(out.recorded).toEqual([ruling]);
  });
  test("does not resolve a previously settled already resolved thread", async () => {
    await recordPrRulings(input([{ ...thread(opener(), echo()), resolved: true }]));
    expect(resolve).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  test("body read failure is best effort and preserves recorded outcome", async () => {
    read.mockImplementation(async () => {
      throw new Error("read failed");
    });
    expect((await recordPrRulings(input())).recorded).toEqual([ruling]);
    expect(logger.warn).toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
