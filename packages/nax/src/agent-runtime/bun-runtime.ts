import type { AgentRuntime, AgentSpawnResult } from "@nathapp/nax-agent";

/**
 * nax's runtime for nax-agent: Bun.spawn as is, so every nax CLI path keeps the
 * exact process behaviour it had before the runtime slot existed (spec S2 §4.2).
 * Installed by ./install.ts; nax-agent's own Node default stays unused in nax.
 */
export const bunAgentRuntime: AgentRuntime = {
  // nax-git-env-allow: the generic runtime; git callers (gitWithTimeout) pass hardenedGitEnv themselves
  spawn: (cmd, opts) => Bun.spawn([...cmd], opts) as unknown as AgentSpawnResult,
};
