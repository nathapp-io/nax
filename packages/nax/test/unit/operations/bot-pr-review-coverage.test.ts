/**
 * US-003 (nax#2858): the bot review ops' coverage retries. Coverage has a budget of its own
 * (`workflow.review.coverageRetries`), separate from the triage retry it wraps, and triage always
 * comes first. A partial verdict is kept through `exhaustedFallback`, findings included.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeMockCallContext, makeNaxConfig, makeScriptedCallOp, makeTestRuntime, opSelector } from "@test/helpers";
import type { RetryStrategy } from "@/agents/retry";
import { ParseValidationError } from "@/agents/retry";
import { _reviewStepDeps, runPrReview } from "@/bot";
import { resolveWorkflowConfig, workflowConfigSelector } from "@/config";
import { NaxError } from "@/errors";
import type { PrInfo } from "@/forge";
import { initLogger, resetLogger } from "@/logger";
import { type BotPrReviewInput, botPrReviewOp, botPrStaticReviewOp, parsePrReviewReply } from "@/operations";
import { buildBotTriageRetry, buildWorkflowBranchCoverageRetry } from "@/prompts";
import type { NaxRuntime } from "@/runtime";
import type { PrStepContext } from "@/workflow/branch-step-context";
import { _workflowDeps } from "@/workflow/step-context";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function buildCtx() {
  const runtime = makeTestRuntime({ config: makeNaxConfig() });
  createdRuntimes.push(runtime);
  const packageView = runtime.packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const RANGE = "reviewed..HEAD";
const REPO_ROOT = "/checkout";

const input: BotPrReviewInput = {
  prompt: "review the PR",
  timeoutMs: 1000,
  threadIds: ["T1"],
  commentIds: [],
  requiredFiles: ["src/a.ts"],
  repoRoot: REPO_ROOT,
  range: RANGE,
};

/** The same input with no coverage set at all: coverage has nothing to compare against. */
const uncovered: BotPrReviewInput = { prompt: "review the PR", timeoutMs: 1000, threadIds: ["T1"], commentIds: [] };

/** A bot review reply that triages the given threads and names the files it read. */
function reply(inspectedFiles: readonly string[], threads: readonly string[] = ["T1"]): string {
  return JSON.stringify({
    intent: "pass",
    quality: "approved",
    findings: [{ issue: "bug" }],
    threads: threads.map((id) => ({ id, decision: "agree", reason: "needed" })),
    inspectedFiles,
  });
}

const probe = new ParseValidationError("parse probe");
const retryCtx = (lastOutput: string) => ({
  site: "run" as const,
  agentName: "native",
  stage: "review" as const,
  lastOutput,
});

/** The op's `retry` resolver, resolved into the strategy `callOp` would run. */
function strategyFor(op: typeof botPrReviewOp, value: BotPrReviewInput): RetryStrategy {
  const resolve = op.retry;
  if (typeof resolve !== "function") throw new Error("retry must be a resolver");
  const strategy = resolve(value, buildCtx());
  if (strategy === undefined || !("shouldRetry" in strategy)) throw new Error("retry must resolve to a strategy");
  return strategy;
}

describe("bot review coverage retry budget (US-003)", () => {
  test("AC-1: a triage-complete reply that reads none of the required files is asked again at attempt 1 of 3", () => {
    const decision = strategyFor(botPrReviewOp, input).shouldRetry(probe, 0, retryCtx(reply([])));

    expect(decision).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(RANGE, ["src/a.ts"], false, { attempt: 1, max: 3 }),
    });
  });

  test("AC-2: the static review asks with the command-free coverage prompt", () => {
    const decision = strategyFor(botPrStaticReviewOp, input).shouldRetry(probe, 0, retryCtx(reply([])));

    expect(decision).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchCoverageRetry(RANGE, ["src/a.ts"], true, { attempt: 1, max: 3 }),
    });
  });

  test("AC-3: a missing thread id beats the missing file, so the triage retry is sent first", () => {
    const decision = strategyFor(botPrReviewOp, input).shouldRetry(probe, 0, retryCtx(reply([], [])));

    expect(decision).toEqual({ retry: true, delayMs: 0, nextPrompt: buildBotTriageRetry(["T1"]) });
    const coveragePrompt = buildWorkflowBranchCoverageRetry(RANGE, ["src/a.ts"], false, { attempt: 1, max: 3 });
    expect("nextPrompt" in decision && decision.nextPrompt).not.toBe(coveragePrompt);
  });

  test("AC-4: a coverage retry that covered no more files stops with the parsed partial verdict", () => {
    const warn = spyOn(initLogger({ level: "silent" }), "warn");
    try {
      const strategy = strategyFor(botPrReviewOp, { ...input, coverageRetries: 3 });
      const partial = reply([]);

      expect(strategy.shouldRetry(probe, 0, retryCtx(partial))).toMatchObject({ retry: true });
      const decision = strategy.shouldRetry(probe, 1, retryCtx(partial));

      expect(decision).toEqual({ retry: false, fallback: parsePrReviewReply(partial, input.threadIds, []) });
      const fallback = "fallback" in decision ? decision.fallback : undefined;
      expect(fallback).toMatchObject({ findings: [{ issue: "bug" }], inspectedFiles: [] });
      // The coverage layer, not the triage budget, is what stopped: the budget still had room.
      expect(warn).toHaveBeenCalledWith(
        "bot-pr-review",
        "Coverage retry stopped",
        expect.objectContaining({ attempt: 1, unread: 1, reason: "no progress" }),
      );
    } finally {
      warn.mockRestore();
      resetLogger();
    }
  });

  test("AC-5: with no coverage retry sent, an exhausted triage budget still stops with the parsed fallback", () => {
    const lastOutput = reply([`${REPO_ROOT}/src/a.ts`], []);
    const decision = strategyFor(botPrReviewOp, input).shouldRetry(probe, 1, retryCtx(lastOutput));

    expect(decision).toEqual({
      retry: false,
      fallback: parsePrReviewReply(lastOutput, input.threadIds, []),
    });
  });

  test("AC-6: with no required files there is no coverage to retry, so a complete reply stops", () => {
    const decision = strategyFor(botPrReviewOp, uncovered).shouldRetry(probe, 0, retryCtx(reply([])));

    expect(decision).toEqual({ retry: false });
  });

  test("AC-7: an exhausted triage budget stops before coverage, even with a file still unread", () => {
    const lastOutput = reply([], []);
    const decision = strategyFor(botPrReviewOp, input).shouldRetry(probe, 1, retryCtx(lastOutput));

    expect(decision).toEqual({
      retry: false,
      fallback: parsePrReviewReply(lastOutput, input.threadIds, []),
    });
  });

  test("AC-8: coverage without a range is a NaxError, never a guess at the cwd", () => {
    const resolve = botPrReviewOp.retry;
    if (typeof resolve !== "function") throw new Error("retry must be a resolver");
    let thrown: unknown;
    try {
      resolve(
        {
          prompt: "review the PR",
          timeoutMs: 1000,
          threadIds: ["T1"],
          commentIds: [],
          requiredFiles: ["src/a.ts"],
          repoRoot: REPO_ROOT,
        },
        buildCtx(),
      );
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(NaxError);
    if (!(thrown instanceof NaxError)) throw new Error("expected a NaxError");
    expect(thrown.code).toBe("BOT_REVIEW_COVERAGE_INVALID");
  });
});

describe("runPrReview coverage budget wiring (US-003)", () => {
  const originalWorkflow = { ..._workflowDeps };
  const originalReview = { ..._reviewStepDeps };
  const info: PrInfo = {
    number: 42,
    title: "Change",
    body: "Adds X",
    author: { login: "alice", id: 123 },
    url: "https://example.test/pull/42",
    state: "open",
    draft: false,
    baseRef: "main",
    headRef: "feature",
    headSha: "head",
    crossRepo: false,
  };
  let ctx: PrStepContext;
  let calls: unknown[];

  beforeEach(() => {
    const config = structuredClone(makeNaxConfig({ workflow: { review: { sliceFiles: 15, coverageRetries: 1 } } }));
    ctx = {
      config,
      workflow: resolveWorkflowConfig(config),
      callCtx: makeMockCallContext(),
      projectDir: "/review/worktree",
      runDir: "/review/artifacts",
      reportPath: "/review/artifacts/report.md",
      feature: "bot-pr-42",
      packageDirs: [],
      dryRun: false,
      pr: { forge: "github", number: 42, base: "base", head: "head" },
    };
    calls = [];
    _reviewStepDeps.writeBranchReviewPackage = async () => ["src/a.ts"];
    _workflowDeps.appendChangedFileRules = async () => {};
    _workflowDeps.callOp = makeScriptedCallOp((_op, value) => {
      calls.push(value);
      return {
        intent: "pass",
        quality: "approved",
        findings: [],
        threads: [],
        comments: [],
        cannotVerify: [],
        inspectedFiles: ["src/a.ts"],
      };
    });
  });

  afterEach(() => {
    Object.assign(_workflowDeps, originalWorkflow);
    Object.assign(_reviewStepDeps, originalReview);
  });

  test("AC-9: workflow.review.coverageRetries reaches the review op's input", async () => {
    await runPrReview(ctx, { mergeBase: "merge-base", info, issues: [], staticMode: false, threads: [], comments: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ coverageRetries: 1, prompt: expect.any(String) });
  });
});
