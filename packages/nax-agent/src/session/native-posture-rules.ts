/** Optional native-session overlays, separate from the existing profile defaults. */
import type { BashApprovalMode } from "#src/config/bash-approval";
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig, SandboxConfigSchema } from "#src/config/schemas-sandbox";
import { parseRuleList } from "#src/permissions/grammar";
import type { SandboxState } from "#src/sandbox/index";
import type { ToolGrant } from "#src/tools/types";
import { AgentSessionError } from "./agent-session-errors.ts";
import type { AgentSessionProfile } from "./agent-session-types.ts";
import type { NativeBackendOptions } from "./native-backend-options.ts";

export interface ResolvedPostureRules {
  readonly askRules: readonly ToolGrant[];
  readonly denyRules: readonly ToolGrant[];
  readonly sandbox: SandboxConfig;
  readonly askOnUnsandboxed: boolean;
  readonly askWhenSandboxDown: boolean;
  readonly askDiscoveredTools: boolean;
}

export function nativePostureRules(profile: AgentSessionProfile, raw: NativeBackendOptions): ResolvedPostureRules {
  const toolOnlyOptions = [
    "askRules",
    "denyRules",
    "askOnUnsandboxed",
    "askWhenSandboxDown",
    "askDiscoveredTools",
  ] as const;
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
  if (raw.askOnUnsandboxed === true && raw.allowUnsandboxedCommands !== true) {
    throw new AgentSessionError(
      "Invalid agent session options: backend.askOnUnsandboxed requires backend.allowUnsandboxedCommands: true",
      "AGENT_SESSION_INVALID_OPTIONS",
      { path: "backend.askOnUnsandboxed" },
    );
  }
  return {
    askOnUnsandboxed: raw.askOnUnsandboxed === true,
    askWhenSandboxDown: raw.askWhenSandboxDown === true,
    askDiscoveredTools: raw.askDiscoveredTools === true,
    askRules: parseRuleList(raw.askRules ?? []),
    denyRules: parseRuleList(raw.denyRules ?? []),
    sandbox: raw.sandbox === undefined ? DEFAULT_SANDBOX_CONFIG : SandboxConfigSchema.parse(raw.sandbox),
  };
}

/** Snapshot the sandbox posture at open; a running session never silently changes modes. */
export function effectiveBashApproval(
  profileMode: BashApprovalMode,
  askWhenSandboxDown: boolean,
  sandboxKind: SandboxState["kind"],
): BashApprovalMode {
  return askWhenSandboxDown && sandboxKind !== "available" ? "gated" : profileMode;
}
