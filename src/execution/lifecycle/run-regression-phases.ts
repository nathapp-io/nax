/**
 * Phases of the deferred regression gate.
 *
 * Extracted from run-regression.ts (file-size limit) — the setup resolution,
 * the initial full-suite run and its guard exits, test-to-story attribution,
 * the per-story rectification loop, and the final confirmation run. Each phase
 * receives a {@link RegressionFrame} carrying everything fixed for the gate's
 * lifetime, including the `_regressionDeps` seam BY REFERENCE (properties are
 * read at call time, so test stubs assigned before the gate runs still
 * intercept) and the `buildStoryCycle` factory, which stays in run-regression.ts
 * so the `FixCycleContext` construction site it owns keeps passing
 * `check-bash-dispatch-ask` from the file that file's test pins.
 *
 * This module imports run-regression.ts TYPE-ONLY: a runtime import would
 * cycle straight back to the `_regressionDeps` seam the barrels re-export.
 */

import type { NaxConfig } from "@/config";
import {
  type Finding,
  type FixCycle,
  type FixCycleContext,
  type FixCycleResult,
  testSummaryToFindings,
} from "@/findings";
import type { Logger } from "@/logger";
import { countStories, type PRD, type UserStory } from "@/prd";
import { type QualityCommandSpec, renderCommandSpec } from "@/quality";
import type { NaxRuntime } from "@/runtime";
import type { TestSummary } from "@/test-runners";
import { type FlakeQuarantineReport, NULL_QUARANTINE_MEMO, type QuarantineMemo } from "@/verification";
import type {
  _regressionDeps,
  DeferredRegressionOptions,
  DeferredRegressionResult,
  findResponsibleStoryByTransition,
} from "./run-regression";
import { runRegressionFlakeTriage } from "./run-regression-triage";

/** The `_regressionDeps` seam, threaded by reference — never imported at runtime here. */
export type RegressionDeps = typeof _regressionDeps;

/** The verify-options literal resolved by {@link resolveRegressionSetup}. */
export type RegressionVerifyOpts = Parameters<RegressionDeps["runVerification"]>[0];

/**
 * A story's rectification cycle, built by the `buildStoryCycle` factory that
 * stays in run-regression.ts. `dispose` releases the per-story ask wiring
 * (`#2201`) once the story's cycle settles — including when the cycle throws.
 */
export interface StoryCycleHandle {
  readonly cycle: FixCycle<Finding>;
  readonly cycleCtx: FixCycleContext;
  readonly dispose: () => Promise<void>;
}

/**
 * Everything fixed for the gate's lifetime. `deps` and `buildStoryCycle` are
 * the two run-regression.ts-owned pieces: read at call time so the seam keeps
 * working; typed via type-only imports so no runtime edge exists.
 */
export interface RegressionFrame {
  readonly logger: Logger | null;
  readonly options: DeferredRegressionOptions;
  readonly config: NaxConfig;
  readonly prd: PRD;
  readonly workdir: string;
  readonly runtime: NaxRuntime;
  readonly testCommand: QualityCommandSpec;
  readonly verifyOpts: RegressionVerifyOpts;
  readonly maxRectificationAttempts: number;
  readonly acceptOnTimeout: boolean;
  readonly passedStories: UserStory[];
  readonly counts: ReturnType<typeof countStories>;
  readonly deps: RegressionDeps;
  readonly findTransition: typeof findResponsibleStoryByTransition;
  readonly buildStoryCycle: (story: UserStory, initialFindings: Finding[]) => Promise<StoryCycleHandle>;
}

/** Shared inputs for the rectification loop and the final verification. */
export interface RegressionOutcomeInput {
  readonly testFilesInFailures: Set<string>;
  readonly quarantineReport?: FlakeQuarantineReport;
  readonly affectedStories: Set<string>;
  readonly affectedStoriesObjs: Map<string, UserStory>;
}

/**
 * Shared shape of every `DeferredRegressionResult` the gate returns. The
 * defaults mirror the monolith's early-exit literals exactly: zero counts,
 * empty collections, and an (absent) quarantine report.
 */
interface RegressionResultParts {
  success: boolean;
  passedTests: number;
  failedTests?: number;
  failedTestFiles?: string[];
  rectificationAttempts?: number;
  affectedStories?: string[];
  storyCosts?: Record<string, number>;
  storyDurations?: Record<string, number>;
  storyOutcomes?: Record<string, boolean>;
  quarantineReport?: FlakeQuarantineReport;
}

function regressionResult(parts: RegressionResultParts): DeferredRegressionResult {
  return {
    success: parts.success,
    failedTests: parts.failedTests ?? 0,
    failedTestFiles: parts.failedTestFiles ?? [],
    passedTests: parts.passedTests,
    rectificationAttempts: parts.rectificationAttempts ?? 0,
    affectedStories: parts.affectedStories ?? [],
    storyCosts: parts.storyCosts ?? {},
    storyDurations: parts.storyDurations ?? {},
    storyOutcomes: parts.storyOutcomes ?? {},
    ...(parts.quarantineReport ? { quarantineReport: parts.quarantineReport } : {}),
  };
}

/**
 * Build the findings that drive a story's rectification cycle.
 *
 * When the parser yields structured failures, map them directly. When it does
 * NOT — count-only output, or a runner format we can't fully parse, while the
 * suite is still failing — fall back to a single synthetic finding carrying the
 * raw output. Without this fallback the fix cycle receives zero findings and
 * `runFixCycle` short-circuits to exitReason "resolved" *without ever invoking
 * the agent*, falsely reporting a fix that never ran (the blind-rectifier bug:
 * empty findings are indistinguishable from an all-green suite).
 *
 * Callers MUST only invoke this when the suite is known to be failing.
 */
export function buildRegressionFindings(summary: TestSummary, rawOutput: string): Finding[] {
  const structured = testSummaryToFindings(summary);
  if (structured.length > 0) return structured;
  return [
    {
      source: "test-runner",
      severity: "error",
      category: "failed-test",
      rule: "regression-suite",
      message: `Full test suite is failing but no individual test failures could be parsed from the output. Diagnose and fix the underlying failure. Raw test output:\n\n${rawOutput.slice(0, SYNTHETIC_FINDING_OUTPUT_LIMIT)}`,
      fixTarget: "source",
    },
  ];
}

/** Max chars of raw test output embedded in a synthetic regression finding. */
const SYNTHETIC_FINDING_OUTPUT_LIMIT = 2000;

/** Discriminated outcome of {@link resolveRegressionSetup}. */
export type SetupOutcome =
  | { kind: "early"; result: DeferredRegressionResult }
  | {
      kind: "run";
      testCommand: QualityCommandSpec;
      verifyOpts: RegressionVerifyOpts;
      maxRectificationAttempts: number;
      acceptOnTimeout: boolean;
      passedStories: UserStory[];
      counts: ReturnType<typeof countStories>;
    };

/** Resolve the gate's config-derived inputs, guarding the two no-op exits. */
export function resolveRegressionSetup(input: {
  config: NaxConfig;
  prd: PRD;
  workdir: string;
  logger: Logger | null;
}): SetupOutcome {
  const { config, prd, logger } = input;

  // The deferred regression runs for both 'deferred' and 'per-story' modes
  // ('per-story' is a superset: per-story gate during the loop + deferred at end-of-run).
  // Only 'disabled' suppresses it entirely.
  const regressionMode = config.execution.regressionGate?.mode ?? "deferred";
  if (regressionMode === "disabled") {
    logger?.info("regression", "Deferred regression gate disabled");
    return { kind: "early", result: regressionResult({ success: true, passedTests: 0 }) };
  }

  const testCommand = config.quality.commands.test ?? "bun test";
  const timeoutSeconds = config.execution.regressionGate?.timeoutSeconds ?? 120;
  // Regression cycle shares the unified cap from execution.rectification (one
  // budget across semantic/adversarial/mechanical/regression strategies).
  const maxRectificationAttempts = config.execution.rectification.maxAttemptsTotal;
  const acceptOnTimeout = config.execution.regressionGate?.acceptOnTimeout ?? true;

  const verifyOpts = {
    workdir: input.workdir,
    command: testCommand,
    timeoutSeconds,
    forceExit: config.quality.forceExit,
    detectOpenHandles: config.quality.detectOpenHandles,
    detectOpenHandlesRetries: config.quality.detectOpenHandlesRetries,
    timeoutRetryCount: 0 as const,
    gracePeriodMs: config.quality.gracePeriodMs,
    drainTimeoutMs: config.quality.drainTimeoutMs,
    shell: config.quality.shell,
    stripEnvVars: config.quality.stripEnvVars,
  };

  // Only check stories that have been marked as passed
  const counts = countStories(prd);
  const passedStories = prd.userStories.filter((s) => s.status === "passed");

  if (passedStories.length === 0) {
    logger?.info("regression", "No passed stories to verify (partial completion)");
    return { kind: "early", result: regressionResult({ success: true, passedTests: 0 }) };
  }

  logger?.info("regression", "Running deferred full-suite regression gate", {
    totalStories: counts.total,
    passedStories: passedStories.length,
  });

  return { kind: "run", testCommand, verifyOpts, maxRectificationAttempts, acceptOnTimeout, passedStories, counts };
}

/** The parsed-suite payload the attribution and rectification phases read. */
export interface RegressionGates {
  readonly testSummary: TestSummary;
  readonly rawOutput: string;
  readonly testFilesInFailures: Set<string>;
  readonly quarantineReport?: FlakeQuarantineReport;
}

/** Discriminated outcome of {@link runInitialSuite}. */
export type InitialSuiteOutcome =
  | { kind: "early"; result: DeferredRegressionResult }
  | ({ kind: "continue" } & RegressionGates);

/**
 * Step 1: run the full test suite and walk its guard exits, then hand the
 * failing suite to flake triage (which may itself short-circuit the gate).
 */
export async function runInitialSuite(frame: RegressionFrame): Promise<InitialSuiteOutcome> {
  const fullSuiteResult = await frame.deps.runVerification(frame.verifyOpts);

  if (fullSuiteResult.success) {
    frame.logger?.info("regression", "Full suite passed");
    return { kind: "early", result: regressionResult({ success: true, passedTests: fullSuiteResult.passCount ?? 0 }) };
  }

  // Handle timeout
  if (fullSuiteResult.status === "TIMEOUT" && frame.acceptOnTimeout) {
    frame.logger?.warn("regression", "Full-suite regression gate timed out (accepted as pass)");
    return { kind: "early", result: regressionResult({ success: true, passedTests: 0 }) };
  }

  if (!fullSuiteResult.output) {
    frame.logger?.error("regression", "Full suite failed with no output");
    return {
      kind: "early",
      result: regressionResult({ success: false, passedTests: fullSuiteResult.passCount ?? 0 }),
    };
  }

  // Step 2: Parse failures and map failing test files to responsible stories
  const testSummary = frame.deps.parseTestOutput(fullSuiteResult.output);

  // Guard: if no test results could be parsed (0 pass + 0 fail), the test runner
  // itself crashed or had a compilation error — there are no actual test regressions.
  // Treat as pass to avoid false-positive regression reports. (BUG-REG-001)
  if (testSummary.failed === 0 && testSummary.passed === 0) {
    frame.logger?.warn(
      "regression",
      "No test results parsed from output — test runner likely crashed or errored (not a regression, accepting as pass)",
      { output: fullSuiteResult.output.slice(0, 500) },
    );
    return { kind: "early", result: regressionResult({ success: true, passedTests: 0 }) };
  }

  // Run flaky-test triage on the regression suite's failed-test findings.
  // Triage can relabel `failed-test` findings to `flaky-test`, which excludes
  // them from the attribution + fix-cycle pipeline below. The shared
  // run-scoped memo (if provided) short-circuits re-probing for tests already
  // judged flaky by an earlier gate.
  const regressionFindings = buildRegressionFindings(testSummary, fullSuiteResult.output);
  const quarantineMemo: QuarantineMemo = frame.options.quarantineMemo ?? NULL_QUARANTINE_MEMO;
  const triageOutcome = await runRegressionFlakeTriage({
    regressionFindings,
    testSummary,
    rawOutput: fullSuiteResult.output,
    config: frame.config,
    workdir: frame.workdir,
    testCommand: renderCommandSpec(frame.testCommand) ?? "",
    quarantineMemo,
    triageFn: frame.deps.triageFlakyFindings,
    resolveBaselineDiffFn: frame.deps.resolveFlakeBaselineDiff,
    flakeDetection: frame.config.execution.flakeDetection,
  });
  if (triageOutcome.shortCircuit) {
    return { kind: "early", result: triageOutcome.result };
  }

  return {
    kind: "continue",
    testSummary,
    rawOutput: fullSuiteResult.output,
    testFilesInFailures: triageOutcome.testFilesInFailures,
    quarantineReport: triageOutcome.quarantineReport,
  };
}

/**
 * Discriminated outcome of attribution: an early exit when no failing test
 * could be mapped to a passed story, or the mapped outcome input.
 */
export type AttributionOutcome =
  | { kind: "early"; result: DeferredRegressionResult }
  | { kind: "mapped"; outcome: RegressionOutcomeInput };

/**
 * Attribute the failing test files to passed stories via per-story gate
 * snapshots (the causal transition), leaving unresolvable files unmapped. A
 * suite whose failures map to no passed story exits the gate early.
 */
export function attributeAffectedStories(frame: RegressionFrame, gates: RegressionGates): AttributionOutcome {
  const affectedStories = new Set<string>();
  const affectedStoriesObjs = new Map<string, UserStory>();

  if (gates.testFilesInFailures.size === 0) {
    frame.logger?.warn("regression", "No test files found in failures (unmapped)");
  } else {
    const testFilesArray = Array.from(gates.testFilesInFailures);
    const snapshots = frame.options.storyMetrics ?? [];
    const passedById = new Map(frame.passedStories.map((s) => [s.id, s]));

    for (const testFile of testFilesArray) {
      // Attribute only with causal evidence: the story where this file first
      // transitioned to failing. A miss is left unresolved rather than guessed.
      const transitionId = frame.findTransition(testFile, snapshots);
      const responsibleStory = transitionId ? passedById.get(transitionId) : undefined;
      if (responsibleStory) {
        frame.logger?.info("regression", "Mapped test to story via gate transition", {
          storyId: transitionId,
          testFile,
        });
        affectedStories.add(responsibleStory.id);
        affectedStoriesObjs.set(responsibleStory.id, responsibleStory);
      } else {
        frame.logger?.warn("regression", "Could not safely map test file to a passed story", {
          testFile,
          ...(transitionId ? { transitionStoryId: transitionId } : {}),
        });
      }
    }
  }

  if (affectedStories.size === 0) {
    frame.logger?.warn("regression", "No stories could be mapped to failures");
    return {
      kind: "early",
      result: regressionResult({
        success: false,
        failedTests: gates.testFilesInFailures.size,
        failedTestFiles: Array.from(gates.testFilesInFailures),
        passedTests: gates.testSummary.passed,
        quarantineReport: gates.quarantineReport,
      }),
    };
  }

  return {
    kind: "mapped",
    outcome: {
      testFilesInFailures: gates.testFilesInFailures,
      quarantineReport: gates.quarantineReport,
      affectedStories,
      affectedStoriesObjs,
    },
  };
}

/**
 * Loop-carried rectification state. MUTATED IN PLACE by
 * {@link runRectificationLoop} — the caller reads the final values after the
 * loop for the confirmation result, so the object is never rebuilt.
 */
export interface RectificationState {
  rectificationAttempts: number;
  storiesRectified: number;
  currentTestOutput: string;
  storyCosts: Record<string, number>;
  storyDurations: Record<string, number>;
  storyOutcomes: Record<string, boolean>;
}

export function initialRectificationState(initialTestOutput: string): RectificationState {
  return {
    rectificationAttempts: 0,
    storiesRectified: 0,
    currentTestOutput: initialTestOutput,
    storyCosts: {},
    storyDurations: {},
    storyOutcomes: {},
  };
}

/**
 * The success-branch of {@link runRectificationLoop}: re-run the full suite
 * before touching the remaining stories, exiting the gate early when it passes
 * (a timeout counts as passing when `acceptOnTimeout` is set), otherwise
 * updating the forwarded test-output context for the next story's agent.
 * Returns the early-exit result, or `undefined` to continue the loop.
 */
async function checkEarlyExitAfterSuccess(
  frame: RegressionFrame,
  state: RectificationState,
  input: { story: UserStory; outcome: RegressionOutcomeInput },
): Promise<DeferredRegressionResult | undefined> {
  const { story, outcome } = input;

  // Early-exit check: re-run full suite before touching remaining stories
  frame.logger?.info("regression", "Re-running full suite after story rectification", {
    storyId: story.id,
    storiesRectified: state.storiesRectified,
    storiesRemaining: outcome.affectedStoriesObjs.size - state.storiesRectified,
  });

  const midResult = await frame.deps.runVerification(frame.verifyOpts);
  const midSuccess = midResult.success || (midResult.status === "TIMEOUT" && frame.acceptOnTimeout);

  if (midSuccess) {
    frame.logger?.info("regression", "Full suite passed after story rectification — early exit", {
      storyId: story.id,
      storiesRectified: state.storiesRectified,
      storiesSkipped: outcome.affectedStoriesObjs.size - state.storiesRectified,
      passCount: midResult.passCount ?? 0,
    });
    return regressionResult({
      success: true,
      failedTests: outcome.testFilesInFailures.size,
      failedTestFiles: Array.from(outcome.testFilesInFailures),
      passedTests: midResult.passCount ?? 0,
      rectificationAttempts: state.rectificationAttempts,
      affectedStories: Array.from(outcome.affectedStories),
      storyCosts: state.storyCosts,
      storyDurations: state.storyDurations,
      storyOutcomes: state.storyOutcomes,
      quarantineReport: outcome.quarantineReport,
    });
  }

  // Still failing — update test output context for the next story's agent
  frame.logger?.warn("regression", "Full suite still failing after story rectification — continuing", {
    storyId: story.id,
    failCount: midResult.failCount ?? 0,
    passCount: midResult.passCount ?? 0,
  });
  if (midResult.output) state.currentTestOutput = midResult.output;
  return undefined;
}

/**
 * Step 3: attempt rectification per affected story, with early-exit after each
 * success once a mid-loop re-run passes. Mutates `state` in place; returns the
 * early-exit result, or `undefined` to fall through to the final verification.
 */
export async function runRectificationLoop(
  frame: RegressionFrame,
  state: RectificationState,
  outcome: RegressionOutcomeInput,
): Promise<DeferredRegressionResult | undefined> {
  for (const story of outcome.affectedStoriesObjs.values()) {
    frame.logger?.info("regression", `Rectifying story ${story.id}`, {
      storyId: story.id,
      maxRectificationAttempts: frame.maxRectificationAttempts,
    });

    const storyStartMs = Date.now();
    const initialFindings = buildRegressionFindings(
      frame.deps.parseTestOutput(state.currentTestOutput),
      state.currentTestOutput,
    );
    const built = await frame.buildStoryCycle(story, initialFindings);

    let cycleResult: FixCycleResult<Finding>;
    try {
      cycleResult = await frame.deps.runFixCycle(built.cycle, built.cycleCtx, "regression");
    } finally {
      await built.dispose();
    }
    const succeeded = cycleResult.exitReason === "resolved";
    const cost = cycleResult.costUsd ?? 0;
    const durationMs = Date.now() - storyStartMs;
    state.rectificationAttempts += cycleResult.iterations.length > 0 ? cycleResult.iterations.length : 1;

    // Accumulate telemetry regardless of whether the cycle succeeded (issue #679).
    // Story outcome is latched true once any cycle succeeds; default false otherwise.
    state.storyCosts[story.id] = (state.storyCosts[story.id] ?? 0) + cost;
    state.storyDurations[story.id] = (state.storyDurations[story.id] ?? 0) + durationMs;
    if (!state.storyOutcomes[story.id]) {
      state.storyOutcomes[story.id] = succeeded;
    }

    if (succeeded) {
      state.storiesRectified++;
      frame.logger?.info("regression", `Story ${story.id} rectified successfully`);
      const earlyExit = await checkEarlyExitAfterSuccess(frame, state, { story, outcome });
      if (earlyExit) return earlyExit;
    }
  }

  return undefined;
}

/**
 * Step 4: re-run the full suite to confirm (reached only when no early exit
 * fired). A timeout counts as success when `acceptOnTimeout` is set.
 */
export async function runFinalVerification(
  frame: RegressionFrame,
  state: RectificationState,
  outcome: RegressionOutcomeInput,
): Promise<DeferredRegressionResult> {
  const { affectedStories, testFilesInFailures, quarantineReport } = outcome;

  frame.logger?.info("regression", "Re-running full suite after rectification");
  const retryResult = await frame.deps.runVerification(frame.verifyOpts);

  const success = retryResult.success || (retryResult.status === "TIMEOUT" && frame.acceptOnTimeout);

  if (success) {
    frame.logger?.info("regression", "Deferred regression gate passed after rectification");
  } else {
    frame.logger?.warn("regression", "Deferred regression gate still failing after rectification", {
      remainingFailures: retryResult.failCount,
    });
  }

  return regressionResult({
    success,
    failedTests: testFilesInFailures.size,
    failedTestFiles: Array.from(testFilesInFailures),
    passedTests: retryResult.passCount ?? 0,
    rectificationAttempts: state.rectificationAttempts,
    affectedStories: Array.from(affectedStories),
    storyCosts: state.storyCosts,
    storyDurations: state.storyDurations,
    storyOutcomes: state.storyOutcomes,
    quarantineReport,
  });
}
