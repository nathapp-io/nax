import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { _rulingsDeps, type RecordRulingsInput, readSettledKeys, recordPrRulings } from "@/bot/rulings";
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
const edit = mock(async () => {});
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
  for (const fn of [edit, access, post, resolve, read, tick, run, readModel]) fn.mockClear();
  edit.mockImplementation(async () => {});
  access.mockImplementation(async () => true);
  post.mockImplementation(async () => ({ id: "posted" }));
  resolve.mockImplementation(async () => {});
  read.mockImplementation(async () => ({ ...info, body: "- [ ] **B3** (finding): x\n- [ ] **B30** untouched" }));
  run.mockImplementation(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
  Object.assign(_rulingsDeps, {
    editComment: edit,
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

describe("recordPrRulings index refresh", () => {
  test("US-006 AC-11 refreshes using the original provenance", async () => {
    const value = input();
    await recordPrRulings(value);
    expect(edit).toHaveBeenCalledWith(
      value.ref,
      value.comments[0],
      withNaxBotMarker(renderItemIndex({ keys: [key], reviewedHead: info.headSha }, 1), "w-index"),
      value.deps,
      value.cwd,
    );
  });
  test("US-006 AC-12 does not rewrite matching body", async () => {
    await recordPrRulings({ ...input(), comments: [marked("index", renderItemIndex({ keys: [key] }, 1), "w-index")] });
    expect(edit).not.toHaveBeenCalled();
  });
  test("US-006 AC-13 no owned index means no refresh", async () => {
    await recordPrRulings({ ...input(), comments: [] });
    expect(edit).not.toHaveBeenCalled();
  });
  test("US-006 AC-14 excludes settled threads outside the index", async () => {
    const otherKey = "w-B4.12345678";
    const other = thread(
      marked("other", renderItemOpener({ id: "B4", kind: "finding", issue: "other" }), otherKey),
      marked("other-echo", renderRulingEcho({ ...ruling, itemId: "B4", itemKey: otherKey }), `wr-waived-${otherKey}`),
    );
    await recordPrRulings(input([thread(opener(), echo()), other]));
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit.mock.calls[0]).toBeDefined();
    expect(edit).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("nax workflow items: 1 (1 settled)"),
      expect.anything(),
      "/checkout",
    );
  });
  test("US-006 AC-15/16/17 refresh failure warns and leaves the full outcome unchanged", async () => {
    const value = input();
    const success = await recordPrRulings(value);
    edit.mockImplementation(async () => {
      throw new Error("refresh failed");
    });
    const failed = await recordPrRulings(value);
    expect(failed).toEqual(success);
    expect(failed.settled).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot-rulings",
      "[bot-rulings] Could not refresh the item index",
      expect.objectContaining({ error: "refresh failed" }),
    );
  });
});

// US-001 / B1: the readiness hold reconciles an immutable review artifact against the PR as it is now,
// so this read must settle what a durable ruling or a closed finding thread has closed — and write nothing.
describe("readSettledKeys", () => {
  const findingKey = "f-1a2b3c4d";
  const findingThread = (resolved: boolean, author = "bot"): PrThread => ({
    id: "finding-thread",
    replyTo: "2",
    resolved,
    outdated: false,
    comments: [
      comment("5", withNaxBotMarker("leaks the token", findingKey), author),
      comment("6", "fixed in abc1234", "alice"),
    ],
  });

  /** A bot finding thread whose newest reply is `body` by `author` (default: an authorized writer). */
  const ruledFinding = (resolved: boolean, body: string, author = "alice"): PrThread => {
    const base = findingThread(resolved);
    return { ...base, comments: [...base.comments, comment("7", body, author)] };
  };

  test("a resolved own finding thread settles its key; an open one does not", async () => {
    expect(await readSettledKeys(input([findingThread(true)]))).toEqual(new Set([findingKey]));
    expect(await readSettledKeys(input([findingThread(false)]))).toEqual(new Set());
  });

  // B1: `recordFindingRulings` applies an authorized non-confirming ruling whether or not the thread was
  // resolved (resolution is presentation only). Reading resolution alone let a waiver the recorder honoured
  // hold readiness forever after a failed resolve.
  test("B1: an authorized waiver settles its finding thread even while the thread is unresolved", async () => {
    expect(await readSettledKeys(input([ruledFinding(false, "waive: by design")]))).toEqual(new Set([findingKey]));
    expect(await readSettledKeys(input([ruledFinding(false, "override: out of scope")]))).toEqual(
      new Set([findingKey]),
    );
    expect(await readSettledKeys(input([ruledFinding(false, "fixed abc1234 — gone")]))).toEqual(new Set([findingKey]));
  });

  test("B1: an unauthorized waiver settles nothing", async () => {
    access.mockImplementation(async () => false);
    expect(await readSettledKeys(input([ruledFinding(false, "waive: by design")]))).toEqual(new Set());
    expect(await readSettledKeys(input([ruledFinding(false, "waive: by design", "outsider")]))).toEqual(new Set());
  });

  // B5: a resolved thread said nothing about a later authorized ruling. A writer who reconfirms the finding
  // reopened outstanding work, so resolution alone must not settle it.
  test("B5: an authorized reconfirmation reopens a resolved finding thread", async () => {
    expect(await readSettledKeys(input([ruledFinding(true, "confirm")]))).toEqual(new Set());
    expect(await readSettledKeys(input([ruledFinding(true, "verified")]))).toEqual(new Set());
  });

  test("B5: a waiver after a reconfirmation settles the finding again", async () => {
    const base = findingThread(true);
    const threadWithBoth: PrThread = {
      ...base,
      comments: [...base.comments, comment("7", "confirm"), comment("8", "waive: by design")],
    };
    expect(await readSettledKeys(input([threadWithBoth]))).toEqual(new Set([findingKey]));
  });

  test("a finding thread someone else opened settles nothing", async () => {
    expect(await readSettledKeys(input([findingThread(true, "alice")]))).toEqual(new Set());
  });

  test("an indexed item with a ruling echo is settled; a writer reply reopens it", async () => {
    expect(await readSettledKeys(input([thread(opener(), echo())]))).toEqual(new Set([key]));
    expect(await readSettledKeys(input([thread(opener(), echo(), reply())]))).toEqual(new Set());
  });

  test("reads settlements without echoing, resolving, editing or calling a model", async () => {
    await readSettledKeys(input([thread(opener(), reply("confirm")), findingThread(true)]));
    expect(post).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(edit).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
    expect(readModel).not.toHaveBeenCalled();
  });
});
