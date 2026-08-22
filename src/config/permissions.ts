/**
 * Permission Resolver — Single Source of Truth
 *
 * All adapters call resolvePermissions() to determine permission mode.
 * No local fallbacks allowed elsewhere in the codebase.
 *
 * Phase 1: permissionProfile field + legacy boolean backward compat.
 * Phase 2: per-stage scoped allowlists (stub below).
 */

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
 * Resolve permissions for a given pipeline stage.
 * Single source of truth — all adapters call this.
 */
export function resolvePermissions(config: AgentManagerConfig | undefined, _stage: PipelineStage): ResolvedPermissions {
  const profile: PermissionProfile = config?.execution?.permissionProfile ?? "unrestricted";

  switch (profile) {
    case "unrestricted":
      return { mode: "approve-all" };
    case "safe":
      return { mode: "approve-reads" };
    case "scoped":
      return resolveScopedPermissions(config, _stage);
    default:
      return { mode: "approve-reads" };
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
