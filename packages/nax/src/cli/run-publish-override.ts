/**
 * `nax run --publish <mode>` → the `workflow` block of `cliOverrides` (US-001).
 *
 * Extracted from `bin/nax.ts` for the same reason as `run-context-overrides.ts`:
 * `bin/` is a CLI entry point with no unit test of its own and `../../` imports
 * are banned, so a mapping that lived inline there could not be tested at all.
 *
 * Only `workflow.publish` is set. The CLI layer deep-merges last
 * (`.nax/rules/config-patterns.md` → *Layering Order*), so every other configured
 * `workflow` key — `maxFixRounds`, `timeouts`, … — keeps its value for this run.
 *
 * The consulted list is `WORKFLOW_PUBLISH_MODES`, the same constant the config
 * schema's `publish` enum is built from, so the flag cannot accept a mode the
 * config would refuse.
 */

import { WORKFLOW_PUBLISH_MODES, type WorkflowPublishMode } from "@/config";

/** The `workflow` block of `cliOverrides`, `undefined` when the flag was not passed, or the refusal text. */
export type PublishCliOverride =
  | { readonly workflow: { readonly publish: WorkflowPublishMode } }
  | { readonly error: string };

/**
 * A recognised mode becomes `{ workflow: { publish } }`; an unset flag yields `undefined` so it
 * never replaces a configured value; anything else yields the refusal the CLI prints and exits on.
 */
export function resolvePublishCliOverride(value: string | undefined): PublishCliOverride | undefined {
  if (value === undefined) return undefined;
  const mode = WORKFLOW_PUBLISH_MODES.find((candidate) => candidate === value);
  if (mode === undefined) {
    const accepted = WORKFLOW_PUBLISH_MODES.join(", ");
    return { error: `nax run --publish must be one of ${accepted} (got "${value}")` };
  }
  return { workflow: { publish: mode } };
}
