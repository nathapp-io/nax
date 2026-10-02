/**
 * The `bashApproval` mode axis (ADR-030).
 *
 * Named `raw | gated | escalate` rather than `unrestricted | ...` on purpose:
 * `unrestricted` already names a permission PROFILE
 * (`src/config/permissions.ts:17`), and a mode value colliding with a profile
 * name is a config foot-gun. Profiles answer "which tools is this stage
 * granted"; the mode answers "how is a bash command string adjudicated".
 */
import { z } from "zod";

export const BashApprovalModeSchema = z.enum(["raw", "gated", "escalate"]);

export type BashApprovalMode = z.infer<typeof BashApprovalModeSchema>;

/**
 * BUG-20 — derived from the schema, never hand-written at a second site. The
 * `execution` default literal in `schemas.ts` must reference THIS constant:
 * zod does not re-parse a `.default()` value, so a literal there drifts from
 * the field's own default the moment either changes.
 */
export const DEFAULT_BASH_APPROVAL_MODE: BashApprovalMode = BashApprovalModeSchema.parse("raw");

/**
 * `bashApprovalOps` (ADR-030): the named surface of mode resolution.
 *
 * Deliberately a pure function, not an async provider chain. The human
 * resolver is the existing `AskResolver`, which the `ask` tier already reaches
 * (`src/tools/runtime.ts:378`); a second chain would duplicate it. A future
 * model-based classifier attaches at the POST-ALLOW seam in `runtime.ts`
 * instead, narrowing allow → ask, which is a different insertion point.
 */
export function resolveBashApproval(
  global: BashApprovalMode | undefined,
  perStage: BashApprovalMode | undefined,
): BashApprovalMode {
  return perStage ?? global ?? DEFAULT_BASH_APPROVAL_MODE;
}
