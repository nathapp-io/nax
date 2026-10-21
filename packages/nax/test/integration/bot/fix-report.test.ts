import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeBotFixEnv } from "@test/helpers";
import {
  _fixReportDeps,
  type BotFixState,
  findingKey,
  readyStep,
  renderFixSummary,
  replyStep,
  reportStep,
} from "@/bot";
import { resolveWorkflowConfig } from "@/config";
import { NAX_WORKFLOW_PR_MARKER, type PrComment, type PrThread, parseNaxBotMarker, withNaxBotMarker } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { markReadyArgv } from "@/workflow/promote";

const state: BotFixState = { step: "reply", timings: {}, outcome: "pushed", pushedSha: "abcdef12" };
/** The `nothing` route: the fix pushed nothing, so there is no pushed head to wait on. */
const nothingState: BotFixState = { step: "ready", timings: {}, outcome: "nothing" };
/** The one CI answer that lets a draft become ready (US-003). */
const greenCi = { outcome: "green", detail: "all checks passed" } as const;
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
  test.each([
    ["short issue\nignored second line", "short issue"],
    [`${"x".repeat(205)}\nignored second line`, "x".repeat(200)],
  ])("AC-1/2/3/4: explains the pushed fix before resolving: %s", async (issue, summary) => {
    const key = findingKey({ issue });
    const own = thread("bot", key);
    const env = { ...makeBotFixEnv([{ kind: "finding", key, issue, severity: "minor" }]), threads: [own] };
    const order: string[] = [];
    const reply = spyOn(_fixReportDeps, "replyToThread").mockImplementation(async () => {
      order.push("reply");
      return { id: "new" };
    });
    spyOn(_fixReportDeps, "resolveThread").mockImplementation(async () => {
      order.push("resolve");
    });
    await replyStep(env, { ...state, pushedSha: "123456789abcdef" });
    expect(reply).toHaveBeenCalledTimes(1);
    const body = reply.mock.calls[0]?.[2] ?? "";
    expect(body).toBe(withNaxBotMarker(`Fixed in 1234567: ${summary}`, `fix-${key}`));
    expect(parseNaxBotMarker(body)).toEqual({ key: `fix-${key}` });
    expect(reply).toHaveBeenCalledWith(env.ref, { replyTo: own.replyTo }, body, env.forge, env.repoRoot);
    expect(order).toEqual(["reply", "resolve"]);
  });
  test.each([
    [
      "ghp_ABCDEFGHIJKLMNOP1234567890 @org/team #123 `<tag>` [x](https://e.test) ![img](https://e.test)\nnot included",
      "[REDACTED] @\u200borg/team #\u200b123 '&lt;tag&gt;' [x]\u200b(https:\u200b//e.test) ![img]\u200b(https:\u200b//e.test)",
    ],
    [`${"x".repeat(180)}[x](https://e.test)`, `${"x".repeat(180)}[x]\u200b(https:\u200b//e.test)`.slice(0, 200)],
  ])("F1: sanitizes own-finding prose and caps the rendered excerpt: %s", async (issue, expected) => {
    const key = findingKey({ issue });
    const env = {
      ...makeBotFixEnv([{ kind: "finding", key, issue, severity: "minor" }]),
      threads: [thread("bot", key)],
    };
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    await replyStep(env, state);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0]?.[2]).toBe(withNaxBotMarker(`Fixed in abcdef1: ${expected}`, `fix-${key}`));
    expect(expected.length).toBeLessThanOrEqual(200);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  test("AC-5/7: failed own-finding reply warns and skips resolution, continuing to the next thread", async () => {
    const key = findingKey({ issue: "Leak" });
    const own = thread("bot", key);
    const env = {
      ...makeBotFixEnv([{ kind: "finding", key, issue: "Leak", severity: "minor" }]),
      threads: [own, { ...own, id: "next", replyTo: "100" }],
    };
    const logger = initLogger({ level: "silent" });
    const warn = spyOn(logger, "warn");
    try {
      const reply = spyOn(_fixReportDeps, "replyToThread")
        .mockRejectedValueOnce(new Error("denied"))
        .mockResolvedValue({ id: "new" });
      const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
      const result = await replyStep(env, state);
      expect(reply).toHaveBeenCalledTimes(2);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(resolve.mock.calls[0]?.[1].id).toBe("next");
      expect(result.patch).toMatchObject({ replied: 1, resolved: 1 });
      expect(warn).toHaveBeenCalledWith("bot-fix", expect.stringContaining("reply"), {
        threadId: own.id,
        error: "denied",
      });
    } finally {
      resetLogger();
    }
  });
  test("invalid persisted marker key cannot prevent later replies or own resolution", async () => {
    const key = findingKey({ issue: "Leak" });
    const env = {
      ...makeBotFixEnv([
        { ...item, key: "invalid key" },
        item,
        { kind: "finding", key, issue: "Leak", severity: "minor" },
      ]),
      threads: [thread("bot", key)],
    };
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "next" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    expect((await replyStep(env, state)).patch).toMatchObject({ replied: 2, resolved: 1 });
    expect(reply).toHaveBeenCalledTimes(2);
    expect(resolve).toHaveBeenCalledTimes(1);
  });
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
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    const result = await replyStep(env, state);
    expect(reply).toHaveBeenCalledTimes(count);
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
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread")
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValue();
    const result = await replyStep(env, state);
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[1]?.[1].id).toBe("next");
    expect(reply.mock.calls.map((call) => call[1])).toEqual([{ replyTo: "99" }, { replyTo: "99" }]);
    expect(result.patch).toMatchObject({ replied: 2, resolved: 1 });
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
  test("AC-1/2/3: leaves a PR that is not a draft alone", async () => {
    const env = makeBotFixEnv();
    const run = spyOn(env.forge, "run");
    const wait = spyOn(_fixReportDeps, "waitForChecks");
    expect(await readyStep(env, state)).toEqual({ patch: { markedReady: false }, exit: "report" });
    expect(wait).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-4/5/6: keeps a marked nax-workflow PR a draft", async () => {
    const env = makeBotFixDraftEnv({ body: `${NAX_WORKFLOW_PR_MARKER}\n\n## Summary` });
    const run = spyOn(env.forge, "run");
    const wait = spyOn(_fixReportDeps, "waitForChecks");
    expect(await readyStep(env, state)).toEqual({
      patch: { markedReady: false, readyHeld: "nax workflow PR: promote it with nax workflow promote" },
      exit: "report",
    });
    expect(wait).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-7: waits for CI on the pushed head", async () => {
    const env = makeBotFixDraftEnv();
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await readyStep(env, state);
    expect(wait.mock.calls[0]?.[2]?.expectedSha).toBe("abcdef12");
  });
  test("AC-8: waits for CI on the reviewed head when nothing was pushed", async () => {
    const env = makeBotFixDraftEnv();
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await readyStep(env, nothingState);
    expect(wait.mock.calls[0]?.[2]?.expectedSha).toBe(env.info.headSha);
  });
  test("AC-9: waits with the configured CI timeout", async () => {
    const env = makeBotFixDraftEnv();
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await readyStep(env, state);
    expect(wait.mock.calls[0]?.[2]?.timeoutMs).toBe(resolveWorkflowConfig(env.config).timeouts.ciWaitMs);
  });
  test("AC-10: waits with the configured CI poll interval", async () => {
    const env = makeBotFixDraftEnv();
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await readyStep(env, state);
    expect(wait.mock.calls[0]?.[2]?.pollMs).toBe(resolveWorkflowConfig(env.config).timeouts.ciPollMs);
  });
  test("AC-11/12: keeps the draft and says why when CI failed", async () => {
    const env = makeBotFixDraftEnv();
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({ outcome: "failed", detail: "a check failed" });
    const run = spyOn(env.forge, "run");
    expect(await readyStep(env, state)).toEqual({
      patch: { markedReady: false, readyHeld: "CI failed: a check failed" },
      exit: "report",
    });
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-13: keeps the draft while CI is pending", async () => {
    const env = makeBotFixDraftEnv();
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({
      outcome: "pending",
      detail: "no CI result within 1200000ms",
    });
    const result = await readyStep(env, state);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toStartWith("CI pending: ");
  });
  test.each(["github", "gitlab"] as const)("AC-14/15: marks a green %s draft ready in repo root", async (forge) => {
    const base = makeBotFixDraftEnv();
    const env = { ...base, ref: { ...base.ref, forge } };
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    expect(await readyStep(env, state)).toEqual({ patch: { markedReady: true }, exit: "report" });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(markReadyArgv(forge, "42"), { cwd: env.repoRoot });
  });
  test("AC-16: rejects failed readiness writes without claiming success", async () => {
    const env = makeBotFixDraftEnv();
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 1, stdout: "", stderr: "denied" });
    await expect(readyStep(env, state)).rejects.toMatchObject({ code: "BOT_FIX_READY_FAILED" });
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
