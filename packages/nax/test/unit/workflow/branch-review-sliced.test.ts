/**
 * US-008: the whole-branch review runs as sequential fresh slices. The package and its required set
 * are built once, each slice gets its own session and its own review timeout, and the verdicts merge
 * into one — with `slices` only when the review really was sliced.
 *
 * `_workflowDeps.git` feeds the package writer the branch's changed files; `_workflowDeps.callOp`
 * answers each slice; `_branchReviewDeps` is the package writer and the required-set classifier, so
 * a failure the real code paths would swallow (the classifier logs a resolver failure and widens the
 * required set) can still be scripted as a hard throw.
 *
 * What each slice received is recorded and asserted AFTER the run: an assertion inside the `callOp`
 * stub would reject the dispatch, and the review's own failure handling would swallow it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeFeatureContext,
  makeResolvedTestPatterns,
  makeScriptedCallOp,
  makeTempDir,
} from "@test/helpers";
import type { CallContext } from "@/operations";
import { buildWorkflowBranchReviewPrompt } from "@/prompts";
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

/** Ten files in `a/`, then ten in `b/`: at the default `sliceFiles` 15 that is one slice per directory. */
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

/** A two-slice run: twenty changed files across `a/` and `b/`, sliceFiles 15 by default. */
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

describe("runBranchReview — two slices", () => {
  test("twenty files call the op twice, one directory each (AC-4)", async () => {
    const ctx = twoSliceContext();
    const calls = scriptSlices((call) => verdict(call === 1 ? DIR_A : DIR_B));
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    expect(out.ran).toBe(true);
    expect(calls.map((call) => call.requiredFiles)).toEqual([DIR_A, DIR_B]);
  });

  test("the second slice's prompt names the slice (AC-5)", async () => {
    const ctx = twoSliceContext();
    const calls = scriptSlices((call) => verdict(call === 1 ? DIR_A : DIR_B));
    await runBranchReview(ctx, { seed: "seed0", facts });
    const prompt = String(calls[1]?.prompt);
    expect(prompt).toContain("This is review slice 2 of 2.");
    expect(String(calls[0]?.prompt)).toContain("This is review slice 1 of 2.");
  });

  test("the first slice resolves before the second starts (AC-6)", async () => {
    const ctx = twoSliceContext();
    const order: string[] = [];
    const firstResolved = { value: false };
    scriptSlices(async (call) => {
      order.push(`start:${call}`);
      if (call === 1) {
        await Promise.resolve();
        await Promise.resolve();
        firstResolved.value = true;
        order.push("end:1");
        return verdict(DIR_A);
      }
      order.push("end:2");
      return verdict(DIR_B);
    });
    await runBranchReview(ctx, { seed: "seed0", facts });
    expect(firstResolved.value).toBe(true);
    expect(order).toEqual(["start:1", "end:1", "start:2", "end:2"]);
  });

  test("each slice carries the configured coverage retry budget (AC-7)", async () => {
    const ctx = twoSliceContext();
    const calls = scriptSlices((call) => verdict(call === 1 ? DIR_A : DIR_B));
    await runBranchReview(ctx, { seed: "seed0", facts });
    const budget = ctx.workflow.review?.coverageRetries;
    expect(budget).toBeGreaterThan(0);
    expect(calls.map((call) => call.coverageRetries)).toEqual([budget, budget]);
  });

  test("the merged verdict records both slices' files (AC-8)", async () => {
    const ctx = twoSliceContext();
    scriptSlices((call) => verdict(call === 1 ? DIR_A : DIR_B));
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect(out.verdict.slices?.map((slice) => slice.files)).toEqual([DIR_A, DIR_B]);
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

describe("runBranchReview — slice failures", () => {
  test("a null slice does not stop the next one and the review still runs (AC-11)", async () => {
    const ctx = twoSliceContext();
    const calls = scriptSlices((call) => (call === 1 ? null : verdict(DIR_B)));
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    expect(calls.length).toBe(2);
    expect(out.ran).toBe(true);
  });

  test("the null slice is recorded unran and its files stay unread (AC-12)", async () => {
    const ctx = twoSliceContext();
    scriptSlices((call) => (call === 1 ? null : verdict(DIR_B)));
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the branch review must run");
    expect(out.verdict.slices?.[0]).toMatchObject({ ran: false, why: "unparseable reply" });
    expect(out.verdict.unreadFiles).toEqual(DIR_A);
  });

  test("both slices unparseable is not run, with the first slice's reason (AC-13)", async () => {
    const ctx = twoSliceContext();
    scriptSlices(() => null);
    expect(await runBranchReview(ctx, { seed: "seed0", facts })).toEqual({ ran: false, why: "unparseable reply" });
  });

  test("a slice rejecting while the run is aborting rejects and stops the loop (AC-14)", async () => {
    const controller = new AbortController();
    const ctx = twoSliceContext({ runSignal: controller.signal });
    const calls = scriptSlices(() => {
      controller.abort();
      throw new Error("aborted mid-slice");
    });
    await expect(runBranchReview(ctx, { seed: "seed0", facts })).rejects.toThrow("aborted mid-slice");
    expect(calls.length).toBe(1);
  });

  test("a slice that throws is recorded and the next one still runs (AC-15)", async () => {
    const ctx = twoSliceContext();
    scriptSlices((call) => {
      if (call === 1) throw new Error("boom");
      return verdict(DIR_B);
    });
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the second slice must run");
    expect(out.verdict.slices?.[0]).toMatchObject({ ran: false, why: "boom" });
    expect(out.verdict.slices?.[1]?.ran).toBe(true);
  });

  test("a slice that hits its own review timeout is recorded, and the next one still runs (AC-16)", async () => {
    const base = makeFeatureContext();
    const ctx = twoSliceContext({
      workflow: { ...base.workflow, timeouts: { ...base.workflow.timeouts, reviewMs: 1 } },
    });
    scriptSlices(async (call, _input, callCtx) => {
      // Waiting on this slice's own signal, never on a fixed sleep: the first slice is out of time.
      if (call === 1) {
        await abortSignal(callCtx.signal);
        return verdict(DIR_A);
      }
      return verdict(DIR_B);
    });
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the second slice must run");
    expect(out.verdict.slices?.[0]?.why).toBe("timeout");
    expect(out.verdict.slices?.[1]?.ran).toBe(true);
  });

  test("every slice failing is not run, with the first slice's reason (AC-19)", async () => {
    const ctx = twoSliceContext();
    scriptSlices((call) => {
      if (call === 1) return null;
      throw new Error("boom");
    });
    expect(await runBranchReview(ctx, { seed: "seed0", facts })).toEqual({ ran: false, why: "unparseable reply" });
  });

  test("a failed slice's files stay unread when the next slice covers only its own (AC-20)", async () => {
    const ctx = twoSliceContext();
    scriptSlices((call) => {
      if (call === 1) throw new Error("boom");
      return verdict(DIR_B);
    });
    const out = await runBranchReview(ctx, { seed: "seed0", facts });
    if (!out.ran) throw new Error("the second slice must run");
    expect(out.verdict.unreadFiles).toEqual(DIR_A);
  });
});
