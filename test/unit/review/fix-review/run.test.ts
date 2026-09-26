/**
 * US-003 — `runFixReview` (src/review/fix-review/run.ts).
 *
 * The ordered runner behind the scoped fix review (ADR-033 §1). It stops at the
 * first stage that decides:
 *
 *   1. `fixReview.enabled === false` → pass, not reviewed
 *   2. no path changed between the pre-fix tree and the post-fix tree → pass, not reviewed
 *   3. a changed path the story was not authorised to touch → fail, cause `scope`
 *   4. otherwise the LLM verdict → pass, or fail with cause `contradiction`
 *
 * Every stage is observable through the injected `FixReviewDeps` seam, so each
 * test asserts on the returned verdict AND on whether the next stage was
 * reached (`snapshotWorkingTree`, `changedPathsBetween`, `callOp`,
 * `emitReviewDecision`). Git itself is never invoked: the whole seam is faked.
 */
import { describe, expect, test } from "bun:test";
import {
  makeCallOp,
  makeConfigSlice,
  makeFinding,
  makeMockCallContext,
  makeResolvedTestPatterns,
  makeStory,
} from "@test/helpers";
import { NaxError } from "@/errors";
import type { CallContext, FixReviewOpInput, Operation } from "@/operations";
import { DIFF_CAP_BYTES, truncateDiff } from "@/review";
import type { FixReviewRequest, FixReviewVerdict } from "@/review/fix-review";
import { type FixReviewDeps, runFixReview } from "@/review/fix-review/run";
import type { ReviewConfig } from "@/review/types";

const WORKDIR = "/tmp/test/pkg";
const STORY_REF = "ref-story-start";
const PRE_TREE = "tree-pre-fix";
const POST_TREE = "tree-post-fix";
const SMALL_DIFF = "diff --git a/src/a.ts b/src/a.ts\n+const guard = 1;\n";
const CONTRADICTION_REASON = "adds mkdir to removeApprovals; AC 4 forbids creating directories";

function makeReviewConfig(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return { ...makeConfigSlice("review"), fixReview: { enabled: true, timeoutMs: 600_000 }, ...overrides };
}

function makeRequest(overrides: Partial<FixReviewRequest> = {}): FixReviewRequest {
  return {
    workdir: WORKDIR,
    story: makeStory({ id: "US-003", storyGitRef: STORY_REF }),
    preFixTree: PRE_TREE,
    findings: [makeFinding({ file: "src/a.ts", message: "the empty path skips the DELETE" })],
    config: makeReviewConfig(),
    ...overrides,
  };
}

/** A fresh call context per test — the mocked runtime is closed between tests. */
function makeCtx(): CallContext {
  return makeMockCallContext({ packageDir: WORKDIR, storyId: "US-003" });
}

interface HarnessOptions {
  /** Repo-relative paths the story had changed before the fix (`storyGitRef` → preFixTree). */
  readonly storyFiles?: readonly string[];
  /** Repo-relative paths the fix itself changed (preFixTree → postTree). */
  readonly fixFiles?: readonly string[];
  readonly diff?: string;
  /** What the LLM stage resolves to. */
  readonly opOutput?: unknown;
  readonly callOpError?: Error;
  readonly snapshotError?: Error;
  readonly changedPathsError?: Error;
}

interface Harness {
  readonly deps: Partial<FixReviewDeps>;
  readonly dispatched: readonly string[];
  readonly inputs: readonly FixReviewOpInput[];
  readonly snapshots: readonly string[];
  readonly changedPathCalls: readonly (readonly [string, string, string])[];
  readonly diffCalls: readonly (readonly [string, string, string])[];
  readonly decisions: readonly { readonly opName: string; readonly output: unknown }[];
}

/** Runtime check for the dispatch seam, which hands the op input over as `unknown`. */
function isFixReviewOpInput(value: unknown): value is FixReviewOpInput {
  if (typeof value !== "object" || value === null) return false;
  return "story" in value && "diff" in value && "findings" in value;
}

/** A `callOp` that rejects, for the dispatch-error path. */
function makeThrowingCallOp(error: Error): FixReviewDeps["callOp"] {
  return async <I, O, C>(_ctx: CallContext, _op: Operation<I, O, C>, _input: I): Promise<O> => {
    throw error;
  };
}

function makeGitFailure(stage: string): NaxError {
  return new NaxError(`[${stage}] git diff failed`, "FIX_REVIEW_GIT_FAILED", { stage });
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const dispatched: string[] = [];
  const inputs: FixReviewOpInput[] = [];
  const snapshots: string[] = [];
  const changedPathCalls: Array<[string, string, string]> = [];
  const diffCalls: Array<[string, string, string]> = [];
  const decisions: Array<{ opName: string; output: unknown }> = [];

  const deps: Partial<FixReviewDeps> = {
    callOp: options.callOpError
      ? makeThrowingCallOp(options.callOpError)
      : makeCallOp({
          fallback: options.opOutput ?? { parsed: true, passed: true, reason: "no contradiction" },
          onDispatch: (op, _ctx, input) => {
            dispatched.push(op.name);
            if (isFixReviewOpInput(input)) inputs.push(input);
          },
        }),
    snapshotWorkingTree: async (workdir: string) => {
      snapshots.push(workdir);
      if (options.snapshotError) throw options.snapshotError;
      return POST_TREE;
    },
    changedPathsBetween: async (workdir: string, from: string, to: string) => {
      changedPathCalls.push([workdir, from, to]);
      if (options.changedPathsError) throw options.changedPathsError;
      const paths = from === STORY_REF ? (options.storyFiles ?? []) : (options.fixFiles ?? ["src/a.ts"]);
      return [...paths];
    },
    diffBetween: async (workdir: string, from: string, to: string) => {
      diffCalls.push([workdir, from, to]);
      return options.diff ?? SMALL_DIFF;
    },
    emitReviewDecision: (_ctx, opName, output) => {
      decisions.push({ opName, output });
    },
    resolveTestFilePatterns: async () => makeResolvedTestPatterns(),
  };

  return { deps, dispatched, inputs, snapshots, changedPathCalls, diffCalls, decisions };
}

/** The out-of-scope file list on a scope failure, `[]` for any other verdict. */
function scopeFiles(verdict: FixReviewVerdict): readonly string[] {
  return verdict.kind === "fail" && verdict.cause === "scope" ? verdict.files : [];
}

describe("runFixReview — stage 1: the fixReview switch (US-003 AC10)", () => {
  test("US-003 AC10: a disabled fixReview passes without reviewing and never snapshots or dispatches", async () => {
    const harness = makeHarness();
    const request = makeRequest({ config: makeReviewConfig({ fixReview: { enabled: false, timeoutMs: 600_000 } }) });

    const verdict = await runFixReview(makeCtx(), request, harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: false });
    expect(harness.snapshots).toEqual([]);
    expect(harness.dispatched).toEqual([]);
    expect(harness.decisions).toEqual([]);
  });

  test("US-003 AC10 boundary: an enabled fixReview proceeds to the snapshot", async () => {
    const harness = makeHarness();

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: true });
    expect(harness.snapshots).toEqual([WORKDIR]);
  });
});

describe("runFixReview — stage 2: the fix's changed paths (US-003 AC11)", () => {
  test("US-003 AC11: a fix that changed nothing passes without reviewing", async () => {
    const harness = makeHarness({ fixFiles: [] });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: false });
    expect(harness.changedPathCalls).toContainEqual([WORKDIR, PRE_TREE, POST_TREE]);
    expect(harness.dispatched).toEqual([]);
    expect(harness.decisions).toEqual([]);
  });

  test("US-003 AC11 boundary: one changed path reaches the LLM verdict", async () => {
    const harness = makeHarness({ fixFiles: ["src/a.ts"] });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: true });
    expect(harness.dispatched).toEqual(["fix-review"]);
  });
});

describe("runFixReview — stage 3: the scope check (US-003 AC12)", () => {
  test("US-003 AC12: a changed file outside the story's own files fails with cause scope", async () => {
    const harness = makeHarness({ storyFiles: ["src/a.ts"], fixFiles: ["src/creep.ts", "src/a.ts"] });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "fail", cause: "scope" });
    expect(scopeFiles(verdict)).toEqual(["src/creep.ts"]);
    expect(harness.dispatched).toEqual([]);
    expect(harness.decisions).toEqual([]);
  });

  test("US-003 AC12 boundary: a fix confined to the story's own files reaches the LLM verdict", async () => {
    const harness = makeHarness({ storyFiles: ["src/a.ts"], fixFiles: ["src/a.ts"] });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: true });
    expect(harness.dispatched).toEqual(["fix-review"]);
  });

  test("US-003 AC12 boundary: a changed test file is exempt and does not fail the scope check", async () => {
    const harness = makeHarness({ storyFiles: [], fixFiles: ["test/unit/fix-review-test-file.test.ts"] });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: true });
    expect(harness.dispatched).toEqual(["fix-review"]);
  });
});

describe("runFixReview — stage 4: the LLM verdict (US-003 AC13-AC16)", () => {
  test("US-003 AC13: a parsed pass dispatches fix-review once and returns a reviewed pass", async () => {
    const harness = makeHarness({ opOutput: { parsed: true, passed: true, reason: "no contradiction" } });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: true });
    expect(harness.dispatched).toEqual(["fix-review"]);
  });

  test("US-003 AC14: a parsed contradiction fails carrying the op's reason, acIndex and file", async () => {
    const harness = makeHarness({
      opOutput: { parsed: true, passed: false, reason: CONTRADICTION_REASON, acIndex: 4, file: "src/a.ts" },
    });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toEqual({
      kind: "fail",
      cause: "contradiction",
      reason: CONTRADICTION_REASON,
      acIndex: 4,
      file: "src/a.ts",
    });
  });

  test("US-003 AC14 boundary: a contradiction naming no acceptance criterion still fails", async () => {
    const harness = makeHarness({ opOutput: { parsed: true, passed: false, reason: "removes the guard" } });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "fail", cause: "contradiction", reason: "removes the guard" });
  });

  test("US-003 AC15: a dispatch error ends the review as an error", async () => {
    const harness = makeHarness({
      callOpError: new NaxError("[fix-review] dispatch failed", "AGENT_DISPATCH_FAILED", { stage: "review" }),
    });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict.kind).toBe("error");
  });

  test("US-003 AC16: an unparseable verdict ends the review as an error", async () => {
    const harness = makeHarness({
      opOutput: { parsed: false, unparsedPreview: "I could not review this fix." },
    });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict.kind).toBe("error");
  });
});

describe("runFixReview — git failures (US-003 AC17)", () => {
  test("US-003 AC17: a snapshot failure ends the review as an error without dispatching", async () => {
    const harness = makeHarness({ snapshotError: makeGitFailure("fix-review-tree-snapshot") });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict.kind).toBe("error");
    expect(harness.dispatched).toEqual([]);
    expect(harness.decisions).toEqual([]);
  });

  test("US-003 AC17 boundary: a changed-paths failure ends the review as an error without dispatching", async () => {
    const harness = makeHarness({ changedPathsError: makeGitFailure("fix-review-changed-paths") });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict.kind).toBe("error");
    expect(harness.dispatched).toEqual([]);
  });
});

describe("runFixReview — the emitted verdict audit (US-003 AC18)", () => {
  test("US-003 AC18: a parsed verdict is emitted once, as fix-review, with the op output", async () => {
    const opOutput = { parsed: true, passed: true, reason: "no contradiction" };
    const harness = makeHarness({ opOutput });

    await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(harness.decisions.map((decision) => decision.opName)).toEqual(["fix-review"]);
    expect(harness.decisions[0]?.output).toBe(opOutput);
  });

  test("US-003 AC18: an unparseable verdict is still emitted once, as fix-review", async () => {
    const harness = makeHarness({ opOutput: { parsed: false, unparsedPreview: "no JSON object here" } });

    await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(harness.decisions.map((decision) => decision.opName)).toEqual(["fix-review"]);
  });
});

describe("runFixReview — the story-files argument (US-003 AC19)", () => {
  test("US-003 AC19: without a storyGitRef the scope check is skipped and the review still dispatches", async () => {
    const harness = makeHarness({ fixFiles: ["src/unlisted.ts"] });
    const request = makeRequest({ story: makeStory({ id: "US-003" }) });

    const verdict = await runFixReview(makeCtx(), request, harness.deps);

    expect(verdict).toMatchObject({ kind: "pass", reviewed: true });
    expect(harness.dispatched).toEqual(["fix-review"]);
    expect(harness.changedPathCalls).toHaveLength(1);
  });

  test("US-003 AC19 boundary: with a storyGitRef the story's own files are read up to the pre-fix tree", async () => {
    const harness = makeHarness({ storyFiles: ["src/a.ts"], fixFiles: ["src/creep.ts"] });

    const verdict = await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(verdict).toMatchObject({ kind: "fail", cause: "scope" });
    expect(harness.changedPathCalls).toContainEqual([WORKDIR, STORY_REF, PRE_TREE]);
  });
});

describe("runFixReview — the embedded fix diff (US-003 AC20)", () => {
  test("US-003 AC20: the op is handed the truncated diff between the pre-fix and post-fix trees", async () => {
    const hugeDiff = `diff --git a/src/a.ts b/src/a.ts\n${"+x\n".repeat(DIFF_CAP_BYTES)}\n`;
    const harness = makeHarness({ diff: hugeDiff });

    await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(harness.diffCalls).toEqual([[WORKDIR, PRE_TREE, POST_TREE]]);
    expect(harness.dispatched).toEqual(["fix-review"]);
    expect(harness.inputs[0]?.diff).toBe(truncateDiff(hugeDiff));
    expect(harness.inputs[0]?.diff).not.toBe(hugeDiff);
  });

  test("US-003 AC20 boundary: a diff under the cap reaches the op unchanged", async () => {
    const harness = makeHarness({ diff: SMALL_DIFF });

    await runFixReview(makeCtx(), makeRequest(), harness.deps);

    expect(harness.inputs[0]?.diff).toBe(SMALL_DIFF);
  });
});
