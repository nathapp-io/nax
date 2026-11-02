import type { NativeBackendOptions, SessionMeta } from "@nathapp/nax-agent";
import { memoryConfigOf, type NaxConfig, type TuiPermissions } from "@/config";
import { NaxError } from "@/errors";

export type ChatMode = "full" | "guarded";

/** The two memory writes a guarded native session asks about. `get` and `search` never ask. */
const MEMORY_WRITE_RULES: readonly string[] = Object.freeze(["nax-memory__save", "nax-memory__forget"]);

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

/**
 * The asks a guarded session resolves to: the posture's own rules, with the two
 * memory writes appended when the config asks about them.
 *
 * With `askOnSave` off — or memory disabled — the posture's array is handed back by
 * identity, so a session that never touches memory is offered exactly the rules the
 * resolver produced and nothing has to be re-derived downstream.
 */
function guardedAskRules(config: Pick<NaxConfig, "memory">, askRules: readonly string[]): readonly string[] {
  const memory = memoryConfigOf(config);
  if (!memory.enabled || !memory.askOnSave) return askRules;
  return [...askRules, ...MEMORY_WRITE_RULES];
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
    askRules: guardedAskRules(config, resolved.askRules),
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
