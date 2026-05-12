/**
 * Plan Command — Generate prd.json from a spec file via planInteractiveOp
 *
 * Reads a spec file (--from), builds a planning prompt with codebase context,
 * runs planning via callOp + planInteractiveOp, validates the JSON response,
 * and writes prd.json.
 *
 * Interactive mode: uses ACP session + stdin bridge for Q&A.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NaxConfig } from "../config";
import { renderManifestSection } from "../debate";
import { NaxError } from "../errors";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import { getLogger } from "../logger";
import { callOp, groundOp, planDraftOp, planInteractiveOp } from "../operations";
import { validatePlanOutput } from "../prd/schema";
import { PlanPromptBuilder } from "../prompts";
import { validateFeatureName } from "../utils/feature-name";
import { buildPackageSummary, buildSourceRootsSection } from "./plan-helpers";
import { DEFAULT_TIMEOUT_SECONDS, _planDeps, createPlanRuntime } from "./plan-runtime";

// Re-exported for backward compatibility — callers that import from "./plan" still work.
export { DEFAULT_TIMEOUT_SECONDS, _planDeps, createPlanRuntime, resolvePlanModelSelection } from "./plan-runtime";

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
export function resolvePlanMode(config: NaxConfig): "single" | "debate" | "pipeline" {
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

/**
 * Apply evidenceMode macro expansion to a plan stage config.
 * "current" (or absent): returns the config unchanged.
 * "asymmetric": injects grounding defaults; explicit user values take precedence per field.
 */
export function buildPlanComposition(
  userStageConfig: import("../debate").DebateStageConfig & { evidenceMode?: "current" | "asymmetric" },
): import("../debate").DebateStageConfig {
  if (userStageConfig.evidenceMode !== "asymmetric") return userStageConfig;
  return {
    ...userStageConfig,
    preDebatePhase: userStageConfig.preDebatePhase ?? { kind: "grounder" },
    proposers: userStageConfig.proposers ?? { citationsRequired: true, fileReadAccess: true, fileReadBudget: 10 },
    sessionMode: userStageConfig.sessionMode ?? "stateful",
    selector: userStageConfig.selector ?? {
      kind: "verifier-pick",
      patch: { enabled: true, overlapThreshold: 0.8, maxDeltas: 5 },
    },
    postDebateVerifier: userStageConfig.postDebateVerifier ?? { kind: "plan-checklist" },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the plan command: read spec, call LLM via planInteractiveOp, write prd.json.
 *
 * @param workdir - Project root directory
 * @param config  - Nax configuration
 * @param options - Command options
 * @returns Path to generated prd.json
 */
export async function planCommand(workdir: string, config: NaxConfig, options: PlanCommandOptions): Promise<string> {
  const naxDir = join(workdir, ".nax");

  if (!existsSync(naxDir)) {
    throw new Error(`.nax directory not found. Run 'nax init' first in ${workdir}`);
  }

  validateFeatureName(options.feature);

  const logger = getLogger();

  // Read spec from --from path
  logger?.info("plan", "Reading spec", { from: options.from });
  const specContent = await _planDeps.readFile(options.from);

  // Scan source roots for context
  logger?.info("plan", "Scanning source roots...");
  const [sourceRoots, pkg] = await Promise.all([
    _planDeps.scanSourceRoots(workdir),
    _planDeps.readPackageJson(workdir),
  ]);
  const normalizedRoots = sourceRoots.map((root) => ({
    ...root,
    path: root.path.startsWith("/") ? root.path.replace(`${workdir}/`, "") : root.path,
  }));
  const codebaseContext = buildSourceRootsSection(normalizedRoots);

  // Derive package list from discovered source roots so plan context and package
  // details are always aligned even when workspace discovery falls back.
  const relativePackages = [
    ...new Set(
      sourceRoots
        .map((root) => root.path)
        .filter((p) => p !== ".")
        .map((p) => (p.startsWith("/") ? p.replace(`${workdir}/`, "") : p)),
    ),
  ];

  // Scan per-package tech stacks for richer monorepo planning context
  const packageDetails =
    relativePackages.length > 0
      ? await Promise.all(
          relativePackages.map(async (rel) => {
            const pkgJson = await _planDeps.readPackageJsonAt(join(workdir, rel, "package.json"));
            return buildPackageSummary(rel, pkgJson);
          }),
        )
      : [];

  // Auto-detect project name
  const projectName = detectProjectName(workdir, pkg);

  // Compute output path early — needed for interactive file-write prompt
  const branchName = options.branch ?? `feat/${options.feature}`;
  const outputDir = join(naxDir, "features", options.feature);
  const outputPath = join(outputDir, "prd.json");
  await _planDeps.mkdirp(outputDir);

  // Timeout: from plan config, or DEFAULT_TIMEOUT_SECONDS
  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  // Resolve orchestration mode.
  const planMode = resolvePlanMode(config);

  // Initialize interaction chain before debate/op dispatch so destroy() always runs in finally.
  const headless = !process.stdin.isTTY;
  const interactionChain = config ? await _planDeps.initInteractionChain(config, headless) : null;

  try {
    let configuredBridge: ReturnType<typeof buildInteractionBridge> | undefined;
    if (interactionChain) {
      try {
        configuredBridge = buildInteractionBridge(interactionChain, {
          featureName: options.feature,
          stage: "pre-flight",
        });
      } catch {}
    }
    const interactionBridge = configuredBridge ?? _planDeps.createInteractionBridge();

    if (planMode === "pipeline") {
      return await runPlanPipeline(workdir, config, options);
    }

    // Derive debateEnabled from resolved mode so the two-branch check below is consistent.
    const debateEnabled = planMode === "debate";

    if (debateEnabled) {
      // Debate path: run N agents in parallel via DebateRunner.runPlan().
      // Each debater calls adapter.plan() writing to a temp path; resolver picks the best PRD.
      const { taskContext: planTaskContext, outputFormat: planOutputFormat } = new PlanPromptBuilder().build(
        specContent,
        codebaseContext,
        undefined, // no file path — runPlan() appends per-debater temp path
        relativePackages,
        packageDetails,
        config?.project,
      );
      // Safe: debateEnabled guard confirms config.debate.stages.plan is defined.
      // buildPlanComposition applies evidenceMode macro (no-op for "current").
      const planStageConfig = buildPlanComposition(
        config?.debate?.stages.plan as import("../debate").DebateStageConfig & {
          evidenceMode?: "current" | "asymmetric";
        },
      );
      const debateRt = createPlanRuntime(config, workdir, options.feature);
      const debateAgentManager = debateRt.agentManager;
      const debateCallCtx = {
        runtime: debateRt,
        packageView: debateRt.packages.resolve(),
        packageDir: workdir,
        agentName: debateAgentManager.getDefault(),
        storyId: options.feature,
        featureName: options.feature,
      } satisfies import("../operations/types").CallContext;
      const debateRunner = _planDeps.createDebateRunner({
        ctx: debateCallCtx,
        stage: "plan",
        stageConfig: planStageConfig,
        config,
        workdir,
        featureName: options.feature,
        timeoutSeconds,
        sessionManager: debateRt.sessionManager,
      });
      logger?.info("plan", "Starting debate planning session", {
        debaters: planStageConfig.debaters?.map((d) => d.agent),
        rounds: planStageConfig.rounds,
        feature: options.feature,
      });
      try {
        const debateResult = await debateRunner.runPlan(planTaskContext, planOutputFormat, {
          workdir,
          feature: options.feature,
          outputDir: outputDir,
          timeoutSeconds,
          maxInteractionTurns: config?.agent?.maxInteractionTurns,
          specContent,
        });
        if (debateResult.outcome !== "failed" && debateResult.output) {
          const finalPrd = validatePlanOutput(debateResult.output, options.feature, branchName);
          assertIsValidPrd(finalPrd);
          await _planDeps.writeFile(outputPath, JSON.stringify({ ...finalPrd, project: projectName }, null, 2));
          logger?.info("plan", "[OK] PRD written via debate", { outputPath });
          return outputPath;
        }
        logger?.warn("debate", "Plan debate returned failed outcome — falling back to single agent", {
          stage: "plan",
          event: "fallback",
        });
        // Debate fallback: callOp + planInteractiveOp (reuses debateRt)
        try {
          const prd = await callOp(
            {
              runtime: debateRt,
              packageView: debateRt.packages.resolve(),
              packageDir: workdir,
              agentName: debateRt.agentManager.getDefault(),
              storyId: options.feature,
              featureName: options.feature,
              interactionBridge,
              maxInteractionTurns: config?.agent?.maxInteractionTurns,
            },
            planInteractiveOp,
            {
              specContent,
              codebaseContext,
              featureName: options.feature,
              branchName,
              outputPath,
              packages: relativePackages,
              packageDetails,
              projectProfile: config?.project,
            },
          );
          assertIsValidPrd(prd);
          await _planDeps.writeFile(outputPath, JSON.stringify({ ...prd, project: projectName }, null, 2));
          logger?.info("plan", "[OK] PRD written via debate fallback", { outputPath });
          return outputPath;
        } catch (err) {
          if (_planDeps.existsSync(outputPath)) {
            logger?.warn("plan", "Debate fallback callOp failed; recovering from agent-written PRD", { outputPath });
            let rawContent: string;
            try {
              rawContent = await _planDeps.readFile(outputPath);
            } catch {
              return outputPath;
            }
            const recoveredPrd = validatePlanOutput(rawContent, options.feature, branchName);
            await _planDeps.writeFile(outputPath, JSON.stringify({ ...recoveredPrd, project: projectName }, null, 2));
            return outputPath;
          }
          throw err;
        }
      } finally {
        await debateRt.close().catch(() => {});
      }
    }

    // Non-debate path: callOp + planInteractiveOp
    const rt = createPlanRuntime(config, workdir, options.feature);
    try {
      const prd = await callOp(
        {
          runtime: rt,
          packageView: rt.packages.resolve(),
          packageDir: workdir,
          agentName: rt.agentManager.getDefault(),
          storyId: options.feature,
          featureName: options.feature,
          interactionBridge,
          maxInteractionTurns: config?.agent?.maxInteractionTurns,
        },
        planInteractiveOp,
        {
          specContent,
          codebaseContext,
          featureName: options.feature,
          branchName,
          outputPath,
          packages: relativePackages,
          packageDetails,
          projectProfile: config?.project,
        },
      );
      assertIsValidPrd(prd);
      await _planDeps.writeFile(outputPath, JSON.stringify({ ...prd, project: projectName }, null, 2));
      logger?.info("plan", "[OK] PRD written", { outputPath });
      return outputPath;
    } catch (err) {
      if (_planDeps.existsSync(outputPath)) {
        logger?.warn("plan", "callOp failed; recovering from agent-written PRD", { outputPath });
        let rawContent: string;
        try {
          rawContent = await _planDeps.readFile(outputPath);
        } catch {
          return outputPath;
        }
        const recoveredPrd = validatePlanOutput(rawContent, options.feature, branchName);
        await _planDeps.writeFile(outputPath, JSON.stringify({ ...recoveredPrd, project: projectName }, null, 2));
        return outputPath;
      }
      throw err;
    } finally {
      await rt.close().catch(() => {});
    }
  } finally {
    if (interactionChain) await interactionChain.destroy().catch(() => {});
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
    const draftCtx = {
      manifestSection,
      manifest,
      specContent,
      codebaseContext,
      feature: options.feature,
      branchName,
      citationThreshold,
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
      await _planDeps.writeFile(outputPath, JSON.stringify({ ...verdict.prd, project: projectName }, null, 2));
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

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constant-time envelope check: confirms callOp returned a PRD, not a TurnResult.
 * Does NOT call validatePlanOutput to avoid re-stamping updatedAt (timestamp drift).
 * Defence-in-depth for issue #993 — the primary fix lives in callOp's catch path.
 */
function assertIsValidPrd(prd: unknown): asserts prd is import("../prd/types").PRD {
  if (typeof prd !== "object" || prd === null || Array.isArray(prd)) {
    throw new NaxError("plan: callOp returned a non-PRD value", "PLAN_INVALID_RESULT", { stage: "plan" });
  }
  const obj = prd as Record<string, unknown>;
  if (!Array.isArray(obj.userStories) || obj.userStories.length === 0) {
    throw new NaxError(
      "plan: callOp returned an envelope-shaped object (no userStories) — likely retry exhaustion (#993)",
      "PLAN_ENVELOPE_LEAK",
      { stage: "plan", keys: Object.keys(obj).join(",") },
    );
  }
}

/**
 * Detect project name from package.json or git remote.
 */
function detectProjectName(workdir: string, pkg: Record<string, unknown> | null): string {
  if (pkg?.name && typeof pkg.name === "string") {
    return pkg.name;
  }

  const result = _planDeps.spawnSync(["git", "remote", "get-url", "origin"], { cwd: workdir });
  if (result.exitCode === 0) {
    const url = result.stdout.toString().trim();
    const match = url.match(/\/([^/]+?)(?:\.git)?$/);
    if (match?.[1]) return match[1];
  }

  return "unknown";
}

// Re-exports for backward compatibility — planDecomposeCommand and runReplanLoop
// were extracted to plan-decompose.ts to keep plan.ts under the 600-line limit.
export { planDecomposeCommand, runReplanLoop } from "./plan-decompose";
