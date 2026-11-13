import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { makeBotFixDeps, makeBotFixDraftEnv, makeTestRuntime } from "@test/helpers";
import {
  _botFixDeps,
  _fixCycleDeps,
  _fixReportDeps,
  type BotFixEnv,
  type BotFixInput,
  type BotFixResult,
  type BotFixState,
  type BotReviewResult,
  readyStep,
  renderFixSummary,
  runBotFix,
  runBotFixCycle,
} from "@/bot";
import type { RecordRulingsOutcome } from "@/bot/rulings";
import { NAX_BOT_HEADER, NAX_WORKFLOW_PR_MARKER, type PrComment, parseNaxBotMarker, withNaxBotMarker } from "@/forge";
import type { CiWaitResult } from "@/workflow/ci-wait";
import { parseCiWaiver } from "@/workflow/ci-waiver";

/** A full 40-hex execution head: the waiver record only round-trips a complete sha. */
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const STARVATION = "runner starvation";
const starved: CiWaitResult = { outcome: "starved", detail: "1 check(s) never got a runner: x", starvedChecks: ["x"] };
const green: CiWaitResult = { outcome: "green", detail: "all checks passed" };
/** The readiness pass at a head nothing pushed: no pushed head to hold for (US-001). */
const state: BotFixState = { step: "ready", timings: {}, outcome: "nothing" };
/** The one item the PR published, settled by a ruling: every item is settled before readiness runs. */
const item = {
  key: "w-B3.12345678",
  itemId: "B3",
  kind: "ruling" as const,
  thread: { id: "1", replyTo: "1", resolved: false, outdated: false, comments: [] },
  replies: [],
};
const settled: RecordRulingsOutcome = {
  index: { keys: [item.key] },
  recorded: [],
  asked: 0,
  failed: 0,
  open: [],
  settled: [
    {
      ...item,
      ruling: {
        itemKey: item.key,
        itemId: item.itemId,
        disposition: "fixed",
        reason: "done",
        sha: "abcdef12",
        by: "writer",
      },
    },
  ],
};

const botFixOriginal = { ..._botFixDeps };
const runtimes: ReturnType<typeof makeTestRuntime>[] = [];
beforeEach(() => {
  spyOn(_fixReportDeps, "waitForPrHead").mockResolvedValue(true);
});
afterEach(async () => {
  Object.assign(_botFixDeps, botFixOriginal);
  mock.restore();
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

/** The draft env at the exact head the waiver record names. */
function draftEnv(body = ""): BotFixEnv {
  const base = makeBotFixDraftEnv({ body });
  return { ...base, info: { ...base.info, headSha: HEAD }, review: { ...base.review, headSha: HEAD } };
}

/** An own evidence comment, so `writeEvidence` edits instead of posting and the waiver is the only post. */
function ownEvidence(env: BotFixEnv): PrComment {
  return {
    id: "7",
    kind: "comment",
    author: env.user.login,
    body: withNaxBotMarker("earlier evidence", "w-evidence"),
    createdAt: "",
  };
}

function workflowFixture(ci: CiWaitResult = starved) {
  const env = draftEnv(NAX_WORKFLOW_PR_MARKER);
  const order: string[] = [];
  spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
  spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
  spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([item.thread]);
  spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([ownEvidence(env)]);
  spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue(settled);
  const wait = spyOn(_fixReportDeps, "waitForChecks").mockImplementation(async () => {
    order.push("ci");
    return ci;
  });
  spyOn(_fixReportDeps, "editComment").mockImplementation(async () => {
    order.push("edit");
  });
  const post = spyOn(_fixReportDeps, "postPrComment").mockImplementation(async () => {
    order.push("post");
    return { id: "waiver" };
  });
  const run = spyOn(env.forge, "run").mockImplementation(async () => {
    order.push("ready");
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { env, order, wait, post, run };
}

function plainFixture(ci: CiWaitResult = starved) {
  const env = draftEnv();
  const order: string[] = [];
  spyOn(_fixReportDeps, "readPrInfo").mockImplementation(async () => {
    order.push("read");
    return env.info;
  });
  const wait = spyOn(_fixReportDeps, "waitForChecks").mockImplementation(async () => {
    order.push("ci");
    return ci;
  });
  const post = spyOn(_fixReportDeps, "postPrComment").mockImplementation(async () => {
    order.push("post");
    return { id: "waiver" };
  });
  const run = spyOn(env.forge, "run").mockImplementation(async () => {
    order.push("ready");
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { env, order, wait, post, run };
}

describe("readyStep starved CI waiver", () => {
  test("AC-5 the ready pass's CI wait re-runs starved jobs", async () => {
    const s = plainFixture();
    await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(s.wait.mock.calls[0]?.[2]).toMatchObject({ rerunStarved: true });
  });

  test("AC-6 the workflow path posts the waiver before marking ready", async () => {
    const s = workflowFixture();
    await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(s.order).toEqual(["ci", "edit", "post", "ready"]);
    expect(parseCiWaiver(s.post.mock.calls[0]?.[1] ?? "")).toEqual({
      headSha: HEAD,
      checks: ["x"],
      reason: STARVATION,
    });
  });

  test("AC-7 the workflow path reports the waiver it recorded", async () => {
    const s = workflowFixture();
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch.markedReady).toBe(true);
    expect(out.patch.ciWaived).toEqual({ checks: ["x"], reason: STARVATION });
  });

  test("AC-8 the plain path waives a starved CI and readies the PR", async () => {
    const s = plainFixture();
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch).toEqual({ markedReady: true, ciWaived: { checks: ["x"], reason: STARVATION } });
    // The head is read before the waiver write and once more after it (B2).
    expect(s.order).toEqual(["ci", "read", "post", "read", "ready"]);
    expect(parseCiWaiver(s.post.mock.calls[0]?.[1] ?? "")).toEqual({
      headSha: HEAD,
      checks: ["x"],
      reason: STARVATION,
    });
  });

  test("B2 the plain path holds the draft when the head moves during the waiver write", async () => {
    const s = plainFixture();
    const moved = { ...s.env.info, headSha: "f".repeat(40) };
    let posted = false;
    spyOn(_fixReportDeps, "readPrInfo").mockImplementation(async () => (posted ? moved : s.env.info));
    s.post.mockImplementation(async () => {
      posted = true;
      return { id: "waiver" };
    });
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch).toEqual({ markedReady: false, readyHeld: "PR head changed since this execution" });
    expect(out.exit).toBe("report");
    expect(s.run).not.toHaveBeenCalled();
  });

  test("M12 a starved CI that named no check is never recorded as a waiver", async () => {
    const s = plainFixture({ outcome: "starved", detail: "0 check(s) never got a runner" });
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch).toEqual({
      markedReady: false,
      readyHeld: "could not record the CI waiver: the CI wait named no starved checks",
    });
    expect(s.post).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });

  test("AC-9 the workflow path keeps the draft when the waiver cannot be recorded", async () => {
    const s = workflowFixture();
    s.post.mockRejectedValue(new Error("boom"));
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch).toEqual({ markedReady: false, readyHeld: "could not record the CI waiver: boom" });
    expect(out.exit).toBe("report");
    expect(s.run).not.toHaveBeenCalled();
  });

  test("AC-15 the plain path keeps the draft when the waiver cannot be recorded", async () => {
    const s = plainFixture();
    s.post.mockRejectedValue(new Error("boom"));
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch).toEqual({ markedReady: false, readyHeld: "could not record the CI waiver: boom" });
    expect(out.exit).toBe("report");
    expect(s.run).not.toHaveBeenCalled();
  });

  test("AC-10 without a reason a starved CI still holds the draft", async () => {
    const s = plainFixture();
    const out = await readyStep(s.env, state);
    expect(out.patch.markedReady).toBe(false);
    expect(out.patch.readyHeld).toStartWith("CI starved:");
    expect(s.post).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });

  test("AC-11 a failed CI is never waived", async () => {
    const s = plainFixture({ outcome: "failed", detail: "a check failed" });
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch).toEqual({ markedReady: false, readyHeld: "CI failed: a check failed" });
    expect(s.post).not.toHaveBeenCalled();
    expect(s.run).not.toHaveBeenCalled();
  });

  test("AC-12 a green CI readies the PR with no waiver", async () => {
    const s = plainFixture(green);
    const out = await readyStep({ ...s.env, waiveStarved: STARVATION }, state);
    expect(out.patch).toEqual({ markedReady: true });
    expect(s.post).not.toHaveBeenCalled();
    expect(s.run).toHaveBeenCalledTimes(1);
  });

  test("AC-17 without a waiver the green path is unchanged", async () => {
    const s = plainFixture(green);
    expect(await readyStep(s.env, state)).toEqual({ patch: { markedReady: true }, exit: "report" });
    expect(s.post).not.toHaveBeenCalled();
  });

  test("AC-4 runBotFix ready-only records the waiver and readies a settled workflow draft", async () => {
    const env = draftEnv(NAX_WORKFLOW_PR_MARKER);
    const runtime = makeTestRuntime({ config: env.config });
    runtimes.push(runtime);
    const deps = makeBotFixDeps(env, runtime);
    // The step graph's own forge is the injected one, so the mark-ready command is observed here.
    Object.assign(_botFixDeps, deps, { recordPrRulings: mock(async () => {}), forge: env.forge });
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([item.thread]);
    spyOn(_fixReportDeps, "listPrComments").mockResolvedValue([ownEvidence(env)]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue(settled);
    spyOn(_fixReportDeps, "editComment").mockResolvedValue();
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(starved);
    const post = spyOn(_fixReportDeps, "postPrComment").mockResolvedValue({ id: "waiver" });
    const run = spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const result = await runBotFix({
      dir: "/repo",
      pr: 42,
      profiles: [],
      interactive: false,
      readyOnly: true,
      waiveStarved: STARVATION,
    });
    expect(result).toMatchObject({ outcome: "ready-pass", markedReady: true });
    expect(post).toHaveBeenCalledTimes(1);
    expect(parseCiWaiver(post.mock.calls[0]?.[1] ?? "")).toEqual({
      headSha: HEAD,
      checks: ["x"],
      reason: STARVATION,
    });
    expect(run).toHaveBeenCalledTimes(1);
  });
});

/** The summary the full fix pass publishes before it holds the draft (F1). */
function heldSummary(env: BotFixEnv): PrComment {
  return {
    id: "9",
    kind: "comment",
    author: env.user.login,
    body: renderFixSummary(
      {
        step: "report",
        timings: {},
        outcome: "pushed",
        pushedSha: HEAD,
        markedReady: false,
        readyHeld: `pushed ${HEAD.slice(0, 7)}; a bot review of the pushed head decides readiness`,
      },
      [],
      env.repoRoot,
    ),
    createdAt: "",
  };
}

/** A forge comment store: posting appends, editing replaces the stored body in place. */
function commentStore(env: BotFixEnv, initial: readonly PrComment[]) {
  const store: PrComment[] = [...initial];
  spyOn(_fixReportDeps, "postPrComment").mockImplementation(async (_ref, body) => {
    const comment: PrComment = {
      id: `c${store.length + 1}`,
      kind: "comment",
      author: env.user.login,
      body,
      createdAt: "",
    };
    store.push(comment);
    return { id: comment.id };
  });
  spyOn(_fixReportDeps, "editComment").mockImplementation(async (_ref, stored, body) => {
    const at = store.findIndex((comment) => comment.id === stored.id);
    const found = store[at];
    if (found !== undefined) store[at] = { ...found, body };
  });
  spyOn(_fixReportDeps, "listPrComments").mockImplementation(async () => [...store]);
  return store;
}

function summaryOf(store: readonly PrComment[]): string {
  return store.filter((comment) => parseNaxBotMarker(comment.body)?.key === "fix-summary").at(-1)?.body ?? "";
}

/** The visible header `withNaxBotMarker` writes: a rewrite must leave exactly one (M15). */
function headerCount(body: string): number {
  return body.split(NAX_BOT_HEADER).length - 1;
}

describe("the fix summary names the waiver", () => {
  test("F1 a ready-only pass rewrites the summary the fix left behind", async () => {
    const env = draftEnv(NAX_WORKFLOW_PR_MARKER);
    const store = commentStore(env, [heldSummary(env)]);
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([item.thread]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue(settled);
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(starved);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    const out = await readyStep({ ...env, waiveStarved: STARVATION }, { ...state, readyOnly: true });
    expect(out.patch.markedReady).toBe(true);
    const body = summaryOf(store);
    expect(body).toContain(
      "Marked ready with a CI waiver: 1 check(s) never got a runner: x. Reason: runner starvation",
    );
    expect(body).not.toContain("Kept as draft:");
    // The rest of the summary survives: only the readiness lines are replaced.
    expect(body).toContain(`Pushed ${HEAD.slice(0, 7)}:`);
    // M15: the visible header is not stacked, once per rewrite.
    expect(headerCount(body)).toBe(1);
  });

  test("M15 a second rewrite does not stack another visible header", async () => {
    const env = draftEnv(NAX_WORKFLOW_PR_MARKER);
    const store = commentStore(env, [heldSummary(env)]);
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([item.thread]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue(settled);
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(starved);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    await readyStep({ ...env, waiveStarved: STARVATION }, { ...state, readyOnly: true });
    const first = summaryOf(store);
    await readyStep({ ...env, waiveStarved: STARVATION }, { ...state, readyOnly: true });
    const second = summaryOf(store);
    expect(headerCount(first)).toBe(1);
    expect(headerCount(second)).toBe(1);
    expect(second).toContain(
      "Marked ready with a CI waiver: 1 check(s) never got a runner: x. Reason: runner starvation",
    );
  });

  test("F1 the full cycle leaves a summary that names the waiver", async () => {
    const env = draftEnv(NAX_WORKFLOW_PR_MARKER);
    const runtime = makeTestRuntime({ config: env.config });
    runtimes.push(runtime);
    Object.assign(_botFixDeps, makeBotFixDeps(env, runtime), {
      recordPrRulings: mock(async () => {}),
      forge: env.forge,
    });
    const store = commentStore(env, []);
    spyOn(_fixReportDeps, "readPrInfo").mockResolvedValue(env.info);
    spyOn(_fixReportDeps, "readCurrentUser").mockResolvedValue(env.user);
    spyOn(_fixReportDeps, "listReviewThreads").mockResolvedValue([item.thread]);
    spyOn(_fixReportDeps, "recordPrRulings").mockResolvedValue(settled);
    spyOn(_fixReportDeps, "waitForChecks").mockResolvedValue(starved);
    spyOn(env.forge, "run").mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });

    // The fix pass the cycle opens with: it pushes, holds the draft and publishes its summary.
    const pushed: BotFixResult = {
      outcome: "pushed",
      pushedSha: HEAD,
      step: "done",
      timings: {},
      markedReady: false,
      readyHeld: `pushed ${HEAD.slice(0, 7)}; a bot review of the pushed head decides readiness`,
      limitUsd: 5,
      spentUsd: 0,
    };
    const runFix = mock(async (input: BotFixInput) => {
      if (input.readyOnly !== true) {
        await _fixReportDeps.postPrComment(
          env.ref,
          renderFixSummary(pushed, [], env.repoRoot),
          env.forge,
          env.repoRoot,
        );
        return pushed;
      }
      return runBotFix(input);
    });
    const posted: BotReviewResult = {
      outcome: "posted",
      intent: "pass",
      quality: "changes",
      staticMode: false,
      checksSource: "config",
      artifactPath: "/review.json",
      earlierAnswered: 0,
      inlineFindings: 0,
      threadsAnswered: 0,
      commentsAnswered: 0,
      offLine: 0,
      failed: 0,
    };

    const cycle = await runBotFixCycle(
      { dir: "/repo", pr: 42, profiles: [], interactive: false, rereview: true, waiveStarved: STARVATION },
      {
        ..._fixCycleDeps,
        runBotFix: runFix,
        runBotReview: async () => posted,
        gitToplevel: async () => "/repo",
        resolvePrRef: async () => env.ref,
        waitForPrHead: async () => true,
      },
    );
    expect(cycle.ready).toMatchObject({ markedReady: true });
    const body = summaryOf(store);
    expect(body).toContain(
      "Marked ready with a CI waiver: 1 check(s) never got a runner: x. Reason: runner starvation",
    );
    expect(body).not.toContain("Kept as draft:");
  });
});
