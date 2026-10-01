/**
 * The agent name that routes to the in-process native adapter.
 *
 * Its own nested barrel so the nax-agent move set can import the value
 * (`@/config/native-agent`) without loading the config barrel (S1 spec
 * section 4.2, port 4). `agent-defaults.ts` re-exports it for config.
 */
export const NATIVE_AGENT_NAME = "native";
