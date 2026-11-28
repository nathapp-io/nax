/**
 * The `./runtime` entry: the agent runtime slot and the Node default alone.
 *
 * A light entry point (#3079); see `./credentials.ts` for the contract. The
 * slot is the same module instance the root entry re-exports.
 */
export {
  type AgentGlobOptions,
  type AgentRuntime,
  type AgentSpawnOptions,
  type AgentSpawnResult,
  type AgentSpawnStdin,
  getAgentRuntime,
  nodeRuntime,
  setAgentRuntime,
} from "#src/runtime/index";
