import type { NaxConfig } from "../config";

export function resolveDefaultAgent(config: NaxConfig): string {
  const fromAgent = config.agent?.default;
  if (typeof fromAgent === "string" && fromAgent.length > 0) return fromAgent;
  return config.autoMode.defaultAgent;
}
