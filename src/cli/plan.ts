/**
 * Plan Command — Generate prd.json from a spec file via LLM one-shot call
 *
 * Reads a spec file (--from), builds a planning prompt with codebase context,
 * runs planning via agent adapter (plan()/complete() depending on mode),
 * validates the JSON response, and writes prd.json.
 *
 * Interactive mode: uses ACP session + stdin bridge for Q&A.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDefaultAgent } from "../agents";
import type { NaxConfig } from "../config";
import { resolvePermissions } from "../config/permissions";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import { getLogger } from "../logger";
import { callOp, planOp } from "../operations";
import { validatePlanOutput } from "../prd/schema";
import type { PRD } from "../prd/types";
import { PlanPromptBuilder } from "../prompts";
import { buildCodebaseContext, buildPackageSummary } from "./plan-helpers";
import { DEFAULT_TIMEOUT_SECONDS, _planDeps, createPlanRuntime, resolvePlanModelSelection } from "./plan-runtime";

// Re-exported for backward compatibility — callers that import from "./plan" still work.
export { DEFAULT_TIMEOUT_SECONDS, _planDeps, createPlanRuntime, resolvePlanModelSelection } from "./plan-runtime";

// ─────────────────────────────────────────────────────────────────────────────
// Plan options
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanCommandOptions {
  /** Path to spec file (--from) — required */
  from: string;
  /** Feature name (-f) — required */
  feature: string;
  /** Run in auto (one-shot LLM) mode */
  auto?: boolean;
  /** Override default branch name (-b) */
  branch?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the plan command: read spec, call LLM, write prd.json.
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

  const logger = getLogger();

  // Read spec from --from path
  logger?.info("plan", "Reading spec", { from: options.from });
  const specContent = await _planDeps.readFile(options.from);

  // Scan codebase for context
  logger?.info("plan", "Scanning codebase...");
  const [scan, discoveredPackages, pkg] = await Promise.all([
    _planDeps.scanCodebase(workdir),
    _planDeps.discoverWorkspacePackages(workdir),
    _planDeps.readPackageJson(workdir),
  ]);
  const codebaseContext = buildCodebaseContext(scan);

  // Normalize to repo-relative paths (discoverWorkspacePackages returns relative,
  // but mocks/legacy callers may return absolute — strip workdir prefix if present)
  const relativePackages = discoveredPackages.map((p) => (p.startsWith("/") ? p.replace(`${workdir}/`, "") : p));

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

  const defaultAgentName = resolveDefaultAgent(config);

  // Timeout: from plan config, or DEFAULT_TIMEOUT_SECONDS
  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  // Route: debate > auto (one-shot) > interactive (multi-turn)
  // Debate fires whenever config.debate.enabled + stages.plan.enabled — regardless of auto/interactive mode.
  let rawResponse: string;

  // Debate check is SSOT here — applies to both auto and interactive paths (Option A).
  const debateEnabled = config?.debate?.enabled && config?.debate?.stages?.plan?.enabled;

  if (debateEnabled) {
    // Debate path: run N agents in parallel via DebateRunner.runPlan().
    // Each debater calls adapter.plan() writing to a temp path; resolver picks the best PRD.
    // taskContext is passed to the rebuttal loop; outputFormat is proposal-round only.
    const { taskContext: planTaskContext, outputFormat: planOutputFormat } = new PlanPromptBuilder().build(
      specContent,
      codebaseContext,
      undefined, // no file path — runPlan() appends per-debater temp path
      relativePackages,
      packageDetails,
      config?.project,
    );
    // Safe: debateEnabled guard confirms config.debate.stages.plan is defined
    const planStageConfig = config?.debate?.stages.plan as import("../debate").DebateStageConfig;
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
    const debateResult = await debateRunner.runPlan(planTaskContext, planOutputFormat, {
      workdir,
      feature: options.feature,
      outputDir: outputDir,
      timeoutSeconds,
      maxInteractionTurns: config?.agent?.maxInteractionTurns,
      specContent,
    });
    if (debateResult.outcome !== "failed" && debateResult.output) {
      rawResponse = debateResult.output;
    } else {
      logger?.warn("debate", "All plan debaters failed — falling back to single agent", {
        stage: "plan",
        event: "fallback",
      });
      // Fallback: interactive single-agent plan (most robust — writes to file)
      rawResponse = await runInteractivePlan();
    }
  } else if (options.auto) {
    // Auto (one-shot) path — callOp routes via completeAs, returns JSON directly
    const resolvedPlanModel = resolvePlanModelSelection(config, defaultAgentName);
    const agentName = resolvedPlanModel.agent;
    const rt = createPlanRuntime(config, workdir, options.feature);
    const agentManager = rt.agentManager;
    if (!agentManager.getAgent(agentName)) throw new Error(`[plan] No agent adapter found for '${agentName}'`);

    logger?.info("plan", "Starting auto planning via callOp", {
      agent: agentName,
      model: resolvedPlanModel.modelDef.model,
      workdir,
      feature: options.feature,
    });

    let autoPrd: PRD;
    try {
      autoPrd = await callOp(
        {
          runtime: rt,
          packageView: rt.packages.resolve(),
          packageDir: workdir,
          agentName,
          featureName: options.feature,
        },
        planOp,
        {
          specContent,
          codebaseContext,
          featureName: options.feature,
          branchName,
          packages: relativePackages,
          packageDetails,
          projectProfile: config?.project,
        },
      );
    } finally {
      await rt.close().catch(() => {});
    }
    await _planDeps.writeFile(outputPath, JSON.stringify({ ...autoPrd, project: projectName }, null, 2));
    logger?.info("plan", "[OK] PRD written", { outputPath });
    return outputPath;
  } else {
    rawResponse = await runInteractivePlan();
  }

  // ── Interactive plan helper (used by: interactive path + debate fallback) ──────────────────────
  async function runInteractivePlan(): Promise<string> {
    // Interactive: agent writes PRD JSON directly to outputPath (avoids output truncation)
    const { taskContext: interactiveTaskCtx, outputFormat: interactiveOutputFmt } = new PlanPromptBuilder().build(
      specContent,
      codebaseContext,
      outputPath,
      relativePackages,
      packageDetails,
      config?.project,
    );
    const prompt = `${interactiveTaskCtx}\n\n${interactiveOutputFmt}`;
    const resolvedPlanModel = resolvePlanModelSelection(config, defaultAgentName);
    const agentName = resolvedPlanModel.agent;
    const rt = createPlanRuntime(config, workdir, options.feature);
    const agentManager = rt.agentManager;
    if (!agentManager.getAgent(agentName)) throw new Error(`[plan] No agent adapter found for '${agentName}'`);
    // Use configured interaction plugin (telegram/webhook/auto) if available;
    // fall back to hardcoded stdin bridge when no interaction config is set.
    const headless = !process.stdin.isTTY;
    const interactionChain = config ? await _planDeps.initInteractionChain(config, headless) : null;
    const configuredBridge = interactionChain
      ? buildInteractionBridge(interactionChain, {
          featureName: options.feature,
          stage: "pre-flight",
        })
      : undefined;
    const interactionBridge = configuredBridge ?? _planDeps.createInteractionBridge();
    const resolvedPerm = resolvePermissions(config, "plan");
    logger?.info("plan", "Starting interactive planning session", {
      agent: agentName,
      model: resolvedPlanModel.modelDef.model,
      permission: resolvedPerm.mode,
      workdir,
      feature: options.feature,
      timeoutSeconds,
    });
    const planStartTime = Date.now();
    let planError: Error | null = null;
    try {
      try {
        await agentManager.runAs(agentName, {
          runOptions: {
            prompt,
            workdir,
            timeoutSeconds,
            interactionBridge,
            config,
            modelTier: resolvedPlanModel.modelTier ?? "balanced",
            modelDef: resolvedPlanModel.modelDef,
            maxInteractionTurns: config?.agent?.maxInteractionTurns,
            featureName: options.feature,
            sessionRole: "plan",
            pipelineStage: "plan",
          },
        });
      } catch (err) {
        planError = err instanceof Error ? err : new Error(String(err));
        logger?.warn("plan", "Interactive planning did not complete cleanly; checking for written PRD", {
          error: planError.message,
          outputPath,
        });
      }
    } finally {
      await rt.pidRegistry.killAll().catch(() => {});
      if (interactionChain) await interactionChain.destroy().catch(() => {});
      await rt.close().catch(() => {});
      logger?.info("plan", "Interactive session ended", { durationMs: Date.now() - planStartTime });
    }
    // Read back from file written by agent
    if (!_planDeps.existsSync(outputPath)) {
      if (planError) {
        throw new Error(`[plan] Planning failed and no PRD was written: ${planError.message}`, { cause: planError });
      }
      throw new Error(`[plan] Agent did not write PRD to ${outputPath}. Check agent logs for errors.`);
    }
    if (planError) {
      logger?.warn("plan", "Proceeding with PRD written by agent despite incomplete terminal response", {
        outputPath,
      });
    }
    return _planDeps.readFile(outputPath);
  }

  // Validate and normalize: handles markdown extraction, trailing commas, LLM quirks,
  // complexity normalization, dependency cross-ref, and forces status → pending.
  const finalPrd = validatePlanOutput(rawResponse, options.feature, branchName);

  // Write normalized PRD — spread to avoid mutating the validated object
  await _planDeps.writeFile(outputPath, JSON.stringify({ ...finalPrd, project: projectName }, null, 2));

  logger?.info("plan", "[OK] PRD written", { outputPath });

  return outputPath;
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers
// ─────────────────────────────────────────────────────────────────────────────

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
