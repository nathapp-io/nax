/**
 * Agent hooks module barrel.
 *
 * `cli/chat.ts` and `run-rules-setup.ts` reach this module through `@/hooks`,
 * never through an internal file.
 */

export { loadAgentHooksConfig } from "./config";
export type {
  AgentHookEntry,
  AgentHookEvent,
  AgentHookRun,
  AgentHookSurface,
  AgentHooksConfig,
} from "./types";
export { AGENT_HOOK_EVENTS } from "./types";
