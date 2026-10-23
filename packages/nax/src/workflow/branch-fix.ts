/**
 * One branch fix session (spec §7 step 3): a branch-fix round (nax#2547) or a final-gate repair
 * (nax#2548). Fresh session, write tools, the fix time limit. Leftover edits are always committed on
 * every non-abort path (even after an interrupt or a failure: a later round only re-checks what is
 * still open, so it may never pick them up), and the fix appends its section to feature-report.md.
 */
import type { ToolProvider } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { ConfiguredModel } from "@/config";
import { getSafeLogger } from "@/logger";
import { workflowBranchFixOp, workflowRepairOp } from "@/operations";
import { buildWorkflowBranchFixPrompt } from "@/prompts";
import type { SessionRole } from "@/session/types";
import { FEATURE_SCOPE } from "./advisor-live";
import type { BranchStepContext } from "./branch-step-context";
import { listUncommitted } from "./git";
import { _workflowDeps } from "./step-context";
import type { ImplementerReply, WorkflowFinding } from "./types";

export interface BranchFixOutcome {
  readonly reply?: ImplementerReply;
  readonly failure?: string;
  readonly autoCommitted: boolean;
  /** True when the leftover commit failed and edits stay in the tree (they are not in the pushed branch). */
  readonly dirty: boolean;
}

interface FixSession {
  readonly reply?: ImplementerReply;
  readonly failure?: string;
}

async function ensureReport(fc: BranchStepContext): Promise<void> {
  if (await Bun.file(fc.reportPath).exists()) return;
  await Bun.write(fc.reportPath, `# Feature report — ${fc.feature}\n\nThe branch fix appends its section below.\n`);
}

/**
 * Best-effort: a failed commit is logged and reported as dirty, never thrown (abort excepted). An
 * unreadable tree (`listUncommitted` throws, nax#2550) lands in the same catch: it is logged and not
 * reported as dirty, because nothing is known to be left; `publish` fails closed on the same read.
 */
async function commitLeftovers(
  fc: BranchStepContext,
  role: SessionRole,
): Promise<{ autoCommitted: boolean; dirty: boolean }> {
  let hasEdits = false;
  try {
    if ((await listUncommitted(fc.projectDir)).length === 0) return { autoCommitted: false, dirty: false };
    hasEdits = true;
    await _workflowDeps.autoCommitIfDirty(
      fc.projectDir,
      "workflow",
      role,
      FEATURE_SCOPE,
      undefined,
      fc.dryRun,
      fc.runGit,
    );
    return { autoCommitted: true, dirty: false };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    getSafeLogger()?.warn("workflow", "Branch fix leftover commit failed; edits stay uncommitted", {
      storyId: FEATURE_SCOPE,
      error: errorMessage(err),
    });
    return { autoCommitted: false, dirty: hasEdits };
  }
}

interface BranchFixInput {
  specPath?: string;
  findings: readonly WorkflowFinding[];
  model?: ConfiguredModel;
  prompt?: string;
  toolProviders?: readonly ToolProvider[];
  /**
   * US-001: `"repair"` runs the same pass as `wf-repair` — its own session role, so the token meter
   * books it apart from the branch fix, and its own leftover-commit identity. Omitted or `"fix"` is
   * the branch fix, unchanged for every existing caller.
   */
  kind?: "fix" | "repair";
}

/** The dispatch identity of one pass — the op to call, and the role its leftover edits are committed as. */
interface BranchFixDispatch {
  readonly op: typeof workflowBranchFixOp;
  readonly role: SessionRole;
}

function dispatchFor(kind: BranchFixInput["kind"]): BranchFixDispatch {
  return kind === "repair"
    ? { op: workflowRepairOp, role: "wf-repair" }
    : { op: workflowBranchFixOp, role: "wf-branch-fix" };
}

async function runFixSession(
  fc: BranchStepContext,
  op: typeof workflowBranchFixOp,
  input: BranchFixInput & { readonly prompt: string },
): Promise<FixSession> {
  const { model, toolProviders, prompt } = input;
  const callCtx = toolProviders?.length ? { ...fc.callCtx, toolProviders } : fc.callCtx;
  try {
    const reply = await _workflowDeps.callOp(callCtx, op, {
      prompt,
      ...(model !== undefined ? { model } : {}),
      timeoutMs: fc.workflow.timeouts.fixMs,
      reportPath: fc.reportPath,
    });
    return reply.failure ? { reply, failure: reply.failure } : { reply };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return { failure: errorMessage(err) };
  }
}

export async function runBranchFix(fc: BranchStepContext, input: BranchFixInput): Promise<BranchFixOutcome> {
  await ensureReport(fc);
  const { op, role } = dispatchFor(input.kind);
  const prompt =
    input.prompt ??
    buildWorkflowBranchFixPrompt({
      ...(input.specPath ? { specPath: input.specPath } : {}),
      ...(fc.prdPath !== undefined ? { prdPath: fc.prdPath } : {}),
      reportPath: fc.reportPath,
      findings: input.findings,
    });
  const session = await runFixSession(fc, op, { ...input, prompt });
  return { ...session, ...(await commitLeftovers(fc, role)) };
}
