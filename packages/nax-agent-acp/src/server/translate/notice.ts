/** A `notice` session update (S5 spec §4.1, §4.3, §4.4). */
import type { SessionUpdate } from "@agentclientprotocol/sdk";

export type NoticeSeverity = "info" | "warning" | "error";

export function notice(severity: NoticeSeverity, title: string, description?: string): SessionUpdate {
  return { sessionUpdate: "notice", severity, title, ...(description !== undefined ? { description } : {}) };
}
