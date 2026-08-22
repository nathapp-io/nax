/**
 * Permission Resolver — Single Source of Truth
 *
 * All adapters call resolvePermissions() to determine permission mode.
 * No local fallbacks allowed elsewhere in the codebase.
 *
 * Phase 1: permissionProfile field + legacy boolean backward compat.
 * Phase 2: per-stage scoped allowlists (stub below).
 */

import { getSafeLogger } from "../logger";
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
  // SEC-41 (D-20): if the caller didn't pass a config (the exact mistake
  // CLAUDE.md warns against — "Never hardcode ?? true/false/..."), the
  // OLD default was `unrestricted` → `approve-all`, the most permissive
  // possible mode. That inverted the safer-than-typo posture: an invalid
  // profile fails closed to `approve-reads` (default arm), but a missing
  // config silently granted the agent maximum permissions. Warn and
  // fail-closed — the absent case should NOT be more permissive than
  // the invalid case.
  if (config === undefined) {
    getSafeLogger()?.warn("permissions", "resolvePermissions called without a config — defaulting to 'safe'", {
      stage: _stage,
      resolvedMode: "approve-reads",
    });
    return { mode: "approve-reads" };
  }

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
