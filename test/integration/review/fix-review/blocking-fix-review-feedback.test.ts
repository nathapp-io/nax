/**
 * US-005 — the scoped fix review around the BLOCKING cycle's
 * `autofix-test-writer` dispatch, end to end through `ExecutionPlan.run`
 * (AC15, AC16).
 *
 * AC15 — a `contradiction` verdict with `acIndex: 2` from the review of a
 *        blocking dispatch reaches the cycle's next dispatch as an input finding.
 * AC16 — with `review.nonBlockingFix.enabled` and scope `both`, a green story's
 *        NBF pass dispatches `autofix-test-writer` and calls the fix review
 *        exactly once, at the NBF keep gate — never after the dispatch.
 *
 * The two tests are the two halves of one rule: the review feeds back on the
 * BLOCKING path only. AC15 pins that a contradiction actually buys a second fix
 * attempt; AC16 pins that the non-blocking strategy set is left alone, because
 * NBF runs its own review once at its keep gate (US-004) and wrapping its
 * strategies too would review every best-effort dispatch on top of that.
 *
 * Everything below the plan is a seam, so no git repository and no subprocess is
 * involved:
 *   - the plan's own phase/fix dispatches run on the stubbed
 *     `_storyOrchestratorDeps.callOp`, which answers each op by name;
 *   - the git-backed tree state and refs are stubbed;
 *   - the fix review's git layer is faked through `_treeSnapshotDeps`;
 *   - the reviewer itself is the runtime's stubbed agent manager, so "runFixReview
 *     returns a contradiction" is expressed as the reviewer's own JSON answer and
 *     the real `runFixReview` decides the verdict from it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeMockAgentManager,
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeStory,
  makeTestRuntime,
} from "@test/helpers";
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import type { NonBlockingFixArgs, NonBlockingFixDeps } from "@/execution/non-blocking-fix";
import type { Finding } from "@/findings";
import type { AutofixTestWriterInput, CallContext, Operation } from "@/operations";
import { _treeSnapshotDeps } from "@/review/fix-review/tree-snapshot";
import type { NaxRuntime } from "@/runtime";
import type { SpawnOptions, SpawnResult } from "@/utils/bun-deps";

const WORKDIR = "/tmp/nax-us-005-fix-review";
const STORY_REF = "ref-story-start";
const PRE_FIX_TREE = "a".repeat(40);
const POST_FIX_TREE = "b".repeat(40);
/** The sha the stubbed `captureSnapshotRef` returns for the NBF pass. */
const NBF_SHA = "nbf-snapshot-sha";
/** A test file — exempt from the review's scope check, so the review reaches the LLM stage. */
const CHANGED_TEST_PATH = "test/dropped-assertion.test.ts";
const CONTRADICTION_REASON = "drops the AC-2 assertion";
const CONTRADICTION_ANSWER = `{"passed":false,"reason":"${CONTRADICTION_REASON}","acIndex":2}`;
const PASS_ANSWER = '{"passed":true,"reason":"consistent with the ACs"}';
const SMALL_DIFF =
  "diff --git a/test/dropped-assertion.test.ts b/test/dropped-assertion.test.ts\n-  expect(x).toBe(2);\n";

/** The blocking cycle's seed: a test-targeted adversarial finding, claimed by autofix-test-writer. */
const ADVERSARIAL_FINDING: Finding = {
  source: "adversarial-review",
  severity: "error",
  category: "test-gap",
  message: "no assertion covers the empty path",
  file: CHANGED_TEST_PATH,
  fixTarget: "test",
};

/** The NBF pass's advisory seed — same lane, below the blocking threshold. */
const ADVISORY_FINDING: Finding = {
  source: "adversarial-review",
  severity: "warning",
  category: "input",
  message: "the empty path skips the DELETE",
  file: CHANGED_TEST_PATH,
  fixTarget: "test",
};

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
  /** `write-tree` runs once per `snapshotWorkingTree`, i.e. once per fix review. */
  snapshots: number;
  /** Prompts the stubbed reviewer received — one per fix review that reached its LLM stage. */
  fixReviewPrompts: string[];
  /** Every `autofix-test-writer` dispatch's input, in dispatch order. */
  autofixInputs: AutofixTestWriterInput[];
  /** Every op name the plan dispatched, in order (phase + fix ops). */
  dispatched: string[];
}

const rec: Recorders = {
  gitCalls: [],
  snapshots: 0,
  fixReviewPrompts: [],
  autofixInputs: [],
  dispatched: [],
};

/**
 * The refs the fix review diffed FROM, over every `--no-renames` diff it ran.
 * A review that ran at the NBF keep gate diffs from the NBF snapshot sha; one
 * that ran after a dispatch diffs from the tree that dispatch's own
 * `beforeDispatch` snapshot produced.
 */
function diffFroms(calls: readonly string[][]): string[] {
  return calls.filter((cmd) => cmd.includes("--no-renames")).map((cmd) => cmd[cmd.indexOf("--no-renames") + 1] ?? "");
}

interface RunOptions {
  /** Enable the ADR-024 non-blocking best-effort pass (AC16) instead of the blocking path. */
  readonly nbf?: boolean;
}

interface Run {
  readonly success: boolean;
  readonly snapshots: number;
  readonly diffFroms: readonly string[];
  readonly fixReviewPrompts: readonly string[];
  readonly autofixInputs: readonly AutofixTestWriterInput[];
  readonly dispatched: readonly string[];
}

describe("US-005 — the scoped fix review on the blocking-cycle autofix-test-writer path", () => {
  let origCallOp: typeof _storyOrchestratorDeps.callOp;
  let origCaptureGitRef: typeof _storyOrchestratorDeps.captureGitRef;
  let origCaptureTreeState: typeof _storyOrchestratorDeps.captureTreeState;
  let origRunNonBlockingFix: typeof _storyOrchestratorDeps.runNonBlockingFix;
  let origTree: typeof _treeSnapshotDeps;
  let runtime: NaxRuntime | undefined;

  beforeEach(() => {
    origCallOp = _storyOrchestratorDeps.callOp;
    origCaptureGitRef = _storyOrchestratorDeps.captureGitRef;
    origCaptureTreeState = _storyOrchestratorDeps.captureTreeState;
    origRunNonBlockingFix = _storyOrchestratorDeps.runNonBlockingFix;
    origTree = { ..._treeSnapshotDeps };

    rec.gitCalls = [];
    rec.snapshots = 0;
    rec.fixReviewPrompts = [];
    rec.autofixInputs = [];
    rec.dispatched = [];

    Object.assign(_storyOrchestratorDeps, {
      captureGitRef: async () => "HEAD",
      captureTreeState: async () => ({ headSha: "us-005-head", dirtyDigest: "clean" }),
    });

    // The fix review's git layer, faked: two working-tree snapshots (pre-dispatch
    // then post-fix), a fix delta that touched one test file, and the story's own
    // files read back as empty.
    Object.assign(_treeSnapshotDeps, {
      spawn: (cmd: string[], _opts?: SpawnOptions): SpawnResult => {
        rec.gitCalls.push([...cmd]);
        const argv = cmd.join(" ");
        if (argv.includes("read-tree")) return fakeProc("");
        if (argv.includes("add -A")) return fakeProc("");
        if (argv.includes("write-tree")) {
          rec.snapshots += 1;
          return fakeProc(`${rec.snapshots === 1 ? PRE_FIX_TREE : POST_FIX_TREE}\n`);
        }
        if (argv.includes("--no-renames")) {
          const from = cmd[cmd.indexOf("--no-renames") + 1];
          return fakeProc(from === STORY_REF ? "" : `${CHANGED_TEST_PATH}\n`);
        }
        if (argv.includes("diff")) return fakeProc(SMALL_DIFF);
        return fakeProc("");
      },
      mkdtemp: async () => "/tmp/nax-us-005-fix-review-snapshot",
      rm: async () => {},
      tmpdir: () => "/tmp",
    });
  });

  afterEach(async () => {
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.captureGitRef = origCaptureGitRef;
    _storyOrchestratorDeps.captureTreeState = origCaptureTreeState;
    _storyOrchestratorDeps.runNonBlockingFix = origRunNonBlockingFix;
    Object.assign(_treeSnapshotDeps, origTree);
    await runtime?.close();
    runtime = undefined;
  });

  /**
   * Run a green TDD story through `ExecutionPlan.run`.
   *
   * The blocking mode (AC15) fails the adversarial review with one test-targeted
   * finding, so rectification dispatches `autofix-test-writer`; the NBF mode
   * (AC16) passes the adversarial review with one advisory finding, so the
   * non-blocking pass dispatches it instead.
   */
  async function runPlan(options: RunOptions = {}): Promise<Run> {
    const nbf = options.nbf === true;
    const config = makeNaxConfig({
      quality: { autofix: { enabled: true } },
      execution: { rectification: { enabled: true, maxAttemptsTotal: 2 } },
      ...(nbf
        ? {
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
          }
        : {}),
    });
    // The story owns a start ref, so the review reads the story's own files and
    // runs its deterministic scope check rather than skipping it.
    const story = makeStory({ id: "US-005", attempts: 1, storyGitRef: STORY_REF });
    runtime = makeTestRuntime({
      config,
      agentManager: makeMockAgentManager({
        // The reviewer the real `runFixReview` dispatches to: AC15 asks for a
        // contradiction, AC16 for a pass at the keep gate.
        runWithFallbackFn: async (req) => {
          rec.fixReviewPrompts.push(req.runOptions.prompt);
          return {
            result: {
              success: true,
              exitCode: 0,
              output: nbf ? PASS_ANSWER : CONTRADICTION_ANSWER,
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

    _storyOrchestratorDeps.callOp = (async (
      _ctx: CallContext,
      op: Operation<unknown, unknown, unknown>,
      input: unknown,
    ) => {
      rec.dispatched.push(op.name);
      if (op.name === "autofix-test-writer") {
        rec.autofixInputs.push(input as AutofixTestWriterInput);
        return { applied: true };
      }
      if (op.name === "adversarial-review") {
        return nbf
          ? { success: true, passed: true, advisoryFindings: [{ ...ADVISORY_FINDING }] }
          : { success: false, passed: false, normalizedFindings: [{ ...ADVERSARIAL_FINDING }] };
      }
      return { success: true };
    }) as typeof _storyOrchestratorDeps.callOp;

    const ctx = makeMockCallContext({ runtime, config, packageDir: WORKDIR, storyId: story.id, story });
    const adversarialConfig = config.review.adversarial;
    if (adversarialConfig === undefined) throw new Error("[test] config.review.adversarial is missing");
    const inputs = makeMockPlanInputs({
      story,
      config,
      implementer: { story },
      fullSuiteGate: { story, workdir: WORKDIR },
      verifier: { story },
      adversarialReview: {
        story,
        workdir: WORKDIR,
        adversarialConfig,
        mode: adversarialConfig.diffMode,
      },
      rectification: { maxAttempts: 2, strategies: [], abortOnIncreasingFailures: false },
    });

    if (nbf) {
      // The real `runNonBlockingFix` runs (so its keep gate consults the real fix
      // review through `buildNbfDeps`); only its git-backed deps are stubbed, so
      // no real tree is snapshotted or rolled back.
      _storyOrchestratorDeps.runNonBlockingFix = async (args: NonBlockingFixArgs, deps?: Partial<NonBlockingFixDeps>) =>
        origRunNonBlockingFix(args, {
          ...(deps ?? {}),
          captureSnapshotRef: async () => ({ sha: NBF_SHA, untrackedBefore: [] }),
          rollbackToRef: async () => {},
          measureSourceDiff: async () => ({ fileCount: 0, sourceLineCount: 0 }),
        });
    }

    const plan = await buildPlanForStrategy(ctx, story, config, "three-session-tdd", inputs);
    const result = await plan.run();
    return {
      success: result.success,
      snapshots: rec.snapshots,
      diffFroms: diffFroms(rec.gitCalls),
      fixReviewPrompts: [...rec.fixReviewPrompts],
      autofixInputs: [...rec.autofixInputs],
      dispatched: [...rec.dispatched],
    };
  }

  test("US-005 AC15: an AC-anchored contradiction reaches the cycle's next autofix-test-writer dispatch", async () => {
    const run = await runPlan();

    // The blocking cycle dispatched the test-writer for the adversarial finding and
    // then again for the contradiction the review fed back.
    expect(run.autofixInputs.length).toBeGreaterThanOrEqual(2);
    expect(run.fixReviewPrompts).toHaveLength(run.autofixInputs.length);
    // The first dispatch could not have seen it — the contradiction did not exist yet.
    expect(JSON.stringify(run.autofixInputs[0])).not.toContain(CONTRADICTION_REASON);
    // ...and the second one carries it in the semantic check lane the strategies read.
    const second = run.autofixInputs[1];
    expect(second).toBeDefined();
    const semantic = second?.failedChecks.find((check) => check.check === "semantic");
    expect(semantic?.findings?.map((finding) => finding.message)).toContain(CONTRADICTION_REASON);
  });

  test("US-005 AC16: a green story's NBF dispatch of autofix-test-writer runs the fix review once, at the keep gate", async () => {
    const run = await runPlan({ nbf: true });

    // The NBF pass really did dispatch the test-writer — otherwise "one review"
    // would be satisfied by a pass that never fixed anything.
    expect(run.autofixInputs).toHaveLength(1);
    expect(run.dispatched.filter((name) => name === "autofix-test-writer")).toHaveLength(1);
    // Exactly one fix review, and it is the keep gate's: the review's first act is
    // a working-tree snapshot, so one snapshot means one `runFixReview`.
    expect(run.snapshots).toBe(1);
    expect(run.fixReviewPrompts).toHaveLength(1);
    // ...taken from the NBF snapshot sha. A review wrapped around the dispatch
    // would have diffed from its own pre-dispatch snapshot instead.
    expect(run.diffFroms).toContain(NBF_SHA);
    expect(run.diffFroms).not.toContain(PRE_FIX_TREE);
    // The reviewed pass was kept, so the story stays green.
    expect(run.success).toBe(true);
  });
});
