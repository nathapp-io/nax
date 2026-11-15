/**
 * Whole-branch review dispatch and failure handling. The scripted op records inputs after dispatch
 * so assertions are not swallowed by the review's own failure handling.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertDefined,
  cleanupTempDir,
  makeFeatureContext,
  makeMockAgentManager,
  makeResolvedTestPatterns,
  makeScriptedCallOp,
  makeSessionManager,
  makeTempDir,
  makeTestRuntime,
} from "@test/helpers";
import { type CallContext, callOp, workflowBranchReviewOp } from "@/operations";
import { buildWorkflowBranchReviewPrompt } from "@/prompts";
import type { NaxRuntime } from "@/runtime";
import { _branchReviewDeps, runBranchReview } from "@/workflow/branch-review";
import type { FeatureContext } from "@/workflow/feature-context";
import { _workflowDeps } from "@/workflow/step-context";
import type { BranchReviewVerdict } from "@/workflow/types";

const originalDeps = { ..._workflowDeps };
const originalBranchDeps = { ..._branchReviewDeps };
const dirs: string[] = [];

afterEach(async () => {
  Object.assign(_workflowDeps, originalDeps);
  Object.assign(_branchReviewDeps, originalBranchDeps);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

/** A fresh feature context over its own temp run dir, with git reporting no changes yet. */
function fc(over: Partial<FeatureContext> = {}): FeatureContext {
  const runDir = makeTempDir("wf-br-sliced-");
  dirs.push(runDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return makeFeatureContext({ runDir, ...over });
}

const facts = {
  stories: [{ id: "US-001", state: "complete" }],
  minors: [],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

/** Ten files in each of two directories. */
const DIR_A = Array.from({ length: 10 }, (_, i) => `a/f${i + 1}.ts`);
const DIR_B = Array.from({ length: 10 }, (_, i) => `b/f${i + 1}.ts`);

/** Stub the package writer's git reads so the branch changed exactly `files`, all of them required. */
function stubBranchChanges(files: readonly string[]): void {
  const changes = files.map((file) => `M\0${file}`).join("\0");
  _workflowDeps.git = async (args) => ({
    stdout: args.includes("--name-status") && changes !== "" ? `${changes}\0` : "",
    exitCode: 0,
  });
  // No path is classified as a test file, so every changed path stays in the required set.
  _workflowDeps.resolveTestPatterns = async () => makeResolvedTestPatterns({ regex: [] });
}

/** A branch-review reply that says it inspected `files`. */
function verdict(files: readonly string[]): BranchReviewVerdict {
  return {
    spec: "pass",
    quality: "approved",
    findings: [],
    cannotVerify: [],
    inspectedFiles: files,
    minorTriage: [],
  };
}

/** One field of a stubbed op input, read off `unknown` — the stub helper hands every input as `unknown`. */
function fieldOf(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null ? new Map(Object.entries(input)).get(key) : undefined;
}

/** One slice's op input, as far as these tests read it. */
interface SliceCall {
  readonly prompt: unknown;
  readonly requiredFiles: unknown;
  readonly coverageRetries: unknown;
}

/** Script `callOp` slice by slice, recording what each call received in dispatch order. */
function scriptSlices(respond: (call: number, input: unknown, ctx: CallContext) => unknown): SliceCall[] {
  const calls: SliceCall[] = [];
  _workflowDeps.callOp = makeScriptedCallOp((_op, input, ctx) => {
    calls.push({
      prompt: fieldOf(input, "prompt"),
      requiredFiles: fieldOf(input, "requiredFiles"),
      coverageRetries: fieldOf(input, "coverageRetries"),
    });
    return respond(calls.length, input, ctx);
  });
  return calls;
}

/** Resolve once the step's signal aborts — the slice's own timeout is the only clock this needs. */
function abortSignal(signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** Twenty changed files across two directories. */
function twoSliceContext(over: Partial<FeatureContext> = {}): FeatureContext {
  const ctx = fc(over);
  stubBranchChanges([...DIR_A, ...DIR_B]);
  return ctx;
}

describe("runBranchReview — one slice", () => {
  test("ten required files call the op once, with all ten as requiredFiles (AC-1)", async () => {
    const ctx = fc();
    stubBranchChanges(DIR_A);
    const calls = scriptSlices(() => verdict(DIR_A));
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    expect(out.ran).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0]?.requiredFiles).toEqual(DIR_A);
  });

  test("the prompt is the builder's, with requiredFiles and no slice (AC-2)", async () => {
    const ctx = fc();
    stubBranchChanges(DIR_A);
    const expected = buildWorkflowBranchReviewPrompt({
      prdPath: ctx.prdPath,
      packagePath: join(ctx.runDir, "package-branch.diff"),
      range: "seed0..HEAD",
      ...facts,
      requiredFiles: DIR_A,
    });
    const calls = scriptSlices(() => verdict(DIR_A));
    await runBranchReview(ctx, { seed: "seed0", facts });
    expect(calls.length).toBe(1);
    expect(calls[0]?.prompt).toBe(expected);
  });

  test("the one-slice verdict is the op's own object, with no slices field (AC-3)", async () => {
    const ctx = fc();
    stubBranchChanges(DIR_A);
    const reply = verdict(DIR_A);
    scriptSlices(() => reply);
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect(out.verdict).toBe(reply);
    expect("slices" in out.verdict).toBe(false);
  });

  test("a verdict with no inspectedFiles reports every required file unread (AC-17)", async () => {
    const ctx = fc();
    stubBranchChanges(DIR_A);
    const { inspectedFiles: _omitted, ...withoutInspected } = verdict(DIR_A);
    scriptSlices(() => withoutInspected);
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect(out.verdict.unreadFiles).toEqual(DIR_A);
  });
});

describe("runBranchReview — the package step", () => {
  test("a package writer that throws skips the review without running a slice (AC-9)", async () => {
    const ctx = fc();
    _branchReviewDeps.writeBranchReviewPackage = async () => {
      throw new Error("boom");
    };
    const calls = scriptSlices(() => verdict([]));
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    expect(out).toEqual({ ran: false, why: "review package failed: boom" });
    expect(calls.length).toBe(0);
  });

  test("a package writer that throws while the run is aborting rejects (AC-10)", async () => {
    const controller = new AbortController();
    const ctx = fc({ runSignal: controller.signal });
    controller.abort();
    _branchReviewDeps.writeBranchReviewPackage = async () => {
      throw new Error("boom");
    };
    await expect(runBranchReview(ctx, { seed: "seed0", facts })).rejects.toThrow("boom");
  });

  test("a required-set failure skips the review without running a slice (AC-18)", async () => {
    const ctx = twoSliceContext();
    _branchReviewDeps.reviewRequiredFiles = async () => {
      throw new Error("boom");
    };
    const calls = scriptSlices(() => verdict([]));
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    expect(out).toEqual({ ran: false, why: "review package failed: boom" });
    expect(calls.length).toBe(0);
  });
});

describe("runBranchReview — opt-in last-parseable handoff (US-013)", () => {
  const prompts: string[] = [];
  const runtimes: NaxRuntime[] = [];

  beforeEach(() => {
    prompts.length = 0;
  });

  afterEach(async () => {
    await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
    runtimes.length = 0;
  });

  /**
   * Dispatch through the real `callOp` instead of the scripted stub, against an agent that answers
   * each turn with the next scripted reply. The ctx is given a real temp workdir so the dispatch's
   * own cwd preflight has a directory to run in.
   */
  function realDispatch(replies: readonly string[]): CallContext {
    const agentManager = makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        assertDefined(req.executeHop, "req.executeHop");
        const hop = await req.executeHop("claude", undefined, { kind: "primary" }, req.runOptions);
        return { result: { ...hop.result, agentFallbacks: [] }, fallbacks: [] };
      },
      runAsSessionFn: async (_agentName, _handle, prompt) => {
        prompts.push(prompt);
        return {
          output: replies[prompts.length - 1] ?? "",
          estimatedCostUsd: 0,
          internalRoundTrips: 1,
          tokenUsage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    });
    const runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });
    runtimes.push(runtime);
    const workdir = makeTempDir("wf-br-handoff-");
    dirs.push(workdir);
    _workflowDeps.callOp = callOp;
    return { runtime, packageView: runtime.packages.repo(), packageDir: workdir, agentName: "claude", storyId: "_run" };
  }

  /** A branch-review reply as the reviewer sends it. */
  function replyJson(over: Record<string, unknown>): string {
    return JSON.stringify({
      spec: "pass",
      quality: "approved",
      findings: [],
      cannotVerify: [],
      inspectedFiles: DIR_A,
      minorTriage: [],
      ...over,
    });
  }

  test("AC-9: with the flag set and no parseable reply the review is skipped, not certified clean", async () => {
    stubBranchChanges(DIR_A);
    const callCtx = realDispatch(["not json", "not json"]);
    const ctx = fc({ callCtx });

    const out = await runBranchReview(ctx, { seed: "seed0", facts });

    // The opt-in is in force — the branch op is the op that sets it.
    expect(workflowBranchReviewOp.preferRetryFallbackOnNullParse).toBe(true);
    expect(out).toEqual({ ran: false, why: "unparseable reply" });
  });

  test("AC-10: the last parseable inconsistent review is the branch verdict, not a skipped review", async () => {
    stubBranchChanges(DIR_A);
    const callCtx = realDispatch([replyJson({ spec: "fail" }), "not json", "not json"]);
    const ctx = fc({ callCtx });

    const out = await runBranchReview(ctx, { seed: "seed0", facts });

    expect(prompts).toHaveLength(3);
    if (!out.ran) throw new Error(`the branch review must run, got ${out.why}`);
    expect(out.verdict.spec).toBe("fail");
    expect(out.verdict.mismatch).toEqual(["spec"]);
  });
});

describe("runBranchReview — session failures", () => {
  test("unparseable replies skip the review", async () => {
    const ctx = twoSliceContext();
    const calls = scriptSlices(() => null);
    expect(await runBranchReview(ctx, { seed: "seed0", facts })).toEqual({ ran: false, why: "unparseable reply" });
    expect(calls.length).toBe(1);
  });
  test("abort propagates", async () => {
    const controller = new AbortController();
    const ctx = twoSliceContext({ runSignal: controller.signal });
    const calls = scriptSlices(() => {
      controller.abort();
      throw new Error("aborted mid-review");
    });
    await expect(runBranchReview(ctx, { seed: "seed0", facts })).rejects.toThrow("aborted mid-review");
    expect(calls.length).toBe(1);
  });
  test("review timeout skips the session", async () => {
    const base = makeFeatureContext();
    const ctx = twoSliceContext({
      workflow: { ...base.workflow, timeouts: { ...base.workflow.timeouts, reviewMs: 1 } },
    });
    scriptSlices(async (_call, _input, callCtx) => {
      await abortSignal(callCtx.signal);
      return verdict(DIR_A);
    });
    expect(await runBranchReview(ctx, { seed: "seed0", facts })).toEqual({ ran: false, why: "timeout" });
  });
});
