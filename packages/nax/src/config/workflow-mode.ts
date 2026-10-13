/**
 * A5 workflow-mode normalisation (spec §4). Runs once on every fully merged config — the root
 * chain and each per-package overlay — so no layer can re-enable what workflow mode turns off.
 * Parallel is NOT a config key (it comes from the --parallel CLI flag); the runner forces it off.
 */
import { isWorkflowMode } from "./schemas-workflow";
import type { NaxConfig } from "./types";

export function applyWorkflowMode(config: NaxConfig, warn: (msg: string) => void): NaxConfig {
  if (!isWorkflowMode(config)) return config;
  const overridden: string[] = [];
  if (config.acceptance.enabled) overridden.push("acceptance.enabled=false");
  if (config.advisor && !config.advisor.enabled) overridden.push("advisor.enabled=true");
  // The workflow tree and its git reads sit in the main checkout (nax#2479), so stories share it.
  if (config.execution.storyIsolation === "worktree") overridden.push("execution.storyIsolation=shared");
  if (overridden.length === 0) return config;
  warn(`execution.mode "workflow" overrides: ${overridden.join(", ")}`);
  return {
    ...config,
    acceptance: { ...config.acceptance, enabled: false },
    execution: { ...config.execution, storyIsolation: "shared" },
    ...(config.advisor ? { advisor: { ...config.advisor, enabled: true } } : {}),
  };
}
