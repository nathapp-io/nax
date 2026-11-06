import { type PRD, pendingStoryIds } from "../prd";

/** The `nax run` flags `--publish-only` (#2819) cannot be combined with. */
export interface PublishOnlyRunFlags {
  readonly feature: string;
  readonly publishOnly?: boolean;
  readonly plan?: boolean;
  readonly compare?: string;
  readonly dryRun?: boolean;
}

/**
 * Why `--publish-only` cannot run (#2819), or undefined when it can (or was not asked for). It
 * reruns only the publish step, so it needs every story passed and no flag that plans, compares
 * or skips the workflow.
 */
export function publishOnlyRefusal(options: PublishOnlyRunFlags, prd: PRD): string | undefined {
  if (options.publishOnly !== true) return undefined;
  const clash = options.plan ? "--plan" : options.compare ? "--compare" : options.dryRun ? "--dry-run" : undefined;
  if (clash) return `--publish-only cannot be combined with ${clash}`;
  const pending = pendingStoryIds(prd).length;
  if (pending === 0) return undefined;
  const noun = pending === 1 ? "story" : "stories";
  return `--publish-only needs every story passed: ${pending} ${noun} still pending; run nax run -f ${options.feature} first`;
}
