/**
 * planDecomposeCommand and runReplanLoop — extracted from plan.ts.
 *
 * Extracted from plan.ts to keep each file within the 600-line project limit.
 * Imports shared runtime helpers and deps from plan.ts.
 */

import { join } from "node:path";
import { resolveDefaultAgent } from "../agents";
import { parseDecomposeOutput } from "../agents/shared/decompose";
import { buildDecomposePromptAsync } from "../agents/shared/decompose-prompt";
import type { DecomposedStory } from "../agents/shared/types-extended";
import type { NaxConfig } from "../config";
import type { DebateStageConfig } from "../debate";
import { NaxError } from "../errors";
import { getLogger } from "../logger";
import { callOp, decomposeOp } from "../operations";
import { mapDecomposedStoriesToUserStories } from "../prd/decompose-mapper";
import type { PRD, StoryStatus, UserStory } from "../prd/types";
import { buildCodebaseContext } from "./plan-helpers";
import { DEFAULT_TIMEOUT_SECONDS, _planDeps, createPlanRuntime, resolvePlanModelSelection } from "./plan-runtime";

/**
 * Decompose an existing story into sub-stories.
 *
 * @param workdir - Project root directory
 * @param config  - Nax configuration
 * @param options - feature name and storyId to decompose
 * @returns no-op function (resolves on success)
 */
export async function planDecomposeCommand(
  workdir: string,
  config: NaxConfig,
  options: { feature: string; storyId: string },
): Promise<() => void> {
  const prdPath = join(workdir, ".nax", "features", options.feature, "prd.json");

  if (!_planDeps.existsSync(prdPath)) {
    throw new NaxError(`PRD not found: ${prdPath}`, "PRD_NOT_FOUND", {
      stage: "decompose",
      feature: options.feature,
    });
  }

  const prdContent = await _planDeps.readFile(prdPath);
  const prd = JSON.parse(prdContent) as PRD;

  const targetStory = prd.userStories.find((s) => s.id === options.storyId) ?? null;
  if (!targetStory) {
    throw new NaxError(`Story "${options.storyId}" not found in PRD`, "STORY_NOT_FOUND", {
      stage: "decompose",
      storyId: options.storyId,
    });
  }

  if (targetStory.status === "decomposed") {
    throw new NaxError(`Story "${options.storyId}" is already decomposed`, "STORY_ALREADY_DECOMPOSED", {
      stage: "decompose",
      storyId: options.storyId,
    });
  }

  const scan = await _planDeps.scanCodebase(workdir);
  const codebaseContext = buildCodebaseContext(scan);

  const siblings = prd.userStories.filter((s) => s.id !== options.storyId);

  const defaultAgentName = resolveDefaultAgent(config);
  const resolvedPlanModel = resolvePlanModelSelection(config, defaultAgentName);
  const agentName = resolvedPlanModel.agent;
  const rt = createPlanRuntime(config, workdir, options.feature);
  const agentManager = rt.agentManager;
  const adapterForCapCheck = agentManager.getAgent(agentName);
  if (!adapterForCapCheck) throw new Error(`[decompose] No agent adapter found for '${agentName}'`);

  const timeoutSeconds = config?.plan?.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const maxAcCount = config?.precheck?.storySizeGate?.maxAcCount ?? Number.POSITIVE_INFINITY;
  const maxReplanAttempts = config?.precheck?.storySizeGate?.maxReplanAttempts ?? 3;

  const debateStages = config?.debate?.stages as unknown as Record<string, DebateStageConfig | undefined>;
  const debateDecompEnabled = config?.debate?.enabled && debateStages?.decompose?.enabled;

  let decompStories: DecomposedStory[] | undefined;
  let repairHint = "";

  try {
    for (let attempt = 0; attempt < maxReplanAttempts; attempt++) {
      if (attempt === 0 && debateDecompEnabled) {
        const decomposeStageConfig = debateStages.decompose as DebateStageConfig;
        const prompt = await buildDecomposePromptAsync({
          specContent: "",
          codebaseContext,
          workdir,
          targetStory,
          siblings,
          featureName: options.feature,
          storyId: options.storyId,
          maxAcCount: config?.precheck?.storySizeGate?.maxAcCount,
        });
        const decompCallCtx = {
          runtime: rt,
          packageView: rt.packages.resolve(),
          packageDir: workdir,
          agentName: agentManager.getDefault(),
          storyId: options.storyId,
          featureName: options.feature,
        } satisfies import("../operations/types").CallContext;
        const debateRunner2 = _planDeps.createDebateRunner({
          ctx: decompCallCtx,
          stage: "decompose",
          stageConfig: decomposeStageConfig,
          config,
          workdir,
          featureName: options.feature,
          timeoutSeconds,
          sessionManager: rt.sessionManager,
        });
        const debateResult = await debateRunner2.run(prompt);
        if (debateResult.outcome !== "failed" && debateResult.output) {
          decompStories = parseDecomposeOutput(debateResult.output);
        }
      }

      if (!decompStories) {
        const effectiveContext = repairHint ? `${codebaseContext}\n\n${repairHint}` : codebaseContext;
        decompStories = await callOp(
          {
            runtime: rt,
            packageView: rt.packages.resolve(),
            packageDir: workdir,
            agentName,
            featureName: options.feature,
            storyId: options.storyId,
          },
          decomposeOp,
          {
            specContent: "",
            codebaseContext: effectiveContext,
            targetStory,
            siblings,
            maxAcCount: config?.precheck?.storySizeGate?.maxAcCount ?? null,
          },
        );
      }

      // Structural validation: throw immediately — no retry benefit
      for (const sub of decompStories) {
        if (!sub.complexity || !sub.testStrategy) {
          throw new NaxError(
            `Sub-story "${sub.id}" is missing required routing fields`,
            "DECOMPOSE_VALIDATION_FAILED",
            {
              stage: "decompose",
              storyId: sub.id,
            },
          );
        }
      }

      // AC-count check: retryable within shared maxReplanAttempts budget
      const violations = decompStories.filter(
        (sub) => sub.acceptanceCriteria && sub.acceptanceCriteria.length > maxAcCount,
      );
      if (violations.length === 0) break;

      const violationSummary = violations
        .map((v) => `"${v.id}" (${v.acceptanceCriteria.length} ACs, max ${maxAcCount})`)
        .join(", ");

      if (attempt + 1 >= maxReplanAttempts) {
        throw new NaxError(
          `Decompose AC repair failed after ${maxReplanAttempts} attempts. Oversized sub-stories: ${violationSummary}`,
          "DECOMPOSE_VALIDATION_FAILED",
          { stage: "decompose", storyId: options.storyId },
        );
      }

      repairHint = `REPAIR REQUIRED (attempt ${attempt + 1}/${maxReplanAttempts}): The following sub-stories exceeded maxAcCount of ${maxAcCount}: ${violationSummary}. Split each offending story further so every sub-story has at most ${maxAcCount} acceptance criteria.`;
      decompStories = undefined;
    }
  } finally {
    await rt.close().catch(() => {});
  }

  const subStoriesWithParent: UserStory[] = mapDecomposedStoriesToUserStories(
    // biome-ignore lint/style/noNonNullAssertion: loop guarantees decompStories is set
    decompStories!,
    options.storyId,
    targetStory.workdir,
  );

  const updatedStories = prd.userStories.map((s) =>
    s.id === options.storyId ? { ...s, status: "decomposed" as StoryStatus } : s,
  );

  const originalIndex = updatedStories.findIndex((s) => s.id === options.storyId);
  const finalStories = [
    ...updatedStories.slice(0, originalIndex + 1),
    ...subStoriesWithParent,
    ...updatedStories.slice(originalIndex + 1),
  ];

  const updatedPrd: PRD = { ...prd, userStories: finalStories };
  await _planDeps.writeFile(prdPath, JSON.stringify(updatedPrd, null, 2));
  return () => {};
}

/**
 * Run the replan loop — decomposes oversized stories and re-runs precheck.
 *
 * When storySizeGate blocks stories with `action === 'block'`, this loop calls
 * planDecomposeCommand for each flagged story, reloads the PRD, and re-runs
 * precheck. Exits with code 1 if stories remain blocked after maxReplanAttempts.
 *
 * No-op when action === 'warn' (gate is non-blocking) or no stories are flagged.
 *
 * @param workdir  - Project root directory
 * @param config   - Nax configuration
 * @param options  - feature name, initial prd, and prd file path
 */
export async function runReplanLoop(
  workdir: string,
  config: NaxConfig,
  options: { feature: string; prd: PRD; prdPath: string },
): Promise<void> {
  const action = config?.precheck?.storySizeGate?.action ?? "block";
  const maxAttempts = config?.precheck?.storySizeGate?.maxReplanAttempts ?? 3;

  // AC-6: warn/skip action — replan loop does not fire
  if (action !== "block") return;

  const logger = getLogger();

  // Initial precheck
  let precheckResult = await _planDeps.runPrecheck(config, options.prd, { workdir, silent: true });

  // No flagged stories — nothing to replan
  if ((precheckResult.flaggedStories ?? []).length === 0) return;

  let currentPrd = options.prd;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const flagged = precheckResult.flaggedStories ?? [];
    logger?.info("replan", `[Replan ${attempt}/${maxAttempts}] Decomposing ${flagged.length} oversized stories...`);

    for (const flaggedStory of flagged) {
      await _planDeps.planDecompose(workdir, config, {
        feature: options.feature,
        storyId: flaggedStory.storyId,
      });
    }

    // Reload PRD from disk after decompose
    const prdContent = await _planDeps.readFile(options.prdPath);
    currentPrd = JSON.parse(prdContent) as PRD;

    // Re-run precheck with reloaded PRD
    precheckResult = await _planDeps.runPrecheck(config, currentPrd, { workdir, silent: true });

    // AC-3: exit early when all stories cleared
    if ((precheckResult.flaggedStories ?? []).length === 0) return;
  }

  // AC-5: still blocked after max attempts
  const remainingIds = (precheckResult.flaggedStories ?? []).map((f) => f.storyId).join(", ");
  logger?.error("replan", `Replan exhausted: stories still oversized after ${maxAttempts} attempts`, {
    storyIds: remainingIds,
  });
  _planDeps.processExit(1);
}
