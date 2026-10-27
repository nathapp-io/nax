import type { NativeBackendOptions, SessionMeta } from "@nathapp/nax-agent";
import type { NaxConfig, TuiPermissions } from "@/config";
import { NaxError } from "@/errors";

export type ChatMode = "full" | "guarded";

export interface ChatSessionSettings {
  readonly profile: "full";
  readonly bashApproval: "raw" | "gated";
  readonly metaMode: "full" | "ask";
}

/** Translate chat's user-facing modes into native session settings. */
export function chatSessionSettings(mode: ChatMode, posture: TuiPermissions | undefined): ChatSessionSettings {
  return mode === "full"
    ? { profile: "full", bashApproval: "raw", metaMode: "full" }
    : { profile: "full", bashApproval: requiredPosture(posture).bashApproval, metaMode: "ask" };
}

function requiredPosture(posture: TuiPermissions | undefined): TuiPermissions {
  if (posture === undefined) {
    throw new NaxError("[chat] guarded session requires a resolved posture", "CHAT_POSTURE_REQUIRED", {
      stage: "chat",
    });
  }
  return posture;
}

/** Backend overlays consume the opener's resolved posture; full never reads guarded policy. */
export function chatBackendPosture(
  mode: ChatMode,
  config: NaxConfig,
  posture: TuiPermissions | undefined,
): Pick<
  NativeBackendOptions,
  "sandbox" | "askRules" | "denyRules" | "askOnUnsandboxed" | "askWhenSandboxDown" | "askDiscoveredTools"
> {
  if (mode === "full") return { sandbox: config.execution.sandbox };
  const resolved = requiredPosture(posture);
  return {
    sandbox: config.execution.sandbox,
    askRules: resolved.askRules,
    denyRules: resolved.denyRules,
    askOnUnsandboxed: true,
    askWhenSandboxDown: true,
    askDiscoveredTools: true,
  };
}

export function nextChatMode(mode: ChatMode): ChatMode {
  return mode === "guarded" ? "full" : "guarded";
}

/** Refuse unsupported persisted modes rather than widening their permissions. */
export function chatModeOfMeta(mode: SessionMeta["mode"]): ChatMode | null {
  if (mode === "ask") return "guarded";
  if (mode === "full") return "full";
  return null;
}
