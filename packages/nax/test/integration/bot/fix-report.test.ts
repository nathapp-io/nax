import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDraftEnv, makeBotFixEnv, makeNaxConfig, makeTestRuntime } from "@test/helpers";
import {
  _fixReportDeps,
  type BotFixState,
  findingKey,
  readyStep,
  renderFixSummary,
  replyStep,
  reportStep,
} from "@/bot";
import { type BotPushEntry, readPushLedger, withPushLedger } from "@/bot/push-ledger";
import {
  MAX_FORGE_COMMENT_CHARS,
  NAX_WORKFLOW_PR_MARKER,
  type PrComment,
  type PrThread,
  parseNaxBotMarker,
  withNaxBotMarker,
} from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { _ciWaitDeps } from "@/workflow/ci-wait";
import { safeCode } from "@/workflow/pr-body-safe";
import { markReadyArgv } from "@/workflow/promote";

const state: BotFixState = { step: "reply", timings: {}, outcome: "pushed", pushedSha: "abcdef12" };
/** A readiness pass at this execution's head: the pushed-head hold (US-001) is not what these tests read. */
const readyPass: BotFixState = { ...state, readyOnly: true };
/** The `nothing` route: the fix pushed nothing, so there is no pushed head to wait on. */
const nothingState: BotFixState = { step: "ready", timings: {}, outcome: "nothing" };
/** The one CI answer that lets a draft become ready (US-003). */
const greenCi = { outcome: "green", detail: "all checks passed" } as const;
/** CI timeouts that differ from the schema defaults, so a hardcoded wait would fail the AC. */
const CI_WAIT_MS = 12_345;
const CI_POLL_MS = 678;

/** A draft PR whose config carries CI timeouts of its own. */
function draftEnvWithTimeouts(): ReturnType<typeof makeBotFixDraftEnv> {
  const base = makeBotFixDraftEnv();
  return {
    ...base,
    config: makeNaxConfig({ workflow: { timeouts: { ciWaitMs: CI_WAIT_MS, ciPollMs: CI_POLL_MS } } }),
  };
}
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
beforeEach(() => {
  spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
});
afterEach(() => mock.restore());

/**
 * The fix-summary bodies the report posted: one entry per write. A push also posts its own append-only
 * record (B1), which is a separate comment with its own identity key.
 */
function summaries(post: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return post.mock.calls
    .map((call) => String(call[1] ?? ""))
    .filter((body) => parseNaxBotMarker(body)?.key === "fix-summary");
}

/** The append-only per-push records the report posted, keyed by the push they name. */
function records(post: { mock: { calls: readonly (readonly unknown[])[] } }): string[] {
  return post.mock.calls
    .map((call) => String(call[1] ?? ""))
    .filter((body) => parseNaxBotMarker(body)?.key.startsWith("push-") === true);
}

describe("reportStep out-of-item files", () => {
  const prefix = "Also changed, not named by an agreed item: ";
  const named = [{ kind: "finding" as const, key: "f1", issue: "fix", severity: "minor" as const, file: "src/a.ts" }];
  test.each([
    [9, "pushed", named, ["src/a.ts", "src/b.ts"], `${prefix}\`src/b.ts\``],
    [10, "pushed", named, ["src/a.ts"], undefined],
    [11, "pushed", [{ kind: "comment", key: "c1", issue: "fix", reason: "yes" }], ["src/b.ts"], undefined],
    [12, "gates-failed", named, ["src/b.ts"], undefined],
    [
      13,
      "pushed",
      named,
      Array.from({ length: 23 }, (_, i) => `src/extra${i}.ts`),
      `${prefix}${Array.from({ length: 20 }, (_, i) => `\`src/extra${i}.ts\``).join(", ")} and 3 more`,
    ],
    [14, "pushed", named, ["src/@alice.ts"], `${prefix}\`${safeCode("src/@alice.ts")}\``],
    ["absent changed", "pushed", named, undefined, undefined],
    ["as spelled", "pushed", named, ["./src/a.ts"], `${prefix}\`./src/a.ts\``],
    [
      "fileless finding",
      "pushed",
      [{ kind: "finding", key: "f2", issue: "fix", severity: "minor" }],
      ["src/b.ts"],
      undefined,
    ],
    ["thread", "pushed", [{ ...item, file: "src/a.ts" }], ["src/b.ts"], `${prefix}\`src/b.ts\``],
  ] satisfies readonly (readonly [
    number | string,
    BotFixState["outcome"],
    Parameters<typeof makeBotFixEnv>[0],
    string[] | undefined,
    string | undefined,
  ])[])("US-002 AC-%s: discloses only pushed unnamed paths", async (_ac, outcome, agreed, changed, expected) => {
    const env = makeBotFixEnv(agreed);
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "summary" });
    expect(await reportStep(env, { ...state, outcome, changed })).toEqual({ patch: {}, exit: "done" });
    expect(summaries(post)).toHaveLength(1);
    const body = summaries(post)[0] ?? "";
    expect(body.split("\n").find((line) => line.startsWith(prefix))).toBe(expected);
  });
});

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
  test("records fix completion for agreed work on an already-resolved thread", async () => {
    const key = findingKey({ issue: "Leak" });
    const env = {
      ...makeBotFixEnv([{ kind: "finding", key, issue: "Leak", severity: "minor" }]),
      threads: [{ ...thread("bot", key), resolved: true }],
    };
    const reply = spyOn(_fixReportDeps, "replyToThread").mockResolvedValue({ id: "new" });
    const resolve = spyOn(_fixReportDeps, "resolveThread").mockResolvedValue();
    const result = await replyStep(env, state);
    expect(reply.mock.calls[0]?.[2]).toBe(withNaxBotMarker("Fixed in abcdef1: Leak", `fix-${key}`));
    expect(resolve).not.toHaveBeenCalled();
    expect(result.patch).toMatchObject({ replied: 1, resolved: 0 });
  });
  test("continues resolution after failure and excludes empty and unmarked threads", async () => {
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
    expect(reply.mock.calls.map((call) => call[1])).toEqual([{ replyTo: "99" }, { replyTo: "99" }, { replyTo: "99" }]);
    expect(result.patch).toMatchObject({ replied: 3, resolved: 1 });
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
  beforeEach(() => {
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
  });
  test.each(["matching", "changed", "unreadable", "reviewed"] as const)(
    "US-008 AC-1/3/5–8: post-green head %s",
    async (mode) => {
      const env = makeBotFixDraftEnv();
      const currentState = mode === "reviewed" ? nothingState : readyPass;
      const order: string[] = [];
      spyOn(_fixReportDeps, "waitForChecks").mockImplementation(async () => {
        order.push("ci");
        return greenCi;
      });
      const read = spyOn(_fixReportDeps, "readPrInfo").mockImplementation(async () => {
        order.push("read");
        if (mode === "unreadable") throw new Error("offline");
        return { ...env.info, headSha: mode === "changed" ? "other" : (currentState.pushedSha ?? env.info.headSha) };
      });
      const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
      const result = await readyStep(env, currentState);
      expect(order).toEqual(["ci", "read"]);
      expect(read).toHaveBeenCalledWith(env.ref, env.forge, env.repoRoot);
      if (mode === "matching" || mode === "reviewed") {
        expect(result).toEqual({ patch: { markedReady: true }, exit: "report" });
        expect(run).toHaveBeenCalledWith(markReadyArgv(env.ref.forge, env.info.url), { cwd: env.repoRoot });
      } else {
        expect(result).toEqual({
          patch: {
            markedReady: false,
            readyHeld: mode === "changed" ? "PR head changed since this execution" : "PR head could not be re-read",
          },
          exit: "report",
        });
        expect(run).not.toHaveBeenCalled();
      }
    },
  );

  test("AC-1/2/3: leaves a PR that is not a draft alone", async () => {
    const env = makeBotFixEnv();
    const run = spyOn(env.forge, "run");
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockImplementation(() => {
      throw new Error("waitForChecks must not run on a PR that is not a draft");
    });
    expect(await readyStep(env, readyPass)).toEqual({ patch: { markedReady: false }, exit: "report" });
    expect(wait).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-4/5/6: keeps a marked nax-workflow PR a draft", async () => {
    const env = makeBotFixDraftEnv({ body: `${NAX_WORKFLOW_PR_MARKER}\n\n## Summary` });
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([]);
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue({
      recorded: [],
      settled: [],
      open: [],
      asked: 0,
      failed: 0,
    });
    const run = spyOn(env.forge, "run");
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockImplementation(() => {
      throw new Error("waitForChecks must not run on a nax-workflow PR");
    });
    expect(await readyStep(env, { ...readyPass, pushedSha: env.info.headSha })).toEqual({
      patch: { markedReady: false, readyHeld: "no nax item index on this PR" },
      exit: "report",
    });
    expect(wait).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  test("AC-7: waits for CI on the pushed head", async () => {
    const env = makeBotFixDraftEnv();
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue({
      ...env.info,
      headSha: state.pushedSha ?? env.info.headSha,
    });
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await readyStep(env, readyPass);
    expect(wait.mock.calls[0]?.[2]?.expectedSha).toBe("abcdef12");
  });
  test("AC-8: waits for CI on the reviewed head when nothing was pushed", async () => {
    const env = makeBotFixDraftEnv();
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    await readyStep(env, nothingState);
    expect(wait.mock.calls[0]?.[2]?.expectedSha).toBe(env.info.headSha);
  });
  test("AC-9: waits with the configured CI timeout", async () => {
    const env = draftEnvWithTimeouts();
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue({
      ...env.info,
      headSha: state.pushedSha ?? env.info.headSha,
    });
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await readyStep(env, readyPass);
    expect(wait.mock.calls[0]?.[2]?.timeoutMs).toBe(CI_WAIT_MS);
  });
  test("AC-10: waits with the configured CI poll interval", async () => {
    const env = draftEnvWithTimeouts();
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue({
      ...env.info,
      headSha: state.pushedSha ?? env.info.headSha,
    });
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    await readyStep(env, readyPass);
    expect(wait.mock.calls[0]?.[2]?.pollMs).toBe(CI_POLL_MS);
  });
  test("AC-11/12: keeps the draft and says why when CI failed", async () => {
    const env = makeBotFixDraftEnv();
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue({ outcome: "failed", detail: "a check failed" });
    const run = spyOn(env.forge, "run");
    expect(await readyStep(env, readyPass)).toEqual({
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
    const result = await readyStep(env, readyPass);
    expect(result.patch.markedReady).toBe(false);
    expect(result.patch.readyHeld).toStartWith("CI pending: ");
  });
  test.each(["github", "gitlab"] as const)("AC-14/15: marks a green %s draft ready in repo root", async (forge) => {
    const base = makeBotFixDraftEnv();
    const env = { ...base, ref: { ...base.ref, forge } };
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue({
      ...env.info,
      headSha: state.pushedSha ?? env.info.headSha,
    });
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    expect(await readyStep(env, readyPass)).toEqual({ patch: { markedReady: true }, exit: "report" });
    expect(wait).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(markReadyArgv(forge, env.info.url), { cwd: env.repoRoot });
  });
  test("aborting during the first CI polling delay stops polling and never marks ready", async () => {
    const controller = new AbortController();
    const base = draftEnvWithTimeouts();
    const runtime = makeTestRuntime({ parentSignal: controller.signal });
    const env = { ...base, ctx: { ...base.ctx, callCtx: { ...base.ctx.callCtx, runtime } } };
    let clock = 0;
    spyOn(_ciWaitDeps, "now").mockImplementation(() => clock);
    spyOn(_ciWaitDeps, "schedule").mockImplementation(() => () => {});
    const sleep = spyOn(_ciWaitDeps, "sleep").mockImplementation(async (ms) => {
      clock += ms;
      controller.abort();
    });
    const checks = spyOn(_ciWaitDeps, "run").mockImplementation(async (cmd) => {
      const stdout =
        cmd[2] === "view"
          ? JSON.stringify({ mergeable: "MERGEABLE", headRefOid: state.pushedSha })
          : JSON.stringify([{ name: "test", bucket: controller.signal.aborted ? "pass" : "pending" }]);
      return { exitCode: 0, stdout, stderr: "" };
    });
    const run = spyOn(env.forge, "run");
    await expect(readyStep(env, readyPass)).rejects.toMatchObject({ name: "AbortError" });
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(checks.mock.calls.filter(([cmd]) => cmd[2] === "checks")).toHaveLength(1);
    expect(run).not.toHaveBeenCalled();
  });
  test("an abort when CI turns green still prevents the readiness write", async () => {
    const controller = new AbortController();
    const base = makeBotFixDraftEnv();
    const runtime = makeTestRuntime({ parentSignal: controller.signal });
    const env = { ...base, ctx: { ...base.ctx, callCtx: { ...base.ctx.callCtx, runtime } } };
    const wait = spyOn(_fixReportDeps, "waitForChecks").mockImplementation(async () => {
      controller.abort();
      return greenCi;
    });
    const read = spyOn(_fixReportDeps, "readPrInfo");
    const run = spyOn(env.forge, "run");
    await expect(readyStep(env, readyPass)).rejects.toMatchObject({ name: "AbortError" });
    expect(read).not.toHaveBeenCalled();
    expect(wait.mock.calls[0]?.[2]?.signal).toBe(runtime.signal);
    expect(run).not.toHaveBeenCalled();
  });
  test.each([
    [1, "denied\n", "denied"],
    [2, "", "exit code 2"],
  ] as const)("US-008 AC-9/10: ready exit %s holds for report", async (exitCode, stderr, detail) => {
    const env = makeBotFixDraftEnv();
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(greenCi);
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue({
      ...env.info,
      headSha: state.pushedSha ?? env.info.headSha,
    });
    spyOn(env.forge, "run").mockResolvedValue({ exitCode, stdout: "", stderr });
    expect(await readyStep(env, readyPass)).toEqual({
      patch: { markedReady: false, readyHeld: `could not mark ready: ${detail}` },
      exit: "report",
    });
  });
});

describe("reportStep", () => {
  // US-004/US-008: the summary now carries the push ledger and the convergence facts, so only those
  // lines may differ from the render.
  const withoutLedger = (body: string): string =>
    body
      .split("\n")
      .filter(
        (line) => !line.startsWith("<!-- nax-bot:pushes v1 ") && !line.startsWith("nax bot fix pushes on this PR: "),
      )
      .join("\n");

  test("posts when no own fix-summary exists", async () => {
    const env = makeBotFixEnv();
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    expect(await reportStep(env, state)).toEqual({ patch: {}, exit: "done" });
    const args = post.mock.calls[0];
    expect(args?.slice(0, 1)).toEqual([env.ref]);
    expect(args?.slice(2)).toEqual([env.forge, env.repoRoot]);
    expect(withoutLedger(args?.[1] ?? "")).toBe(renderFixSummary(state));
    expect(edit).not.toHaveBeenCalled();
  });
  test("edits the own fix-summary identity rather than posting", async () => {
    const env = { ...makeBotFixEnv(), own: [{ key: "fix-summary", comment }] };
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep(env, state);
    const args = edit.mock.calls[0];
    expect(args?.slice(0, 2)).toEqual([env.ref, comment]);
    expect(args?.slice(3)).toEqual([env.forge, env.repoRoot]);
    expect(withoutLedger(args?.[2] ?? "")).toBe(renderFixSummary(state));
    // The summary itself is edited in place; only the push's own append-only record is posted (B1).
    expect(summaries(post)).toEqual([]);
    expect(records(post)).toHaveLength(1);
  });
});

describe("reportStep push ledger (US-004)", () => {
  test("AC-22 a failed summary edit records no push in the persisted comment", async () => {
    const env = makeBotFixEnv([{ kind: "finding", key: "f-a", issue: "no lock file", severity: "important" }]);
    const stored: PrComment = {
      id: "7",
      kind: "comment",
      author: env.user.login,
      body: withNaxBotMarker("earlier summary", "fix-summary"),
      createdAt: "",
    };
    spyOn(_fixReportDeps, "editComment").mockRejectedValue(new Error("denied"));
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    await expect(reportStep({ ...env, own: [{ key: "fix-summary", comment: stored }] }, state)).rejects.toThrow(
      "denied",
    );
    expect(readPushLedger(stored.body).entries).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * US-008: the fix summary states the convergence it can see — how many pushes this PR has had, and the
 * blocking findings that sit on an earlier fix's lines. Both are facts about the PR, so the body a
 * reader of the public comment sees is what these tests pin.
 */
describe("reportStep convergence facts (US-008)", () => {
  const S = "abcdef1234567890abcdef1234567890abcdef12";
  /** A 40-hex head and push for the budget case, which reads the ledger back. */
  const BASE_SHA = "b".repeat(40);
  const PUSH = "a".repeat(40);
  const base = makeBotFixEnv();
  /** The same env with an artifact carrying the facts a later push records. */
  const withReview = (review: Partial<typeof base.review>): typeof base => ({
    ...base,
    review: { ...base.review, ...review },
  });
  const posted = (post: { mock: { calls: readonly (readonly unknown[])[] } }): string =>
    String(post.mock.calls[0]?.[1] ?? "");

  test("AC-22 states the push count and the pushes this history no longer reaches", async () => {
    const env = withReview({
      agreed: [{ kind: "finding", key: "f-a", issue: "no lock file", severity: "important" }],
      unreachablePushes: 1,
    });
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    // A real 40-hex push, so the ledger the summary carries reads back as this execution's one entry.
    expect(await reportStep(env, { ...state, pushedSha: S })).toEqual({ patch: {}, exit: "done" });
    expect(posted(post)).toContain("nax bot fix pushes on this PR: 1 (1 no longer in history)");
    expect(readPushLedger(posted(post)).entries).toHaveLength(1);
  });

  test("names a blocking finding that sits on an earlier fix push", async () => {
    const env = withReview({
      agreed: [
        {
          kind: "finding",
          key: "f-x",
          issue: "lock leaks again",
          severity: "important",
          lineage: { generation: 2, parents: ["f-a"], pushSha: S },
        },
      ],
    });
    const stored: PrComment = {
      id: "7",
      kind: "comment",
      author: env.user.login,
      body: withPushLedger(withNaxBotMarker("earlier summary", "fix-summary"), [
        { base: "b".repeat(40), sha: S, at: "", items: [{ key: "f-a", generation: 1, issue: "lock leaks" }] },
      ]),
      createdAt: "",
    };
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep({ ...env, own: [{ key: "fix-summary", comment: stored }] }, state);
    const body = String(edit.mock.calls[0]?.[2] ?? "");
    expect(body).toContain("### Findings are chasing their own fixes");
    expect(body).toContain(
      "- f-x (Important, normal), generation 2: on lines added by nax bot fix abcdef1 for f-a (lock leaks)",
    );
    // The count is this PR's whole recorded history: the earlier entry plus this execution's push.
    expect(body).toContain("nax bot fix pushes on this PR: 2");
  });

  // B2: the forge refuses a comment past its size limit, and a refused summary records no push at all.
  test("B2: a long ledger plus a long chain still posts a body under the forge limit", async () => {
    const parents = ["f-p0", "f-p1", "f-p2", "f-p3", "f-p4"];
    const fat: BotPushEntry = {
      base: BASE_SHA,
      sha: "7".repeat(40),
      at: "",
      items: parents.map((key) => ({ key, generation: 1, issue: "z".repeat(120) })),
    };
    // Enough chained findings that the chain section alone would overrun the forge's comment limit.
    const agreed = Array.from({ length: 400 }, (_unused, index) => ({
      kind: "finding" as const,
      key: `f-x${index}`,
      issue: `lock leaks again ${index}`,
      severity: "important" as const,
      lineage: { generation: 2, parents, pushSha: fat.sha },
    }));
    const stored: PrComment = {
      id: "7",
      kind: "comment",
      author: "bot",
      body: withPushLedger(withNaxBotMarker("earlier summary", "fix-summary"), [fat]),
      createdAt: "",
    };
    const env = withReview({ agreed });
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep({ ...env, own: [{ key: "fix-summary", comment: stored }] }, { ...state, pushedSha: PUSH });
    const body = String(edit.mock.calls[0]?.[2] ?? "");
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS);
    // The push this execution made is still recorded: the record is what must not be truncated.
    expect(readPushLedger(body).entries.at(-1)?.sha).toBe(PUSH);
    expect(body).toContain("nax bot fix pushes on this PR:");
    expect(body).toMatch(/more finding\(s\) not listed/);
  });

  // B2: the outcome line names the protected files the fix touched, and that list is as long as the
  // diff. A scoped report with a long one and a retained ledger was 65,184 characters before the chain,
  // and the forge refuses the write — so the push was never recorded. The list is capped, the chain is
  // budgeted, and what is left is what the ledger may not push past.
  test("B2: a long protected-file list beside a retained ledger still posts under the forge limit", async () => {
    const retained: BotPushEntry = {
      base: BASE_SHA,
      sha: "7".repeat(40),
      at: "",
      items: [{ key: "f-a", generation: 1, issue: "lock leaks" }],
    };
    // Far more protected paths than the comment can name: 400 × a path at the inline cap.
    const protectedFiles = Array.from(
      { length: 400 },
      (_unused, index) => `.nax/protected/${index}/${"p".repeat(3_400)}.md`,
    );
    const env = withReview({ agreed: [{ kind: "finding", key: "f-a", issue: "lock leaks", severity: "important" }] });
    const stored: PrComment = {
      id: "7",
      kind: "comment",
      author: "bot",
      body: withPushLedger(withNaxBotMarker("earlier summary", "fix-summary"), [retained]),
      createdAt: "",
    };
    const edit = spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    await reportStep(
      { ...env, own: [{ key: "fix-summary", comment: stored }] },
      { step: "report", timings: {}, outcome: "protected", protectedFiles },
    );
    const body = String(edit.mock.calls[0]?.[2] ?? "");
    expect(body.length).toBeLessThanOrEqual(MAX_FORGE_COMMENT_CHARS);
    // The retained record survives, and the comment says what it did not name.
    expect(readPushLedger(body).entries).toEqual([retained]);
    expect(body).toContain("The fix changed protected files; nothing pushed.");
    expect(body).toContain("- and 380 more");
  });

  test("a fix that changed nothing states no new push but keeps the history's count", async () => {
    const env = withReview({ agreed: [{ kind: "finding", key: "f-a", issue: "x", severity: "minor" }] });
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    await reportStep(env, { step: "report", timings: {}, outcome: "no-change" });
    expect(posted(post)).not.toContain("nax bot fix pushes");
  });

  test.each([
    ["a pushed fix", state],
    ["a fix that pushed nothing", { step: "report", timings: {}, outcome: "nothing" } satisfies BotFixState],
  ] as const)("the outcome line stays the summary's first content line: %s", async (_label, fixState) => {
    const env = withReview({ unreachablePushes: 1 });
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "new" });
    await reportStep(env, fixState);
    expect(posted(post).split("\n")[2]).toBe(renderFixSummary(fixState).split("\n")[2]);
  });
});

describe("renderFixSummary gate baseline (nax#2631)", () => {
  const red = (patch: Partial<BotFixState>): BotFixState => ({
    step: "report",
    timings: {},
    failingGates: ["lint", "test"],
    ...patch,
  });

  test("baseline-red with CI green blames the bot checkout, not the fix", () => {
    const out = renderFixSummary(
      red({ outcome: "baseline-red", baselineFailing: ["lint", "test"], ciOutcome: "green" }),
    );
    expect(out).toContain("Gates failed: lint, test.");
    expect(out).toContain("They fail on the unmodified PR head in the bot checkout too, while CI is green on it");
    expect(out).toContain("so the bot checkout differs from CI and these gates cannot judge the fix");
  });
  test("baseline-red with CI red says the failure predates the fix", () => {
    const out = renderFixSummary(
      red({ outcome: "baseline-red", baselineFailing: ["lint", "test"], ciOutcome: "failed" }),
    );
    expect(out).toContain("CI is red on it too: the failure predates the fix");
  });
  test("baseline-red without a CI result names CI's state", () => {
    const out = renderFixSummary(
      red({ outcome: "baseline-red", baselineFailing: ["lint", "test"], ciOutcome: "pending" }),
    );
    expect(out).toContain("CI has no result for it (pending)");
  });
  test("gates-failed names the gates that were already red on the head", () => {
    const out = renderFixSummary(red({ outcome: "gates-failed", baselineFailing: ["lint"], ciOutcome: "green" }));
    expect(out).toContain("Gates failed: lint, test; nothing pushed.");
    expect(out).toContain("Already red on the unmodified PR head: lint.");
  });
  test("gates-failed with a green head adds nothing", () => {
    const out = renderFixSummary(red({ outcome: "gates-failed", baselineFailing: [], ciOutcome: "green" }));
    expect(out).not.toContain("Already red");
  });
});
