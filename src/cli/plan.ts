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
import { buildInteractionBridge } from "../interaction/bridge-builder";
import { getLogger } from "../logger";
import { callOp, planInteractiveOp } from "../operations";
import { validatePlanOutput } from "../prd/schema";
import { PlanPromptBuilder } from "../prompts";
import { validateFeatureName } from "../utils/feature-name";
import { buildCodebaseContext, buildPackageSummary } from "./plan-helpers";
import { DEFAULT_TIMEOUT_SECONDS, _planDeps, createPlanRuntime } from "./plan-runtime";

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
  /** @deprecated No longer used — kept for caller compatibility only */
  auto?: boolean;
  /** Override default branch name (-b) */
  branch?: string;
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

  // Timeout: from plan config, or DEFAULT_TIMEOUT_SECONDS
  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;

  // Debate fires whenever config.debate.enabled + stages.plan.enabled.
  const debateEnabled = config?.debate?.enabled && config?.debate?.stages?.plan?.enabled;

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
          await _planDeps.writeFile(outputPath, JSON.stringify({ ...finalPrd, project: projectName }, null, 2));
          logger?.info("plan", "[OK] PRD written via debate", { outputPath });
          return outputPath;
        }
        logger?.warn("debate", "All plan debaters failed — falling back to single agent", {
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
          await _planDeps.writeFile(outputPath, JSON.stringify({ ...prd, project: projectName }, null, 2));
          logger?.info("plan", "[OK] PRD written via debate fallback", { outputPath });
          return outputPath;
        } catch (err) {
          if (_planDeps.existsSync(outputPath)) {
            logger?.warn("plan", "Debate fallback callOp failed; recovering from agent-written PRD", { outputPath });
            try {
              const rawContent = await _planDeps.readFile(outputPath);
              const recoveredPrd = validatePlanOutput(rawContent, options.feature, branchName);
              await _planDeps.writeFile(outputPath, JSON.stringify({ ...recoveredPrd, project: projectName }, null, 2));
            } catch {}
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
      await _planDeps.writeFile(outputPath, JSON.stringify({ ...prd, project: projectName }, null, 2));
      logger?.info("plan", "[OK] PRD written", { outputPath });
      return outputPath;
    } catch (err) {
      if (_planDeps.existsSync(outputPath)) {
        logger?.warn("plan", "callOp failed; recovering from agent-written PRD", { outputPath });
        try {
          const rawContent = await _planDeps.readFile(outputPath);
          const recoveredPrd = validatePlanOutput(rawContent, options.feature, branchName);
          await _planDeps.writeFile(outputPath, JSON.stringify({ ...recoveredPrd, project: projectName }, null, 2));
        } catch {}
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
