/** Repo-scoped bounded repair session; independent tree and gate checks follow it. */
import { createForgeReadProvider } from "@/forge-tools";
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
      pinnedBase: env.checkout.inPlace !== true,
      headSha: env.info.headSha,
      setup: env.checks.preRun.map((step) => step.command),
      ciFiles: await listCiConfigFiles(env.checkout.worktree),
    }),
    reportPath: env.ctx.reportPath,
  });
  const result = await _fixStepsDeps.runBranchFix(env.ctx, {
    findings: [],
    model: botModel(env.config, "fix", env.model),
    prompt,
    // US-002: both repair modes are repair sessions, so they book as `wf-repair` — not as the
    // branch fix's `wf-branch-fix`, which is what `fixStep` alone keeps.
    kind: "repair",
    toolProviders: [createForgeReadProvider({ resolveRef: async () => env.ref, deps: env.forge, cwd: env.repoRoot })],
  });
  const patch: Partial<BotFixState> = {
    gateRepairRounds: (state.gateRepairRounds ?? 0) + 1,
    repairMode,
    fixSha: headBefore,
    ...(result.failure !== undefined ? { fixFailure: result.failure } : {}),
    ...(result.dirty ? { fixDirty: true } : {}),
  };
  if (repairMode === "prepare") {
    const boundary = await prepareBoundary(env, headBefore);
    if (boundary)
      return {
        patch: { ...patch, outcome: "prepare-touched-tracked", prepareTreeUnreadable: boundary === "unreadable" },
        exit: "out-of-scope",
      };
  } else {
    const fixSha = await _fixStepsDeps.readHead(env.checkout.worktree).catch((error) => {
      getLogger()?.warn("bot-fix", "Could not read repaired HEAD; keeping the prior recovery commit", { error });
      return headBefore;
    });
    return { patch: { ...patch, fixSha }, exit: "ran" };
  }
  return { patch, exit: "ran" };
}

async function prepareBoundary(env: BotFixEnv, headBefore: string): Promise<"changed" | "unreadable" | undefined> {
  if ((await _fixStepsDeps.readHead(env.checkout.worktree)) !== headBefore) return "changed";
  const status = await _fixStepsDeps.runGit(["status", "--porcelain", "--untracked-files=no"], env.checkout.worktree);
  // An unreadable tree cannot establish that prepare respected the tracked-file boundary.
  if (status.exitCode !== 0) return "unreadable";
  return status.stdout !== "" ? "changed" : undefined;
}
