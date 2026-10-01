/**
 * US-004 — the scoped fix review at the NBF keep gate, end to end through
 * `ExecutionPlan.run` (AC11, AC12).
 *
 * The unit suite (`test/unit/execution/non-blocking-fix-scoped-review.test.ts`)
 * pins `runNonBlockingFix`'s keep/restore decision against an injected
 * `reviewFix`. These two tests pin the WIRING that supplies that dep:
 *
 *   ExecutionPlan.run → buildNbfDeps({ ctx, findings }) → reviewFix(ref)
 *     → runFixReview(ctx, { workdir, story, preFixTree: ref, findings, config })
 *
 * Everything below the plan is a seam, so no git repository and no subprocess is
 * involved: the plan runs on the same mocked `callOp`/`runFixCycle` the existing
 * NBF wiring suite uses, the git-backed snapshot/rollback deps are stubbed
 * exactly as `test/helpers/e2e/orchestrator-harness.ts` stubs them, the fix
 * review's git layer is faked through `_treeSnapshotDeps`, and the reviewer is
 * the runtime's stubbed agent manager (AC12: "the agent stubbed to answer the
 * fix review with {"passed":true,"reason":"ok"}").
 *
 * Consequences asserted, all of them observable behaviour:
 *   - `snapshotWorkingTree` runs exactly once ⇒ `runFixReview` was invoked once;
 *   - the fix review's `changedPathsBetween` diff runs FROM the NBF snapshot sha
 *     ⇒ `preFixTree` equals the sha `captureSnapshotRef` returned;
 *   - the fix review reaches its verdict exactly once, which is only possible if
 *     the NBF seed findings were forwarded: the seed finding names the path the
 *     stubbed fix changed, and the scope check rejects that path outright when
 *     the findings arrive empty;
 *   - the seed finding's message reaches the review prompt;
 *   - a kept pass emits exactly one review-decision event with reviewer `"fix"`
 *     and restores nothing.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  assertDefined,
  makeFixCycleResult,
  makeMockAgentManager,
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeResolvedTestPatterns,
  makeSpawn,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import type { NonBlockingFixArgs, NonBlockingFixDeps } from "@/execution/non-blocking-fix";
import { _nonBlockingFixDeps } from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";
import type { CallContext, FixReviewOpInput, Operation } from "@/operations";
import { _treeSnapshotDeps } from "@/review/fix-review/tree-snapshot";
import type { NaxRuntime } from "@/runtime";
import { _rollbackDeps } from "@/tdd";
import type { SpawnOptions, SpawnResult } from "@/utils/bun-deps";

/** The sha the stubbed `captureSnapshotRef` returns — the NBF snapshot. */
const NBF_SHA = "nbf-snapshot-sha";
/** Tree id the faked `snapshotWorkingTree` reports (40 hex, as git would). */
const POST_TREE = "b".repeat(40);
/** The story's own start ref, so the fix review's scope check actually runs. */
const STORY_REF = "ref-story-start";
/** What the stubbed agent answers the fix review with. */
const FIX_REVIEW_ANSWER = '{"passed":true,"reason":"ok"}';
const SEED_MESSAGE = "the empty path skips the DELETE";
/** The path the stubbed fix pass changed — also the seed finding's `file`. */
const CHANGED_PATH = "src/creep.ts";

const SEED_FINDING = {
  source: "adversarial-review",
  severity: "warning",
  category: "input",
  message: SEED_MESSAGE,
  file: CHANGED_PATH,
} as const;

/**
 * A fake subprocess for the modules whose `_deps.spawn` is typed against
 * `src/utils/bun-deps` (`typedSpawn`) rather than `typeof Bun.spawn`.
 */
function fakeProc(stdout: string, exitCode = 0): SpawnResult {
  const body = new TextEncoder().encode(stdout);
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        if (body.length > 0) controller.enqueue(body);
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    pid: 4242,
    kill: () => {},
  };
}

interface Recorders {
  /** Every argv the fix review's git layer received, in order. */
  gitCalls: string[][];
  /** Prompts the stubbed agent received (the real-`callOp` dispatch channel). */
  prompts: string[];
  /** Fix-review op inputs seen on the orchestrator's injected `callOp` channel. */
  fixReviewInputs: FixReviewOpInput[];
  decisions: { reviewer: string; parsed: boolean; passed?: boolean; result: unknown }[];
  rollbacks: string[];
}

const rec: Recorders = {
  gitCalls: [],
  prompts: [],
  fixReviewInputs: [],
  decisions: [],
  rollbacks: [],
};

/** `git write-tree` runs once per `snapshotWorkingTree`, i.e. once per fix review. */
function snapshotCount(calls: readonly string[][]): number {
  return calls.filter((cmd) => cmd.includes("write-tree")).length;
}

/**
 * The `from` ref of the `git diff --name-only -z --no-renames <from> <to>` call whose
 * `to` is the post-fix tree — i.e. the ref the fix review treated as its pre-fix
 * tree. `undefined` when that diff never ran.
 */
function fixDiffFrom(calls: readonly string[][]): string | undefined {
  const call = calls.find((cmd) => cmd.includes("--no-renames") && cmd.includes(POST_TREE));
  if (!call) return undefined;
  return call[call.indexOf("--no-renames") + 1];
}

describe("US-004 — the scoped fix review is wired into the NBF keep gate", () => {
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origRunFixCycle: typeof _storyOrchestratorDeps.runFixCycle;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let origRunNonBlockingFix: typeof _storyOrchestratorDeps.runNonBlockingFix;
  let origTree: {
    spawn: typeof _treeSnapshotDeps.spawn;
    mkdtemp: typeof _treeSnapshotDeps.mkdtemp;
    rm: typeof _treeSnapshotDeps.rm;
    tmpdir: typeof _treeSnapshotDeps.tmpdir;
  };
  let origNbfSpawn: typeof _nonBlockingFixDeps.spawn;
  let origNbfResolve: typeof _nonBlockingFixDeps.resolveTestFilePatterns;
  let origRollbackSpawn: typeof _rollbackDeps.spawn;
  let origRollbackAutoCommit: typeof _rollbackDeps.autoCommitIfDirty;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
    origRunFixCycle = _storyOrchestratorDeps.runFixCycle;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    origRunNonBlockingFix = _storyOrchestratorDeps.runNonBlockingFix;
    origTree = {
      spawn: _treeSnapshotDeps.spawn,
      mkdtemp: _treeSnapshotDeps.mkdtemp,
      rm: _treeSnapshotDeps.rm,
      tmpdir: _treeSnapshotDeps.tmpdir,
    };
    origNbfSpawn = _nonBlockingFixDeps.spawn;
    origNbfResolve = _nonBlockingFixDeps.resolveTestFilePatterns;
    origRollbackSpawn = _rollbackDeps.spawn;
    origRollbackAutoCommit = _rollbackDeps.autoCommitIfDirty;

    rec.gitCalls = [];
    rec.prompts = [];
    rec.fixReviewInputs = [];
    rec.decisions = [];
    rec.rollbacks = [];

    // Phase dispatch: a green story whose adversarial review passed with one
    // advisory finding — exactly the NBF entry state. The fix review's own
    // dispatch is answered here too, so the wiring is testable whether it reaches
    // the review through the orchestrator's `callOp` seam or directly through
    // `@/operations`' real `callOp` (which then goes to the stubbed agent below).
    _storyOrchestratorDeps.captureGitRef = mock(async () => "HEAD");
    _storyOrchestratorDeps.callOp = mock(
      async (_ctx: CallContext, op: Operation<unknown, unknown, unknown>, input: unknown) => {
        if (op.name === "fix-review") {
          rec.fixReviewInputs.push(input as unknown as FixReviewOpInput); // test-ratchet-allow: as-unknown-as
          return { parsed: true, passed: true, reason: "ok" };
        }
        if (op.name === "adversarial-review") {
          return { success: true, passed: true, advisoryFindings: [{ ...SEED_FINDING }] };
        }
        return { success: true };
      },
    ) as typeof _storyOrchestratorDeps.callOp;
    _storyOrchestratorDeps.runFixCycle = async <F extends Finding>() =>
      makeFixCycleResult<F>({ exitReason: "no-strategy" });
    _rollbackDeps.autoCommitIfDirty = mock(async () => {});
    _rollbackDeps.spawn = makeSpawn(() => "abc1234\n").spawn;

    // The NBF pass's own source-diff measurement (its git layer): an empty
    // numstat, i.e. a pass well inside `sourceDiffCap`.
    _nonBlockingFixDeps.spawn = (_cmd: string[], _opts: SpawnOptions): SpawnResult => fakeProc("");
    _nonBlockingFixDeps.resolveTestFilePatterns = async () => makeResolvedTestPatterns();

    // The fix review's git layer, faked: a working-tree snapshot, a fix diff that
    // touched CHANGED_PATH, and the story's own files read back as empty. The
    // members are `readonly` in `TreeSnapshotDeps`, so they are swapped through
    // `Object.assign` (the same idiom `orchestrator-harness.ts` uses for
    // `_storyOrchestratorDeps`).
    Object.assign(_treeSnapshotDeps, {
      spawn: (cmd: string[], _opts: SpawnOptions): SpawnResult => {
        rec.gitCalls.push(cmd);
        const argv = cmd.join(" ");
        if (argv.includes("write-tree")) return fakeProc(`${POST_TREE}\n`);
        // The fix's own delta (pre-fix tree → post-fix tree) changed a path; the
        // story's own files (story ref → pre-fix tree) changed nothing, so the
        // scope check runs for real against the seed findings.
        if (argv.includes("--name-only")) return fakeProc(cmd.includes(STORY_REF) ? "" : `${CHANGED_PATH}\0`);
        if (argv.includes("diff"))
          return fakeProc(`diff --git a/${CHANGED_PATH} b/${CHANGED_PATH}\n+const guard = 1;\n`);
        return fakeProc("");
      },
      mkdtemp: async () => "/tmp/nax-fix-review-snapshot-test",
      rm: async () => {},
      tmpdir: () => "/tmp",
    });
  });

  afterEach(async () => {
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.runFixCycle = origRunFixCycle;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    _storyOrchestratorDeps.runNonBlockingFix = origRunNonBlockingFix;
    Object.assign(_treeSnapshotDeps, origTree);
    _nonBlockingFixDeps.spawn = origNbfSpawn;
    _nonBlockingFixDeps.resolveTestFilePatterns = origNbfResolve;
    _rollbackDeps.spawn = origRollbackSpawn;
    _rollbackDeps.autoCommitIfDirty = origRollbackAutoCommit;
    await runtime?.close();
    runtime = undefined;
  });

  /**
   * Run a green TDD story through `ExecutionPlan.run` with NBF enabled.
   *
   * `runNonBlockingFix` is NOT replaced: the real implementation runs, so the
   * second call-site argument `buildNbfDeps(...)` supplies is what dispatches the
   * scoped fix review. Only the git-backed snapshot/rollback deps are stubbed
   * (merged after the plan's own deps, exactly as the e2e harness does), so the
   * pass would otherwise be committed and rolled back for real.
   */
  async function runPlan(): Promise<void> {
    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      review: {
        nonBlockingFix: {
          enabled: true,
          scope: "both",
          regressionAttempts: 1,
          verifierGuard: true,
          sourceDiffCap: { maxFiles: 10, maxLines: 500 },
          sources: ["adversarial"],
        },
        adversarial: {
          model: "balanced",
          diffMode: "ref",
          rules: [],
          timeoutMs: 600_000,
          parallel: false,
          maxConcurrentSessions: 2,
        },
      },
    });
    // The story owns a start ref, so `runFixReview` reads the story's own files
    // and runs its deterministic scope check rather than skipping it.
    const story = makeStory({ attempts: 1, storyGitRef: STORY_REF });
    runtime = makeTestRuntime({
      config,
      agentManager: makeMockAgentManager({
        runWithFallbackFn: async (req) => {
          rec.prompts.push(req.runOptions.prompt);
          return {
            result: {
              success: true,
              exitCode: 0,
              output: FIX_REVIEW_ANSWER,
              rateLimited: false,
              durationMs: 0,
              estimatedCostUsd: 0,
              agentFallbacks: [],
            },
            fallbacks: [],
            dispatchesCompleted: 1,
          };
        },
      }),
    });
    runtime.dispatchEvents.onReviewDecision((event) => {
      rec.decisions.push({
        reviewer: event.reviewer,
        parsed: event.parsed,
        passed: event.passed,
        result: event.result,
      });
    });

    const ctx = makeMockCallContext({ runtime, config, packageDir: "/tmp/test", storyId: story.id, story });
    const adversarialConfig = config.review.adversarial;
    assertDefined(adversarialConfig, "config.review.adversarial");
    const inputs = makeMockPlanInputs({
      story,
      implementer: { story },
      fullSuiteGate: { story, workdir: "/tmp/test" },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: "/tmp/test",
        adversarialConfig,
        mode: adversarialConfig.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    // The plan builds its NBF overrides through `buildNbfDeps`; git-backed deps
    // are stubbed here so the pass has a deterministic snapshot and no real tree
    // is ever touched.
    _storyOrchestratorDeps.runNonBlockingFix = async (args: NonBlockingFixArgs, deps?: Partial<NonBlockingFixDeps>) =>
      origRunNonBlockingFix(args, {
        ...(deps ?? {}),
        captureSnapshotRef: async () => ({ sha: NBF_SHA, untrackedBefore: [] }),
        rollbackToRef: async (_workdir, ref) => {
          rec.rollbacks.push(ref);
        },
      });

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    await plan.run();
  }

  test("US-004 AC11: the plan consults the scoped fix review once, at the NBF snapshot sha, with the NBF seed findings", async () => {
    await runPlan();

    // Exactly one runFixReview: the snapshot helper is its first act, and nothing
    // else in the plan calls it.
    expect(snapshotCount(rec.gitCalls)).toBe(1);
    // preFixTree is the sha `captureSnapshotRef` returned for the NBF pass — the
    // fix review diffs the fix's own delta from the pass's entry snapshot.
    expect(fixDiffFrom(rec.gitCalls)).toBe(NBF_SHA);
    // …and the verdict was reached exactly once. That is only reachable if the NBF
    // seed findings were forwarded: with an empty findings list the scope check
    // rejects CHANGED_PATH outright (it names no allowed file) and the review
    // returns a scope fail before any dispatch.
    expect(rec.prompts.length + rec.fixReviewInputs.length).toBe(1);
    const reviewed = `${rec.prompts.join("\n")}${JSON.stringify(rec.fixReviewInputs)}`;
    expect(reviewed).toContain(SEED_MESSAGE);
    expect(reviewed).toContain(CHANGED_PATH);
  });

  test("US-004 AC12: a kept NBF pass emits exactly one review-decision event with reviewer fix", async () => {
    await runPlan();

    const fixDecisions = rec.decisions.filter((decision) => decision.reviewer === "fix");
    expect(fixDecisions).toHaveLength(1);
    // The stubbed agent answered `{"passed":true,"reason":"ok"}`, so the recorded
    // decision is the parsed pass — not a fail-open, not a parse give-up.
    expect(fixDecisions[0]?.parsed).toBe(true);
    expect(fixDecisions[0]?.passed).toBe(true);
    expect(fixDecisions[0]?.result).toEqual({ passed: true, findings: [] });
    // Kept, not restored: the pass survived the review.
    expect(rec.rollbacks).toEqual([]);
  });
});
