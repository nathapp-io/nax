/**
 * The single pre-write invariant for every PRD `nax plan` persists.
 *
 * `applyPlanFidelity` used to be invoked per-strategy — inside `planOp.parse`
 * for single, `planRefineOp.verify` for refine, and in the strategy body for
 * pipeline and debate. Every one of those sites sits on the *happy* path, so a
 * throw that diverted a strategy onto its disk-recovery branch persisted the
 * agent-written PRD raw, silently discarding the deterministic spec→PRD repairs
 * (#1494). `modifiedFiles` was the canary: unlike `outOfScope` it has no
 * prompt-side self-heal turn, so the backfill is its only channel.
 *
 * Routing them all through here makes the repair a property of *writing a PRD*
 * rather than of any one code path, which is what `applyPlanFidelity`'s own
 * contract already claimed ("the four plan strategies cannot drift on which
 * repairs they apply"). Re-application is safe: `backfillOutOfScope` early-returns
 * once nothing is missing, and `applyModifiedFiles` merges deduped by path.
 */
import type { AgentRoutingConfig } from "@/config";
import { applyPlanFidelity } from "@/operations";
import type { PRD } from "@/prd/types";
import { finalizePrdRouting } from "./finalize-routing";
import type { PlanModeContext } from "./types";

export interface PersistPrdArgs {
  readonly prd: PRD;
  readonly specContent: string;
  readonly featureName: string;
  readonly projectName: string;
  readonly agentRouting: AgentRoutingConfig | undefined;
  readonly profileName: string | undefined;
  readonly outputPath: string;
  readonly writeFile: (path: string, content: string) => Promise<void>;
}

/**
 * Repair → finalize routing → write. Returns the path written.
 *
 * Context-free so `runPlanPipeline`, which never builds a `PlanModeContext`,
 * shares the same invariant as the four strategies.
 */
export async function finalizeAndWritePrd(args: PersistPrdArgs): Promise<string> {
  const repaired = applyPlanFidelity(args.prd, args.specContent, args.featureName);
  const finalized = finalizePrdRouting({ ...repaired, project: args.projectName }, args.agentRouting, args.profileName);
  await args.writeFile(args.outputPath, JSON.stringify(finalized, null, 2));
  return args.outputPath;
}

/** `finalizeAndWritePrd` for the four strategies, which all carry a full context. */
export async function persistPrd(ctx: PlanModeContext, prd: PRD): Promise<string> {
  return finalizeAndWritePrd({
    prd,
    specContent: ctx.specContent,
    featureName: ctx.options.feature,
    projectName: ctx.projectName,
    agentRouting: ctx.config.routing?.agents,
    profileName: ctx.profileName,
    outputPath: ctx.outputPath,
    writeFile: ctx.deps.writeFile,
  });
}
