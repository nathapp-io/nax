/**
 * Flake Probe — Isolation Re-Run Mechanic
 *
 * Re-runs a single failing test in isolation to decide whether the failure
 * is deterministic or transient. Returns a discriminated verdict that the
 * downstream triage layer (out of scope for this story) consumes to decide
 * whether to quarantine the failure or attribute it to the story.
 *
 * Why: pre-existing flaky tests in the target repo currently burn real money
 * and time — nax attributes the intermittent failure to the agent's change,
 * dispatches rectification fix cycles, escalates model tiers, and can fail
 * the regression gate — all for a failure the story did not cause.
 */

import { NaxError } from "../errors";
import type { Framework } from "../test-runners/detector";
import type { TestFailure } from "../test-runners/types";
import { executeWithTimeout } from "./executor";
import type { TestExecutionResult } from "./types";

export type FlakeProbeVerdict =
  | { verdict: "flaky"; probeRuns: number; probePasses: number }
  | { verdict: "consistent-failure"; probeRuns: number }
  | { verdict: "unprobeable"; reason: string };

export interface FlakeProbeInput {
  /** Detected test framework for the failing test. */
  framework: Framework;
  /** Package's base test command (from config.quality.commands.test). */
  baseCommand: string;
  /** The failing test to re-run in isolation. */
  failure: TestFailure;
  /** Working directory for the probe subprocess. */
  cwd: string;
  /** Number of probe runs to perform. */
  probeRuns: number;
  /** Per-probe timeout in seconds. */
  probeTimeoutSeconds: number;
}

/** Injectable deps for testability. */
export const _flakeProbeDeps = {
  execute: executeWithTimeout as (
    command: string,
    timeoutSeconds: number,
    env?: Record<string, string | undefined>,
    options?: { cwd?: string },
  ) => Promise<TestExecutionResult>,
};

/**
 * Escape regex metacharacters so the resulting filter selects the test name
 * literally instead of treating `(`, `?`, `.`, etc. as regex syntax.
 *
 * Used by both `-t <name>` (bun/jest/vitest) and `-run <name>` (go). pytest's
 * `<file>::<name>` addressing does not interpret the name as regex, so
 * `buildIsolationCommand` deliberately does NOT call escapeRegex on the pytest
 * path — the raw name is preserved.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build an isolation command for the failing test, scoped to its framework.
 *
 * - bun / jest / vitest: `<base> <file> -t <escaped name>`
 * - pytest: `<base> <file>::<name>` (raw name, no regex escaping — pytest
 *   uses `::` addressing, not regex)
 * - go: `<base> -run '^<escaped name>$'` (cwd scoped to the failing package)
 *
 * Unknown / unsupported frameworks are explicit failures rather than
 * silent fallthroughs — `runFlakeProbe` already rejects `framework === "unknown"`
 * before reaching here, so any other Framework value reaching this function
 * is a programming error and should be loud.
 */
export function buildIsolationCommand(baseCommand: string, failure: TestFailure, framework: Framework): string {
  const file = failure.file;
  const name = failure.testName;

  switch (framework) {
    case "pytest":
      return `${baseCommand} ${file}::${name}`;
    case "go":
      return `${baseCommand} -run '^${escapeRegex(name)}$'`;
    case "bun":
    case "jest":
    case "vitest":
      return `${baseCommand} ${file} -t ${escapeRegex(name)}`;
    default:
      throw new NaxError(
        `[flake-probe] unsupported framework: ${framework as string}`,
        "FLAKE_PROBE_UNSUPPORTED_FRAMEWORK",
        {
          stage: "verify",
          framework,
        },
      );
  }
}

/**
 * Run the isolation re-probe and return a discriminated verdict.
 *
 * Pass semantics: a probe run is a "pass" only when the executor reports
 * `countsTowardEscalation: true` AND `success: true` — i.e. the run produced
 * a clean, attributable test pass. Crashes (executor throws), environmental
 * failures (`countsTowardEscalation: false`), and timeouts all count as
 * failed probes. They are not code-failure signals we can attribute to the
 * story, so they neither confirm nor rule out flakiness — they only consume
 * a probe.
 */
export async function runFlakeProbe(input: FlakeProbeInput): Promise<FlakeProbeVerdict> {
  const { framework, baseCommand, failure, cwd, probeRuns, probeTimeoutSeconds } = input;

  // Unprobeable when either the file or framework can't be addressed.
  if (failure.file === "unknown" || framework === "unknown") {
    return {
      verdict: "unprobeable",
      reason:
        failure.file === "unknown" && framework === "unknown"
          ? "unknown file and framework"
          : failure.file === "unknown"
            ? "unknown file"
            : "unknown framework",
    };
  }

  const command = buildIsolationCommand(baseCommand, failure, framework);

  let probePasses = 0;
  for (let i = 0; i < probeRuns; i += 1) {
    let result: TestExecutionResult | undefined;
    try {
      result = await _flakeProbeDeps.execute(command, probeTimeoutSeconds, undefined, { cwd });
    } catch {
      // Executor crashed (e.g. spawn failure). Counts as a failed probe —
      // environmental, not an attributable flake signal.
      continue;
    }
    if (result.success && result.countsTowardEscalation) {
      probePasses += 1;
    }
  }

  if (probePasses > 0) {
    return { verdict: "flaky", probeRuns, probePasses };
  }
  return { verdict: "consistent-failure", probeRuns };
}
