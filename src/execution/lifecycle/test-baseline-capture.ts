/**
 * Run-start baseline capture and sequential roll-forward (US-002).
 *
 * Owns the harness-side capture step at the top of `runExecutionPhase` and
 * the per-story roll-forward writes in the post-run story-completion path.
 * Delegates persistence to `writeRunBaseline` / `writeStoryBaseline` from
 * `src/verification/test-baseline.ts`; this module is the orchestration layer,
 * not the IO layer.
 *
 * Out of scope (see US-002 §Out of Scope): baseline types/classification
 * (US-001), attaching dispositions to gate findings (US-003), prompt
 * rendering (US-004). Parallel-mode re-capture after a dependency merge is
 * also out of scope — parallel stories inherit the run-start baseline.
 */

import type { NaxConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { resolveQualityTestCommands } from "@/quality";
import { parseTestOutput, type TestSummary } from "@/test-runners";
import { errorMessage } from "@/utils/errors";
import {
  clearStoryBaselines,
  executeWithTimeout,
  type TestBaseline,
  writeRunBaseline,
  writeStoryBaseline,
} from "@/verification";
import { captureRunStartRef } from "../deferred-review";

/** Subset of TestExecutionResult the capture step actually reads. */
export interface CaptureRunnerResult {
  readonly success: boolean;
  readonly output: string;
  readonly timedOut: boolean;
  readonly exitCode?: number;
}

/** Subset of TestSummary the capture step actually reads. */
export interface CaptureParsedSummary {
  readonly passed: number;
  readonly failed: number;
  readonly failures: readonly { file: string; testName: string }[];
}

/**
 * Injectable seams. Production wiring populates them from
 * `executeWithTimeout` / `parseTestOutput` / `captureRunStartRef` /
 * `writeRunBaseline` / `writeStoryBaseline` / `resolveQualityTestCommands`.
 * Tests override the whole object to avoid `mock.module()` contamination.
 *
 * Fields are non-readonly so tests can override individual members (the
 * established _deps pattern in this codebase — e.g. _fullSuiteGateDeps,
 * _regressionDeps — uses the same shape).
 */
export interface TestBaselineCaptureDeps {
  /**
   * Resolve the suite command for the capture step. Returns:
   *   - `undefined` when no command is configured (AC7);
   *   - a single `string` for the historical list-of-one / single-string shape;
   *   - a `string[]` (nax#1990 list form) — each entry runs independently so
   *     a failing earlier entry does NOT short-circuit later entries (the
   *     full-suite gate's `runVerificationCore` already aggregates per-command
   *     outputs the same way). Tests overriding with the string form are
   *     unaffected: `string` is a subtype of `string | readonly string[]`.
   */
  resolveTestCommands: (config: NaxConfig, workdir: string) => Promise<string | readonly string[] | undefined>;
  runCommand: (command: string, timeoutSeconds: number, workdir: string) => Promise<CaptureRunnerResult>;
  captureGitRef: (workdir: string) => Promise<string>;
  parseTestOutput: (output: string) => CaptureParsedSummary;
  writeRunBaseline: (root: string, featureId: string, baseline: TestBaseline) => Promise<void>;
  writeStoryBaseline: (root: string, featureId: string, storyId: string, baseline: TestBaseline) => Promise<void>;
  clearStoryBaselines: (root: string, featureId: string) => Promise<void>;
  now: () => string;
  /** Resolve the gate timeout: regressionGate.timeoutSeconds ?? rectification.fullSuiteTimeoutSeconds ?? schema default. */
  resolveGateTimeoutSeconds: (config: NaxConfig) => number;
  regressionGateEnabled: (config: NaxConfig) => boolean;
}

/** Schema default for the gate timeout (matches `regressionGate.timeoutSeconds` schema floor). */
const DEFAULT_GATE_TIMEOUT_SECONDS = 300;

/**
 * Production wiring: production code reads from this object; tests override
 * individual members. All external calls (process spawn, file IO, git) live
 * behind the dep so `_captureDeps.runCommand` / `writeRunBaseline` etc. are
 * the only injection points — no `mock.module()` required.
 */
export const _captureDeps: TestBaselineCaptureDeps = {
  resolveTestCommands: async (config, workdir) => {
    const { testCommand } = await resolveQualityTestCommands(config, workdir);
    if (testCommand === undefined) return undefined;
    // nax#1990: a list means "run every entry, report every failure" — never
    // join with `&&`, which short-circuits on the first failing command and
    // hides later failures. `captureRunBaseline` handles each entry
    // independently and aggregates the parsed summaries. Tests and the
    // string-form callers see the same `string | string[] | undefined` shape.
    return testCommand;
  },
  runCommand: async (command, timeoutSeconds, workdir) => {
    // Forward `workdir` so the spawned command runs from the resolved package
    // dir — `executeWithTimeout` defaults `cwd` to `process.cwd()`, which
    // breaks when nax is launched from a parent shell / editor / CI with a
    // different cwd than the target repo (monorepo-awareness §1).
    const result = await executeWithTimeout(command, timeoutSeconds, undefined, {
      cwd: workdir,
    });
    return {
      success: result.success,
      output: result.output ?? "",
      timedOut: result.timeout,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    };
  },
  captureGitRef: captureRunStartRef,
  parseTestOutput: (output) => adaptTestSummary(parseTestOutput(output)),
  writeRunBaseline,
  writeStoryBaseline,
  clearStoryBaselines,
  now: () => new Date().toISOString(),
  resolveGateTimeoutSeconds: (config) =>
    config.execution?.regressionGate?.timeoutSeconds ??
    config.execution?.rectification?.fullSuiteTimeoutSeconds ??
    DEFAULT_GATE_TIMEOUT_SECONDS,
  regressionGateEnabled: (config) => config.execution?.regressionGate?.enabled ?? true,
};

/** Strip the runtime-only fields the capture step never reads. */
function adaptTestSummary(summary: TestSummary): CaptureParsedSummary {
  return {
    passed: summary.passed,
    failed: summary.failed,
    failures: summary.failures.map((f) => ({ file: f.file, testName: f.testName })),
  };
}

/** Options for the run-start capture step. */
export interface CaptureRunBaselineOptions {
  readonly root: string;
  readonly featureId: string;
  readonly config: NaxConfig;
  readonly workdir: string;
}

/** Options for the sequential roll-forward write. */
export interface RollForwardOptions {
  readonly root: string;
  readonly featureId: string;
  readonly executionMode: "sequential" | "parallel";
  /** Populated only in sequential mode — the next story's id, or undefined if this is the last story. */
  readonly nextStoryId?: string;
  /** The summary the gate phase just produced, or undefined when the gate did not produce one. */
  readonly summary?: CaptureParsedSummary;
}

/** Resolve the story id that follows `currentStoryId` in the PRD's userStories array. */
export function resolveNextStoryId(
  userStories: ReadonlyArray<{ id: string }>,
  currentStoryId: string,
): string | undefined {
  const idx = userStories.findIndex((s) => s.id === currentStoryId);
  if (idx < 0 || idx >= userStories.length - 1) return undefined;
  return userStories[idx + 1]?.id;
}

/** Minimal shape the post-run story-completion path must forward to `persistNextStoryRollForward`. */
export interface RollForwardContext {
  /** Repository root — anchors the baseline artifact paths. */
  readonly root: string;
  /** Feature id — segments the artifact tree. */
  readonly featureId: string;
  /** The current story's userStories array, used to resolve the next story id. */
  readonly userStories: ReadonlyArray<{ id: string }>;
  /** The current story id. */
  readonly currentStoryId: string;
  /**
   * True when the story is running under a parallel batch orchestrator (concurrent worktrees,
   * no total order). False for shared / sequential-worktree modes.
   */
  readonly isParallelMode: boolean;
  /** Optional full-suite-gate summary produced by the gate phase, when available. */
  readonly gateSummary?: CaptureParsedSummary;
}

/**
 * Resolves the next story id, builds the roll-forward options, and delegates to
 * `persistNextStoryRollForward`. Single entry point the post-run story-completion
 * path calls — keeps post-run.ts's hook at one delegated call (AC12).
 *
 * Outer try/catch matches the run-start hook's invariant ("never blocks or
 * fails the run"): the helper writes either a captured roll-forward baseline
 * or a `no-baseline: no-gate-parse` marker for the documented degraded paths,
 * but `writeStoryBaseline` (mkdir + atomic write) can throw on disk /
 * permission failure. That throw must never abort the story's success path
 * or escalate a passing story. The catch logs and resolves — same posture
 * the run-start hook's outer catch uses.
 */
export async function invokeRollForwardFromContext(ctx: RollForwardContext): Promise<void> {
  const nextStoryId = resolveNextStoryId(ctx.userStories, ctx.currentStoryId);
  try {
    await persistNextStoryRollForward({
      root: ctx.root,
      featureId: ctx.featureId,
      executionMode: ctx.isParallelMode ? "parallel" : "sequential",
      nextStoryId,
      summary: ctx.gateSummary,
    });
  } catch (err) {
    // The write (mkdir + atomic write) can fail on a full / read-only volume.
    // A baseline write must never abort a passing story's success path, but the
    // failure is still surfaced so a missing roll-forward artifact is traceable
    // rather than invisible — same posture as the run-start hook's outer catch.
    getSafeLogger()?.warn("execution", "Roll-forward baseline write failed — continuing", {
      storyId: ctx.currentStoryId,
      error: errorMessage(err),
    });
  }
}

/** Write a `no-baseline` marker with the given reason. Single persistence seam for every degraded path. */
async function writeNoBaseline(
  kind: "run" | "story",
  root: string,
  featureId: string,
  storyId: string | undefined,
  reason: "gate-disabled" | "no-test-command" | "timeout" | "unparseable" | "error" | "no-gate-parse",
): Promise<void> {
  const baseline: TestBaseline = {
    kind: "no-baseline",
    reason,
    capturedAt: _captureDeps.now(),
  };
  if (kind === "run") {
    await _captureDeps.writeRunBaseline(root, featureId, baseline);
  } else {
    if (storyId === undefined) return;
    await _captureDeps.writeStoryBaseline(root, featureId, storyId, baseline);
  }
}

/**
 * Captures the suite once and persists the run-start baseline. Never blocks
 * or fails the run — every degraded path resolves normally with a `no-baseline`
 * marker so the capture step is observable but never a tripwire.
 *
 * Decision tree (per AC1–AC10, AC17):
 *   1. `regressionGate.enabled === false` → `no-baseline: gate-disabled` (no spawn).
 *   2. No resolvable test command → `no-baseline: no-test-command` (no spawn).
 *   3. Runner throws → catch, `no-baseline: error`, resolve normally.
 *   4. Runner result `timedOut` → `no-baseline: timeout`.
 *   5. Runner result `!success && failures.length === 0` → `no-baseline: unparseable`.
 *   6. Otherwise (suite ran and parser produced failures, or green suite) →
 *      `captured` with `source: "preflight"`, `baseRef` from `captureGitRef`,
 *      one entry per parsed failure. Green suites carry `entries: []` — the
 *      baseline is the empty set, not a missing baseline (AC5).
 *
 * List-form commands (nax#1990) run each entry independently and aggregate
 * the parsed summaries — never `&&`-join (which would short-circuit on the
 * first failing command and hide later failures).
 */
export async function captureRunBaseline(opts: CaptureRunBaselineOptions): Promise<void> {
  try {
    await captureRunBaselineInner(opts);
  } catch (err) {
    try {
      await writeNoBaseline("run", opts.root, opts.featureId, undefined, "error");
    } catch (writeErr) {
      getSafeLogger()?.warn("execution", "Run baseline error marker write failed — continuing", {
        featureId: opts.featureId,
        error: errorMessage(writeErr),
      });
    }
    getSafeLogger()?.warn("execution", "Run-start baseline capture failed — continuing", {
      featureId: opts.featureId,
      error: errorMessage(err),
    });
  }
}

async function captureRunBaselineInner(opts: CaptureRunBaselineOptions): Promise<void> {
  const { root, featureId, config, workdir } = opts;

  try {
    await _captureDeps.clearStoryBaselines(root, featureId);
  } catch (err) {
    getSafeLogger()?.warn("execution", "Story baseline cleanup failed — continuing", {
      featureId,
      error: errorMessage(err),
    });
  }

  // AC6 — gate disabled, no spawn.
  if (!_captureDeps.regressionGateEnabled(config)) {
    await writeNoBaseline("run", root, featureId, undefined, "gate-disabled");
    return;
  }

  // AC7 — no resolvable command, no spawn.
  const resolved = await _captureDeps.resolveTestCommands(config, workdir);
  if (resolved === undefined) {
    await writeNoBaseline("run", root, featureId, undefined, "no-test-command");
    return;
  }

  const commands = typeof resolved === "string" ? [resolved] : Array.from(resolved);
  const timeoutSeconds = _captureDeps.resolveGateTimeoutSeconds(config);
  const capturedAt = _captureDeps.now();

  // Run each command independently; aggregate outputs and parsed summaries.
  // A single timed-out result short-circuits the whole loop to `timeout` —
  // matches the gate's `TIMEOUT` semantics: don't pollute the baseline with
  // partial output from commands that never ran.
  let aggregateSuccess = true;
  let aggregateTimedOut = false;
  let runnerThrew = false;
  const parsedSummaries: CaptureParsedSummary[] = [];

  for (const command of commands) {
    let result: CaptureRunnerResult;
    try {
      result = await _captureDeps.runCommand(command, timeoutSeconds, workdir);
    } catch {
      // AC10 — runner throws; record so we write a `no-baseline: error`
      // marker after the loop and don't claim the suite ran.
      runnerThrew = true;
      break;
    }

    if (result.timedOut) {
      // AC8 — runner timed out; stop running remaining entries.
      aggregateTimedOut = true;
      break;
    }

    if (!result.success) aggregateSuccess = false;

    parsedSummaries.push(_captureDeps.parseTestOutput(result.output));
  }

  if (runnerThrew) {
    await writeNoBaseline("run", root, featureId, undefined, "error");
    return;
  }

  if (aggregateTimedOut) {
    await writeNoBaseline("run", root, featureId, undefined, "timeout");
    return;
  }

  // Aggregate the parsed summaries: sum passed/failed, concatenate failures.
  // The gate does the same — see `aggregateVerificationResults` in
  // `verification/runners.ts:128`.
  const totalPassed = parsedSummaries.reduce((sum, s) => sum + s.passed, 0);
  const totalFailed = parsedSummaries.reduce((sum, s) => sum + s.failed, 0);
  const allFailures = parsedSummaries.flatMap((s) => s.failures);
  const summary: CaptureParsedSummary = {
    passed: totalPassed,
    failed: totalFailed,
    failures: allFailures,
  };

  // AC9 — runner exited non-zero but parser produced zero structured failures
  // (across every command in the list).
  if (!aggregateSuccess && summary.failed === 0) {
    await writeNoBaseline("run", root, featureId, undefined, "unparseable");
    return;
  }

  // AC1 + AC5 — green suite (success + zero failures) writes a captured
  // baseline with `entries: []` rather than a `no-baseline` marker; non-zero
  // failures produce one entry per parsed failure.
  const baseRef = await _captureDeps.captureGitRef(workdir);
  await _captureDeps.writeRunBaseline(root, featureId, {
    kind: "captured",
    source: "preflight",
    capturedAt,
    baseRef,
    entries: summary.failures.map((f) => ({ file: f.file, testName: f.testName })),
  });
}

/**
 * Persists the next-story roll-forward baseline after a sequential story
 * completes. Skipped entirely in parallel mode (every parallel story inherits
 * the run-start baseline) and on the last story in the PRD (no next story to
 * roll forward to).
 *
 * Decision tree (per AC12–AC14):
 *   1. Parallel mode → no-op.
 *   2. No `nextStoryId` → no-op (last story).
 *   3. `summary` provided → `captured` with `source: "roll-forward"`, one
 *      entry per failure.
 *   4. `summary` undefined → `no-baseline: no-gate-parse`.
 *
 * Note on branch 4: `execution.regressionGate.mode` defaults to `"deferred"`, and
 * non-TDD plans add the per-story full-suite gate only when the mode is
 * `"per-story"` (`build-plan-for-strategy.ts`, issue #1116) — so for an ordinary
 * non-TDD sequential run branch 4 is the steady state, not an anomaly. That is
 * designed (spec §3.2: record that no roll-forward was available rather than
 * guess a baseline); do NOT "fix" it by substituting the run-start `preflight`
 * artifact here — it predates the stories in between, so their failures would be
 * re-attributed to this story as introduced rather than left unattributed.
 * TDD plans always carry the gate and do exercise branch 3.
 */
export async function persistNextStoryRollForward(opts: RollForwardOptions): Promise<void> {
  // AC14 — parallel mode skips entirely.
  if (opts.executionMode === "parallel") return;
  // Last story — no next story to write for.
  if (opts.nextStoryId === undefined) return;

  // AC13 — no usable gate parse → no-gate-parse marker.
  if (opts.summary === undefined) {
    await writeNoBaseline("story", opts.root, opts.featureId, opts.nextStoryId, "no-gate-parse");
    return;
  }

  // AC12 — summary carries parsed failures → captured roll-forward baseline.
  await _captureDeps.writeStoryBaseline(opts.root, opts.featureId, opts.nextStoryId, {
    kind: "captured",
    source: "roll-forward",
    capturedAt: _captureDeps.now(),
    entries: opts.summary.failures.map((f) => ({ file: f.file, testName: f.testName })),
  });
}
