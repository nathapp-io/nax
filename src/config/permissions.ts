/**
 * Permission Resolver — Single Source of Truth
 *
 * All adapters call resolvePermissions() to determine permission mode.
 * No local fallbacks allowed elsewhere in the codebase.
 *
 * Phase 1: permissionProfile field + legacy boolean backward compat.
 * Phase 2: per-stage scoped allowlists (stub below).
 */

import type { NaxConfig } from "./schema";

export type PermissionProfile = "unrestricted" | "safe" | "scoped";

export type PipelineStage =
  | "plan"
  | "run"
  | "verify"
  | "review"
  | "rectification"
  | "regression"
  | "acceptance"
  | "complete";

export interface ResolvedPermissions {
  /** ACP permission mode string */
  mode: "approve-all" | "approve-reads" | "default";
  /** CLI adapter: whether to pass --dangerously-skip-permissions */
  skipPermissions: boolean;
  /** Future: scoped tool allowlist (Phase 2) */
  allowedTools?: string[];
}

/**
 * Resolve permissions for a given pipeline stage.
 * Single source of truth — all adapters call this.
 *
 * Precedence: permissionProfile > dangerouslySkipPermissions boolean > safe default.
 */
export function resolvePermissions(config: NaxConfig | undefined, _stage: PipelineStage): ResolvedPermissions {
  const profile: PermissionProfile =
    config?.execution?.permissionProfile ?? (config?.execution?.dangerouslySkipPermissions ? "unrestricted" : "safe");

  switch (profile) {
    case "unrestricted":
      return { mode: "approve-all", skipPermissions: true };
    case "safe":
      return { mode: "approve-reads", skipPermissions: false };
    case "scoped":
      return resolveScopedPermissions(config, _stage);
    default:
      return { mode: "approve-reads", skipPermissions: false };
  }
}

/**
 * Phase 2 stub — resolves per-stage permissions from config block.
 * Returns safe defaults until Phase 2 is implemented.
 */
function resolveScopedPermissions(_config: NaxConfig | undefined, _stage: PipelineStage): ResolvedPermissions {
  // Phase 2 implementation goes here
  return { mode: "approve-reads", skipPermissions: false };
}
