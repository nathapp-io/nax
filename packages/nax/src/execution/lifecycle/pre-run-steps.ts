/**
 * Blocking host-side pre-run steps (`execution.preRun`, US-003).
 *
 * Agent sessions are sandboxed: they cannot start the services a test suite
 * needs (a test database, a fixture server). `execution.preRun` declares the
 * setup commands the *host* runs instead — once per run, sequentially, from the
 * run workdir and before the run-start baseline and any story dispatch, so a
 * step that fails stops the run before anything is measured or attempted.
 *
 * The command string is passed verbatim to `/bin/sh -c` (`executeWithTimeout`),
 * because setup commands legitimately need shell features (pipes, redirects,
 * env substitution) — the same trust boundary as `quality.commands`. It
 * originates in `.nax/config.json`, a trusted file, and it is refused before
 * spawning unless a trust decision covers the workdir.
 *
 * No retries: a step is expected to be idempotent (`nax resume` runs it again)
 * and a failure is fail-closed.
 */

import type { PreRunStepConfig } from "@/config/runtime-types-execution";
import { NaxError } from "@/errors";
import { getSafeLogger } from "@/logger";
import { assertTrusted } from "@/trust";
import { executeWithTimeout, type TestExecutionResult } from "@/verification";

/** Characters of a failing step's output kept for the log line. */
const OUTPUT_TAIL_CHARS = 2000;

/** Run-scoped pseudo story id: pre-run steps belong to the run, not a story. */
const RUN_SCOPE_STORY_ID = "_run";

/**
 * Injectable dependencies. Tests replace `assertTrusted` / `executeWithTimeout`
 * to observe the spawn call and its arguments without launching a process, and
 * `now` to make `durationMs` deterministic.
 */
export const _preRunDeps = {
  assertTrusted,
  executeWithTimeout,
  now: (): number => Date.now(),
};

/** Options for {@link runPreRunSteps}. */
export interface RunPreRunStepsOptions {
  readonly steps: readonly PreRunStepConfig[];
  /** Run workdir (repo root) — the cwd every step runs from. */
  readonly workdir: string;
}

/**
 * Run every configured step in order, awaiting each.
 *
 * Throws `NaxError` code `PRE_RUN_FAILED` on the first step that exits
 * non-zero or times out; later steps do not run. No-op when `steps` is empty.
 */
export async function runPreRunSteps(opts: RunPreRunStepsOptions): Promise<void> {
  for (const step of opts.steps) {
    // "pre-run" is asserted before `executeWithTimeout`'s own "test-command"
    // check on the same cwd, so a refusal names the pre-run step rather than
    // the test surface the step happens to run through.
    await _preRunDeps.assertTrusted(opts.workdir, "pre-run");
    const startedAt = _preRunDeps.now();
    const result = await _preRunDeps.executeWithTimeout(step.command, step.timeoutSeconds, undefined, {
      cwd: opts.workdir,
    });
    const durationMs = _preRunDeps.now() - startedAt;

    if (result.success) {
      getSafeLogger()?.info("execution", "Pre-run step completed", {
        storyId: RUN_SCOPE_STORY_ID,
        command: step.command,
        exitCode: result.exitCode ?? 0,
        durationMs,
      });
      continue;
    }

    throw failStep(step, result, durationMs);
  }
}

/** Log the failing step at error level, then build the fail-closed error. */
function failStep(step: PreRunStepConfig, result: TestExecutionResult, durationMs: number): NaxError {
  const outputTail = (result.output ?? "").slice(-OUTPUT_TAIL_CHARS);
  const context = { stage: "execution", command: step.command, exitCode: result.exitCode };

  if (result.timeout) {
    getSafeLogger()?.error("execution", "Pre-run step failed", {
      storyId: RUN_SCOPE_STORY_ID,
      command: step.command,
      timedOut: true,
      timeoutSeconds: step.timeoutSeconds,
      durationMs,
      outputTail,
    });
    return new NaxError(
      `Pre-run step failed: ${step.command} (timed out after ${step.timeoutSeconds}s)`,
      "PRE_RUN_FAILED",
      context,
    );
  }

  getSafeLogger()?.error("execution", "Pre-run step failed", {
    storyId: RUN_SCOPE_STORY_ID,
    command: step.command,
    exitCode: result.exitCode,
    timedOut: false,
    durationMs,
    outputTail,
  });
  return new NaxError(
    `Pre-run step failed: ${step.command} (exit ${result.exitCode ?? "unknown"})`,
    "PRE_RUN_FAILED",
    context,
  );
}
