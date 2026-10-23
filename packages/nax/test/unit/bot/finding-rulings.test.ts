import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { makeLogger } from "@test/helpers";
import * as bot from "@/bot";
import type { FindingRulingsInput } from "@/bot/finding-rulings";
import { withNaxBotMarker } from "@/forge";
import type { PrComment, PrThread } from "@/forge/pr-types";

const key = "f-1234567890abcdef";
const comment = (id: string, body: string, author = "alice"): PrComment => ({
  id,
  body,
  author,
  kind: "thread",
  createdAt: "2026-01-01T00:00:00Z",
});
const marked = (id: string, body: string, marker: string) => comment(id, withNaxBotMarker(body, marker), "bot");
const opener = (marker = key) => marked("opener", "Missing check\nMore context", marker);
const thread = (...comments: PrComment[]): PrThread => ({
  id: "T1",
  replyTo: "opener",
  resolved: false,
  outdated: false,
  comments,
});
const logger = makeLogger();
const post = mock(async (..._args: Parameters<typeof bot._findingRulingsDeps.replyToThread>) => ({ id: "posted" }));
const resolve = mock(async (..._args: Parameters<typeof bot._findingRulingsDeps.resolveThread>) => {});
const isWriter = mock(async (_comment: PrComment) => true);
const input = (threads = [thread(opener(), comment("ruling", "waive: out of scope"))]): FindingRulingsInput => ({
  ref: { forge: "github", host: "github.com", repo: "org/repo", number: 1 },
  login: "bot",
  threads,
  cwd: "/checkout",
  isWriter,
  deps: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readText: async () => null },
});
let original: typeof bot._findingRulingsDeps | undefined;
beforeEach(() => {
  expect(bot._findingRulingsDeps).toBeDefined();
  original = { ...bot._findingRulingsDeps };
  logger.reset();
  post.mockReset();
  post.mockImplementation(async () => ({ id: "posted" }));
  resolve.mockReset();
  resolve.mockImplementation(async () => {});
  isWriter.mockReset();
  isWriter.mockImplementation(async () => true);
  Object.assign(bot._findingRulingsDeps, { replyToThread: post, resolveThread: resolve, getLogger: () => logger });
});
afterEach(() => {
  if (original) Object.assign(bot._findingRulingsDeps, original);
});

describe("findingRulingKey", () => {
  test("AC-1 exports the stable fr hash from the bot barrel", () => {
    expect(bot.findingRulingKey("T1")).toBe(`fr-${bot.earlierKey("T1").slice(2)}`);
  });
});
describe("recordFindingRulings", () => {
  test("AC-2 settles a writer waiver on an owned finding thread", async () => {
    const out = await bot.recordFindingRulings(input());
    expect(out.settled).toHaveLength(1);
    expect(out.settled[0]?.threadId).toBe("T1");
    expect(out.confirmed).toEqual([]);
    expect(out.echoed).toBe(1);
    expect(out.failed).toBe(0);
  });
  test("AC-3 returns the finding key, first issue line and keyword fields", async () => {
    const out = await bot.recordFindingRulings(input());
    expect(out.settled[0]?.ruling).toEqual({
      id: key,
      kind: "finding",
      issue: "Missing check",
      disposition: "waived",
      reason: "out of scope",
    });
  });
  test("AC-4 preserves a fixed ruling's sha", async () => {
    const out = await bot.recordFindingRulings(
      input([thread(opener(), comment("r", "fixed abc1234 — moved the check"))]),
    );
    expect(out.settled[0]?.ruling).toMatchObject({ disposition: "fixed", sha: "abc1234", reason: "moved the check" });
  });
  test.each([["AC-5", "confirm", "confirmed"] as const, ["AC-6", "verified", "verified"] as const])(
    "%s classifies %s as confirming",
    async (_ac, text, disposition) => {
      const out = await bot.recordFindingRulings(input([thread(opener(), comment("r", text))]));
      expect(out.confirmed).toHaveLength(1);
      expect(out.confirmed[0]?.ruling.disposition).toBe(disposition);
      expect(out.settled).toEqual([]);
    },
  );
  test("AC-7 echoes confirmation without resolving", async () => {
    const out = await bot.recordFindingRulings(input([thread(opener(), comment("r", "confirm"))]));
    expect(out.confirmed).toHaveLength(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
  test.each(["AC-8 denied", "AC-9 rejected"])("%s authorization fails closed", async (mode) => {
    isWriter.mockImplementation(async () => {
      if (mode.startsWith("AC-9")) throw new Error("permission unavailable");
      return false;
    });
    const out = await bot.recordFindingRulings(input());
    expect(out).toEqual({ settled: [], confirmed: [], echoed: 0, failed: 0 });
    expect(post).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  test("AC-10 the last writer keyword wins", async () => {
    const out = await bot.recordFindingRulings(
      input([thread(opener(), comment("a", "waive: a"), comment("b", "confirm"))]),
    );
    expect(out.confirmed[0]?.ruling.disposition).toBe("confirmed");
    expect(out.settled).toEqual([]);
  });
  test("AC-11 a later non-writer cannot override a writer", async () => {
    isWriter.mockImplementation(async (reply) => reply.author === "alice");
    const out = await bot.recordFindingRulings(
      input([thread(opener(), comment("a", "waive: a"), comment("b", "confirm", "mallory"))]),
    );
    expect(out.settled[0]?.ruling.disposition).toBe("waived");
    expect(out.confirmed).toEqual([]);
  });
  test("AC-12 ignores own marked keyword replies", async () => {
    const out = await bot.recordFindingRulings(
      input([thread(opener(), comment("r", "waive: x\n\n<!-- nax-bot:v1 key=t-echo -->", "bot"))]),
    );
    expect(out.settled).toEqual([]);
    expect(out.confirmed).toEqual([]);
    expect(isWriter).not.toHaveBeenCalled();
  });
  test("AC-13 accepts an unmarked reply by the bot login when authorized", async () => {
    const out = await bot.recordFindingRulings(input([thread(opener(), comment("r", "waive: x", "bot"))]));
    expect(out.settled[0]?.ruling.reason).toBe("x");
    expect(isWriter).toHaveBeenCalledWith(expect.objectContaining({ author: "bot" }));
  });
  test("AC-14 ignores workflow item openers", async () => {
    const out = await bot.recordFindingRulings(input([thread(opener("w-B3.12345678"), comment("r", "waive: x"))]));
    expect(out).toEqual({ settled: [], confirmed: [], echoed: 0, failed: 0 });
    expect(isWriter).not.toHaveBeenCalled();
  });
  test("AC-15 posts the rendered echo with the stable marker", async () => {
    const value = input();
    await bot.recordFindingRulings(value);
    expect(post).toHaveBeenCalledWith(
      value.ref,
      value.threads[0],
      withNaxBotMarker(
        "Recorded: waived — out of scope\nBy @alice\nTo change it, reply on this thread.",
        bot.findingRulingKey("T1"),
      ),
      value.deps,
      value.cwd,
    );
  });
  test("AC-16 resolves once after echoing a settlement", async () => {
    const order: string[] = [];
    post.mockImplementation(async () => {
      order.push("echo");
      return { id: "posted" };
    });
    resolve.mockImplementation(async () => {
      order.push("resolve");
    });
    const value = input();
    await bot.recordFindingRulings(value);
    expect(order).toEqual(["echo", "resolve"]);
    expect(resolve).toHaveBeenCalledWith(value.ref, value.threads[0], value.deps, value.cwd);
  });
  test("AC-17 an own echo after the ruling suppresses only posting", async () => {
    const out = await bot.recordFindingRulings(
      input([thread(opener(), comment("r", "waive: a"), marked("echo", "Recorded", bot.findingRulingKey("T1")))]),
    );
    expect(out.settled).toHaveLength(1);
    expect(out.echoed).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  test("AC-18 resolved findings retain their ruling without mutations", async () => {
    const value = { ...thread(opener(), comment("r", "waive: a")), resolved: true };
    const out = await bot.recordFindingRulings(input([value]));
    expect(out.settled[0]?.ruling.disposition).toBe("waived");
    expect(out.echoed).toBe(0);
    expect(post).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });
  test("AC-19 echo failure warns but does not undo settlement or resolution", async () => {
    post.mockImplementation(async () => {
      throw new Error("post failed");
    });
    const out = await bot.recordFindingRulings(input());
    expect(out.failed).toBe(1);
    expect(out.echoed).toBe(0);
    expect(out.settled).toHaveLength(1);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot-rulings",
      expect.stringContaining("Could not echo finding ruling"),
      expect.objectContaining({ threadId: "T1", error: "post failed" }),
    );
  });
  test.each([
    ["free text before a keyword", "Please consider this\nwaive: x", false],
    ["invalid fixed sha", "fixed not-a-sha — changed", false],
    ["blank first line", "\n  override: intentional\nMore context", true],
  ])("parses only valid first non-empty keywords: %s", async (_label, text, accepted) => {
    const out = await bot.recordFindingRulings(input([thread(opener(), comment("r", text))]));
    expect(out.settled).toHaveLength(accepted ? 1 : 0);
    expect(out.echoed).toBe(accepted ? 1 : 0);
    if (accepted) expect(out.settled[0]?.ruling.disposition).toBe("overridden");
  });
  test("an echo before the latest ruling does not suppress a fresh echo", async () => {
    const out = await bot.recordFindingRulings(
      input([thread(opener(), marked("echo", "Recorded", bot.findingRulingKey("T1")), comment("new", "confirm"))]),
    );
    expect(out.confirmed).toHaveLength(1);
    expect(out.echoed).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
  test("foreign markers do not establish opener ownership or suppress echoes", async () => {
    const foreignOpener = comment("foreign", withNaxBotMarker("Issue", key), "mallory");
    const ignored = await bot.recordFindingRulings(input([thread(foreignOpener, comment("r", "waive: x"))]));
    expect(ignored.settled).toEqual([]);
    const out = await bot.recordFindingRulings(
      input([
        thread(
          opener(),
          comment("r", "waive: x"),
          comment("fake", withNaxBotMarker("Recorded", bot.findingRulingKey("T1")), "mallory"),
        ),
      ]),
    );
    expect(out.settled).toHaveLength(1);
    expect(out.echoed).toBe(1);
  });
  test("resolved confirmations remain confirming and simultaneous I/O failures accumulate", async () => {
    const resolved = { ...thread(opener(), comment("r", "verified")), resolved: true };
    const out = await bot.recordFindingRulings(input([resolved]));
    expect(out.confirmed[0]?.ruling.disposition).toBe("verified");
    expect(post).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    post.mockImplementation(async () => {
      throw new Error("post failed");
    });
    resolve.mockImplementation(async () => {
      throw new Error("resolve failed");
    });
    const failed = await bot.recordFindingRulings(input());
    expect(failed.failed).toBe(2);
    expect(failed.settled).toHaveLength(1);
  });
  test("AC-20 resolve failure warns but does not undo settlement", async () => {
    resolve.mockImplementation(async () => {
      throw new Error("resolve failed");
    });
    const out = await bot.recordFindingRulings(input());
    expect(out.failed).toBe(1);
    expect(out.echoed).toBe(1);
    expect(out.settled).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot-rulings",
      expect.stringContaining("Could not resolve settled finding"),
      expect.objectContaining({ threadId: "T1", error: "resolve failed" }),
    );
  });
});
