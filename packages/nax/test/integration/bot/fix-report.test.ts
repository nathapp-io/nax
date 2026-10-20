import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixEnv } from "@test/helpers";
import {
  _fixReportDeps,
  type BotFixState,
  findingKey,
  readyStep,
  renderFixSummary,
  replyStep,
  reportStep,
} from "@/bot";
import { type PrComment, type PrThread, parseNaxBotMarker, withNaxBotMarker } from "@/forge";
import { markReadyArgv } from "@/workflow/promote";

const state: BotFixState = { step: "reply", timings: {}, outcome: "pushed", pushedSha: "abcdef12" };
const item = {
  kind: "thread" as const,
  key: "t-1",
  replyTo: "r1",
  threadId: "node1",
  issue: "rename",
  reason: "clearer",
};
const comment: PrComment = { id: "7", kind: "comment", author: "bot", body: "", createdAt: "" };
function thread(author: string, key: string): PrThread {
  return {
    id: "node-own",
    replyTo: "99",
    resolved: false,
    outdated: false,
    comments: [{ ...comment, kind: "thread", author, body: withNaxBotMarker("finding", key) }],
  };
}
afterEach(() => mock.restore());

describe("replyStep", () => {
  test("replies to the REST target with pushed sha and fix marker", async () => {
    const env = makeBotFixEnv([item]);
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const result = await replyStep(env, state);
    expect(reply).toHaveBeenCalledTimes(1);
    const args = reply.mock.calls[0];
    expect(args?.[0]).toEqual(env.ref);
    expect(args?.[1]).toEqual({ replyTo: "r1" });
    expect(args?.[2]).toContain("nax bot fix pushed abcdef1 for this thread. Run nax bot review to check it.");
    expect(parseNaxBotMarker(args?.[2] ?? "")).toEqual({ key: "fix-t-1" });
    expect(args?.slice(3)).toEqual([env.forge, env.repoRoot]);
    expect(result).toEqual({ patch: { replied: 1, resolved: 0 }, exit: "ready" });
  });
  test.each([
    ["bot", true, 1],
    ["alice", true, 0],
    ["bot", false, 0],
  ])("resolves only own agreed finding: %s agreed=%s", async (author, agreed, count) => {
    const key = findingKey({ issue: "Leak" });
    const env = {
      ...makeBotFixEnv([{ kind: "finding", key: agreed ? key : "f-other", issue: "Leak", severity: "minor" }]),
      threads: [thread(author, key)],
    };
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    const result = await replyStep(env, state);
    expect(resolve).toHaveBeenCalledTimes(count);
    if (count) expect(resolve).toHaveBeenCalledWith(env.ref, env.threads[0], env.forge, env.repoRoot);
    expect(result.patch.resolved).toBe(count);
  });
  test("continues resolution after failure and excludes empty, unmarked, and resolved threads", async () => {
    const key = findingKey({ issue: "Leak" });
    const own = thread("bot", key);
    const env = {
      ...makeBotFixEnv([{ kind: "finding", key, issue: "Leak", severity: "minor" }]),
      threads: [
        { ...own, comments: [] },
        { ...own, comments: [{ ...comment, body: "not marked" }] },
        { ...own, resolved: true },
        own,
        { ...own, id: "next" },
      ],
    };
    const resolve = spyOn(_fixReportDeps, "resolveThread")
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue();
    const result = await replyStep(env, state);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]?.[1].id).toBe("next");
    expect(result.patch.resolved).toBe(1);
  });
  test("continues replies after a failed write", async () => {
    const env = makeBotFixEnv([item, { ...item, key: "t-2", replyTo: "r2" }]);
    const reply = spyOn(_fixReportDeps, "replyToThread")
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue({ id: "next" });
    const result = await replyStep(env, state);
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[1]?.[1]).toEqual({ replyTo: "r2" });
    expect(result.patch.replied).toBe(1);
  });
});

describe("readyStep", () => {
  test("rejects failed readiness writes without claiming success", async () => {
    const base = makeBotFixEnv();
    const env = { ...base, info: { ...base.info, draft: true } };
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "denied" });
    await expect(readyStep(env, state)).rejects.toMatchObject({ code: "BOT_FIX_READY_FAILED" });
  });
  test.each(["github", "gitlab"] as const)("marks a %s draft ready in repo root", async (forge) => {
    const base = makeBotFixEnv();
    const env = { ...base, ref: { ...base.ref, forge }, info: { ...base.info, draft: true } };
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    expect(await readyStep(env, state)).toEqual({ patch: { markedReady: true }, exit: "report" });
    expect(run).toHaveBeenCalledWith(markReadyArgv(forge, "42"), { cwd: env.repoRoot });
  });
  test("does not call forge or claim readiness for a non-draft", async () => {
    const env = makeBotFixEnv();
    const run = spyOn(env.forge, "run");
    expect(await readyStep(env, state)).toEqual({ patch: { markedReady: false }, exit: "report" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("reportStep", () => {
  test("posts when no own fix-summary exists", async () => {
    const env = makeBotFixEnv();
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    expect(await reportStep(env, state)).toEqual({ patch: {}, exit: "done" });
    expect(post).toHaveBeenCalledWith(env.ref, renderFixSummary(state), env.forge, env.repoRoot);
    expect(edit).not.toHaveBeenCalled();
  });
  test("edits the own fix-summary identity rather than posting", async () => {
    const env = { ...makeBotFixEnv(), own: [{ key: "fix-summary", comment }] };
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep(env, state);
    expect(edit).toHaveBeenCalledWith(env.ref, comment, renderFixSummary(state), env.forge, env.repoRoot);
    expect(post).not.toHaveBeenCalled();
  });
});
