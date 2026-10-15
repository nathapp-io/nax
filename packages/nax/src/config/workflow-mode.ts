/**
 * A5 workflow-mode normalisation (spec §4). Runs once on every fully merged config — the root
 * chain and each per-package overlay — so no layer can re-enable what workflow mode turns off.
 * Parallel is NOT a config key (it comes from the --parallel CLI flag); the runner forces it off.
 */
import { isWorkflowMode } from "./schemas-workflow";
import type { NaxConfig } from "./types";

/** Root-chain only, so a run warns once rather than once per package overlay. */
export function warnDeprecatedPipelineMode(config: NaxConfig, warn: (msg: string) => void): void {
  if (config.execution.mode !== "pipeline") return;
  warn(
    'execution.mode "pipeline" is deprecated and will be removed in a future release; "workflow" is now the default. Remove execution.mode or set it to "workflow".',
  );
}

export function applyWorkflowMode(config: NaxConfig, warn: (msg: string) => void): NaxConfig {
  if (!isWorkflowMode(config)) return config;
  const forceAcceptanceOff = config.acceptance.enabled;
  const forceAdvisorOn = config.advisor !== undefined && !config.advisor.enabled;
  // The workflow tree and its git reads sit in the main checkout (nax#2479), so stories share it.
  const forceShared = config.execution.storyIsolation === "worktree";
  if (!forceAcceptanceOff && !forceAdvisorOn && !forceShared) return config;
  // Workflow is the default mode and acceptance-on / advisor-off are the shipped defaults, so
  // forcing them is silent; warning would fire on every default run. Only worktree isolation,
  // which is never the default, is named.
  if (forceShared) warn('execution.mode "workflow" overrides: execution.storyIsolation=shared');
  return {
    ...config,
    acceptance: { ...config.acceptance, enabled: false },
    execution: { ...config.execution, storyIsolation: "shared" },
    ...(config.advisor ? { advisor: { ...config.advisor, enabled: true } } : {}),
  };
}
