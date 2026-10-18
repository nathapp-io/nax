/** Private model-env carrier: config is read here, never inside the ACP adapter. */
import { AgentAcpShellSandboxConfigSchema, type NaxConfig } from "@/config";

export type AcpShellSandboxSettings = {
  mode: "auto" | "off";
  pi: { extensions: "user" | "none" };
  opencode: { projectConfig: "disable" | "keep" };
  cursor: { onUnwrapped: "rules" | "deny" };
};

/** Fill missing levels, including individual nested controls, using schema defaults. */
export function acpShellSandboxSettings(config: Pick<NaxConfig, "agent"> | undefined): AcpShellSandboxSettings {
  return AgentAcpShellSandboxConfigSchema.parse(config?.agent?.acp?.shellSandbox);
}

export function withAcpShellSandboxEnv<T extends { env?: Record<string, string> }>(
  def: T,
  agentName: string | undefined,
  settings: AcpShellSandboxSettings,
): T {
  if (agentName !== "opencode" && agentName !== "cursor" && agentName !== "pi") return def;
  if (settings.mode === "off") return def;
  const { pi, opencode, cursor } = settings;
  return { ...def, env: { ...def.env, NAX_ACP_SHELL_SANDBOX: JSON.stringify({ pi, opencode, cursor }) } };
}
