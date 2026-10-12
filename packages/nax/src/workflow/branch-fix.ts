/**
 * The one branch fix (spec §7 step 3). Fresh session, write tools, the fix time limit.
 * Leftover edits are always committed on every non-abort path (even after an interrupt or a
 * failure: the branch fix is the only pass, so no later round picks them up), and the fix
 * appends its section to feature-report.md.
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
}

interface FixSession {
  readonly reply?: ImplementerReply;
  readonly failure?: string;
}

async function ensureReport(fc: FeatureContext): Promise<void> {
  if (await Bun.file(fc.reportPath).exists()) return;
  await Bun.write(fc.reportPath, `# Feature report — ${fc.feature}\n\nThe branch fix appends its section below.\n`);
}

/** Best-effort: a failed commit is logged and reported as not committed, never thrown (abort excepted). */
async function commitLeftovers(fc: FeatureContext): Promise<boolean> {
  try {
    if ((await listUncommitted(fc.projectDir)).length === 0) return false;
    await _workflowDeps.autoCommitIfDirty(
      fc.projectDir,
      "workflow",
      "wf-branch-fix",
      FEATURE_SCOPE,
      undefined,
      fc.dryRun,
    );
    return true;
  } catch (err) {
    if (fc.runSignal?.aborted) throw err;
    getSafeLogger()?.warn("workflow", "Branch fix leftover commit failed; edits stay uncommitted", {
      storyId: FEATURE_SCOPE,
      error: errorMessage(err),
    });
    return false;
  }
}

async function runFixSession(fc: FeatureContext, prompt: string): Promise<FixSession> {
  try {
    const reply = await _workflowDeps.callOp(fc.callCtx, workflowBranchFixOp, {
      prompt,
      timeoutMs: fc.workflow.timeouts.fixMs,
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
  return { ...session, autoCommitted: await commitLeftovers(fc) };
}
