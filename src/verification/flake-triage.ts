/**
 * Flake Triage — Run-Scoped Quarantine Classifier
 *
 * Decides whether each `failed-test` finding is a deterministic failure
 * (attributable to the story) or a transient flake (quarantined for the
 * remainder of the run). Composes the isolation probe (`flake-probe`) with
 * the baseline pre-existing-test check (story diff + source→test mapping)
 * and a run-scoped memo so the regression gate never re-probes a test
 * already judged flaky earlier in the run.
 *
 * Two-signal detection — both must agree:
 *   1. Baseline (cheap): test file is absent from the story diff and
 *      unmapped from any changed source file.
 *   2. Isolation probe (expensive): re-running the failing test in
 *      isolation produces at least one clean pass.
 *
 * Fail closed: any ambiguous or unprobeable outcome keeps the finding
 * blocking. All downstream branching discriminates on `category`, never
 * on `meta` — see src/findings/types.ts for the `meta` contract.
 */

import type { FlakeDetectionConfig } from "../config/runtime-types";
import type { Finding } from "../findings/types";
import { getSafeLogger } from "../logger";
import type { Framework } from "../test-runners/detector";
import type { TestFailure } from "../test-runners/types";
import { type FlakeProbeInput, runFlakeProbe } from "./flake-probe";

/** Run-scoped quarantine memo — shared across gates within a single run. */
export interface QuarantineMemo {
  has(key: string): boolean;
  add(key: string): void;
}

/** Diff context for the baseline pre-existing-test check. */
export interface FlakeTriageDiff {
  /** Test files changed in the story commit (absolute or workdir-relative). */
  changedTestFiles: readonly string[];
  /** Test files mapped from changed source files (absolute paths). */
  mappedTestFiles: readonly string[];
}

/** Wrapped probe input that carries the resolved flake-detection config. */
export interface FlakeProbeCall {
  failure: TestFailure;
  config: FlakeDetectionConfig;
  /** The underlying FlakeProbeInput the probe dependency will use. */
  probeInput: FlakeProbeInput;
}

export interface FlakeTriageInput {
  /** Findings to triage. Only `category: "failed-test"` findings are classified. */
  findings: readonly Finding[];
  /** Story diff context (changed files + mapped tests) for baseline check. */
  diff: FlakeTriageDiff;
  /** Resolved flake-detection config (execution.flakeDetection). */
  flakeDetection: FlakeDetectionConfig;
  /** Package's base test command (config.quality.commands.test). */
  baseCommand: string;
  /** Working directory for probe subprocesses. */
  cwd: string;
  /** Detected framework for the package under test. */
  framework: Framework;
  /** Run-scoped memo so re-probing is skipped for tests already quarantined. */
  quarantineMemo: QuarantineMemo;
}

/** Report of quarantined flakes for logging/events. */
export interface FlakeQuarantineReport {
  /** Memo keys of findings relabeled to flaky-test (in input order). */
  keys: string[];
  /** One short human-readable reason per skip/probe outcome. */
  reasons: string[];
}

export interface FlakeTriageResult {
  findings: Finding[];
  quarantineReport: FlakeQuarantineReport;
}

/** Stable identity for a failing test, used for the run-scoped memo. */
export function flakeMemoKey(failure: { file?: string; rule?: string }): string {
  return `${failure.file ?? ""}::${failure.rule ?? ""}`;
}

/** A no-op memo for callers that don't carry run-scoped state. */
export const NULL_QUARANTINE_MEMO: QuarantineMemo = {
  has: () => false,
  add: () => {},
};

/** Create a fresh, in-memory run-scoped quarantine memo. One per `NaxRuntime`. */
export function createQuarantineMemo(): QuarantineMemo {
  const keys = new Set<string>();
  return {
    has: (key) => keys.has(key),
    add: (key) => {
      keys.add(key);
    },
  };
}

/**
 * Injectable deps — overridable in tests via _flakeTriageDeps.
 *
 * The triage layer invokes `runFlakeProbe(call)` where `call` carries the
 * resolved `config` so callers (and tests) can observe it. The wrapped
 * `probeInput` holds the underlying `FlakeProbeInput` for the real probe.
 */
export const _flakeTriageDeps = {
  runFlakeProbe: async (call: FlakeProbeCall): Promise<Awaited<ReturnType<typeof runFlakeProbe>>> =>
    runFlakeProbe(call.probeInput),
};

/**
 * Classify each `failed-test` finding in `input.findings`. Confirmed flakes
 * are relabeled to `category: "flaky-test"` with `meta: { probeRuns, probePasses }`
 * and recorded in the returned quarantine report. All other findings pass
 * through unchanged. Non-`failed-test` findings pass through untouched.
 *
 * Returns a new findings array; the input is not mutated.
 */
export async function triageFlakyFindings(input: FlakeTriageInput): Promise<FlakeTriageResult> {
  const { findings, diff, flakeDetection, baseCommand, cwd, framework, quarantineMemo } = input;
  const logger = getSafeLogger();

  const result: Finding[] = [];
  const keys: string[] = [];
  const reasons: string[] = [];

  if (findings.length === 0) {
    return { findings: result, quarantineReport: { keys, reasons } };
  }

  if (!flakeDetection.enabled) {
    for (const f of findings) result.push({ ...f });
    return { findings: result, quarantineReport: { keys, reasons } };
  }

  // Build baseline sets once — used to skip probing for story-touched tests.
  // Normalize to basename so absolute paths from `mapSourceToTests` and
  // workdir-relative paths from `getChangedTestFiles` both compare cleanly.
  const changedTestSet = new Set(diff.changedTestFiles.map(basename));
  const mappedTestSet = new Set(diff.mappedTestFiles.map(basename));

  // Distinct pre-existing candidates that would be probed at this gate.
  const candidates = findings.filter((f) => isProbeCandidate(f, changedTestSet, mappedTestSet));

  if (candidates.length > flakeDetection.maxProbesPerGate) {
    logger?.info(
      "flake-triage",
      `Skipping flake triage — ${candidates.length} candidates exceed maxProbesPerGate=${flakeDetection.maxProbesPerGate}`,
    );
    reasons.push(`skipped: ${candidates.length} candidates exceed maxProbesPerGate=${flakeDetection.maxProbesPerGate}`);
    for (const f of findings) result.push({ ...f });
    return { findings: result, quarantineReport: { keys, reasons } };
  }

  for (const finding of findings) {
    const copy: Finding = { ...finding };

    if (copy.category !== "failed-test") {
      result.push(copy);
      continue;
    }

    const key = flakeMemoKey(copy);
    const eligibleForProbe = isProbeCandidate(copy, changedTestSet, mappedTestSet);

    // BUG-9: only honor the run-scoped quarantine memo when the finding would
    // also currently be eligible for probing. A story fix cycle can touch the
    // exact test file that was memoized flaky earlier in the run — once that
    // happens the baseline (story-diff) check must re-run, not be
    // short-circuited by a stale memo entry from before the edit.
    if (quarantineMemo.has(key) && eligibleForProbe) {
      copy.category = "flaky-test";
      keys.push(key);
      reasons.push(`quarantined (memo): ${key}`);
      result.push(copy);
      continue;
    }

    if (!eligibleForProbe) {
      result.push(copy);
      continue;
    }

    const failure: TestFailure = {
      file: copy.file ?? "unknown",
      testName: copy.rule ?? "",
      error: copy.message,
      stackTrace: [],
    };

    const probeInput: FlakeProbeInput = {
      framework,
      baseCommand,
      failure,
      cwd,
      probeRuns: flakeDetection.probeRuns,
      probeTimeoutSeconds: flakeDetection.probeTimeoutSeconds,
    };

    let verdict: Awaited<ReturnType<typeof runFlakeProbe>>;
    try {
      verdict = await _flakeTriageDeps.runFlakeProbe({ failure, config: flakeDetection, probeInput });
    } catch (err) {
      logger?.warn("flake-triage", `Probe dependency threw for ${key} — keeping finding blocking`, {
        file: copy.file,
        testName: copy.rule,
        error: err instanceof Error ? err.message : String(err),
      });
      // Probe crashed — fail closed, leave the finding blocking (AC10).
      result.push(copy);
      continue;
    }

    if (verdict.verdict === "flaky") {
      copy.category = "flaky-test";
      copy.meta = { ...(copy.meta ?? {}), probeRuns: verdict.probeRuns, probePasses: verdict.probePasses };
      quarantineMemo.add(key);
      keys.push(key);
      reasons.push(`quarantined: ${key}`);
    }
    // "consistent-failure" and "unprobeable" both keep category as failed-test.

    result.push(copy);
  }

  return { findings: result, quarantineReport: { keys, reasons } };
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function isProbeCandidate(finding: Finding, changedTestSet: Set<string>, mappedTestSet: Set<string>): boolean {
  if (finding.category !== "failed-test") return false;
  if (!finding.file || finding.file === "unknown") return false;
  if (!finding.rule) return false;
  const base = basename(finding.file);
  if (changedTestSet.has(base) || changedTestSet.has(finding.file)) return false;
  if (mappedTestSet.has(base) || mappedTestSet.has(finding.file)) return false;
  return true;
}
