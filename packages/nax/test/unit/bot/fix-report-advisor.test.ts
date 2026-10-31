import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import { _fixReportDeps, replyStep } from "@/bot/fix-report";
import type { BotFixState } from "@/bot/fix-steps";
import { type PrComment, type PrThread, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { renderItemOpener, renderRulingEcho } from "@/workflow/item-threads";

const key = "w-D-1.12345678";
const state: BotFixState = { step: "reply", timings: {}, outcome: "pushed", pushedSha: "abcdef123456" };
const comment = (body: string, marker: string, author = "bot"): PrComment => ({
  id: marker,
  kind: "thread",
  author,
  body: withNaxBotMarker(body, marker),
  createdAt: "",
});
const echo = () =>
  comment(
    renderRulingEcho({ itemKey: key, itemId: "D-1", disposition: "confirmed", reason: "change X", by: "alice" }),
    `wr-confirmed-${key}`,
  );
const fixed = (author = "bot", marker = `fix-${key}`) => comment("Fixed in old", marker, author);
function envFor(
  options: { kind?: "advisor" | "finding"; resolved?: boolean; author?: string; tail?: readonly PrComment[] } = {},
) {
  const thread: PrThread = {
    id: "advisor-thread",
    replyTo: "opener",
    resolved: options.resolved ?? false,
    outdated: false,
    comments: [
      comment(renderItemOpener({ id: "D-1", kind: options.kind ?? "advisor", issue: "change X" }), key, options.author),
      ...(options.tail ?? [echo()]),
    ],
  };
  return {
    ...makeBotFixEnv([{ kind: "finding", key, issue: "change @alice\nignored", severity: "minor" }]),
    threads: [thread],
  };
}
afterEach(() => {
  mock.restore();
  resetLogger();
});

describe("replyStep advisor closure", () => {
  test("AC-1/2 replies with sanitized summary, short SHA and marker before resolving", async () => {
    const env = envFor();
    const order: string[] = [];
    const reply = spyOn(_fixReportDeps, "replyToThread").mockImplementation(async () => {
      order.push("reply");
      return { id: "new" };
    });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockImplementation(async () => {
      order.push("resolve");
    });
    expect(await replyStep(env, state)).toEqual({ patch: { replied: 1, resolved: 1 }, exit: "ready" });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith(
      env.ref,
      { replyTo: "opener" },
      withNaxBotMarker("Fixed in abcdef1: change @\u200balice", `fix-${key}`),
      env.forge,
      env.repoRoot,
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["reply", "resolve"]);
  });
  test.each([{ kind: "finding" as const }, { author: "alice" }])(
    "AC-3 preserves non-advisor and ownership exclusions: %j",
    async (options) => {
      const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
      const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
      await replyStep(envFor(options), state);
      expect(reply).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
    },
  );
  test("AC-4/5 answers an already-resolved advisor without resolving again", async () => {
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    expect((await replyStep(envFor({ resolved: true }), state)).patch).toEqual({ replied: 1, resolved: 0 });
    expect(reply).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
  test("AC-6/7 warns with thread id and never resolves after a reply failure", async () => {
    const warn = spyOn(initLogger({ level: "silent" }), "warn");
    const reply = spyOn(_fixReportDeps, "replyToThread").mockRejectedValue(new Error("denied"));
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    await replyStep(envFor(), state);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("bot-fix", expect.stringContaining("reply"), {
      threadId: "advisor-thread",
      error: "denied",
    });
  });
  test("AC-8 repeated run skips its own fix following the latest echo", async () => {
    const env = envFor();
    const reply = spyOn(_fixReportDeps, "replyToThread").mockImplementation(async (_ref, _target, body) => {
      const thread = env.threads[0];
      if (thread) env.threads[0] = { ...thread, comments: [...thread.comments, comment(body, `fix-${key}`)] };
      return { id: "new" };
    });
    spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    await replyStep(env, state);
    await replyStep(env, state);
    expect(reply).toHaveBeenCalledTimes(1);
  });
  test.each([
    { tail: [echo(), fixed(), comment("Raised again", `wo-${key}`), echo()] },
    { tail: [echo(), fixed("alice")] },
    { tail: [echo(), fixed("bot", "fix-w-other.12345678")] },
  ])("AC-9 admits a new confirmation or ignores a foreign fix: %j", async ({ tail }) => {
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    await replyStep(envFor({ tail }), state);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[2]).toContain("Fixed in abcdef1:");
  });
  test("AC-10/11 resolve failure warns with thread id but fulfills ready", async () => {
    const warn = spyOn(initLogger({ level: "silent" }), "warn");
    spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockRejectedValue(new Error("denied"));
    expect(await replyStep(envFor(), state)).toEqual({ patch: { replied: 1, resolved: 0 }, exit: "ready" });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("bot-fix", expect.stringContaining("resolve"), {
      threadId: "advisor-thread",
      error: "denied",
    });
  });
});
