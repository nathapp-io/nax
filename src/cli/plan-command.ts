/**
 * Plan Command — Generate prd.json from a spec file via planInteractiveOp
 *
 * Reads a spec file (--from), builds a planning prompt with codebase context,
 * runs planning via callOp + planInteractiveOp, validates the JSON response,
 * and writes prd.json.
 *
 * Interactive mode: uses ACP session + stdin bridge for Q&A.
 */

import { join } from "node:path";
import type { NaxConfig } from "../config";
import { renderManifestSection } from "../debate";
import { NaxError } from "../errors";
import type { PlanDraftInput } from "../operations";
import { callOp, groundOp, planDraftOp } from "../operations";
import type { PlanResult } from "../plan/strategies";
import { buildPlanModeContext, createPlanStrategy, finalizeAndWritePrd } from "../plan/strategies";

export { assertIsValidPrd, buildPlanComposition } from "../plan/strategies";

import { buildPackageSummary, buildSourceRootsSection } from "./plan-helpers";
import { _planDeps, createPlanRuntime } from "./plan-runtime";

// Re-exported for backward compatibility — callers that import from "./plan" still work.
export { _planDeps, createPlanRuntime, DEFAULT_TIMEOUT_SECONDS, resolvePlanModelSelection } from "./plan-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Mode resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve which orchestration mode to use for the plan command.
 *
 * Resolution order:
 * 1. config.plan.mode (explicit user override)
 * 2. debate (both debate.enabled and stages.plan.enabled must be true)
 * 3. single (default)
 */
export function resolvePlanMode(config: NaxConfig): "single" | "debate" | "pipeline" | "refine" {
  const explicit = config?.plan?.mode;
  if (explicit) return explicit;
  if (config?.debate?.enabled && config?.debate?.stages?.plan?.enabled) return "debate";
  return "single";
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan options
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanCommandOptions {
  /** Path to spec file (--from) — required */
  from: string;
  /** Feature name (-f) — required */
  feature: string;
  /** @deprecated No longer used — kept for caller compatibility only */
  auto?: boolean;
  /** Override default branch name (-b) */
  branch?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evidence mode composition
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the plan command: read spec, call LLM via planInteractiveOp, write prd.json.
 *
 * @param workdir - Project root directory
 * @param config  - Nax configuration
 * @param options - Command options
 * @returns The generated prd.json path, plus `degraded` when the plan threw and
 *          the PRD had to be recovered from disk.
 */
export async function planCommand(
  workdir: string,
  config: NaxConfig,
  options: PlanCommandOptions,
): Promise<PlanResult> {
  const ctx = await buildPlanModeContext(workdir, config, options, _planDeps);
  try {
    const mode = resolvePlanMode(config);
    const strategy = createPlanStrategy(mode);
    return await strategy.execute(ctx);
  } finally {
    if (ctx.interactionChain) await ctx.interactionChain.destroy().catch(() => {});
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline mode — US-005
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asymmetric pipeline plan mode.
 * Runs mechanical checks + LLM judgment (runPlanCritic) to produce a validated PRD.
 */
export async function runPlanPipeline(
  workdir: string,
  config: NaxConfig,
  options: PlanCommandOptions,
): Promise<string> {
  const debateEnabled = config?.debate?.enabled === true;
  if (debateEnabled) {
    _planDeps.getLogger()?.warn("plan", "pipeline mode active; debate config ignored", {
      mode: "pipeline",
      debateEnabled: true,
    });
  }

  const { runPlanCritic } = await import("../plan/critic");
  const logger = _planDeps.getLogger();

  const specContent = await _planDeps.readFile(options.from);
  const [sourceRoots, pkg] = await Promise.all([
    _planDeps.scanSourceRoots(workdir),
    _planDeps.readPackageJson(workdir),
  ]);
  const normalizedRoots = sourceRoots.map((root) => ({
    ...root,
    path: root.path.startsWith("/") ? root.path.replace(`${workdir}/`, "") : root.path,
  }));
  const codebaseContext = buildSourceRootsSection(normalizedRoots);

  // Mirror non-pipeline path: derive relative package list + per-package tech stacks
  // so the draft prompt receives the same monorepo context single mode has.
  const relativePackages = [
    ...new Set(
      sourceRoots
        .map((root) => root.path)
        .filter((p) => p !== ".")
        .map((p) => (p.startsWith("/") ? p.replace(`${workdir}/`, "") : p)),
    ),
  ];
  const packageDetails =
    relativePackages.length > 0
      ? await Promise.all(
          relativePackages.map(async (rel) => {
            const pkgJson = await _planDeps.readPackageJsonAt(join(workdir, rel, "package.json"));
            return buildPackageSummary(rel, pkgJson);
          }),
        )
      : [];

  const branchName = options.branch ?? `feat/${options.feature}`;
  const naxDir = join(workdir, ".nax");
  const outputDir = join(naxDir, "features", options.feature);
  const outputPath = join(outputDir, "prd.json");
  await _planDeps.mkdirp(outputDir);

  const projectName = pkg?.name && typeof pkg.name === "string" ? pkg.name : options.feature;

  const rt = createPlanRuntime(config, workdir, options.feature);
  try {
    const callCtx = {
      runtime: rt,
      packageView: rt.packages.resolve(),
      packageDir: workdir,
      agentName: rt.agentManager.getDefault(),
      storyId: options.feature,
      featureName: options.feature,
    } satisfies import("../operations/types").CallContext;

    // Phase 1 — ground
    let manifest: import("../debate/facts-manifest").FactsManifest;
    try {
      manifest = await callOp(callCtx, groundOp, { specContent, codebaseContext, workdir });
    } catch (err) {
      throw new NaxError("Plan pipeline: grounder failed", "PLAN_PIPELINE_GROUND_FAILED", {
        stage: "plan",
        cause: err,
      });
    }

    // Phase 2 — draft
    const citationThreshold = config?.plan?.citationThreshold ?? 0.5;
    const manifestSection = renderManifestSection(manifest);
    const draftCtx: PlanDraftInput = {
      manifestSection,
      manifest,
      specContent,
      codebaseContext,
      feature: options.feature,
      branchName,
      citationThreshold,
      packages: relativePackages,
      packageDetails,
      projectProfile: config?.project,
    };
    const draft = await callOp(callCtx, planDraftOp, draftCtx);

    // Phase 3 — critic
    const verdict = await runPlanCritic({
      prd: draft.prd,
      manifest,
      workdir,
      runId: rt.runId,
      storyId: options.feature,
      config,
      callCtx,
      draftCtx,
    });

    if (verdict.outcome === "passed") {
      // Delta C4 + ADR-025: finalizeAndWritePrd re-applies the spec→PRD fidelity
      // repairs, resolves agentProfileId → agent, stamps origin fields, and
      // records the loader-resolved config profile name so nax run can detect
      // ladder drift.
      await finalizeAndWritePrd({
        prd: verdict.prd,
        specContent,
        featureName: options.feature,
        projectName,
        agentRouting: config.routing?.agents,
        profileName: config.profile,
        models: config.models,
        defaultAgent: config.agent?.default ?? "claude",
        outputPath,
        writeFile: _planDeps.writeFile,
      });
      logger?.info("plan", "[OK] PRD written via pipeline", { outputPath });
      return outputPath;
    }

    throw new NaxError(
      verdict.specDeltasPath
        ? `Plan pipeline failed; see ${verdict.specDeltasPath}`
        : "Plan pipeline failed with no spec-deltas path",
      "PLAN_CRITIC_BLOCKED",
      { stage: "plan", specDeltasPath: verdict.specDeltasPath },
    );
  } finally {
    await rt.close().catch(() => {});
  }
}

// Re-exports for backward compatibility — planDecomposeCommand and runReplanLoop
// were extracted to plan-decompose.ts to keep plan.ts under the 600-line limit.
export { planDecomposeCommand, runReplanLoop } from "./plan-decompose";
