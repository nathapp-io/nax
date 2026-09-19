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
import { resolveQualityTestCommands } from "@/quality";
import { parseTestOutput, type TestSummary } from "@/test-runners";
import { executeWithTimeout, type TestBaseline, writeRunBaseline, writeStoryBaseline } from "@/verification";
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
  resolveTestCommands: (config: NaxConfig, workdir: string) => Promise<string | undefined>;
  runCommand: (command: string, timeoutSeconds: number) => Promise<CaptureRunnerResult>;
  captureGitRef: (workdir: string) => Promise<string>;
  parseTestOutput: (output: string) => CaptureParsedSummary;
  writeRunBaseline: (root: string, featureId: string, baseline: TestBaseline) => Promise<void>;
  writeStoryBaseline: (root: string, featureId: string, storyId: string, baseline: TestBaseline) => Promise<void>;
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
    return typeof testCommand === "string" ? testCommand : testCommand.join(" && ");
  },
  runCommand: async (command, timeoutSeconds) => {
    const result = await executeWithTimeout(command, timeoutSeconds, undefined, {
      // Pre-existing failures in the captured baseline are environmental, not code
      // defects — same posture as the full-suite gate: accept-on-timeout is irrelevant
      // here because we only read `output`/`success`/`timedOut`, but we keep the
      // executor's default behaviour (no accept-on-timeout semantics at this layer).
      cwd: undefined,
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
 */
export async function invokeRollForwardFromContext(ctx: RollForwardContext): Promise<void> {
  const nextStoryId = resolveNextStoryId(ctx.userStories, ctx.currentStoryId);
  await persistNextStoryRollForward({
    root: ctx.root,
    featureId: ctx.featureId,
    executionMode: ctx.isParallelMode ? "parallel" : "sequential",
    nextStoryId,
    summary: ctx.gateSummary,
  });
}

/** Resolve the suite command via the production resolver; returns `undefined` when no command is configured. */
async function resolveSuiteCommand(config: NaxConfig, workdir: string): Promise<string | undefined> {
  return _captureDeps.resolveTestCommands(config, workdir);
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
 */
export async function captureRunBaseline(opts: CaptureRunBaselineOptions): Promise<void> {
  const { root, featureId, config, workdir } = opts;

  // AC6 — gate disabled, no spawn.
  if (!_captureDeps.regressionGateEnabled(config)) {
    await writeNoBaseline("run", root, featureId, undefined, "gate-disabled");
    return;
  }

  // AC7 — no resolvable command, no spawn.
  const command = await resolveSuiteCommand(config, workdir);
  if (command === undefined) {
    await writeNoBaseline("run", root, featureId, undefined, "no-test-command");
    return;
  }

  const timeoutSeconds = _captureDeps.resolveGateTimeoutSeconds(config);
  const capturedAt = _captureDeps.now();

  // AC10 — runner throws, catch and resolve normally.
  let result: CaptureRunnerResult;
  try {
    result = await _captureDeps.runCommand(command, timeoutSeconds);
  } catch {
    await writeNoBaseline("run", root, featureId, undefined, "error");
    return;
  }

  // AC8 — runner timed out.
  if (result.timedOut) {
    await writeNoBaseline("run", root, featureId, undefined, "timeout");
    return;
  }

  const summary = _captureDeps.parseTestOutput(result.output);

  // AC9 — runner exited non-zero but parser produced zero structured failures.
  if (!result.success && summary.failed === 0) {
    await writeNoBaseline("run", root, featureId, undefined, "unparseable");
    return;
  }

  // AC1 + AC5 — green suite (success + zero failures) writes a captured baseline
  // with `entries: []` rather than a `no-baseline` marker; non-zero failures
  // produce one entry per parsed failure.
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
