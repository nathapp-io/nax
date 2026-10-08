/** A `notice` session update (S5 spec §4.1, §4.3, §4.4). */
import type { SessionUpdate } from "@agentclientprotocol/sdk";

export type NoticeSeverity = "info" | "warning" | "error";

export function notice(severity: NoticeSeverity, title: string, description?: string): SessionUpdate {
  return { sessionUpdate: "notice", severity, title, ...(description !== undefined ? { description } : {}) };
}

/**
 * A notice when the client advertised `session.notices`; otherwise the same text
 * as an agent message, which every client shows (ACP: agents MUST NOT send
 * notices to a client that did not advertise them).
 */
export function announce(
  notices: boolean,
  severity: NoticeSeverity,
  title: string,
  description?: string,
): SessionUpdate {
  if (notices) return notice(severity, title, description);
  const text = description === undefined ? title : `${title}: ${description}`;
  return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `\n\n${text}\n\n` } };
}
