/**
 * The chat session's own compaction policy (US-006).
 *
 * The native chat compacts when `execution.compaction` says so, which is a percentage of the
 * model's window. On the largest windows that percentage is hundreds of thousands of tokens, so
 * a chat that runs for hours reaches it far later than an operator wants. `chat.compaction`
 * holds the chat-specific policy: an absolute token cap for the native chat session's history and
 * the idle delay before a background compact.
 *
 * Only the native chat session (`open-chat-session.ts`) takes the cap. Story sessions and chat
 * subagents keep `execution.compaction` exactly as configured — the chat cap is chat policy, and
 * `0` turns it off rather than falling back.
 */
import { DEFAULT_CHAT_COMPACT_AT_TOKENS, DEFAULT_IDLE_COMPACT_AFTER_MINUTES, type NaxConfig } from "@/config";

const MS_PER_MINUTE = 60_000;

/** The absolute trigger the native chat session compacts at; 0 when the operator turned it off. */
export function chatCompactAtTokens(config: NaxConfig): number {
  return config.chat?.compaction?.compactAtTokens ?? DEFAULT_CHAT_COMPACT_AT_TOKENS;
}

/** How long the chat may sit idle before an idle compaction; 0 when the operator turned it off. */
export function idleCompactAfterMs(config: NaxConfig): number {
  return (config.chat?.compaction?.idleCompactAfterMinutes ?? DEFAULT_IDLE_COMPACT_AFTER_MINUTES) * MS_PER_MINUTE;
}
