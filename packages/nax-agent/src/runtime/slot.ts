import { nodeRuntime } from "./node-runtime";
import type { AgentRuntime } from "./types";

let installed: AgentRuntime | null = null;

/**
 * Install (or, with `null`, clear) the process-wide runtime. nax installs its
 * Bun runtime at startup; an embedder may install its own. Like the logger
 * slot, it is module-level; S3 decides whether it becomes per-session.
 */
export function setAgentRuntime(runtime: AgentRuntime | null): void {
  installed = runtime;
}

/** The installed runtime, or the Node default. */
export function getAgentRuntime(): AgentRuntime {
  return installed ?? nodeRuntime;
}

/** Spawn through whatever runtime is installed at the moment of the call. */
// nax-git-env-allow: pass-through to the installed runtime; git callers pass hardenedGitEnv themselves
export const runtimeSpawn: AgentRuntime["spawn"] = (cmd, opts) => getAgentRuntime().spawn(cmd, opts);
