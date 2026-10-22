/** Repo-scoped bounded repair session; independent tree and gate checks follow it. */
import { getLogger } from "@/logger";
import { buildBotPrFixPrompt, renderCheckoutState } from "@/prompts";
import type { StepResult } from "@/step-graph";
import { listCiConfigFiles } from "./checkout-state";
import { barCommands } from "./checks";
import { _fixStepsDeps, type BotFixEnv, type BotFixState } from "./fix-steps";
import { featureIntentPaths } from "./intent";
import { botModel } from "./models";

export async function repairStep(env: BotFixEnv, state: BotFixState): Promise<StepResult<BotFixState>> {
  const headBefore = await _fixStepsDeps.readHead(env.checkout.worktree);
  if (headBefore === env.info.headSha && state.fixSha !== undefined && state.fixSha !== headBefore) {
    getLogger()?.warn("bot-fix", "Repair skipped: baseline run did not restore the fix commit", {
      pr: env.info.number,
      worktree: env.checkout.worktree,
      headBefore,
      fixSha: state.fixSha,
    });
    return { patch: {}, exit: "out-of-scope" };
  }
  const repairMode = state.outcome === "baseline-red" && state.ciOutcome === "green" ? "prepare" : "repair";
  const prompt = buildBotPrFixPrompt({
    mode: repairMode,
    findings: [],
    pr: env.info,
    ...featureIntentPaths(env.checkout),
    redGates: state.gateTails,
    bar: barCommands(env.checks),
    checkoutState: renderCheckoutState({
      phase: "after-fix",
      headSha: headBefore,
      setup: env.checks.preRun.map((step) => step.command),
      ciFiles: await listCiConfigFiles(env.checkout.worktree),
    }),
    reportPath: env.ctx.reportPath,
  });
  const result = await _fixStepsDeps.runBranchFix(env.ctx, {
    findings: [],
    model: botModel(env.config, "fix", env.model),
    prompt,
  });
  const patch: Partial<BotFixState> = {
    gateRepairRounds: (state.gateRepairRounds ?? 0) + 1,
    repairMode,
    ...(result.failure !== undefined ? { fixFailure: result.failure } : {}),
    ...(result.dirty ? { fixDirty: true } : {}),
  };
  if (repairMode === "prepare" && (await prepareTouchedTracked(env, headBefore))) {
    return { patch: { ...patch, outcome: "prepare-touched-tracked" }, exit: "out-of-scope" };
  }
  return { patch, exit: "ran" };
}

async function prepareTouchedTracked(env: BotFixEnv, headBefore: string): Promise<boolean> {
  if ((await _fixStepsDeps.readHead(env.checkout.worktree)) !== headBefore) return true;
  const status = await _fixStepsDeps.runGit(["status", "--porcelain", "--untracked-files=no"], env.checkout.worktree);
  // An unreadable tree cannot establish that prepare respected the tracked-file boundary.
  return status.exitCode !== 0 || status.stdout !== "";
}
