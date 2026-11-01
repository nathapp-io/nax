/**
 * Agent hooks module barrel.
 *
 * `cli/chat.ts` and `run-rules-setup.ts` reach this module through `@/hooks`,
 * never through an internal file.
 */

export { loadAgentHooksConfig } from "./config";
export { _agentHookHandlerDeps, AGENT_HOOKS_PLUGIN, createAgentHookHandlers } from "./handlers";
export {
  _runAgentHookDeps,
  AGENT_HOOK_DRAIN_MS,
  AGENT_HOOK_HANDLER_MARGIN_MS,
  AGENT_HOOK_KILL_GRACE_MS,
  runAgentHook,
} from "./run-hook";
export type {
  AgentHookEntry,
  AgentHookEvent,
  AgentHookRun,
  AgentHookSurface,
  AgentHooksConfig,
} from "./types";
export { AGENT_HOOK_EVENTS } from "./types";
