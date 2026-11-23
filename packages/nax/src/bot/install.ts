/**
 * The derived frozen install, with the ordered lockfile fallbacks a repo that
 * carries more than one lockfile needs (US-001).
 *
 * `checks.preRun` runs first. A `PRE_RUN_FAILED` there is not fatal while the
 * chosen lockfile has frozen alternatives: each is tried once, in order, so a
 * stale lockfile (a `bun.lock` beside the `package-lock.json` the repository
 * actually uses) costs one failed attempt instead of the whole setup. Anything
 * else — a trust refusal, a spawn failure — propagates at once, and every
 * command attempted is reported when the last one fails.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { PreRunStepConfig } from "@/config/runtime-types-execution";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";
import type { runPreRunSteps } from "../execution/lifecycle/pre-run-steps";
import type { BotChecks } from "./checks";

const PRE_RUN_FAILED = "PRE_RUN_FAILED";

/** Only `PRE_RUN_FAILED` names a step this wrapper may retry; everything else is fatal as-is. */
function preRunFailure(error: unknown): NaxError | undefined {
  return error instanceof NaxError && error.code === PRE_RUN_FAILED ? error : undefined;
}

/** The command the failure names, or the step that was asked to run. */
function attemptedCommand(failure: NaxError, steps: readonly PreRunStepConfig[]): string {
  const command = failure.context?.command;
  if (typeof command === "string") return command;
  return steps[0]?.command ?? "unknown";
}

/**
 * The checks to run the rest of the command with: unchanged when the setup that
 * ran is the one they already name, so a command that needed no fallback keeps
 * the checks object its steps came from.
 */
export function withRanSteps(checks: BotChecks, ran: readonly PreRunStepConfig[]): BotChecks {
  return ran === checks.preRun ? checks : { ...checks, preRun: ran };
}

/**
 * Run `checks.preRun`, then each of `checks.install.fallbacks` once, in order,
 * until one succeeds. Reports the steps that actually ran.
 */
export async function runBotInstall(
  checks: BotChecks,
  workdir: string,
  run: typeof runPreRunSteps,
): Promise<{ ran: readonly PreRunStepConfig[] }> {
  try {
    await run({ steps: checks.preRun, workdir });
    return { ran: checks.preRun };
  } catch (error) {
    const failure = preRunFailure(error);
    const fallbacks = checks.install?.fallbacks ?? [];
    if (failure === undefined || fallbacks.length === 0) throw error;
    return runFallbacks(fallbacks, workdir, run, failure, attemptedCommand(failure, checks.preRun));
  }
}

async function runFallbacks(
  fallbacks: readonly PreRunStepConfig[],
  workdir: string,
  run: typeof runPreRunSteps,
  firstFailure: NaxError,
  firstCommand: string,
): Promise<{ ran: readonly PreRunStepConfig[] }> {
  const tried = [firstCommand];
  let failure = firstFailure;
  for (const step of fallbacks) {
    const failed = tried[tried.length - 1];
    getLogger().warn("bot", `[WARN] ${failed} failed; trying ${step.command}`, {
      command: failed,
      next: step.command,
      error: errorMessage(failure),
    });
    try {
      await run({ steps: [step], workdir });
      return { ran: [step] };
    } catch (error) {
      const cause = preRunFailure(error);
      if (cause === undefined) throw error;
      failure = cause;
      tried.push(attemptedCommand(cause, [step]));
    }
  }
  throw new NaxError(`[bot] Every frozen install failed: ${tried.join(", ")}`, PRE_RUN_FAILED, {
    stage: "bot",
    command: firstCommand,
    tried,
    cause: failure,
  });
}
