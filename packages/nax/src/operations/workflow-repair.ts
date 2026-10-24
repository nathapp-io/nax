/**
 * US-001 (SPEC-ci-repair-and-review-sandbox) — a repair pass as its own session role.
 *
 * The repair session does exactly what the branch fix does — fresh write session,
 * the fix time limit, the implementer reply contract, the feature report as its
 * one writable file, the same soft interrupt — but the token meter keys `byRole`
 * on the dispatch's `sessionRole`. Dispatching through this op books the repair
 * separately from `wf-branch-fix`, so a repair's tokens are attributable to the
 * repair rather than merged into the branch fix.
 *
 * It is deliberately defined *as* `workflowBranchFixOp` with a new name and
 * session role, so the two can never drift: tools, model resolution, timeout,
 * writable output, hop body, parser and recover are the same object identities.
 */
import type { WorkflowOpConfig } from "@/config/selectors";
import type { RunOperationWithHooks } from "./types";
import type { WorkflowBranchFixInput } from "./workflow-branch-fix";
import { workflowBranchFixOp } from "./workflow-branch-fix";
import type { ImplementerReply } from "./workflow-types";

export const workflowRepairOp: RunOperationWithHooks<
  WorkflowBranchFixInput,
  ImplementerReply,
  WorkflowOpConfig,
  "hopBody" | "recover"
> = {
  ...workflowBranchFixOp,
  name: "workflow-repair",
  session: { role: "wf-repair", lifetime: "fresh" },
};
