/**
 * A5 workflow-mode normalisation (spec §4). Runs once on every fully merged config — the root
 * chain and each per-package overlay — so no layer can re-enable what workflow mode turns off.
 * Workflow mode forces the advisor on and nothing else: parallel is not a config key (it comes
 * from the --parallel CLI flag, and the runner forces it off), and story isolation has no
 * worktree mode left to turn off (US-004 removed those execution paths).
 */
import type { NaxConfig } from "./types";

export function applyWorkflowMode(config: NaxConfig): NaxConfig {
  // Forcing the advisor on is silent: advisor-off is the shipped default, so a warning here
  // would fire on every default run.
  if (config.advisor === undefined || config.advisor.enabled) return config;
  return { ...config, advisor: { ...config.advisor, enabled: true } };
}
