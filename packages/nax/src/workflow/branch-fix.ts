/**
 * One branch fix session (spec §7 step 3): a branch-fix round (nax#2547) or a final-gate repair
 * (nax#2548). Fresh session, write tools, the fix time limit. Leftover edits are always committed on
 * every non-abort path (even after an interrupt or a failure: a later round only re-checks what is
 * still open, so it may never pick them up), and the fix appends its section to feature-report.md.
 */
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger } from "@/logger";
import { workflowBranchFixOp } from "@/operations";
import { buildWorkflowBranchFixPrompt } from "@/prompts";
import { FEATURE_SCOPE } from "./advisor-live";
import type { FeatureContext } from "./feature-context";
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

async function ensureReport(fc: FeatureContext): Promise<void> {
  if (await Bun.file(fc.reportPath).exists()) return;
  await Bun.write(fc.reportPath, `# Feature report — ${fc.feature}\n\nThe branch fix appends its section below.\n`);
}

/**
 * Best-effort: a failed commit is logged and reported as dirty, never thrown (abort excepted). An
 * unreadable tree (`listUncommitted` throws, nax#2550) lands in the same catch: it is logged and not
 * reported as dirty, because nothing is known to be left; `publish` fails closed on the same read.
 */
async function commitLeftovers(fc: FeatureContext): Promise<{ autoCommitted: boolean; dirty: boolean }> {
  let hasEdits = false;
  try {
    if ((await listUncommitted(fc.projectDir)).length === 0) return { autoCommitted: false, dirty: false };
    hasEdits = true;
    await _workflowDeps.autoCommitIfDirty(
      fc.projectDir,
      "workflow",
      "wf-branch-fix",
      FEATURE_SCOPE,
      undefined,
      fc.dryRun,
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

async function runFixSession(fc: FeatureContext, prompt: string): Promise<FixSession> {
  try {
    const reply = await _workflowDeps.callOp(fc.callCtx, workflowBranchFixOp, {
      prompt,
      timeoutMs: fc.workflow.timeouts.fixMs,
      reportPath: fc.reportPath,
    });
    return reply.failure ? { reply, failure: reply.failure } : { reply };
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    return { failure: errorMessage(err) };
  }
}

export async function runBranchFix(
  fc: FeatureContext,
  input: { specPath?: string; findings: readonly WorkflowFinding[] },
): Promise<BranchFixOutcome> {
  await ensureReport(fc);
  const prompt = buildWorkflowBranchFixPrompt({
    ...(input.specPath ? { specPath: input.specPath } : {}),
    prdPath: fc.prdPath,
    reportPath: fc.reportPath,
    findings: input.findings,
  });
  const session = await runFixSession(fc, prompt);
  return { ...session, ...(await commitLeftovers(fc)) };
}
