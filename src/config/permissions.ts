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
import { parseRuleList } from "@/permissions";
import type { CodingToolName, ToolGrant } from "@/tools";
import { EXEC_TOOL_NAME } from "@/tools";
import { type BashApprovalMode, resolveBashApproval } from "./bash-approval";
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
  /**
   * Deny rules for the stage (spec R6: deny > ask > allow). Same {tool, patterns}
   * shape as `toolGrants`; compiled and enforced by src/tools/.
   */
  denyRules?: readonly ToolGrant[];
  /** Ask rules for the stage; resolved by an AskResolver at call time (spec R1). */
  askRules?: readonly ToolGrant[];
  /**
   * How far provider (MCP) tools reach for this stage (spec R7).
   *
   * `all` — every attached provider, as `unrestricted` has always had it.
   * `rules` — only what the stage's `Mcp(...)` rules admit (`scoped`).
   * `none` — no provider tools at all (`safe`, and the fail-closed arm).
   *
   * Decided here rather than by the consumer because `scoped` and `safe` both
   * resolve to the same MODE, so no consumer can tell them apart — and this is
   * a permission decision, which lives in this file by rule.
   */
  providerScope?: "all" | "rules" | "none";
  /**
   * How a model-authored bash command string is adjudicated for this stage
   * (ADR-030). Always present: the global default is `raw`, and a per-stage
   * `permissions.<stage>.bashApproval` overrides it. Compiled into the policy
   * by src/tools/, like the rule lists above — the DECISION stays here.
   */
  bashApproval: BashApprovalMode;
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
export const DEFAULT_CODING_TOOLS: readonly CodingToolName[] = [
  "Read",
  "Glob",
  "Grep",
  "ScratchpadWrite",
  "ScratchpadRead",
  "ScratchpadList",
];

/**
 * What `Exec` may run when a project has written no grant of its own.
 *
 * DEFAULT_PERMISSION_PROFILE is `unrestricted`, and unrestricted means "any
 * tool, any path within the root". Letting it also mean "any command" would
 * ship a general exec to every run by default, which ADR-029 section 3 forbids.
 * So Exec is excluded from the blanket grant and given this list instead: the
 * restore and add forms nax knows how to harden, and nothing else. A project
 * widens it by writing `Exec(...)` explicitly, which is a human decision
 * recorded in config — and that expression REPLACES this list rather than
 * extending it, so a project that writes `Exec(bun x tsc*)` and still wants
 * installs must name them too.
 */
export const BUILT_IN_EXEC_PATTERNS: readonly string[] = [
  "bun install",
  "bun add*",
  "npm ci",
  "npm install*",
  "pnpm install*",
  "pnpm add*",
  "yarn install*",
  "yarn add*",
  "pip install*",
  "uv sync*",
  "uv add*",
  "go mod download",
  "go get*",
  "cargo fetch",
  "cargo add*",
];

/**
 * Grants for a profile that imposes no per-stage policy.
 *
 * `Bash` is deliberately absent from every caller's tool list below, and has
 * no built-in pattern list of its own (spec R4). `Exec` is excluded from the
 * blanket `["*"]` and given BUILT_IN_EXEC_PATTERNS instead; Bash goes one
 * further and is granted NOTHING anywhere — not under `unrestricted`, not
 * derived from `quality.commands`. A model-authored shell command runs only
 * where a human wrote a `Bash(...)` allow rule, which is the whole of
 * ADR-029 §3's bargain. Adding "Bash" to any list here breaks that bargain
 * and the deny suite (`test/integration/permissions/bash-deny-suite.test.ts`)
 * fails on purpose if anyone does.
 */
function unconditionalGrants(tools: readonly string[]): ToolGrant[] {
  return tools.map((tool) =>
    tool === EXEC_TOOL_NAME ? { tool, patterns: BUILT_IN_EXEC_PATTERNS } : { tool, patterns: ["*"] },
  );
}

interface StageBlock {
  allowedTools?: string[];
  allow?: string[];
  deny?: string[];
  ask?: string[];
  inherit?: string;
  bashApproval?: BashApprovalMode;
}

/** Stage -> inherit chain -> `default` -> undefined. The walk formerly inside
 * resolveScopedPermissions; now shared by every profile (spec R10). */
function lookupStageBlock(
  blocks: Record<string, StageBlock | undefined> | undefined,
  stage: PipelineStage,
): StageBlock | undefined {
  if (!blocks) return undefined;
  const seen = new Set<string>();
  let key: string | undefined = stage;
  let block = blocks[stage];
  while (block?.inherit !== undefined && key !== undefined && !seen.has(key)) {
    seen.add(key);
    key = block.inherit;
    block = blocks[key];
  }
  return block ?? blocks.default;
}

interface StageRules {
  readonly allow: readonly ToolGrant[];
  readonly deny: readonly ToolGrant[];
  readonly ask: readonly ToolGrant[];
  readonly bashApproval: BashApprovalMode;
}

function stageRules(config: AgentManagerConfig | undefined, stage: PipelineStage): StageRules {
  const blocks = config?.execution?.permissions as Record<string, StageBlock | undefined> | undefined;
  const block = lookupStageBlock(blocks, stage);
  return {
    allow: parseRuleList(block?.allow ?? block?.allowedTools ?? []),
    deny: parseRuleList(block?.deny ?? []),
    ask: parseRuleList(block?.ask ?? []),
    bashApproval: resolveBashApproval(config?.execution?.bashApproval, block?.bashApproval),
  };
}

/** Attach rule fields only when non-empty, so no-block configs stay
 * byte-identical to the pre-rules shape (the regression gate). */
function withRules(base: Omit<ResolvedPermissions, "bashApproval">, rules: StageRules): ResolvedPermissions {
  return {
    ...base,
    bashApproval: rules.bashApproval,
    ...(rules.allow.length > 0 ? { toolGrants: [...(base.toolGrants ?? []), ...rules.allow] } : {}),
    ...(rules.deny.length > 0 ? { denyRules: rules.deny } : {}),
    ...(rules.ask.length > 0 ? { askRules: rules.ask } : {}),
  };
}

/**
 * Resolve permissions for a given pipeline stage.
 * Single source of truth — all adapters call this.
 */
export function resolvePermissions(config: AgentManagerConfig | undefined, _stage: PipelineStage): ResolvedPermissions {
  const profile: PermissionProfile = config?.execution?.permissionProfile ?? DEFAULT_PERMISSION_PROFILE;

  switch (profile) {
    case "unrestricted":
      return withRules(
        {
          mode: "approve-all",
          providerScope: "all",
          toolGrants: unconditionalGrants([
            ...DEFAULT_CODING_TOOLS,
            "Write",
            "Edit",
            "Delete",
            "Git",
            "GitCommit",
            "RunCommand",
            "RequestCapability",
            EXEC_TOOL_NAME,
          ]),
        },
        stageRules(config, _stage),
      );
    case "safe":
      return withRules(
        { mode: "approve-reads", providerScope: "none", toolGrants: unconditionalGrants(DEFAULT_CODING_TOOLS) },
        stageRules(config, _stage),
      );
    case "scoped":
      return resolveScopedPermissions(config, _stage);
    default:
      getSafeLogger()?.warn("permissions", `[resolve] Unrecognised permissionProfile — failing closed`, {
        profile: String(profile),
        stage: _stage,
        mode: INVALID_PROFILE_MODE,
      });
      // Fail closed here on purpose: an unrecognised profile must not also hand out raw bash.
      return { mode: INVALID_PROFILE_MODE, bashApproval: "gated" };
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
  // No baseline: withRules concatenates the block's allow rules onto []. When
  // the lookup finds no block (or a block with no allow list) and the block
  // declared no deny/ask, withRules returns `{ mode: "approve-reads",
  // toolGrants: [] }` unchanged.
  //
  // The bounded inherit chain lives in lookupStageBlock now. It backstops a
  // config that never went through the loader: validatePermissionsBlock refuses
  // both a cycle and a dangling target at load, and falling through to
  // `default` remains the right failure even then -- fewer grants, never more,
  // and never a throw mid-run.
  return withRules({ mode: "approve-reads", providerScope: "rules", toolGrants: [] }, stageRules(config, stage));
}
