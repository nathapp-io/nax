/**
 * The ACP permission profile an ACP subagent opens with (chat-acp-subagents US-003).
 *
 * An ordered derivation: an operator override wins, then an agent that declares no
 * `tools:` line — or one that names a write tool — runs as the chat itself does
 * (`ask` guarded, `full` full), and everything else is read-only `review`.
 * `acpReadOnlyEnforced` answers the separate question of whether the agent enforces
 * that read-only profile itself, through its own permission mode rather than through
 * nax's rule translation.
 */

import { registryEntry } from "@nathapp/nax-agent-acp/client";
import type { ChatMode } from "../chat-mode";
import type { AcpChatAgent } from "./acp-model";

export type AcpSubagentProfile = "review" | "read" | "ask" | "full";

/** Tool names that make a subagent inherit the chat's own profile instead of the read-only one. */
export const ACP_SUBAGENT_WRITE_TOOLS: readonly string[] = Object.freeze([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Delete",
  "GitCommit",
]);

/** The profiles that admit no write: no tool call that changes the checkout is granted. */
const READ_ONLY_PROFILES: ReadonlySet<AcpSubagentProfile> = new Set(["review", "read"]);

/**
 * `Write(src/**)` -> `Write`; an entry without a trailing `(...)` is returned as is.
 * The same rule `bareName` in `../subagent-tools.ts` applies — duplicated on purpose,
 * because that one stays private to the tool mapping.
 */
function bareName(entry: string): string {
  const open = entry.indexOf("(");
  return open > 0 && entry.endsWith(")") ? entry.slice(0, open) : entry;
}

function namesWriteTool(tools: readonly string[]): boolean {
  return tools.some((entry) => ACP_SUBAGENT_WRITE_TOOLS.includes(bareName(entry)));
}

/** What the chat itself opens with: guarded asks, full does not. */
function chatOwnProfile(mode: ChatMode): AcpSubagentProfile {
  return mode === "full" ? "full" : "ask";
}

export function acpSubagentProfile(input: {
  /** The agent file's `tools:`, as AgentResource.tools; absent when the file declares none. */
  readonly tools: readonly string[] | undefined;
  readonly mode: ChatMode;
  /** The operator's `agent.acpSubagents.profile`, applied in every chat mode. */
  readonly override?: AcpSubagentProfile;
}): AcpSubagentProfile {
  if (input.override !== undefined) return input.override;
  if (input.tools === undefined || namesWriteTool(input.tools)) return chatOwnProfile(input.mode);
  return "review";
}

export function isReadOnlyAcpProfile(profile: AcpSubagentProfile): boolean {
  return READ_ONLY_PROFILES.has(profile);
}

/**
 * True when the agent enforces read-only through its own permission mode (`policy` is
 * undefined in its registry entry), so a read-only profile needs no rule translation
 * from nax. An agent with no registry entry enforces nothing.
 */
export function acpReadOnlyEnforced(agent: AcpChatAgent): boolean {
  const readOnly = registryEntry(agent)?.readOnly;
  return readOnly !== undefined && readOnly.policy === undefined;
}
