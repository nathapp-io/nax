/**
 * Agent hooks loader — the non-throwing seam chat (and, later, a run) reaches
 * the factory through.
 *
 * Two responsibilities, both of them the reason this is a module rather than
 * two lines at the call site:
 *
 *   - **Where the config lives.** The project file is `<repoRoot>/.nax/hooks.json`
 *     and the global one sits in `globalConfigDir()`; `loadAgentHooksConfig`
 *     takes those two directories, not file paths.
 *   - **It never rejects.** `hooks.json` is user-edited text holding shell
 *     commands, so a broken file, an unreadable directory or a factory that
 *     throws must not be able to stop a chat session or a run. An unexpected
 *     throw yields an EMPTY set plus one `agent-hooks` warning: the surface
 *     runs without its hooks, which is exactly how it behaved before this
 *     feature existed.
 *
 * The config is read once when the surface starts, not per turn — the caller
 * owns that lifetime, and these handlers keep the entries they were built from.
 */

import { join } from "node:path";
import { errorMessage, type LoopHandlerSet } from "@nathapp/nax-agent/internal";
import { globalConfigDir, PROJECT_NAX_DIR } from "@/config";
import { getLogger } from "@/logger";
import { AGENT_HOOKS_STAGE } from "./common";
import { loadAgentHooksConfig } from "./config";
import { createAgentHookHandlers } from "./handlers";
import type { AgentHookSurface } from "./types";

/**
 * Injectable for tests; read at call time, never captured at import.
 * `globalConfigDir` is a function so the isolated test environment's override
 * is honoured at the moment the surface starts.
 */
export const _loadAgentHookDeps: {
  loadAgentHooksConfig: typeof loadAgentHooksConfig;
  globalDir: () => string;
} = { loadAgentHooksConfig, globalDir: globalConfigDir };

/**
 * Read the agent hooks config and build one surface's handler set.
 *
 * @param input.surface - Which surface's entries to build (`chat` or `run`)
 * @param input.repoRoot - Repository root; the project file is `<repoRoot>/.nax`
 * @returns The surface's handler set, empty when nothing applies or on failure
 */
export async function loadAgentHookHandlers(input: {
  readonly surface: AgentHookSurface;
  readonly repoRoot: string;
}): Promise<LoopHandlerSet> {
  try {
    const config = await _loadAgentHookDeps.loadAgentHooksConfig(
      join(input.repoRoot, PROJECT_NAX_DIR),
      _loadAgentHookDeps.globalDir(),
    );
    return createAgentHookHandlers({ config, surface: input.surface, repoRoot: input.repoRoot });
  } catch (error) {
    // One warning, no throw: the surface runs with no agent hooks rather than
    // not at all. The reason is in the record for whoever has to fix the file.
    getLogger().warn(
      AGENT_HOOKS_STAGE,
      `Agent hooks are unavailable on the ${input.surface} surface: ${errorMessage(error)}`,
      { surface: input.surface, repoRoot: input.repoRoot, error: errorMessage(error) },
    );
    return [];
  }
}
