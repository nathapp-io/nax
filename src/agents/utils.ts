import type { AgentConfig } from "@/config/selectors";

const FALLBACK_DEFAULT_AGENT = "claude";

export function resolveDefaultAgent(config: AgentConfig): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return FALLBACK_DEFAULT_AGENT;
}
