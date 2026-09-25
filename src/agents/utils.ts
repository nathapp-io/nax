import { DEFAULT_AGENT_NAME } from "@/config";
import type { AgentConfig } from "@/config/selectors";

const FALLBACK_DEFAULT_AGENT = DEFAULT_AGENT_NAME;

export function resolveDefaultAgent(config: AgentConfig): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return FALLBACK_DEFAULT_AGENT;
}
