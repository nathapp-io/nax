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
import type { NaxConfig } from "@/config";
import { NaxError } from "@/errors";

export const _runRulesSetupDeps: {
  /** Directory existence probe for `context.rules.overrideDir`. */
  dirExists: (path: string) => Promise<boolean>;
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
  return input.pluginHandlers;
}
