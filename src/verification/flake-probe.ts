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
 * `<file>::<name>` address doesn't interpret the name as regex, but we still
 * pass it through for consistency / defense-in-depth.
 */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build an isolation command for the failing test, scoped to its framework.
 *
 * - bun / jest / vitest: `<base> <file> -t <escaped name>`
 * - pytest: `<base> <file>::<name>`
 * - go: `<base> -run '^<escaped name>$'` (cwd scoped to the failing package)
 */
export function buildIsolationCommand(baseCommand: string, failure: TestFailure, framework: Framework): string {
  const file = failure.file;
  const name = failure.testName;

  if (framework === "pytest") {
    return `${baseCommand} ${file}::${name}`;
  }
  if (framework === "go") {
    return `${baseCommand} -run '^${escapeRegex(name)}$'`;
  }
  // bun / jest / vitest share the `-t <name>` shape
  return `${baseCommand} ${file} -t ${escapeRegex(name)}`;
}

/**
 * Run the isolation re-probe and return a discriminated verdict.
 *
 * Pass semantics: a probe run is a "pass" only on `success && !timeout` —
 * crashes, environmental failures, and timeouts all count as failed probes
 * (they're not code-failure signals we can attribute to the story).
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
    const result = await _flakeProbeDeps.execute(command, probeTimeoutSeconds, undefined, { cwd });
    if (result.success && !result.timeout) {
      probePasses += 1;
    }
  }

  if (probePasses > 0) {
    return { verdict: "flaky", probeRuns, probePasses };
  }
  return { verdict: "consistent-failure", probeRuns };
}
