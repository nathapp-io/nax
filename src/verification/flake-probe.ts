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
import { getSafeLogger } from "../logger";
import type { Framework } from "../test-runners/detector";
import type { TestFailure } from "../test-runners/types";
import { executeWithTimeout } from "./executor";
import type { TestExecutionResult } from "./types";

// Frameworks that exit 0 for "zero tests matched the isolation filter" (primarily `go
// test -run '^Name$'` when the name doesn't round-trip the filter) need this check so an
// undetectable-but-still-failing test isn't declared "flaky" from a probe that never ran
// it. Conservative on purpose: only the well-known zero-match phrasing counts, so a
// framework whose real failure output happens to differ isn't misclassified as clean.
const NO_TESTS_EXECUTED_MARKERS = [/no tests? to run/i, /^ran 0 tests?/im];

function probeRanNoTests(output: string | undefined): boolean {
  if (!output) return false;
  return NO_TESTS_EXECUTED_MARKERS.some((re) => re.test(output));
}

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
 * Single-quote a value for safe interpolation into a shell command string
 * (executed via `[shell, "-c", command]` — see `executeWithTimeout`). Wraps in
 * single quotes and escapes any embedded `'` using the standard
 * close-quote/escaped-quote/reopen-quote trick: `'` -> `'\''`.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Build an isolation command for the failing test, scoped to its framework.
 *
 * - bun / jest / vitest: `<base> <quoted file> -t '<escaped name>'`
 * - pytest: `<base> '<file>::<name>'` (raw name, no regex escaping — pytest
 *   uses `::` addressing, not regex; still shell-quoted as a whole node id)
 * - go: `<base> -run '^<escaped name>$'` (cwd scoped to the failing package)
 *
 * Filter values — and, for bun/jest/vitest, the file path — are
 * single-quoted (`shellQuote`) because the command is ultimately executed
 * through a shell (`[shell, "-c", command]`) — an unquoted test name or file
 * path containing whitespace (or shell metacharacters, since both originate
 * from parsed output of an arbitrary target repo) would be word-split or
 * interpreted, silently matching the wrong test or reaching the shell
 * (SEC-4). pytest and go already quote their whole node id / filter.
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
      return `${baseCommand} ${shellQuote(`${file}::${name}`)}`;
    case "go":
      return `${baseCommand} -run ${shellQuote(`^${escapeRegex(name)}$`)}`;
    case "bun":
    case "jest":
    case "vitest":
      return `${baseCommand} ${shellQuote(file)} -t ${shellQuote(escapeRegex(name))}`;
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
 * Pass semantics: a probe run is an attributable "pass" only when the
 * executor reports `countsTowardEscalation: true` AND `success: true` (and
 * didn't merely match zero tests) — i.e. the run produced a clean,
 * attributable test pass. A probe run is an attributable "fail" when the
 * executor reports `countsTowardEscalation: true` AND `success: false` —
 * i.e. the target repo's own test runner genuinely ran the test and it
 * failed.
 *
 * Environmental / non-attributable outcomes — executor crashes (throw),
 * `countsTowardEscalation: false` (which also covers timeouts, since the
 * executor always sets `countsTowardEscalation: false` on timeout) — are
 * NOT code-failure signals we can attribute to the story: they consume a
 * probe slot but confirm nothing. Per D-5 (docs/reviews/2026-08-14-deep-code-review.md),
 * if every probe run in the budget was environmental, the verdict must be
 * `"unprobeable"` (never `"consistent-failure"`), so an unattributable
 * signal never fails a story. The reason is logged so operators can see why
 * a probe was inconclusive (BUG-8).
 */
export async function runFlakeProbe(input: FlakeProbeInput): Promise<FlakeProbeVerdict> {
  const { framework, baseCommand, failure, cwd, probeRuns, probeTimeoutSeconds } = input;
  const logger = getSafeLogger();

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
  let attributableRuns = 0;
  for (let i = 0; i < probeRuns; i += 1) {
    let result: TestExecutionResult | undefined;
    try {
      result = await _flakeProbeDeps.execute(command, probeTimeoutSeconds, undefined, { cwd });
    } catch {
      // Executor crashed (e.g. spawn failure) — environmental, not an
      // attributable pass or fail. Consumes a probe slot only.
      continue;
    }
    if (!result.countsTowardEscalation) {
      // Environmental (includes timeouts, which always set this false) —
      // not an attributable pass or fail.
      continue;
    }
    if (probeRanNoTests(result.output)) {
      // Zero tests matched the isolation filter — the probe never actually
      // executed the target test (e.g. Go rewrites spaces to underscores in
      // -run patterns, so a filter built from a space-containing subtest
      // name matches nothing). This run confirms nothing either way, so it
      // must not count toward attributableRuns — counting it would let a
      // batch of all-zero-matched runs read as "consistent-failure" (BUG-8),
      // directly contradicting the unattributable-never-fails-a-story
      // contract above.
      continue;
    }
    attributableRuns += 1;
    if (result.success) {
      probePasses += 1;
    }
  }

  if (attributableRuns === 0) {
    const reason = `all ${probeRuns} probe run(s) were environmental (executor crash, timeout, or non-attributable) — no attributable pass or fail`;
    logger?.warn("flake-probe", `Unprobeable — ${reason}`, {
      file: failure.file,
      testName: failure.testName,
      probeRuns,
    });
    return { verdict: "unprobeable", reason };
  }

  if (probePasses > 0) {
    return { verdict: "flaky", probeRuns, probePasses };
  }
  return { verdict: "consistent-failure", probeRuns };
}
