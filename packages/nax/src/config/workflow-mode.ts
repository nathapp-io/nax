/**
 * A5 workflow-mode normalisation (spec §4). Runs once on every fully merged config — the root
 * chain and each per-package overlay — so no layer can re-enable what workflow mode turns off.
 * Parallel is NOT a config key (it comes from the --parallel CLI flag); the runner forces it off.
 */
import type { NaxConfig } from "./types";

export function applyWorkflowMode(config: NaxConfig, warn: (msg: string) => void): NaxConfig {
  const forceAdvisorOn = config.advisor !== undefined && !config.advisor.enabled;
  // The workflow tree and its git reads sit in the main checkout (nax#2479), so stories share it.
  const forceShared = config.execution.storyIsolation === "worktree";
  if (!forceAdvisorOn && !forceShared) return config;
  // Workflow is the default mode and advisor-off is the shipped default, so forcing it is
  // silent; warning would fire on every default run. Only worktree isolation, which is never
  // the default, is named.
  if (forceShared) warn('execution.mode "workflow" overrides: execution.storyIsolation=shared');
  return {
    ...config,
    execution: { ...config.execution, storyIsolation: "shared" },
    ...(config.advisor ? { advisor: { ...config.advisor, enabled: true } } : {}),
  };
}
