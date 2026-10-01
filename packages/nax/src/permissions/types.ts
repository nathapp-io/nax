/**
 * Permission-subsystem types (spec 2026-09-13 native-permission-subsystem).
 *
 * Rules reuse the ToolGrant shape — {tool, patterns} — with the EFFECT carried
 * by which list a rule sits in (allow/deny/ask), never inside the rule itself.
 * Precedence is deny > ask > allow (spec R6) and is enforced where rules are
 * evaluated (src/tools/policy.ts), not where they are declared.
 */
import type { BashApprovalMode } from "@/config/bash-approval";
import type { ToolGrant } from "@/tools";

/** What a matched `ask` rule needs answered before the call may run. */
export interface AskRequest {
  readonly tool: string;
  /** PipelineStage at the time of the call; a plain string here to keep this
   * module free of value imports from src/config. */
  readonly stage: string;
  /** The rule expression that matched, verbatim from config. */
  readonly rule: string;
  /**
   * The ask rule that matched, verbatim. Set ONLY when an ask rule matched;
   * absent when the ask is an `escalate`-mode grant miss, where `rule` falls
   * back to the denial reason. A remembered approval derives its `origin`
   * from this (#2249).
   */
  readonly matchedRule?: string;
  /** One human-readable line describing the attempted call. */
  readonly summary: string;
  /**
   * The command string VERBATIM, never truncated. `summary` is capped at 200
   * chars for logs; a human deciding whether to permit a command must see all
   * of it, or they are approving a string they never read.
   */
  readonly command?: string;
  /**
   * Set when the call's arguments contain a secret whose masked form could
   * hide shell syntax (review #9). The human link denies without prompting.
   */
  readonly unshowable?: true;
  /** The permitted root -- where the shell actually starts (src/tools/bash.ts:165). */
  readonly root?: string;
  /** The verdict's original reason, NOT rewritten as `matched ask rule "..."`. */
  readonly reason?: string;
  readonly storyId?: string;
  readonly featureName?: string;
}

export type { ToolGrant };

export interface ResolvedPermissions {
  /**
   * ACP permission mode string — the only resolved value anything consumes
   * (`agents/acp/adapter.ts`, `runtime/middleware/audit.ts`).
   */
  mode: "approve-all" | "approve-reads" | "default"; // nax-permission-mode-allow: type of the resolved value, moved with ResolvedPermissions
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
