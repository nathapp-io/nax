/**
 * Inert Bash stages — stages that DECLARE the Bash tool but whose resolved
 * permissions can never offer it (ADR-030).
 *
 * Under `gated`/`escalate` a stage receives a Bash tool only when its resolved
 * grants already contain a `Bash` entry, and that entry comes solely from a
 * human-written `Bash(...)` allow rule: nothing else in nax grants Bash (see
 * `unconditionalGrants` in ./permissions.ts and the deny suite
 * `test/integration/permissions/bash-deny-suite.test.ts`). A stage that
 * declares Bash while its grants hold none is therefore *inert* — the mode is
 * configured, the tool is never offered, and nothing can escalate. That is
 * silent misconfiguration, which is what this module exists to surface.
 *
 * The decision is read from `resolvePermissions(config, stage)` alone — the
 * same grant list `resolveBashSupport` searches — so the warning and the tool
 * offer cannot disagree.
 */

import { BASH_TOOL_NAME } from "@/tools";
import type { PipelineStage } from "./permissions";
import { resolvePermissions } from "./permissions";
import type { NaxConfig } from "./runtime-types";

/**
 * Stages that dispatch at least one operation declaring the Bash tool.
 *
 * Mirrors the `stage` field of the nine operations that declare `Bash`:
 * `implementerOp` / `testWriterOp` (run); `rectifyOp` (review);
 * `fullSuiteRectifyOp` / `finishFixOp` / `implementerRectifyOp` /
 * `testWriterRectifyOp` (rectification); `acceptanceFixSourceOp` /
 * `acceptanceFixTestOp` (acceptance).
 */
export const BASH_DECLARING_STAGES: readonly PipelineStage[] = ["run", "review", "rectification", "acceptance"];

/**
 * Stages whose resolved `bashApproval` is `gated`/`escalate` AND whose resolved
 * grants hold no `Bash` entry.
 *
 * Reads `resolvePermissions(config, stage)` for each candidate — the same
 * grant list `resolveBashSupport` searches — so the warning and the tool
 * offer cannot disagree. A stage with no `Bash(...)` allow rule resolves with
 * `toolGrants` containing every tool the profile grants but no `Bash` entry,
 * which is exactly the "inert" condition.
 */
export function findInertBashStages(config: NaxConfig): readonly PipelineStage[] {
  const inert: PipelineStage[] = [];
  for (const stage of BASH_DECLARING_STAGES) {
    const resolved = resolvePermissions(config, stage);
    if (resolved.bashApproval !== "gated" && resolved.bashApproval !== "escalate") continue;
    const grants = resolved.toolGrants ?? [];
    if (grants.some((grant) => grant.tool === BASH_TOOL_NAME)) continue;
    inert.push(stage);
  }
  return inert;
}
