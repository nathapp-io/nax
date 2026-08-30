/**
 * Permission Resolver — Single Source of Truth
 *
 * All adapters call resolvePermissions() to determine permission mode.
 * No local fallbacks allowed elsewhere in the codebase.
 *
 * Phase 1: permissionProfile field + legacy boolean backward compat.
 * Phase 2: per-stage scoped allowlists (stub below).
 */

import { getSafeLogger } from "@/logger";
import type { AgentManagerConfig } from "./selectors";

export type PermissionProfile = "unrestricted" | "safe" | "scoped";

export type PipelineStage =
  | "plan"
  | "run"
  | "setup"
  | "verify"
  | "review"
  | "rectification"
  | "regression"
  | "acceptance"
  | "complete";

export interface ResolvedPermissions {
  /**
   * ACP permission mode string — the only resolved value anything consumes
   * (`agents/acp/adapter.ts`, `runtime/middleware/audit.ts`).
   */
  mode: "approve-all" | "approve-reads" | "default";
}

/**
 * Disposition for an **unset** `permissionProfile` — ruled 2026-08-30 (ENH-45).
 *
 * nax's own pipeline is the caller: every stage runs an agent that must edit
 * files, run tests and commit without a human at the keyboard. `unrestricted`
 * (→ `approve-all`) is therefore the documented and intended default, and a
 * config that simply omits the field is not an error — it is the common case.
 * Named rather than inlined so the disposition is one greppable constant, and
 * so the *unset* path is visibly distinct from the *invalid* path below.
 *
 * Opting out is `execution.permissionProfile: "safe"`.
 */
export const DEFAULT_PERMISSION_PROFILE: PermissionProfile = "unrestricted";

/**
 * Disposition for an **invalid** `permissionProfile` — the `default:` arm.
 *
 * Distinct in kind from an unset profile: `PermissionProfile` is a closed union
 * and the config schema rejects anything outside it, so reaching this arm means
 * config validation was bypassed. An unrecognised profile carries no intent to
 * widen, so it fails *closed* — and, unlike before, says so, because silently
 * downgrading a caller that asked for something else is how a misconfiguration
 * gets mistaken for working software.
 */
const INVALID_PROFILE_MODE: ResolvedPermissions["mode"] = "approve-reads";

/**
 * Permission mode for the **session-close** path (SEC-12, ruled 2026-08-30).
 *
 * `closePhysicalSession` must sometimes `loadSession()` purely to `close()` it on
 * the next line; the ACP `loadSession` signature requires a mode. It cannot call
 * `resolvePermissions` for one: `scripts/check-adapter-no-config-import.sh` bans
 * `NaxConfig` from `src/agents/acp/`, so no config is in scope there by design.
 *
 * `approve-reads` regardless of the configured profile is correct and not a
 * contract violation, because no agent work runs under it — the session is
 * loaded and immediately closed. This constant exists so that decision lives in
 * the SSOT with its rationale rather than as a bare literal at the call site.
 */
export const SESSION_CLOSE_PERMISSION_MODE: ResolvedPermissions["mode"] = "approve-reads";

/**
 * Resolve permissions for a given pipeline stage.
 * Single source of truth — all adapters call this.
 */
export function resolvePermissions(config: AgentManagerConfig | undefined, _stage: PipelineStage): ResolvedPermissions {
  const profile: PermissionProfile = config?.execution?.permissionProfile ?? DEFAULT_PERMISSION_PROFILE;

  switch (profile) {
    case "unrestricted":
      return { mode: "approve-all" };
    case "safe":
      return { mode: "approve-reads" };
    case "scoped":
      return resolveScopedPermissions(config, _stage);
    default:
      getSafeLogger()?.warn("permissions", `[resolve] Unrecognised permissionProfile — failing closed`, {
        profile: String(profile),
        stage: _stage,
        mode: INVALID_PROFILE_MODE,
      });
      return { mode: INVALID_PROFILE_MODE };
  }
}

/**
 * Phase 2 stub — resolves per-stage permissions from config block.
 *
 * NOT YET IMPLEMENTED (tracked by GitHub #374). Currently unreachable in normal
 * flow: `rejectUnimplementedScopedProfile` in src/config/loader.ts rejects
 * `permissionProfile: "scoped"` at config-load time so it can't silently degrade
 * here. Kept as a defensive fallback for any path that bypasses the loader guard.
 * When #374 lands, implement per docs/specs/scoped-permissions.md §2.4 and remove
 * the loader guard.
 */
function resolveScopedPermissions(_config: AgentManagerConfig | undefined, _stage: PipelineStage): ResolvedPermissions {
  return { mode: "approve-reads" };
}
