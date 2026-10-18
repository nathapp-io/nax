/**
 * Run-start configuration of the rule-delivery loop handlers (US-002).
 *
 * `initializeAfterLock` loads the run's plugins and hands their loop handlers to
 * the run's session manager. That call site is also the only place that runs
 * after the config and the workdir are both resolved but before any story
 * starts, so it is where the run-level rules override is validated: an
 * `overrideDir` the operator asked for but that is not a directory must fail the
 * run rather than quietly deliver the repo's rules alone.
 *
 * All of that branching lives here on purpose. `initializeAfterLock` is
 * baselined at complexity 21 (`scripts/baselines/complexity-baseline.json`) and
 * `bun run check:complexity` allows no growth, so the call site stays a single
 * expression:
 *
 *     runtime.sessionManager.configureLoopHandlers(
 *       await configureRunRules({ config, workdir, pluginHandlers: registry.getLoopHandlers() }),
 *     );
 *
 * Later stories extend this module, not that call site: US-005 appends the
 * native rule-delivery handlers to the returned set, and US-007 adds the
 * project-context file checks.
 */

import { stat } from "node:fs/promises";
import type { LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { isWorkflowMode, type NaxConfig } from "@/config";
import { createRuleDeliveryHandlers } from "@/context/rules/rule-delivery";
import { NaxError } from "@/errors";

export const _runRulesSetupDeps: {
  /** Directory existence probe for `context.rules.overrideDir`. */
  dirExists: (path: string) => Promise<boolean>;
  /** US-005 — the native rule-delivery handlers the run registers. */
  createRuleDeliveryHandlers: typeof createRuleDeliveryHandlers;
} = {
  /**
   * Deliberately not `Bun.file(dir).exists()`: that reports `false` for a
   * directory, which would make every configured `overrideDir` look missing.
   * The same reasoning as `directoryExists` in `src/context/fragments/store.ts`.
   */
  dirExists: async (path: string): Promise<boolean> => {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  createRuleDeliveryHandlers,
};

/** Validates both overrides (throws before returning); returns the set for configureLoopHandlers. */
export async function configureRunRules(input: {
  config: NaxConfig;
  workdir: string;
  pluginHandlers: LoopHandlerSet;
}): Promise<LoopHandlerSet> {
  // Defensive reads: a sparse test config, or a config object assembled before
  // this key existed, must not throw here — same shape as the `context?.v2?.`
  // reads elsewhere.
  const overrideDir = input.config.context?.rules?.overrideDir;
  if (overrideDir !== undefined && !(await _runRulesSetupDeps.dirExists(overrideDir))) {
    throw new NaxError(`context.rules.overrideDir is not a directory: ${overrideDir}`, "RULES_OVERRIDE_DIR_NOT_FOUND", {
      stage: "run-setup",
      overrideDir,
    });
  }
  return withRuleDeliveryHandlers(input.config, input.workdir, input.pluginHandlers, overrideDir);
}

/**
 * US-005 — append the native rule-delivery handlers to the plugin set.
 *
 * Two conditions gate the append. Under `context.rules.delivery: "push"` the
 * brief carries every rule body again, so a handler would deliver the same text
 * a second time; in pipeline mode nothing runs the native loop these handlers
 * belong to. In both cases the plugin registry's own set is returned by
 * identity, which is what US-002 pinned.
 *
 * The append is deliberately AFTER the plugin entries: `dispatchBeforeTool`
 * keeps the last nudge, so a plugin that nudges a governed call cannot suppress
 * the rule text — and a plugin block still short-circuits the chain, because a
 * block is the dispatcher's verdict rather than a chained decision.
 */
function withRuleDeliveryHandlers(
  config: NaxConfig,
  workdir: string,
  pluginHandlers: LoopHandlerSet,
  overrideDir: string | undefined,
): LoopHandlerSet {
  if (!isWorkflowMode(config)) return pluginHandlers;
  if ((config.context?.rules?.delivery ?? "index") !== "index") return pluginHandlers;
  const handlers = _runRulesSetupDeps.createRuleDeliveryHandlers({
    repoRoot: workdir,
    ...(overrideDir !== undefined && { overrideDir }),
    overrideMode: config.context?.rules?.overrideMode ?? "merge",
  });
  return [...pluginHandlers, ...handlers];
}
