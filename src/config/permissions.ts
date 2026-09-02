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
import type { CodingToolName, ToolGrant } from "@/tools";
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
  /**
   * Declarative grants — data, never matchers. Compiled into an enforceable
   * policy by src/tools/, which keeps glob and filesystem semantics out of the
   * config layer while the decision stays here, in the gated SSOT.
   */
  toolGrants?: readonly ToolGrant[];
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
 * Coding tools a native run-op receives when it declares none.
 *
 * Named rather than inlined for the same reason as DEFAULT_PERMISSION_PROFILE
 * above: the *unset* case is a deliberate disposition, not an accident, and it
 * should be greppable. Reading within the root is the same risk class as the
 * context pull tools ops already receive, and defaulting it on is what closes
 * the diff-only review gap for every native op at once.
 *
 * Write, Edit and Git are absent by design: Write/Edit mutate, and Git exposes
 * history, arbitrary refs and blame — materially more surface than "search the
 * working tree". Each must be declared by the operation that wants it.
 */
export const DEFAULT_CODING_TOOLS: readonly CodingToolName[] = ["Read", "Glob", "Grep"];

/** Grants for a profile that imposes no per-stage policy. */
function unconditionalGrants(tools: readonly string[]): ToolGrant[] {
  return tools.map((tool) => ({ tool, patterns: ["*"] }));
}

/**
 * Parse one #374 tool expression.
 *
 * `Read`                  -> unconditional
 * `Write(src/**,test/**)` -> those two globs
 * `Git(diff,log)`         -> those two subcommands
 */
function parseToolExpression(expression: string): ToolGrant {
  const open = expression.indexOf("(");
  if (open === -1) return { tool: expression.trim(), patterns: ["*"] };
  const tool = expression.slice(0, open).trim();
  const inner = expression.slice(open + 1, expression.lastIndexOf(")"));
  const patterns = inner
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return { tool, patterns: patterns.length > 0 ? patterns : ["*"] };
}

/**
 * Resolve permissions for a given pipeline stage.
 * Single source of truth — all adapters call this.
 */
export function resolvePermissions(config: AgentManagerConfig | undefined, _stage: PipelineStage): ResolvedPermissions {
  const profile: PermissionProfile = config?.execution?.permissionProfile ?? DEFAULT_PERMISSION_PROFILE;

  switch (profile) {
    case "unrestricted":
      return {
        mode: "approve-all",
        toolGrants: unconditionalGrants([...DEFAULT_CODING_TOOLS, "Write", "Edit", "Git"]),
      };
    case "safe":
      return { mode: "approve-reads", toolGrants: unconditionalGrants(DEFAULT_CODING_TOOLS) };
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
 * Per-stage scoped allowlists (GitHub #374).
 *
 * Lookup order matches docs/specs/scoped-permissions.md section 2.4:
 * stage block -> inherit target -> default block -> no grants.
 *
 * Note what does NOT appear here: any notion of a filesystem root. Containment
 * is not expressible in config by design — the root is a hard boundary that no
 * profile can widen, enforced in src/tools/policy.ts.
 */
function resolveScopedPermissions(config: AgentManagerConfig | undefined, stage: PipelineStage): ResolvedPermissions {
  const blocks = config?.execution?.permissions as
    | Record<string, { allowedTools?: string[]; inherit?: string } | undefined>
    | undefined;
  if (!blocks) return { mode: "approve-reads", toolGrants: [] };

  const seen = new Set<string>();
  let key: string | undefined = stage;
  let block = blocks[stage];

  // Bounded inherit chain: a cycle or a dangling target falls through to
  // `default` rather than looping or throwing mid-run.
  while (block?.inherit !== undefined && key !== undefined && !seen.has(key)) {
    seen.add(key);
    key = block.inherit;
    block = blocks[key];
  }
  block ??= blocks.default;
  if (!block?.allowedTools) return { mode: "approve-reads", toolGrants: [] };

  return { mode: "approve-reads", toolGrants: block.allowedTools.map(parseToolExpression) };
}
