import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import { CallerRecordingError, type CallerRuling } from "@/bot/caller-rulings";
import { _rulingsDeps, type RecordRulingsInput, recordPrRulings } from "@/bot/rulings";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrInfo, PrThread } from "@/forge/pr-types";
import { renderItemIndex, renderItemOpener } from "@/workflow/item-threads";

const key = "w-B3.12345678";
const comment = (id: string, body: string, author = "bot", createdAt = "2026-01-01T00:00:00Z"): PrComment => ({
  id,
  body,
  author,
  authorId: 7,
  kind: "thread",
  createdAt,
});
const opener = () => comment("1", withNaxBotMarker(renderItemOpener({ id: "B3", kind: "finding", issue: "x" }), key));
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
const post = mock(async (_ref: unknown, _thread: unknown, _body: string) => ({ id: "posted" }));
const postedBody = (): string => post.mock.calls[0]?.[2] ?? "";
const run = mock(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const readModel = mock(async () => null);
const caller = (over: Partial<CallerRuling> = {}): CallerRuling => ({
  item: "B3",
  ruling: "waive: accepted risk",
  by: "orch:alice",
  at: "2026-01-02T00:00:00Z",
  ...over,
});
const input = (threads: PrThread[], callerRulings?: CallerRuling[]): RecordRulingsInput => ({
  ref: { forge: "github", host: "github.com", repo: "org/repo", number: 1 },
  info,
  login: "bot",
  threads,
  comments: [comment("index", withNaxBotMarker(renderItemIndex({ keys: [key] }), "w-index"))],
  deps: { run, readText: async () => null },
  cwd: "/checkout",
  readModel,
  ...(callerRulings === undefined ? {} : { callerRulings }),
});

beforeEach(() => {
  for (const fn of [post, run, readModel]) fn.mockClear();
  Object.assign(_rulingsDeps, {
    editComment: mock(async () => {}),
    hasWriteAccess: mock(async () => true),
    replyToThread: post,
    resolveThread: mock(async () => {}),
    readPrInfo: mock(async () => ({ ...info, body: "- [ ] **B3** (finding): x" })),
    getLogger: () => logger,
  });
});
afterEach(() => Object.assign(_rulingsDeps, original));

describe("recordPrRulings with caller rulings", () => {
  test("records through the same echo path with caller provenance", async () => {
    const value = input([thread(opener())], [caller()]);
    const out = await recordPrRulings(value);
    expect(post).toHaveBeenCalledTimes(1);
    const body = postedBody();
    expect(body).toContain("Recorded: waived — accepted risk (caller ruling by orch:alice)");
    expect(body).toContain(`wr-waived-${key}`);
    expect(out.recorded).toHaveLength(1);
    expect(out.settled).toHaveLength(1);
    expect(out.callerRulings).toEqual({ applied: [{ item: "B3", disposition: "waived" }], skipped: [] });
  });
  test("no callerRulings in the outcome without the input", async () => {
    const out = await recordPrRulings(input([thread(opener())]));
    expect(out).not.toHaveProperty("callerRulings");
  });
  test("a later writer ruling wins and the caller ruling is skipped", async () => {
    const writer = comment("2", "confirm", "alice", "2026-01-03T00:00:00Z");
    const out = await recordPrRulings(input([thread(opener(), writer)], [caller()]));
    const body = postedBody();
    expect(body).toContain("Recorded: confirmed");
    expect(body).not.toContain("caller ruling");
    expect(out.callerRulings).toEqual({ applied: [], skipped: [{ item: "B3", reason: "superseded-by-writer" }] });
  });
  test("a caller ruling wins over an older writer reply", async () => {
    const writer = comment("2", "confirm", "alice", "2026-01-01T12:00:00Z");
    const out = await recordPrRulings(input([thread(opener(), writer)], [caller()]));
    expect(out.callerRulings?.applied).toEqual([{ item: "B3", disposition: "waived" }]);
  });
  test("a newer natural-language writer reply goes to the model path instead of the caller ruling", async () => {
    const objection = comment("2", "actually this needs a fix, do not waive", "alice", "2026-01-03T00:00:00Z");
    const out = await recordPrRulings(input([thread(opener(), objection)], [caller()]));
    expect(readModel).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining("caller ruling"),
      expect.anything(),
      expect.anything(),
    );
    expect(out.callerRulings?.skipped).toEqual([{ item: "B3", reason: "superseded-by-writer" }]);
  });
  test("a recorder failure reports what was recorded and marks the rest recorder-failed", async () => {
    const keyB = "w-B4.12345678";
    const openerB = comment("3", withNaxBotMarker(renderItemOpener({ id: "B4", kind: "finding", issue: "y" }), keyB));
    const openerC = comment(
      "4",
      withNaxBotMarker(renderItemOpener({ id: "B5", kind: "finding", issue: "z" }), "w-B5.12345678"),
    );
    const value = {
      ...input(
        [
          thread(opener()),
          { ...thread(openerB), id: "tb", replyTo: "3" },
          { ...thread(openerC), id: "tc", replyTo: "4" },
        ],
        [caller(), caller({ item: "B4" }), caller({ item: "B5" }), caller({ item: "Z9" })],
      ),
      comments: [
        comment("index", withNaxBotMarker(renderItemIndex({ keys: [key, keyB, "w-B5.12345678"] }), "w-index")),
      ],
    };
    post.mockImplementationOnce(async () => ({ id: "one" }));
    post.mockImplementationOnce(async () => ({ id: "two" }));
    post.mockImplementationOnce(async () => {
      throw new Error("forge down");
    });
    // The third echo fails and its warning path throws, so the recorder aborts after two echoes.
    Object.assign(_rulingsDeps, {
      getLogger: () => {
        throw new Error("logger down");
      },
    });
    const failure = await recordPrRulings(value).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CallerRecordingError);
    expect((failure as CallerRecordingError).callerRulings).toEqual({
      applied: [
        { item: "B3", disposition: "waived" },
        { item: "B4", disposition: "waived" },
      ],
      skipped: [
        { item: "Z9", reason: "unknown-item" },
        { item: "B5", reason: "recorder-failed" },
      ],
    });
  });
  test("an unrecognised older writer reply is not sent to the model when a caller ruling decides the item", async () => {
    const chatter = comment("2", "please look again", "alice", "2026-01-01T12:00:00Z");
    await recordPrRulings(input([thread(opener(), chatter)], [caller()]));
    expect(readModel).not.toHaveBeenCalled();
  });
  test("unknown items and stale keys post nothing", async () => {
    const out = await recordPrRulings(
      input([thread(opener())], [caller({ item: "Z9" }), caller({ item: "B3", key: "w-B3.deadbeef" })]),
    );
    expect(post).not.toHaveBeenCalled();
    expect(out.callerRulings?.skipped).toEqual([
      { item: "Z9", reason: "unknown-item" },
      { item: "B3", reason: "stale-key" },
    ]);
  });
  test("an echo failure leaves the item open and is reported", async () => {
    post.mockImplementationOnce(async () => {
      throw new Error("forge down");
    });
    const out = await recordPrRulings(input([thread(opener())], [caller()]));
    expect(out.open).toHaveLength(1);
    expect(out.callerRulings).toEqual({ applied: [], skipped: [{ item: "B3", reason: "echo-failed" }] });
  });
  test("a second review with the same file does not re-record the settled item", async () => {
    const first = await recordPrRulings(input([thread(opener())], [caller()]));
    const echo = comment("echo", postedBody());
    post.mockClear();
    const second = await recordPrRulings(input([thread(opener(), echo)], [caller()]));
    expect(first.recorded).toHaveLength(1);
    expect(post).not.toHaveBeenCalled();
    expect(second.callerRulings?.skipped).toEqual([{ item: "B3", reason: "already-settled" }]);
  });
});
