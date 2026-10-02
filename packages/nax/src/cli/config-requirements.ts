import { NATIVE_AGENT, nativeTierProviders } from "@nathapp/nax-agent";
import { resolveDefaultAgent } from "@/agents";
import type { NaxConfig } from "@/config";
import { DEFAULT_AGENT_PROTOCOL } from "@/config";

export interface ConfigRequirements {
  agent: string;
  transport: "native" | "acp";
  protocol: "acp" | "native" | "hybrid";
  providers: string[];
  sandbox: boolean;
}

export const _configRequirementsDeps = { nativeTierProviders };

export function buildConfigRequirements(config: NaxConfig): ConfigRequirements {
  const agent = resolveDefaultAgent(config);
  const transport = agent === NATIVE_AGENT ? "native" : "acp";
  const providers =
    transport === "native" ? [..._configRequirementsDeps.nativeTierProviders(config).keys()].sort() : [];

  return {
    agent,
    transport,
    protocol: config.agent?.protocol ?? DEFAULT_AGENT_PROTOCOL,
    providers,
    sandbox: transport === "native" && config.execution?.sandbox?.enabled !== false,
  };
}
