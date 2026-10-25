import type { SessionMeta } from "@nathapp/nax-agent";

export type ChatMode = "full" | "guarded";

export interface ChatSessionSettings {
  readonly profile: "full" | "ask";
  readonly bashApproval: "raw" | "gated";
  readonly metaMode: "full" | "ask";
}

/** Translate chat's user-facing modes into native session settings. */
export function chatSessionSettings(mode: ChatMode): ChatSessionSettings {
  return mode === "full"
    ? { profile: "full", bashApproval: "raw", metaMode: "full" }
    : { profile: "ask", bashApproval: "gated", metaMode: "ask" };
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
