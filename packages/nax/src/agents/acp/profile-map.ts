/**
 * nax's resolved permission mode -> the nax-agent-acp session profile (S4b spec
 * §6.4). Pure. The per-agent fail-closed rule (no `read` on codex, opencode,
 * gemini or pi until #2372) lives in the backend, which rejects the open with
 * AGENT_SESSION_CAPABILITY_UNSUPPORTED; this map never widens a profile to make
 * an open succeed (D2-i). Profile `ask` is never produced.
 */
import type { ResolvedPermissions } from "@/config/permissions";

export type AcpProfile = "full" | "read";

const PROFILE_BY_MODE: Readonly<Record<ResolvedPermissions["mode"], AcpProfile>> = Object.freeze({
  "approve-all": "full", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  "approve-reads": "read", // nax-permission-mode-allow: consumer, maps the resolved mode to an ACP profile
  default: "read",
});

export function acpProfileFor(mode: ResolvedPermissions["mode"]): AcpProfile {
  return PROFILE_BY_MODE[mode];
}
