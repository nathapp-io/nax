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
 *
 * What this check does NOT look at is the call site. It is sound only because
 * of an invariant enforced elsewhere: every `CallContext` that can dispatch a
 * Bash-declaring op carries an ask resolver and a command shadow, built by
 * `buildDispatchAskWiring` / `buildRunDispatchAskWiring` (src/interaction).
 * Without one the tool runtime falls back to `headlessAskResolver()` and
 * escalation always denies even for a stage this reports as healthy — which is
 * what the finish phase, the acceptance fix cycle and the deferred regression
 * gate did before #2201. `scripts/check-bash-dispatch-ask.ts` (in
 * `lint:checks`) fails on any CallContext construction that omits either
 * field unless it is allowlisted as dispatching no Bash-declaring op (#2202),
 * so "grantable per stage" here implies "reachable at every call site".
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
 *
 * Per stage, not per call site: a stage absent from the result is escalatable
 * at every site that dispatches it because every such site attaches an ask
 * resolver — the invariant `scripts/check-bash-dispatch-ask.ts` enforces
 * (see the module docblock).
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
