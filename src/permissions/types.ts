/**
 * Permission-subsystem types (spec 2026-09-13 native-permission-subsystem).
 *
 * Rules reuse the ToolGrant shape — {tool, patterns} — with the EFFECT carried
 * by which list a rule sits in (allow/deny/ask), never inside the rule itself.
 * Precedence is deny > ask > allow (spec R6) and is enforced where rules are
 * evaluated (src/tools/policy.ts), not where they are declared.
 */
import type { ToolGrant } from "@/tools";

/** What a matched `ask` rule needs answered before the call may run. */
export interface AskRequest {
  readonly tool: string;
  /** PipelineStage at the time of the call; a plain string here to keep this
   * module free of value imports from src/config. */
  readonly stage: string;
  /** The rule expression that matched, verbatim from config. */
  readonly rule: string;
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
