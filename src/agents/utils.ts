import type { NaxConfig } from "../config";

const FALLBACK_DEFAULT_AGENT = "claude";

export function resolveDefaultAgent(config: Pick<NaxConfig, "agent">): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return FALLBACK_DEFAULT_AGENT;
}
