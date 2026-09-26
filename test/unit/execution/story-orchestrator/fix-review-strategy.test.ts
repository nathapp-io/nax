/**
 * US-005 — `createFixReviewWrapper` (`src/execution/story-orchestrator/fix-review-strategy.ts`).
 *
 * The wrapper around the blocking cycle's `autofix-test-writer` strategy that
 * reviews each dispatch's own delta and feeds an AC-anchored contradiction back
 * into the cycle:
 *
 * AC8  — a contradiction carrying an `acIndex` is queued, and `drainFindings()`
 *        empties the queue (a finding must not be re-fed on every later drain).
 * AC9  — a `scope` fail queues nothing and warns.
 * AC10 — a contradiction naming no AC queues nothing and warns.
 * AC11 — a pass queues nothing (and does not warn).
 * AC12 — an error verdict queues nothing and warns.
 * AC13 — a failing pre-dispatch snapshot skips the review for that dispatch.
 * AC14 — the review is seeded with the findings `buildInput` received.
 *
 * Nothing below the wrapper is faked at the module boundary: the review runs for
 * real (`runFixReview`), with its git layer faked through `_treeSnapshotDeps`
 * and its reviewer answered by the runtime's stubbed agent manager — the same
 * seam the sibling wiring test (`test/integration/review/fix-review/`) uses.
 * That is deliberate: the wrapper's whole job is to hand the review the right
 * tree and the right findings, and both are only observable through it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  makeCallOp,
  makeMockAgentManager,
  makeMockCallContext,
  makeNaxConfig,
  makeStory,
  makeTestRuntime,
  withWarnSpy,
} from "@test/helpers";
import { createFixReviewWrapper } from "@/execution/story-orchestrator/fix-review-strategy";
import type { Finding, FixApplied, FixCycleContext, FixStrategy } from "@/findings";
import { dispatchStrategy } from "@/findings/cycle-dispatch";
import type { CallOpFn } from "@/findings/cycle-types";
import {
  type AutofixTestWriterInput,
  type AutofixTestWriterOutput,
  type CallContext,
  testWriterRectifyOp,
} from "@/operations";
import { _treeSnapshotDeps } from "@/review/fix-review/tree-snapshot";
import type { SpawnOptions, SpawnResult } from "@/utils/bun-deps";

const WORKDIR = "/tmp/nax-us-005-fix-review";
const STORY_REF = "ref-story-start";
const PRE_FIX_TREE = "a".repeat(40);
const POST_FIX_TREE = "b".repeat(40);
/** A test file — exempt from the review's scope check, so the review reaches the LLM stage. */
const CHANGED_TEST_PATH = "test/dropped-assertion.test.ts";
/** A source path no story file and no seeding finding names — the scope-fail case. */
const CHANGED_UNLISTED_PATH = "src/nax-us-005-unlisted-path.ts";
/** A source path that is in scope ONLY because a seeding finding names it (AC14). */
const SEEDED_PATH = "src/nax-us-005-seeded-path.ts";
const SEED_MESSAGE = "the empty path skips the DELETE";
const CONTRADICTION_REASON = "drops the AC-2 assertion";
const CONTRADICTION_ANSWER = `{"passed":false,"reason":"${CONTRADICTION_REASON}","acIndex":2}`;
const UNANCHORED_CONTRADICTION_ANSWER = '{"passed":false,"reason":"removes the guard from removeApprovals"}';
const PASS_ANSWER = '{"passed":true,"reason":"consistent with the ACs"}';
/** No JSON object at all — `runFixReview` reports this as `kind: "error"`. */
const UNPARSEABLE_ANSWER = "I could not review this fix.";
const SMALL_DIFF =
  "diff --git a/test/dropped-assertion.test.ts b/test/dropped-assertion.test.ts\n-  expect(x).toBe(2);\n";

/** The warning the wrapper must emit for every non-pass it does not feed back. */
const NON_PASS_WARNING = "fix review non-pass not fed back";

function seedFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "adversarial-review",
    severity: "error",
    category: "test-gap",
    message: SEED_MESSAGE,
    fixTarget: "test",
    ...overrides,
  };
}

/** A fake `SpawnResult` for the faked git layer (typed against `src/utils/bun-deps`). */
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

interface RunOptions {
  /** What the stubbed reviewer answers `fix-review` with. */
  readonly answer?: string;
  /** Repo-relative paths the fix changed (the review's fix delta). */
  readonly fixPaths?: readonly string[];
  /** Repo-relative paths the story had already changed before the fix. */
  readonly storyPaths?: readonly string[];
  /** Make the working-tree snapshot taken before the dispatch reject. */
  readonly failPreFixSnapshot?: boolean;
  /** Findings handed to the wrapped strategy's dispatch. */
  readonly findings?: readonly Finding[];
  /** How many times to dispatch the wrapped strategy (default 1). */
  readonly dispatches?: number;
}

interface Run {
  readonly applied: FixApplied;
  /** `drainFindings()` after the dispatches. */
  readonly drained: Finding[];
  /** A second `drainFindings()`, which must not re-deliver the first one's findings. */
  readonly drainedAgain: Finding[];
  /** One entry per `buildInput` call: the findings that dispatch was built from. */
  readonly built: Finding[][];
  /** Prompts the reviewer received — one entry per `runFixReview` that reached its LLM stage. */
  readonly prompts: string[];
  /** Every argv the review's git layer received, in order. */
  readonly gitCalls: string[][];
}

/**
 * Dispatch the wrapped strategy and report every observable the ACs turn on.
 *
 * A fresh runtime (and therefore a fresh stubbed reviewer) per call, so the
 * verdict a test asks for is the verdict that dispatch sees.
 */
async function runWrappedDispatch(options: RunOptions = {}): Promise<Run> {
  const built: Finding[][] = [];
  const prompts: string[] = [];
  const gitCalls: string[][] = [];
  let snapshots = 0;
  let readTreeFailures = options.failPreFixSnapshot ? 1 : 0;

  Object.assign(_treeSnapshotDeps, {
    spawn: (cmd: string[], _opts?: SpawnOptions): SpawnResult => {
      gitCalls.push([...cmd]);
      const argv = cmd.join(" ");
      if (argv.includes("read-tree")) {
        if (readTreeFailures > 0) {
          readTreeFailures -= 1;
          return fakeProc("", 1);
        }
        return fakeProc("");
      }
      if (argv.includes("add -A")) return fakeProc("");
      if (argv.includes("write-tree")) {
        snapshots += 1;
        // The pre-dispatch snapshot is taken first; the review's post-fix one second.
        return fakeProc(`${snapshots === 1 ? PRE_FIX_TREE : POST_FIX_TREE}\n`);
      }
      if (argv.includes("--no-renames")) {
        const from = cmd[cmd.indexOf("--no-renames") + 1];
        const paths = from === STORY_REF ? (options.storyPaths ?? []) : (options.fixPaths ?? [CHANGED_TEST_PATH]);
        return fakeProc(paths.length === 0 ? "" : `${paths.join("\n")}\n`);
      }
      if (argv.includes("diff")) return fakeProc(SMALL_DIFF);
      return fakeProc("");
    },
    mkdtemp: async () => "/tmp/nax-us-005-fix-review-snapshot",
    rm: async () => {},
    tmpdir: () => "/tmp",
  });

  const config = makeNaxConfig({ quality: { autofix: { enabled: true } } });
  const story = makeStory({ id: "US-005", storyGitRef: STORY_REF });
  const runtime = makeTestRuntime({
    config,
    agentManager: makeMockAgentManager({
      runWithFallbackFn: async (req) => {
        prompts.push(req.runOptions.prompt);
        return {
          result: {
            success: true,
            exitCode: 0,
            output: options.answer ?? PASS_ANSWER,
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
  const ctx: CallContext = makeMockCallContext({
    runtime,
    config,
    packageDir: WORKDIR,
    storyId: story.id,
    story,
  });
  const wrapper = createFixReviewWrapper({ ctx, story, config: config.review });
  const base: FixStrategy<Finding, AutofixTestWriterInput, AutofixTestWriterOutput> = {
    name: "autofix-test-writer",
    appliesTo: () => true,
    fixOp: testWriterRectifyOp,
    buildInput: (findings) => {
      built.push([...findings]);
      return { failedChecks: [], story };
    },
    extractApplied: () => ({ targetFiles: [CHANGED_TEST_PATH], summary: "rewrote the assertion" }),
    maxAttempts: 5,
    coRun: "co-run-sequential",
  };
  const wrapped = wrapper.wrap(base);
  const callOp: CallOpFn = makeCallOp({ fallback: { applied: true } });
  const cycleCtx: FixCycleContext = { ...ctx, storyId: story.id };
  const deps = {
    callOp,
    dispatchCallId: "call-1",
    logger: null,
    logCtx: { storyId: story.id, cycleName: "test-cycle", packageDir: WORKDIR },
  };

  let applied: FixApplied | undefined;
  for (let i = 0; i < (options.dispatches ?? 1); i += 1) {
    applied = await dispatchStrategy(wrapped, cycleCtx, [...(options.findings ?? [])], [], deps);
  }
  const drained = wrapper.drainFindings();
  const drainedAgain = wrapper.drainFindings();
  await runtime.close();
  if (applied === undefined) throw new Error("[test] the wrapped strategy was never dispatched");
  return { applied, drained, drainedAgain, built, prompts, gitCalls };
}

/** The `[stage, message]` pair of every `logger.warn` call the spy captured. */
function warnPairs(warnSpy: { mock: { calls: unknown[][] } }): string[] {
  return warnSpy.mock.calls.map((call) => `${String(call[0])}|${String(call[1])}`);
}

let origTree: typeof _treeSnapshotDeps;
beforeEach(() => {
  origTree = { ..._treeSnapshotDeps };
});
afterEach(() => {
  Object.assign(_treeSnapshotDeps, origTree);
});

describe("createFixReviewWrapper — the AC-anchored contradiction it feeds back (US-005 AC8)", () => {
  test("US-005 AC8: a contradiction with acIndex 2 queues one finding, and a second drain returns none", async () => {
    const run = await runWrappedDispatch({
      answer: CONTRADICTION_ANSWER,
      findings: [seedFinding({ file: CHANGED_TEST_PATH })],
    });

    expect(run.drained).toHaveLength(1);
    expect(run.drained[0]?.rule).toBe("fix-review:AC-2");
    expect(run.drained[0]?.message).toBe(CONTRADICTION_REASON);
    // Draining is one-shot: a finding left in place would be re-fed to the cycle
    // on every later postValidate, re-dispatching a fix for a contradiction the
    // cycle already answered.
    expect(run.drainedAgain).toEqual([]);
  });

  test("US-005 AC8 boundary: one contradictory dispatch queues one finding each time", async () => {
    const run = await runWrappedDispatch({
      answer: CONTRADICTION_ANSWER,
      findings: [seedFinding({ file: CHANGED_TEST_PATH })],
      dispatches: 2,
    });

    // The queue accumulates rather than overwriting, so a second contradiction is
    // not lost — and the first is not delivered twice.
    expect(run.drained).toHaveLength(2);
    expect(run.drained.every((finding) => finding.rule === "fix-review:AC-2")).toBe(true);
    expect(run.drainedAgain).toEqual([]);
  });
});

describe("createFixReviewWrapper — the non-passes that must not be fed back (US-005 AC9, AC10)", () => {
  test("US-005 AC9: a scope fail queues nothing and warns", async () => {
    await withWarnSpy(async (warnSpy) => {
      const run = await runWrappedDispatch({
        answer: CONTRADICTION_ANSWER,
        fixPaths: [CHANGED_UNLISTED_PATH],
        findings: [seedFinding()],
      });

      expect(run.drained).toEqual([]);
      // The scope check decides before the LLM stage, so a scope fail spends no
      // reviewer turn at all.
      expect(run.prompts).toEqual([]);
      expect(warnPairs(warnSpy)).toContain(`fix-review|${NON_PASS_WARNING}`);
    });
  });

  test("US-005 AC10: a contradiction naming no acceptance criterion queues nothing and warns", async () => {
    await withWarnSpy(async (warnSpy) => {
      const run = await runWrappedDispatch({
        answer: UNANCHORED_CONTRADICTION_ANSWER,
        findings: [seedFinding({ file: CHANGED_TEST_PATH })],
      });

      expect(run.drained).toEqual([]);
      // The review did run and did answer — the warning is the only trace, and
      // that is exactly the nax#1359 ruling: unanchored non-passes warn only.
      expect(run.prompts).toHaveLength(1);
      expect(warnPairs(warnSpy)).toContain(`fix-review|${NON_PASS_WARNING}`);
    });
  });
});

describe("createFixReviewWrapper — the passes and errors (US-005 AC11, AC12)", () => {
  test("US-005 AC11: a pass queues nothing and does not warn", async () => {
    await withWarnSpy(async (warnSpy) => {
      const run = await runWrappedDispatch({
        answer: PASS_ANSWER,
        findings: [seedFinding({ file: CHANGED_TEST_PATH })],
      });

      expect(run.drained).toEqual([]);
      // The review reached its verdict — otherwise "queues nothing" would be
      // satisfied by never reviewing at all.
      expect(run.prompts).toHaveLength(1);
      expect(warnPairs(warnSpy)).not.toContain(`fix-review|${NON_PASS_WARNING}`);
    });
  });

  test("US-005 AC12: an error verdict queues nothing and warns", async () => {
    await withWarnSpy(async (warnSpy) => {
      const run = await runWrappedDispatch({
        answer: UNPARSEABLE_ANSWER,
        findings: [seedFinding({ file: CHANGED_TEST_PATH })],
      });

      expect(run.drained).toEqual([]);
      expect(run.prompts).toHaveLength(1);
      expect(warnPairs(warnSpy)).toContain(`fix-review|${NON_PASS_WARNING}`);
    });
  });
});

describe("createFixReviewWrapper — the pre-dispatch snapshot (US-005 AC13)", () => {
  test("US-005 AC13: a rejecting snapshot skips the review for that dispatch", async () => {
    await withWarnSpy(async (warnSpy) => {
      const run = await runWrappedDispatch({
        answer: CONTRADICTION_ANSWER,
        failPreFixSnapshot: true,
        findings: [seedFinding({ file: CHANGED_TEST_PATH })],
      });

      // The warning is the visible half of "logs a warning and skips".
      expect(warnPairs(warnSpy).some((pair) => pair.startsWith("fix-review|"))).toBe(true);
      // The review never ran: no diff of the fix's delta and no reviewer turn —
      // with no pre-fix tree there is nothing to diff against.
      expect(run.gitCalls.filter((cmd) => cmd.join(" ").includes("--no-renames"))).toEqual([]);
      expect(run.prompts).toEqual([]);
      expect(run.drained).toEqual([]);
      // The dispatch itself still happened: a review that cannot run must not
      // cost the strategy its fix.
      expect(run.applied.strategyName).toBe("autofix-test-writer");
      expect(run.applied.targetFiles).toEqual([CHANGED_TEST_PATH]);
    });
  });
});

describe("createFixReviewWrapper — the findings the review is seeded with (US-005 AC14)", () => {
  test("US-005 AC14: the review is seeded with the findings buildInput received", async () => {
    const seed = seedFinding({ file: SEEDED_PATH, message: SEED_MESSAGE });
    const run = await runWrappedDispatch({
      answer: CONTRADICTION_ANSWER,
      // In scope ONLY because the seeding finding names this path — if the review
      // were handed an empty list, the scope check would fail before any dispatch.
      fixPaths: [SEEDED_PATH],
      findings: [seed],
    });

    expect(run.built[0]).toEqual([seed]);
    expect(run.prompts).toHaveLength(1);
    expect(run.prompts[0]).toContain(SEED_MESSAGE);
    expect(run.drained).toHaveLength(1);
    expect(run.drained[0]?.rule).toBe("fix-review:AC-2");
  });

  test("US-005 AC14 boundary: a dispatch with no findings seeds the review with none", async () => {
    const run = await runWrappedDispatch({
      answer: CONTRADICTION_ANSWER,
      fixPaths: [SEEDED_PATH],
      // No findings at all: the empty list really is what the review is handed,
      // so its scope check rejects the changed path and no reviewer turn is spent.
      findings: [],
    });

    expect(run.built[0]).toEqual([]);
    expect(run.drained).toEqual([]);
    // The review ran and stopped at its scope check — the empty findings list is
    // what it was handed, not a review that never happened.
    expect(run.gitCalls.filter((cmd) => cmd.join(" ").includes("--no-renames")).length).toBeGreaterThan(0);
    expect(run.prompts).toEqual([]);
  });
});
