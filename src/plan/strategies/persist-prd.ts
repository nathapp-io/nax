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
import { existsSync as defaultExistsSync } from "node:fs";
import { join } from "node:path";
import type { AgentRoutingConfig, ModelsConfig } from "@/config";
import { discoverWorkspacePackages as defaultDiscoverWorkspacePackages } from "@/context/generator";
import { getLogger } from "@/logger";
import { applyPlanFidelity } from "@/operations";
import { canonicalizePrdWorkdirs } from "@/prd";
import type { PRD } from "@/prd/types";
import { errorMessage } from "@/utils/errors";
import { finalizePrdRouting } from "./finalize-routing";
import type { PlanModeContext } from "./types";

/**
 * Plan-time filesystem probes. Injected so the canonicalization decision table
 * is testable without a fixture tree.
 */
export const _persistPrdDeps = {
  existsSync: (path: string): boolean => defaultExistsSync(path),
  discoverWorkspacePackages: (repoRoot: string): Promise<string[]> => defaultDiscoverWorkspacePackages(repoRoot),
};

export interface PersistPrdArgs {
  readonly prd: PRD;
  readonly specContent: string;
  readonly featureName: string;
  readonly projectName: string;
  readonly agentRouting: AgentRoutingConfig | undefined;
  readonly profileName: string | undefined;
  readonly models: ModelsConfig;
  readonly defaultAgent: string;
  readonly outputPath: string;
  /** Repo root, for the plan-time workdir probes (nax#2067). */
  readonly repoRoot: string;
  readonly writeFile: (path: string, content: string) => Promise<void>;
}

/**
 * Repair → canonicalize → finalize routing → write. Returns the path written.
 *
 * Context-free so `runPlanPipeline`, which never builds a `PlanModeContext`,
 * shares the same invariant as the four strategies.
 */
export async function finalizeAndWritePrd(args: PersistPrdArgs): Promise<string> {
  // Fidelity runs BEFORE canonicalization. `applyPlanFidelity` ends by calling
  // `warnOnDroppedContextFiles`, which compares the spec's raw `### Context Files`
  // declarations against `getContextFiles(story)` by exact match. Canonicalization
  // re-spells those entries into the repo frame, so running it first would make
  // every package-relative spec entry read as dropped on exactly the monorepo case
  // this feature targets. Fidelity never writes `contextFiles`/`expectedFiles`, and
  // the repo state does not change between the two calls, so the order is free.
  const repaired = applyPlanFidelity(args.prd, args.specContent, args.featureName);

  // nax#2067: decide each story's workdir and re-spell its declared paths into
  // the repo frame, while the repo is still in the state the planner described.
  // Degrades to the fidelity-repaired PRD rather than failing the plan: a PRD with
  // an underived workdir is the status quo, a lost plan is not.
  let canonical = repaired;
  try {
    const packages = await _persistPrdDeps.discoverWorkspacePackages(args.repoRoot);
    const result = canonicalizePrdWorkdirs(repaired, args.repoRoot, packages, _persistPrdDeps.existsSync);
    canonical = result.prd;
    if (result.collisions.length > 0) {
      getLogger().warn("plan", "declared path exists at both the repo root and the story package; took story-local", {
        collisions: result.collisions,
      });
    }
    // nax#2067: a declared path that resolves only at the repo root (not under
    // the story's package) is a guess the planner could not have intended --
    // the plan-builder prompt frames paths workdir-relative, so `P` means W/P.
    // Package-contained consumers resolve against the package dir, so the file
    // would never surface at runtime. Warn here, where the author can act.
    if (result.rootOnly.length > 0) {
      getLogger().warn(
        "plan",
        "declared paths resolve only at the repo root, outside the story's package -- package-scoped agents cannot read them; move the file under the package or root the story",
        { rootOnly: result.rootOnly },
      );
    }
    // nax#2067: the only point in `nax plan` where "this story will be root-scoped"
    // is known. Both consequences are named because both are silent at every later
    // stage -- plan output, run log, and the completed run's artifacts.
    if (result.defaulted.length > 0 && _persistPrdDeps.existsSync(join(args.repoRoot, ".nax", "mono"))) {
      getLogger().warn(
        "plan",
        "stories have no resolved workdir in a monorepo: they will receive the WHOLE rule corpus and the ROOT quality.commands, not their package's",
        { storyIds: result.defaulted },
      );
    }
  } catch (err) {
    getLogger().warn("plan", "workdir canonicalization skipped", { error: errorMessage(err) });
  }

  const finalized = finalizePrdRouting(
    { ...canonical, project: args.projectName },
    args.agentRouting,
    args.profileName,
    args.models,
    args.defaultAgent,
  );
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
    models: ctx.config.models,
    defaultAgent: ctx.config.agent?.default ?? "claude",
    outputPath: ctx.outputPath,
    repoRoot: ctx.workdir,
    writeFile: ctx.deps.writeFile,
  });
}
