/**
 * nax's resolved permission mode + the op's declared tools -> the nax-agent-acp
 * session profile (S4b spec §6.4, nax#2444 D2). Pure. The profile is the
 * NARROWER of the two axes: a declaration with no write-class tool opens
 * `read` even under `approve-all`. The per-agent fail-closed rule (no `read`
 * on codex, opencode, gemini or pi until #2372) lives in the backend, which
 * rejects the open with AGENT_SESSION_CAPABILITY_UNSUPPORTED; this map never
 * widens a profile to make an open succeed (D2-i). Profile `ask` is never
 * produced.
 */
import type { ResolvedPermissions } from "@/config/permissions";

export type AcpProfile = "full" | "read";

/**
 * Tool names that make a declaration "not read-only" (#2444 Expected 2: write,
 * edit, delete, git-write or command). `Git` stays read-only (git read ops);
 * the `Scratchpad*` universal trio is not listed — nax-internal scratch space
 * is not a repo write, and exact-name membership already exempts it.
 */
export const ACP_WRITE_CLASS_TOOLS: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "Delete",
  "Bash",
  "Exec",
  "RunCommand",
  "GitCommit",
]);

const PROFILE_BY_MODE: Readonly<Record<ResolvedPermissions["mode"], AcpProfile>> = Object.freeze({
  "approve-all": "full", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  "approve-reads": "read", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  default: "read",
});

export function acpProfileFor(mode: ResolvedPermissions["mode"], declaredTools?: readonly string[]): AcpProfile {
  const modeProfile = PROFILE_BY_MODE[mode];
  // No declaration (sessions opened outside an op): the mode decides alone.
  if (declaredTools === undefined || declaredTools.length === 0) return modeProfile;
  const declaresWrite = declaredTools.some((tool) => ACP_WRITE_CLASS_TOOLS.has(tool));
  return declaresWrite ? modeProfile : "read";
}
