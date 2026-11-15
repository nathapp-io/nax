import { afterEach, describe, expect, test } from "bun:test";
import {
  assertDefined,
  makeMockAgentManager,
  makeNaxConfig,
  makeSessionManager,
  makeTestRuntime,
  opSelector,
} from "@test/helpers";
import { ParseValidationError } from "@/agents";
import type { RetryStrategy } from "@/agents/retry";
import type { TurnResult } from "@/agents/types";
import { workflowConfigSelector } from "@/config";
import {
  _branchReviewRetryDeps,
  type BranchReviewVerdict,
  callOp,
  parseBranchReviewReply,
  type WorkflowBranchReviewInput,
  workflowBranchReviewOp,
} from "@/operations";
import {
  buildWorkflowBranchVerdictMismatchRetry,
  buildWorkflowReviewJsonRetry,
  VERDICT_MISMATCH_SENTENCES,
} from "@/prompts";
import type { NaxRuntime } from "@/runtime";

const createdRuntimes: NaxRuntime[] = [];
afterEach(async () => {
  await Promise.allSettled(createdRuntimes.map((r) => r.close()));
  createdRuntimes.length = 0;
});

function buildCtx(overrides: Record<string, unknown> = {}) {
  const config = makeNaxConfig(overrides);
  const packageView = makeTestRuntime({ config }).packages.repo();
  return { packageView, config: packageView.select(opSelector(workflowConfigSelector)) };
}

const input: WorkflowBranchReviewInput = {
  prompt: "review the branch",
  timeoutMs: 1000,
  minorIds: ["M1"],
  repoRoot: "/repo",
  requiredFiles: [],
  range: "seed0..HEAD",
};

function modelFor(i: WorkflowBranchReviewInput, overrides: Record<string, unknown>) {
  const m = workflowBranchReviewOp.model;
  return typeof m === "function" ? m(i, buildCtx(overrides)) : m;
}

describe("workflowBranchReviewOp", () => {
  test("shape: fresh wf-branch-review, stage review, read tools + Git + sandboxed Bash", () => {
    expect(workflowBranchReviewOp.session).toEqual({ role: "wf-branch-review", lifetime: "fresh" });
    expect(workflowBranchReviewOp.stage).toBe("review");
    expect(workflowBranchReviewOp.tools).toEqual(["Read", "Glob", "Grep", "Git", "Bash"]);
    expect(workflowBranchReviewOp.build(input, buildCtx()).task.content).toBe("review the branch");
  });

  test("model: input, then workflow.models.branchReview, then finish.reviewers.quality (spec §4)", () => {
    expect(modelFor(input, { finish: { reviewers: { quality: "fast" } } })).toBe("fast");
    expect(
      modelFor(input, {
        finish: { reviewers: { quality: "fast" } },
        workflow: { models: { branchReview: "powerful" } },
      }),
    ).toBe("powerful");
    expect(modelFor({ ...input, model: "balanced" }, { workflow: { models: { branchReview: "powerful" } } })).toBe(
      "balanced",
    );
  });

  test("parse triages the given minor ids", () => {
    const out = workflowBranchReviewOp.parse(
      JSON.stringify({ spec: "pass", quality: "approved", findings: [], cannotVerify: [] }),
      input,
      buildCtx(),
    );
    expect(out?.minorTriage).toEqual([{ id: "M1", decision: "leave" }]);
  });

  test("timeout adds the step margin to the input timeout", () => {
    const t = workflowBranchReviewOp.timeoutMs;
    const ms = typeof t === "function" ? t(input, buildCtx()) : t;
    expect(ms).toBeGreaterThan(input.timeoutMs);
  });

  test("retry: an unparseable reply is retried with a JSON-only prompt, a truncated one with the condensed prompt", () => {
    // US-012: the shape allowance is counted per invocation, so each probe is its own invocation
    // (a fresh strategy) instead of two probes against one instance.
    const invalid = strategyFor(input).shouldRetry(new ParseValidationError("bad"), 0, retryCtx("not json"));
    expect(invalid.retry).toBe(true);
    const truncated = strategyFor(input).shouldRetry(
      new ParseValidationError("bad"),
      0,
      retryCtx('{"spec": "pass", "findings": [{"issue": "cut'),
    );
    expect(truncated.retry).toBe(true);
    if (!invalid.retry || !truncated.retry) throw new Error("both replies must be retried");
    expect(truncated.nextPrompt).not.toBe(invalid.nextPrompt);
  });
});

// ─── Coverage retry (US-003, nax#2532) ───────────────────────────────────────

const retryInput: WorkflowBranchReviewInput = { ...input, minorIds: [], requiredFiles: ["src/a.ts"] };

function retryCtx(lastOutput: string) {
  return { site: "complete" as const, agentName: "claude", stage: "review" as const, storyId: "_run", lastOutput };
}

/** Resolve the op's `retry` resolver into the strategy it produces. */
function strategyFor(i: WorkflowBranchReviewInput): RetryStrategy {
  const resolve = workflowBranchReviewOp.retry;
  if (typeof resolve !== "function") throw new Error("retry must be a resolver");
  const strategy = resolve(i, buildCtx());
  if (strategy === undefined || !("shouldRetry" in strategy)) throw new Error("retry must resolve to a strategy");
  return strategy;
}

/** A branch-review reply as the reviewer sends it: parseable, with the files it claims to have read. */
function verdictJson(inspectedFiles: readonly string[], findings: readonly unknown[] = []): string {
  return JSON.stringify({
    spec: "pass",
    quality: "approved",
    inspectedFiles,
    findings,
    cannotVerify: [],
    minorTriage: [],
  });
}

const IMPORTANT_FINDING = {
  kind: "quality",
  severity: "important",
  issue: "b.ts is never exported from the barrel",
  file: "src/b.ts",
};

describe("workflowBranchReviewOp coverage retry (US-003)", () => {
  test("an incomplete verdict asks again with the coverage prompt (AC-8)", () => {
    const decision = strategyFor(retryInput).shouldRetry(new ParseValidationError("bad"), 0, retryCtx(verdictJson([])));

    expect(decision.retry).toBe(true);
    if (!decision.retry) throw new Error("an incomplete verdict must be retried");
    expect(decision.nextPrompt).toContain("- src/a.ts");
  });

  test("a complete verdict is accepted with no fallback (AC-9)", () => {
    const decision = strategyFor(retryInput).shouldRetry(
      new ParseValidationError("bad"),
      0,
      retryCtx(verdictJson(["src/a.ts"])),
    );

    expect(decision).toEqual({ retry: false });
  });

  test("an unparseable reply keeps the plain JSON retry prompt (AC-10)", () => {
    const decision = strategyFor(retryInput).shouldRetry(new ParseValidationError("bad"), 0, retryCtx("not json"));

    expect(decision.retry).toBe(true);
    if (!decision.retry) throw new Error("an unparseable reply must be retried");
    expect(decision.nextPrompt).toBe(buildWorkflowReviewJsonRetry());
  });

  test("a coverage retry that covered no more files keeps the incomplete verdict with its findings (AC-11)", () => {
    const strategy = strategyFor(retryInput);
    // US-002: at attempt 0 the incomplete verdict is asked again, on the coverage budget of its own.
    expect(strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx(verdictJson([])))).toMatchObject({
      retry: true,
    });
    const lastOutput = verdictJson([], [IMPORTANT_FINDING]);
    const decision = strategy.shouldRetry(new ParseValidationError("bad"), 1, retryCtx(lastOutput));

    expect(decision.retry).toBe(false);
    expect(decision).toEqual({ retry: false, fallback: parseBranchReviewReply(lastOutput, []) });
    const fallback = "fallback" in decision ? decision.fallback : undefined;
    expect(fallback).toMatchObject({ spec: "pass", inspectedFiles: [] });
    expect((fallback as { findings: readonly { issue: string }[] }).findings.map((f) => f.issue)).toEqual([
      IMPORTANT_FINDING.issue,
    ]);
  });

  test("the one retry spent, an unparseable reply falls back to null (AC-12)", () => {
    const decision = strategyFor(retryInput).shouldRetry(new ParseValidationError("bad"), 1, retryCtx("not json"));

    expect(decision.retry).toBe(false);
    expect(decision).toEqual({ retry: false, fallback: null });
  });

  test("a parseable incomplete reply that looks truncated gets the coverage prompt, not the condensed one (AC-13)", () => {
    const decision = strategyFor(retryInput).shouldRetry(
      new ParseValidationError("bad"),
      0,
      retryCtx(`${verdictJson([])}\n{"spec": "pass",`),
    );

    expect(decision.retry).toBe(true);
    if (!decision.retry) throw new Error("an incomplete verdict must be retried");
    expect(decision.nextPrompt).toContain("- src/a.ts");
  });

  test("an empty required set is complete: no coverage retry (AC-15)", () => {
    const decision = strategyFor({ ...retryInput, requiredFiles: [] }).shouldRetry(
      new ParseValidationError("bad"),
      0,
      retryCtx(verdictJson([])),
    );

    expect(decision).toEqual({ retry: false });
  });
});

describe("workflowBranchReviewOp coverage retry through callOp (AC-14)", () => {
  test("an incomplete first verdict is re-prompted in the same session, and the second verdict is the result", async () => {
    const turns: { handle: { id: string }; prompt: string }[] = [];
    const replies = [verdictJson([]), verdictJson(["src/a.ts"])];
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        const { executeHop } = req;
        assertDefined(executeHop, "req.executeHop");
        const hopResult = await executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hopResult.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, handle, prompt): Promise<TurnResult> => {
        turns.push({ handle, prompt });
        return {
          output: replies[turns.length - 1] ?? "",
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    createdRuntimes.push(runtime);

    const verdict = await callOp(
      { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "_run" },
      workflowBranchReviewOp,
      {
        repoRoot: "/tmp",
        prompt: "review the branch",
        timeoutMs: 1000,
        minorIds: [],
        requiredFiles: ["src/a.ts"],
        range: "seed0..HEAD",
      },
    );

    expect(turns).toHaveLength(2);
    expect(turns[0]?.handle).toBe(turns[1]?.handle);
    expect(turns[1]?.prompt).toContain("- src/a.ts");
    expect(verdict?.inspectedFiles).toEqual(["src/a.ts"]);
  });
});

// ─── Mismatch clarification (US-012) ────────────────────────────────────────

/**
 * A branch-review reply whose verdict contradicts its findings: `spec: fail` with nothing blocking.
 * The parser records the `spec` mismatch and keeps whatever findings the reply carries.
 */
function mismatchJson(inspectedFiles: readonly string[], findings: readonly unknown[] = []): string {
  return JSON.stringify({
    spec: "fail",
    quality: "approved",
    inspectedFiles,
    findings,
    cannotVerify: [],
    minorTriage: [],
  });
}

/** The blocking work the clarification asks the reviewer to name, as it then writes it. */
const BLOCKING_FINDING = {
  kind: "spec",
  severity: "critical",
  issue: "AC-3 is not implemented: the guard is missing",
  file: "src/a.ts",
};

/** A minor finding real enough to be kept: it is not blocking, so the mismatch stands. */
const MINOR_FINDING = {
  kind: "quality",
  severity: "minor",
  issue: "leftover debug log in src/a.ts",
  file: "src/a.ts",
};

const clarifyInput: WorkflowBranchReviewInput = { ...input, minorIds: [], requiredFiles: [] };

interface ReviewRun {
  readonly prompts: string[];
  readonly handles: { id: string }[];
}

/** Dispatch the op through real callOp, answering each turn with the next scripted reply. */
async function runReview(
  i: WorkflowBranchReviewInput,
  replies: readonly string[],
): Promise<ReviewRun & { verdict: BranchReviewVerdict | null }> {
  const prompts: string[] = [];
  const handles: { id: string }[] = [];
  const agentManager = makeMockAgentManager({
    runWithFallbackFn: async (req) => {
      assertDefined(req.executeHop, "req.executeHop");
      const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
      return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
    },
    runAsSessionFn: async (_agentName, handle, prompt): Promise<TurnResult> => {
      prompts.push(prompt);
      handles.push(handle);
      return {
        output: replies[prompts.length - 1] ?? "",
        estimatedCostUsd: 0,
        internalRoundTrips: 1,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
      };
    },
  });
  const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
  createdRuntimes.push(runtime);
  const verdict = await callOp(
    { runtime, packageView: runtime.packages.repo(), packageDir: "/tmp", agentName: "claude", storyId: "_run" },
    workflowBranchReviewOp,
    i,
  );
  return { prompts, handles, verdict };
}

describe("workflowBranchReviewOp mismatch clarification (US-012)", () => {
  test("AC-1: exactly one clarification for a parseable review that lacks blockers", async () => {
    const { prompts } = await runReview(clarifyInput, [mismatchJson([]), verdictJson([])]);

    expect(prompts).toHaveLength(2);
    const clarifications = prompts.filter((prompt) => prompt.includes("contradict each other"));
    expect(clarifications).toHaveLength(1);
  });

  test("AC-2: the clarification goes to the initial review's session handle", async () => {
    const { handles } = await runReview(clarifyInput, [mismatchJson([]), verdictJson([])]);

    expect(handles).toHaveLength(2);
    expect(handles[1]).toBe(handles[0]);
    expect(new Set(handles).size).toBe(1);
  });

  test("AC-3: the clarification asks for the failed kind's remedy, to name the missing work or correct the verdict", async () => {
    const { prompts } = await runReview(clarifyInput, [mismatchJson([]), verdictJson([])]);

    const clarification = prompts[1] ?? "";
    expect(clarification).toContain(VERDICT_MISMATCH_SENTENCES.spec);
    expect(clarification).toContain("Name the missing defect or the acceptance criterion that fails");
    expect(clarification).toContain("or correct the verdict");
  });

  test("AC-3: a quality mismatch carries the quality remedy instead", async () => {
    const { prompts } = await runReview(clarifyInput, [
      JSON.stringify({ spec: "pass", quality: "changes", inspectedFiles: [], findings: [], cannotVerify: [] }),
      verdictJson([]),
    ]);

    const clarification = prompts[1] ?? "";
    expect(clarification).toContain(VERDICT_MISMATCH_SENTENCES.quality);
    expect(clarification).not.toContain(VERDICT_MISMATCH_SENTENCES.spec);
  });

  test("AC-4: the clarification requires the complete branch-review object", async () => {
    const { prompts } = await runReview(clarifyInput, [mismatchJson([]), verdictJson([])]);

    const clarification = prompts[1] ?? "";
    for (const field of ['"findings"', '"inspectedFiles"', '"cannotVerify"', '"minorTriage"']) {
      expect(clarification).toContain(field);
    }
  });

  test("AC-5: a corrected clean verdict is accepted, with no fix target", () => {
    const strategy = strategyFor(clarifyInput);
    expect(strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx(mismatchJson([])))).toMatchObject({
      retry: true,
    });

    expect(strategy.shouldRetry(new ParseValidationError("bad"), 1, retryCtx(verdictJson([])))).toEqual({
      retry: false,
    });
  });

  test("AC-6: the last-parseable fallback carries the blocking work the clarification reply named", () => {
    const strategy = strategyFor({ ...clarifyInput, requiredFiles: ["src/a.ts"] });
    strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx(mismatchJson([])));
    strategy.shouldRetry(new ParseValidationError("bad"), 1, retryCtx(mismatchJson([], [BLOCKING_FINDING])));
    strategy.shouldRetry(new ParseValidationError("bad"), 2, retryCtx("not json"));
    const decision = strategy.shouldRetry(new ParseValidationError("bad"), 3, retryCtx("not json"));

    expect(decision.retry).toBe(false);
    const fallback = "fallback" in decision ? decision.fallback : undefined;
    const findings = (fallback as { findings: readonly { issue: string }[] }).findings;
    expect(findings.map((f) => f.issue)).toEqual([BLOCKING_FINDING.issue]);
  });

  test("AC-7: a persistently inconsistent reply gets no second clarification", async () => {
    const { prompts } = await runReview({ ...clarifyInput, coverageRetries: 0 }, [mismatchJson([]), mismatchJson([])]);

    expect(prompts.filter((prompt) => prompt.includes("contradict each other"))).toHaveLength(1);
  });

  test("AC-8: the exhausted fallback is the last parseable reply, with its mismatch evidence and real findings", () => {
    const strategy = strategyFor(clarifyInput);
    strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx(mismatchJson([], [MINOR_FINDING])));
    strategy.shouldRetry(new ParseValidationError("bad"), 1, retryCtx("not json"));
    const decision = strategy.shouldRetry(new ParseValidationError("bad"), 2, retryCtx("not json"));

    expect(decision.retry).toBe(false);
    const fallback = "fallback" in decision ? decision.fallback : undefined;
    expect(fallback).toMatchObject({
      spec: "fail",
      mismatch: ["spec"],
      findings: [{ issue: MINOR_FINDING.issue, severity: "minor" }],
    });
  });

  test("AC-9: a malformed clarification is repaired only with the remaining one-turn JSON allowance", () => {
    const strategy = strategyFor(clarifyInput);
    strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx(mismatchJson([])));

    const repair = strategy.shouldRetry(new ParseValidationError("bad"), 1, retryCtx("not json"));
    expect(repair).toEqual({ retry: true, delayMs: 0, nextPrompt: buildWorkflowReviewJsonRetry() });
    expect(strategy.shouldRetry(new ParseValidationError("bad"), 2, retryCtx("not json")).retry).toBe(false);
  });

  test("AC-10: an inconsistent and incomplete reply is clarified before any coverage prompt", async () => {
    const { prompts } = await runReview({ ...clarifyInput, requiredFiles: ["src/a.ts"] }, [
      mismatchJson([]),
      verdictJson(["src/a.ts"]),
    ]);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("contradict each other");
    expect(prompts.filter((prompt) => prompt.includes("coverage retry"))).toHaveLength(0);
  });

  test("AC-17: a mismatch introduced by a coverage response is clarified", async () => {
    const { prompts } = await runReview({ ...clarifyInput, requiredFiles: ["src/a.ts"] }, [
      verdictJson([]),
      mismatchJson(["src/a.ts"]),
      verdictJson(["src/a.ts"]),
    ]);

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("- src/a.ts");
    expect(prompts[2]).toContain("contradict each other");
  });

  test("AC-17: a spent clarification latch is not reopened by a mismatch a coverage response introduces", () => {
    const strategy = strategyFor({ ...clarifyInput, requiredFiles: ["src/a.ts"] });
    // The invocation's one clarification is spent on the first reply.
    expect(strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx(mismatchJson([])))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowBranchVerdictMismatchRetry(["spec"]),
    });
    expect(strategy.shouldRetry(new ParseValidationError("bad"), 1, retryCtx(verdictJson([])))).toMatchObject({
      retry: true,
    });

    // This mismatch answers that coverage prompt; the latch is spent, so nothing asks again.
    expect(strategy.shouldRetry(new ParseValidationError("bad"), 2, retryCtx(mismatchJson(["src/a.ts"])))).toEqual({
      retry: false,
    });
  });

  test("AC-20: a hop restarted at attempt 0 issues no second JSON repair", () => {
    const strategy = strategyFor(clarifyInput);
    expect(strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx("not json"))).toEqual({
      retry: true,
      delayMs: 0,
      nextPrompt: buildWorkflowReviewJsonRetry(),
    });

    const restarted = strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx("not json"));
    expect(restarted.retry).toBe(false);
  });

  test("AC-21: an adapterFailure transport result gets no clarification, JSON or coverage prompt", () => {
    const adapterFailedTurn: TurnResult = {
      output: mismatchJson([]),
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      internalRoundTrips: 0,
      adapterFailure: { category: "availability", outcome: "fail-rate-limit", retriable: true, message: "" },
    };
    const failed = strategyFor({ ...clarifyInput, requiredFiles: ["src/a.ts"] }).shouldRetry(
      new ParseValidationError("bad"),
      0,
      { ...retryCtx(mismatchJson([])), lastTurnResult: adapterFailedTurn },
    );
    expect(failed.retry).toBe(false);

    // The same reply without the transport failure is exactly what the clarification asks about,
    // so the absence above is the transport result's doing and not the reply's.
    expect(
      strategyFor({ ...clarifyInput, requiredFiles: ["src/a.ts"] }).shouldRetry(
        new ParseValidationError("bad"),
        0,
        retryCtx(mismatchJson([])),
      ),
    ).toEqual({ retry: true, delayMs: 0, nextPrompt: buildWorkflowBranchVerdictMismatchRetry(["spec"]) });
  });
});

describe("workflowBranchReviewOp retry seams (US-012)", () => {
  const savedMake = _branchReviewRetryDeps.makeMismatchClarificationStrategy;
  const savedBuild = _branchReviewRetryDeps.buildWorkflowBranchVerdictMismatchRetry;
  afterEach(() => {
    _branchReviewRetryDeps.makeMismatchClarificationStrategy = savedMake;
    _branchReviewRetryDeps.buildWorkflowBranchVerdictMismatchRetry = savedBuild;
  });

  test("AC-22 and AC-24: the wrapper is built from the seam, and callOp sends the factory's prompt for the failed kind", async () => {
    const builderCalls: (readonly string[])[] = [];
    let parsedViaCallback: unknown;
    let promptViaFactory: string | undefined;
    let callbackIsParse: boolean | undefined;
    _branchReviewRetryDeps.buildWorkflowBranchVerdictMismatchRetry = (kinds) => {
      builderCalls.push([...kinds]);
      return savedBuild(kinds);
    };
    _branchReviewRetryDeps.makeMismatchClarificationStrategy = (opts) => {
      // Capture during a real mismatch run: both callbacks the seam is given, exercised.
      callbackIsParse = opts.parse(mismatchJson([])) !== null;
      parsedViaCallback = opts.parse(mismatchJson([]));
      promptViaFactory = opts.prompt(opts.mismatch(parsedViaCallback));
      return savedMake(opts);
    };

    const { prompts } = await runReview(clarifyInput, [mismatchJson([]), verdictJson([])]);

    expect(callbackIsParse).toBe(true);
    expect(promptViaFactory).toContain("contradict each other");
    expect(prompts[1]).toBe(buildWorkflowBranchVerdictMismatchRetry(["spec"]));
    expect(builderCalls.length).toBeGreaterThan(0);
    expect(builderCalls.every((kinds) => kinds.length === 1 && kinds[0] === "spec")).toBe(true);
  });

  test("AC-23: the stubbed wrapper's returns decide the follow-up prompt callOp sends", async () => {
    const stubbed: RetryStrategy = {
      shouldRetry: (_failure, attempt) =>
        attempt === 0 ? { retry: true, delayMs: 0, nextPrompt: "STUBBED CLARIFICATION" } : { retry: false },
    };
    _branchReviewRetryDeps.makeMismatchClarificationStrategy = () => stubbed;

    const { prompts } = await runReview(clarifyInput, [mismatchJson([]), verdictJson([])]);

    expect(prompts[1]).toBe("STUBBED CLARIFICATION");
  });
});
