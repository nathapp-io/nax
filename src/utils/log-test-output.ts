import type { Logger } from "../logger";

/**
 * Log test output consistently across all pipeline stages.
 *
 * Summary (exitCode, storyId) is logged at the caller's level (error/warn).
 * Raw output is logged at debug level only — last `tailLines` lines.
 *
 * `storyId` is optional: works for per-story verify/acceptance AND for
 * deferred runs (deferred acceptance, deferred regression) with no story context.
 */
export function logTestOutput(
  logger: Logger | null | undefined,
  stage: string,
  output: string | undefined,
  opts: { storyId?: string; tailLines?: number } = {},
): void {
  if (!logger || !output) return;
  const tailLines = opts.tailLines ?? 20;
  const lines = output.split("\n").slice(-tailLines).join("\n");
  logger.debug(stage, "Test output (tail)", {
    ...(opts.storyId !== undefined && { storyId: opts.storyId }),
    output: lines,
  });
}
