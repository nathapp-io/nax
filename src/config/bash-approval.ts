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
