import type { NaxConfig } from "../config/runtime-types";
import { configureRunRules } from "../execution/lifecycle/run-rules-setup";
import { assertDefaultNativeCredentials } from "../execution/lifecycle/run-setup-warnings";
import type { NaxRuntime } from "../runtime/index";

export const _botRunSetupDeps = { assertDefaultNativeCredentials, configureRunRules };

/** Pre-flight credentials and install checkout-scoped rule delivery without plugins. */
export async function setupBotRuntime(runtime: NaxRuntime, config: NaxConfig, worktree: string): Promise<void> {
  await runtime.agentManager.validateCredentials();
  await _botRunSetupDeps.assertDefaultNativeCredentials(config);
  runtime.sessionManager.configureLoopHandlers(
    await _botRunSetupDeps.configureRunRules({ config, workdir: worktree, pluginHandlers: [] }),
  );
}
