/**
 * nax's resolved permission mode + the op's declared tools -> the nax-agent-acp
 * session profile (S4b spec §6.4, nax#2444 D2, nax#2500). Pure. Three tiers: a
 * declaration with a file-write tool keeps the mode's profile; command tools
 * without a file-write tool open `review` (read-only files, and a shell command
 * decided by the operator's Bash rules where the agent has no nax sandbox);
 * anything else opens `read`. The profile is never wider
 * than the mode. An agent with no read-only enforcement — no registry entry, or
 * an entry without one — is refused by the backend, which rejects the open with
 * AGENT_SESSION_CAPABILITY_UNSUPPORTED instead of opening an unenforced session;
 * this map never widens a profile to make an open succeed (D2-i). Profile `ask`
 * is never produced. pi has its own enforcement (its `--tools` allowlist plus the
 * shell gate, SPEC-cursor-pi-acp-read-only US-004), so `read` is no longer
 * refused for it.
 */
import type { ResolvedPermissions } from "@/config/permissions";

export type AcpProfile = "full" | "review" | "read";

/** Declared tools that write files or git state: their presence keeps the mode's profile. */
export const ACP_FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "Delete", "GitCommit"]);
/** Declared tools that run commands: without a file-write tool they open `review` (nax#2500). */
export const ACP_COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash", "Exec", "RunCommand"]);

/** nax#2500 R9: command tools without file-write tools — the reviewer declaration shape. */
export function isReviewerShaped(declaredTools: readonly string[]): boolean {
  return declaredTools.some((t) => ACP_COMMAND_TOOLS.has(t)) && !declaredTools.some((t) => ACP_FILE_WRITE_TOOLS.has(t));
}

const PROFILE_BY_MODE: Readonly<Record<ResolvedPermissions["mode"], AcpProfile>> = Object.freeze({
  "approve-all": "full", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  "approve-reads": "read", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  default: "read",
});

export function acpProfileFor(mode: ResolvedPermissions["mode"], declaredTools?: readonly string[]): AcpProfile {
  const modeProfile = PROFILE_BY_MODE[mode];
  // No declaration (sessions opened outside an op): the mode decides alone.
  if (declaredTools === undefined || declaredTools.length === 0) return modeProfile;
  if (modeProfile === "read") return "read";
  if (declaredTools.some((tool) => ACP_FILE_WRITE_TOOLS.has(tool))) return modeProfile;
  return isReviewerShaped(declaredTools) ? "review" : "read";
}
