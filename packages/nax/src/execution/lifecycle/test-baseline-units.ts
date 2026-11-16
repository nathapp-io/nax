/**
 * Per-package run-start baseline capture (US-004).
 *
 * In a monorepo the root test command runs through the workspace runner, which
 * prefixes every output line with the package name: the parser then names no
 * failure and a red suite degrades to `unparseable`. It also measures a
 * different command from the per-story test gate the baseline is compared
 * against. So when the run's pending stories span packages, each package is
 * captured on its own — with that package's gate switch, timeout and suite
 * command (`resolveSuiteTestCommand`, the same resolver the gate uses) — and
 * equivalent commands run once.
 *
 * This module owns:
 *   - `CaptureUnit` and the production unit resolver behind
 *     `_captureDeps.resolveUnit`;
 *   - the grouping of units that resolve to the same command, and the serial
 *     multi-unit capture loop;
 *   - the command-run and evidence primitives, which the single-package path in
 *     `test-baseline-capture.ts` imports so both paths time a command and
 *     evidence a degraded baseline identically (exactly two clock reads per
 *     attempted command).
 *
 * Import direction: `test-baseline-capture.ts` -> this module. The reverse edges
 * are type-only (`CaptureRunBaselineOptions`, `TestBaselineCaptureDeps`, the
 * parsed-summary shapes) and are erased, so there is no runtime import cycle.
 */

import { join, relative } from "node:path";
import { errorMessage, normalizeCommandSpec } from "@nathapp/nax-agent/internal";
import { getSafeLogger, redactSecrets } from "@/logger";
import { gateOutputTail } from "@/operations/gate-output-tail";
import { resolveSuiteTestCommand, type SuiteTestCommand } from "@/operations/suite-test-command";
import type { PackageRegistry } from "@/runtime";
import type { BaselineEntry, BaselineEvidence, TestBaseline } from "@/verification";
import type {
  CaptureParsedSummary,
  CaptureRunBaselineOptions,
  CaptureRunnerResult,
  NoBaselineReason,
  TestBaselineCaptureDeps,
} from "./test-baseline-capture";

/** Logged once per package the capture cannot measure. */
const SKIP_GATE_DISABLED = "Run-start test baseline skips a package with the regression gate disabled";
const SKIP_NO_COMMAND = "Run-start test baseline skips a package with no test command";

/** One failing test the parser named. */
export interface NamedFailure {
  readonly file: string;
  readonly testName: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture units
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One package the capture may measure: its gate switch, its gate timeout and —
 * only when the gate is enabled and a command resolves — the suite command.
 *
 * `packageDir` is repo-relative, `"."` for the repo root.
 */
export interface CaptureUnit {
  readonly packageDir: string;
  readonly gateEnabled: boolean;
  readonly timeoutSeconds: number;
  readonly command?: SuiteTestCommand;
}

/** Input of the production unit resolver (`_captureDeps.resolveUnit`). */
export interface UnitResolveInput {
  readonly packages: Pick<PackageRegistry, "resolve">;
  /** Absolute repo root — the anchor for every package path. */
  readonly root: string;
  /** Repo-relative package dir, `"."` for the repo root. */
  readonly packageDir: string;
}

/** The two config reads a unit needs, taken from `_captureDeps` so tests can stub them. */
type UnitPolicyDeps = Pick<TestBaselineCaptureDeps, "regressionGateEnabled" | "resolveGateTimeoutSeconds">;

/**
 * Resolve one package's capture unit.
 *
 * The gate switch, the timeout and the command all come from the same
 * package-merged config the gate itself reads, so the baseline can never
 * measure a command the gate does not run.
 */
export async function resolveCaptureUnit(input: UnitResolveInput, deps: UnitPolicyDeps): Promise<CaptureUnit> {
  const { packages, root, packageDir } = input;
  const view = packages.resolve(packageDir === "." ? undefined : packageDir);
  const gateEnabled = deps.regressionGateEnabled(view.config);
  const timeoutSeconds = deps.resolveGateTimeoutSeconds(view.config);
  if (!gateEnabled) return { packageDir, gateEnabled, timeoutSeconds };

  const command = await resolveSuiteTestCommand({
    packageView: view,
    workdir: packageDir === "." ? root : join(root, packageDir),
    packageDir: packageDir === "." ? undefined : packageDir,
  });
  return { packageDir, gateEnabled, timeoutSeconds, ...(command !== undefined ? { command } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Command runs and evidence (shared with the single-package path)
// ─────────────────────────────────────────────────────────────────────────────

/** One command the capture ran, with its own timing and outcome. */
export interface CommandRun {
  readonly command: string;
  /** Relative to the capture root; `"."` for the root itself. */
  readonly cwd: string;
  readonly durationMs: number;
  /** Absent when the runner threw. */
  readonly result?: CaptureRunnerResult;
  /** Set only when the runner threw. */
  readonly error?: unknown;
}

/** Root-relative cwd for the evidence — `"."` when the command ran at the root. */
export function relativeCwd(root: string, workdir: string): string {
  const rel = relative(root, workdir);
  return rel === "" ? "." : rel;
}

/** Bounded, redacted output tail; omitted entirely when the output was empty. */
function outputTailField(output: string): { outputTail?: string } {
  const tail = gateOutputTail(output);
  return tail === "" ? {} : { outputTail: tail };
}

/**
 * Turn one command run into persistable evidence. `command` and `error` are
 * redacted because `test-baseline.json` is committed; `outputTail` is redacted
 * and bounded by `gateOutputTail`. Absent values are absent keys, not
 * `undefined`.
 */
export function evidenceFor(run: CommandRun | undefined): BaselineEvidence | undefined {
  if (run === undefined) return undefined;
  return {
    command: redactSecrets(run.command),
    cwd: run.cwd,
    ...(run.result?.exitCode !== undefined ? { exitCode: run.result.exitCode } : {}),
    durationMs: run.durationMs,
    ...(run.result !== undefined ? outputTailField(run.result.output) : {}),
    ...(run.error !== undefined ? { error: redactSecrets(errorMessage(run.error)) } : {}),
  };
}

/** One command the loop ran, kept beside the summary its own output parsed to. */
export interface CommandOutcome {
  readonly run: CommandRun;
  readonly success: boolean;
  readonly parsed: CaptureParsedSummary;
}

/** What the per-command loop observed, in a shape the decision tree can read. */
export interface CaptureLoopOutcome {
  readonly parsedSummaries: readonly CaptureParsedSummary[];
  /** Every command that completed, in run order, each with its own parse. */
  readonly outcomes: readonly CommandOutcome[];
  /** The command that timed out, if one did. */
  readonly timedOut?: CommandRun;
  /** The command whose run threw, if one did. */
  readonly thrown?: CommandRun;
}

/**
 * The first command, in run order, that failed and whose parsed output named no
 * failure — the command that makes the whole baseline `unparseable`.
 *
 * Per command, deliberately: one failing command that does name its failures
 * must not hide another failing command that names none. A capture that kept
 * going would record the first command's failures only, and every pre-existing
 * failure of the second would later be labelled as introduced.
 */
export function unparseableFailure(outcome: CaptureLoopOutcome): CommandRun | undefined {
  return outcome.outcomes.find((command) => !command.success && command.parsed.failures.length === 0)?.run;
}

/**
 * The root path's rule, unchanged by this feature: the whole command list
 * degrades only when a command failed and no command in the list named a
 * failure, and the evidence is the first failing command in run order.
 *
 * Aggregate deliberately — spec US-004 keeps the root path exactly as today, so
 * `unparseableFailure`'s per-command rule applies to per-package groups only.
 * Lifting this masking defect out of the root path is a separate change.
 */
export function aggregateUnparseableFailure(outcome: CaptureLoopOutcome): CommandRun | undefined {
  if (outcome.parsedSummaries.some((summary) => summary.failures.length > 0)) return undefined;
  return outcome.outcomes.find((command) => !command.success)?.run;
}

/** One list of commands to run, from one directory, under one timeout. */
export interface CommandRunInput {
  readonly commands: readonly string[];
  readonly timeoutSeconds: number;
  /** Absolute directory the commands run in. */
  readonly workdir: string;
  /** Root-relative label recorded as the evidence `cwd`. */
  readonly cwd: string;
  readonly deps: TestBaselineCaptureDeps;
}

/**
 * Run every command independently, timing each one through `deps.clockMs` and
 * recording its outcome. A timed-out result or a runner throw stops the loop —
 * matches the gate's semantics: don't pollute the baseline with partial output
 * from commands that never ran.
 */
export async function runCaptureCommands(input: CommandRunInput): Promise<CaptureLoopOutcome> {
  const { commands, timeoutSeconds, workdir, cwd, deps } = input;
  let timedOut: CommandRun | undefined;
  let thrown: CommandRun | undefined;
  const outcomes: CommandOutcome[] = [];
  const parsedSummaries: CaptureParsedSummary[] = [];

  for (const command of commands) {
    const startedAt = deps.clockMs();
    let result: CaptureRunnerResult;
    try {
      result = await deps.runCommand(command, timeoutSeconds, workdir);
    } catch (err) {
      thrown = { command, cwd, durationMs: deps.clockMs() - startedAt, error: err };
      break;
    }

    const run: CommandRun = { command, cwd, durationMs: deps.clockMs() - startedAt, result };
    if (result.timedOut) {
      timedOut = run;
      break;
    }
    const parsed = deps.parseTestOutput(result.output);
    outcomes.push({ run, success: result.success, parsed });
    parsedSummaries.push(parsed);
  }

  return {
    parsedSummaries,
    outcomes,
    ...(timedOut ? { timedOut } : {}),
    ...(thrown ? { thrown } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouping
// ─────────────────────────────────────────────────────────────────────────────

/** One executed command list, and the packages it measures. */
interface CommandGroup {
  readonly cmdWorkdir: string;
  readonly commands: readonly string[];
  /** In unit order — the first one decides where the group sits in the run. */
  readonly packageDirs: string[];
  /** The largest timeout of the units in the group. */
  timeoutSeconds: number;
}

interface RunnableUnit {
  readonly unit: CaptureUnit;
  readonly command: SuiteTestCommand;
}

/**
 * Group the units that resolve to the same command.
 *
 * The key is `cmdWorkdir` plus the normalised command list, so `"x"` and
 * `["x"]` (the two spellings of the same command, nax#1990) share a group and
 * the command list runs once. Insertion order is unit order, so the groups run
 * in the order of their first package directory.
 */
function groupUnits(runnable: readonly RunnableUnit[]): CommandGroup[] {
  const groups = new Map<string, CommandGroup>();
  for (const { unit, command } of runnable) {
    const commands = normalizeCommandSpec(command.testCmd);
    const key = JSON.stringify([command.cmdWorkdir, commands]);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        cmdWorkdir: command.cmdWorkdir,
        commands,
        packageDirs: [unit.packageDir],
        timeoutSeconds: unit.timeoutSeconds,
      });
      continue;
    }
    existing.packageDirs.push(unit.packageDir);
    existing.timeoutSeconds = Math.max(existing.timeoutSeconds, unit.timeoutSeconds);
  }
  return [...groups.values()];
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-unit capture
// ─────────────────────────────────────────────────────────────────────────────

/** Persists and logs a `no-baseline` marker; owned by the capture module. */
export type NoBaselineWriter = (reason: NoBaselineReason, evidence?: BaselineEvidence) => Promise<void>;

export interface CapturePackageBaselinesInput {
  readonly opts: CaptureRunBaselineOptions;
  /** Repo-relative package dirs to capture, already distinct and sorted. */
  readonly packageDirs: readonly string[];
  readonly packages: Pick<PackageRegistry, "resolve">;
  readonly deps: TestBaselineCaptureDeps;
  readonly writeNoBaseline: NoBaselineWriter;
}

/** One group that ran, with the failures its parsed output named. */
interface CapturedGroup {
  readonly group: CommandGroup;
  readonly namedFailures: readonly NamedFailure[];
  readonly passed: number;
  readonly failed: number;
}

/**
 * Capture every package's suite and persist one package-scoped baseline.
 *
 * Units are resolved in order (a package's command is resolved before the next
 * package's is read), then grouped. Groups run serially; the capture time is
 * their sum. A degraded group stops the loop and writes its marker, exactly as
 * the single-package path does for a degraded command.
 */
export async function capturePackageBaselines(input: CapturePackageBaselinesInput): Promise<void> {
  const units = await resolveUnits(input);
  const runnable = logSkippedUnits(units);
  if (runnable.length === 0) {
    await input.writeNoBaseline(units.every((unit) => !unit.gateEnabled) ? "gate-disabled" : "no-test-command");
    return;
  }

  const capturedAt = input.deps.now();
  const captureStartedAt = Date.now();
  const captured: CapturedGroup[] = [];
  for (const group of groupUnits(runnable)) {
    const result = await runGroup(group, input);
    if (result === undefined) return; // a degraded marker was written; stop.
    captured.push(result);
  }
  await writeCaptured(input, captured, capturedAt, captureStartedAt);
}

async function resolveUnits(input: CapturePackageBaselinesInput): Promise<CaptureUnit[]> {
  const units: CaptureUnit[] = [];
  for (const packageDir of input.packageDirs) {
    units.push(await input.deps.resolveUnit({ packages: input.packages, root: input.opts.root, packageDir }));
  }
  return units;
}

/** Split the units into runnable pairs, logging each skip exactly once. */
function logSkippedUnits(units: readonly CaptureUnit[]): RunnableUnit[] {
  const runnable: RunnableUnit[] = [];
  for (const unit of units) {
    if (!unit.gateEnabled) {
      getSafeLogger()?.info("execution", SKIP_GATE_DISABLED, { packageDir: unit.packageDir });
      continue;
    }
    if (unit.command === undefined) {
      getSafeLogger()?.info("execution", SKIP_NO_COMMAND, { packageDir: unit.packageDir });
      continue;
    }
    runnable.push({ unit, command: unit.command });
  }
  return runnable;
}

/**
 * Run one group. Returns the captured outcome, or `undefined` when the group
 * degraded — in which case its `no-baseline` marker is already written and the
 * caller must stop.
 */
async function runGroup(group: CommandGroup, input: CapturePackageBaselinesInput): Promise<CapturedGroup | undefined> {
  const { opts, deps, writeNoBaseline } = input;
  const outcome = await runCaptureCommands({
    commands: group.commands,
    timeoutSeconds: group.timeoutSeconds,
    workdir: group.cmdWorkdir,
    cwd: relativeCwd(opts.root, group.cmdWorkdir),
    deps,
  });

  if (outcome.thrown !== undefined) {
    await writeNoBaseline("error", evidenceFor(outcome.thrown));
    return undefined;
  }
  if (outcome.timedOut !== undefined) {
    await writeNoBaseline("timeout", evidenceFor(outcome.timedOut));
    return undefined;
  }

  const namedFailures = outcome.parsedSummaries.flatMap((summary) => summary.failures);
  // Per command, not per group: a command that read "990 failed" but named none
  // would otherwise ride on another command's named failures, and every
  // pre-existing failure it counted would later be labelled as introduced. The
  // evidence names that command, not the group's first failure.
  const unparseable = unparseableFailure(outcome);
  if (unparseable !== undefined) {
    await writeNoBaseline("unparseable", evidenceFor(unparseable));
    return undefined;
  }

  return {
    group,
    namedFailures,
    passed: sumBy(outcome.parsedSummaries, (summary) => summary.passed),
    failed: sumBy(outcome.parsedSummaries, (summary) => summary.failed),
  };
}

function sumBy<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((sum, item) => sum + pick(item), 0);
}

/**
 * Persist the captured baseline: one entry per named failure per package the
 * group measured, and `packageDirs` naming exactly the packages that ran — a
 * package skipped here is absent, so the gate leaves its findings unattributed
 * rather than measuring them against another package's failures.
 */
async function writeCaptured(
  input: CapturePackageBaselinesInput,
  captured: readonly CapturedGroup[],
  capturedAt: string,
  captureStartedAt: number,
): Promise<void> {
  const { opts, deps } = input;
  const entries: BaselineEntry[] = [];
  for (const { group, namedFailures } of captured) {
    for (const packageDir of group.packageDirs) {
      for (const failure of namedFailures) entries.push(entryFor(failure, packageDir));
    }
  }

  const packageDirs = [...new Set(captured.flatMap(({ group }) => group.packageDirs))].sort();
  const baseRef = await deps.captureGitRef(opts.root);
  const baseline: TestBaseline = {
    kind: "captured",
    source: "preflight",
    capturedAt,
    baseRef,
    packageDirs,
    entries,
  };
  await deps.writeRunBaseline(opts.root, opts.featureId, baseline);
  getSafeLogger()?.info("execution", "Run-start test baseline captured", {
    durationMs: Date.now() - captureStartedAt,
    passed: sumBy(captured, (group) => group.passed),
    failed: sumBy(captured, (group) => group.failed),
    entries: entries.length,
    packageDirs,
    baseRef,
  });
}

/** One baseline entry. The root package (".") carries no `packageDir` key. */
function entryFor(failure: NamedFailure, packageDir: string): BaselineEntry {
  return {
    file: failure.file,
    testName: failure.testName,
    ...(packageDir === "." ? {} : { packageDir }),
  };
}
