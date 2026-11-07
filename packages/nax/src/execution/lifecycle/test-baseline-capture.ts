/**
 * Run-start baseline capture (US-002).
 *
 * Owns the harness-side capture step at the top of `runExecutionPhase`.
 * Delegates persistence to `writeRunBaseline` from
 * `src/verification/test-baseline.ts`; this module is the orchestration layer,
 * not the IO layer.
 *
 * Out of scope (see US-002 §Out of Scope): baseline types/classification
 * (US-001), attaching dispositions to gate findings (US-003), prompt
 * rendering (US-004). Parallel-mode re-capture after a dependency merge is
 * also out of scope — parallel stories inherit the run-start baseline.
 */

import { errorMessage } from "@nathapp/nax-agent/internal";
import type { NaxConfig } from "@/config";
import { getSafeLogger } from "@/logger";
import { resolveFullSuiteTimeoutSeconds, resolveQualityTestCommands } from "@/quality";
import { parseTestOutput, type TestSummary } from "@/test-runners";
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
 * _lockDeps — uses the same shape).
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
  resolveGateTimeoutSeconds: resolveFullSuiteTimeoutSeconds,
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

/** Write a `no-baseline` marker with the given reason. Single persistence seam for every degraded path. */
async function writeNoBaseline(
  root: string,
  featureId: string,
  reason: "gate-disabled" | "no-test-command" | "timeout" | "unparseable" | "error",
): Promise<void> {
  const baseline: TestBaseline = {
    kind: "no-baseline",
    reason,
    capturedAt: _captureDeps.now(),
  };
  await _captureDeps.writeRunBaseline(root, featureId, baseline);
  getSafeLogger()?.info("execution", "No run-start test baseline", { reason });
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
      await writeNoBaseline(opts.root, opts.featureId, "error");
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
    await writeNoBaseline(root, featureId, "gate-disabled");
    return;
  }

  // AC7 — no resolvable command, no spawn.
  const resolved = await _captureDeps.resolveTestCommands(config, workdir);
  if (resolved === undefined) {
    await writeNoBaseline(root, featureId, "no-test-command");
    return;
  }

  const commands = typeof resolved === "string" ? [resolved] : Array.from(resolved);
  const timeoutSeconds = _captureDeps.resolveGateTimeoutSeconds(config);
  const capturedAt = _captureDeps.now();
  const captureStartedAt = Date.now();

  getSafeLogger()?.info("execution", "Capturing run-start test baseline", { commands, timeoutSeconds });

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
    await writeNoBaseline(root, featureId, "error");
    return;
  }

  if (aggregateTimedOut) {
    await writeNoBaseline(root, featureId, "timeout");
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
  // (across every command in the list). Keyed on the named failures, not the
  // count: a parser that reads "990 failed" but names none would otherwise write
  // a captured baseline with no entries, and every pre-existing failure would
  // later be labelled as introduced.
  if (!aggregateSuccess && summary.failures.length === 0) {
    await writeNoBaseline(root, featureId, "unparseable");
    return;
  }

  if (summary.failures.length < summary.failed) {
    getSafeLogger()?.warn("execution", "Run-start test baseline names fewer failures than were counted", {
      failed: summary.failed,
      named: summary.failures.length,
    });
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
  getSafeLogger()?.info("execution", "Run-start test baseline captured", {
    durationMs: Date.now() - captureStartedAt,
    passed: summary.passed,
    failed: summary.failed,
    entries: summary.failures.length,
    baseRef,
  });
}
