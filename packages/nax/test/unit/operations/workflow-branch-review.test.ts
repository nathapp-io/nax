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
import { callOp, parseBranchReviewReply, type WorkflowBranchReviewInput, workflowBranchReviewOp } from "@/operations";
import { buildWorkflowReviewJsonRetry } from "@/prompts";
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
    const resolve = workflowBranchReviewOp.retry;
    if (typeof resolve !== "function") throw new Error("retry must be a resolver");
    const strategy = resolve(input, buildCtx());
    if (strategy === undefined || !("shouldRetry" in strategy)) throw new Error("retry must resolve to a strategy");
    const invalid = strategy.shouldRetry(new ParseValidationError("bad"), 0, retryCtx("not json"));
    expect(invalid.retry).toBe(true);
    const truncated = strategy.shouldRetry(
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

  test("the one retry spent, an incomplete verdict is kept with its findings (AC-11)", () => {
    const lastOutput = verdictJson([], [IMPORTANT_FINDING]);
    const decision = strategyFor(retryInput).shouldRetry(new ParseValidationError("bad"), 1, retryCtx(lastOutput));

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
