/** Optional native-session overlays, separate from the existing profile defaults. */
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig, SandboxConfigSchema } from "#src/config/schemas-sandbox";
import { parseRuleList } from "#src/permissions/grammar";
import type { ToolGrant } from "#src/tools/types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AgentSessionProfile } from "./agent-session-types.ts";
import type { NativeBackendOptions } from "./native-backend-options.ts";

export interface ResolvedPostureRules {
  readonly askRules: readonly ToolGrant[];
  readonly denyRules: readonly ToolGrant[];
  readonly sandbox: SandboxConfig;
}

export function nativePostureRules(profile: AgentSessionProfile, raw: NativeBackendOptions): ResolvedPostureRules {
  const toolOnlyOptions = ["askRules", "denyRules"] as const;
  for (const name of toolOnlyOptions) {
    if ((profile === "none" || profile === "read") && raw[name] !== undefined) {
      const path = `backend.${name}`;
      throw new AgentSessionError(
        `Invalid agent session options: ${path} applies to profiles "ask", "full" and "review" only`,
        "AGENT_SESSION_INVALID_OPTIONS",
        { path },
      );
    }
  }
  return {
    askRules: parseRuleList(raw.askRules ?? []),
    denyRules: parseRuleList(raw.denyRules ?? []),
    sandbox: raw.sandbox === undefined ? DEFAULT_SANDBOX_CONFIG : SandboxConfigSchema.parse(raw.sandbox),
  };
}
