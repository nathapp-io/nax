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
}

/**
 * The seam an interactive approval channel later plugs into (spec R1).
 * Injected where the runtime is created — a runtime capability, not config.
 */
export interface AskResolver {
  resolve(req: AskRequest): Promise<"allow" | "deny">;
}

export type { ToolGrant };
