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
import { resolveDefaultAgent } from "@/agents";
import { isWorkflowMode, NATIVE_AGENT_NAME, type NaxConfig } from "@/config";
import { loadProjectContextOverride } from "@/context/project-context-override";
import { createRuleDeliveryHandlers } from "@/context/rules/rule-delivery";
import { NaxError } from "@/errors";
import { getLogger } from "@/logger";

/**
 * US-007 — the one line a `mode: "replace"` run with a non-native default agent is told.
 *
 * `replace` is a native-session behaviour: no other agent goes through
 * `instructionOptionsForSession`, so no other agent can be told to skip the
 * repository's instruction files — saying so is the difference between an
 * operator believing the mode applied and knowing it did not.
 */
const REPLACE_NATIVE_ONLY =
  'context.projectContext.mode is "replace": the mode applies to native sessions only, and other agents still load the repository\'s own instruction files.';

export const _runRulesSetupDeps: {
  /** Directory existence probe for `context.rules.overrideDir`. */
  dirExists: (path: string) => Promise<boolean>;
  /** US-007 — the run's project-context file, read once at run start to validate it. */
  loadProjectContextOverride: typeof loadProjectContextOverride;
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
  loadProjectContextOverride,
  createRuleDeliveryHandlers,
};

/**
 * US-007 — validate `context.projectContext.file` and warn when `replace` cannot apply.
 *
 * The read is the validation: the loader throws
 * `PROJECT_CONTEXT_FILE_NOT_FOUND` / `PROJECT_CONTEXT_FILE_TOO_LARGE`, and both
 * must stop the run before any story starts rather than surfacing later as a
 * brief quietly missing its context. The warning comes after it, so a run that is
 * about to fail for a different reason is not also told about a mode it never
 * reached.
 */
async function validateProjectContext(config: NaxConfig): Promise<void> {
  const projectContext = config.context?.projectContext;
  if (projectContext?.file === undefined) return;
  await _runRulesSetupDeps.loadProjectContextOverride(config);
  if (projectContext.mode !== "replace") return;
  const agent = resolveDefaultAgent(config);
  if (agent === NATIVE_AGENT_NAME) return;
  getLogger().warn("run-setup", REPLACE_NATIVE_ONLY, { agent, file: projectContext.file });
}

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
  await validateProjectContext(input.config);
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
