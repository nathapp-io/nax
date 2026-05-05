/**
 * Hardening Pass — test debater-suggested criteria after acceptance passes.
 *
 * Non-blocking: failures are informational, never block the pipeline.
 * Passing criteria are promoted from suggestedCriteria → acceptanceCriteria.
 */

import type { AgentAdapter } from "../agents/types";
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import { callOp as _callOp, acceptanceGenerateOp, acceptanceRefineOp } from "../operations";
import type { CallContext } from "../operations/types";
import { savePRD } from "../prd";
import type { PRD } from "../prd/types";
import type { DispatchContext } from "../runtime/dispatch-context";
import { parseTestFailures } from "../test-runners/ac-parser";
import { buildAcceptanceRunCommand, generateSkeletonTests } from "./generator";
import { resolveSuggestedPackageFeatureTestPath } from "./test-path";
import type { AcceptanceCriterion, RefinedCriterion } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HardeningResult {
  /** Suggested ACs that passed — promoted to acceptanceCriteria */
  promoted: string[];
  /** Suggested ACs that failed — discarded */
  discarded: string[];
}

export interface HardeningContext extends DispatchContext {
  prd: PRD;
  prdPath: string;
  featureDir: string;
  workdir: string;
  config: NaxConfig;
  agentGetFn?: (name: string) => AgentAdapter | undefined;
}

// ─── Injectable deps ────────────────────────────────────────────────────────

export const _hardeningDeps = {
  callOp: _callOp as typeof _callOp,
  savePRD: savePRD,
  spawn: Bun.spawn as typeof Bun.spawn,
  writeFile: async (p: string, c: string) => {
    await Bun.write(p, c);
  },
};

// ─── Main runner ────────────────────────────────────────────────────────────

export async function runHardeningPass(ctx: HardeningContext): Promise<HardeningResult> {
  const logger = getSafeLogger();
  const result: HardeningResult = { promoted: [], discarded: [] };

  // 1. Collect stories with suggestedCriteria
  const storiesWithSuggested = ctx.prd.userStories.filter((s) => s.suggestedCriteria && s.suggestedCriteria.length > 0);
  if (storiesWithSuggested.length === 0) return result;

  logger?.info("acceptance", "Starting hardening pass", {
    storyIds: storiesWithSuggested.map((s) => s.id),
    storiesProcessed: storiesWithSuggested.length,
    totalSuggestedACs: storiesWithSuggested.reduce((n, s) => n + (s.suggestedCriteria?.length ?? 0), 0),
  });

  try {
    // 2. Refine suggested criteria via acceptanceRefineOp
    const allRefined: RefinedCriterion[] = [];
    for (const story of storiesWithSuggested) {
      const criteria = story.suggestedCriteria ?? [];
      const callCtx: CallContext = {
        runtime: ctx.runtime,
        packageView: ctx.runtime.packages.resolve(ctx.workdir),
        packageDir: ctx.workdir,
        storyId: story.id,
        featureName: ctx.prd.feature,
        agentName: ctx.agentManager.getDefault(),
      };
      const refined = await _hardeningDeps.callOp(callCtx, acceptanceRefineOp, {
        criteria,
        codebaseContext: "",
        storyId: story.id,
        testStrategy: ctx.config.acceptance?.testStrategy,
        testFramework: ctx.config.acceptance?.testFramework,
        storyTitle: story.title,
        storyDescription: story.description,
      });
      allRefined.push(...refined);
    }

    // 3. Resolve test path
    const language = ctx.config.project?.language;
    const suggestedTestPath = resolveSuggestedPackageFeatureTestPath(
      ctx.workdir,
      ctx.prd.feature,
      ctx.config.acceptance?.suggestedTestPath,
      language,
    );

    // 4. Generate test file via acceptanceGenerateOp
    const criteriaList = allRefined.map((c, i) => `AC-${i + 1}: ${c.refined}`).join("\n");
    const frameworkOverrideLine = ctx.config.acceptance?.testFramework
      ? `\n[FRAMEWORK OVERRIDE: Use ${ctx.config.acceptance.testFramework} as the test framework regardless of what you detect.]`
      : "";

    const genCallCtx: CallContext = {
      runtime: ctx.runtime,
      packageView: ctx.runtime.packages.resolve(ctx.workdir),
      packageDir: ctx.workdir,
      storyId: storiesWithSuggested[0]?.id,
      featureName: ctx.prd.feature,
      agentName: ctx.agentManager.getDefault(),
    };
    const genResult = await _hardeningDeps.callOp(genCallCtx, acceptanceGenerateOp, {
      featureName: ctx.prd.feature,
      criteriaList,
      frameworkOverrideLine,
      targetTestFilePath: suggestedTestPath,
    });

    // 5. Write test file if returned as code (ACP writes directly)
    let testCode = genResult.testCode;
    if (!testCode) {
      // Fall back to skeleton tests when the op returns no code
      const skeletonCriteria: AcceptanceCriterion[] = allRefined.map((c, i) => ({
        id: `AC-${i + 1}`,
        text: c.refined,
        lineNumber: i + 1,
      }));
      testCode = generateSkeletonTests(
        ctx.prd.feature,
        skeletonCriteria,
        ctx.config.acceptance?.testFramework,
        language,
      );
      logger?.warn("acceptance", "Hardening generate op returned no test code — using skeleton", {
        storyIds: storiesWithSuggested.map((s) => s.id),
        storiesProcessed: storiesWithSuggested.length,
      });
    }
    await _hardeningDeps.writeFile(suggestedTestPath, testCode);

    // 6. Run tests
    const testCmd = buildAcceptanceRunCommand(
      suggestedTestPath,
      ctx.config.project?.testFramework,
      ctx.config.acceptance?.command,
    );
    const proc = _hardeningDeps.spawn(testCmd, {
      cwd: ctx.workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const output = `${stdout}\n${stderr}`;

    // 7. Parse results and promote/discard
    const failedACs = parseTestFailures(output);
    const failedSet = new Set(failedACs.map((ac) => ac.toUpperCase()));

    // Group allRefined by storyId so the mapping loop is driven by the refined
    // criteria (not the original suggestedCriteria). This prevents AC index drift
    // if acceptanceRefineOp ever changes the criterion count (#336 gap 4).
    const refinedByStory = new Map<string, RefinedCriterion[]>();
    for (const r of allRefined) {
      const list = refinedByStory.get(r.storyId) ?? [];
      list.push(r);
      refinedByStory.set(r.storyId, list);
    }

    let acIndex = 0;
    for (const story of storiesWithSuggested) {
      const storyRefined = refinedByStory.get(story.id) ?? [];
      const toPromote: string[] = [];
      const toDiscard: string[] = [];

      for (const refinedCriterion of storyRefined) {
        acIndex++;
        const acId = `AC-${acIndex}`;
        const nonTestable = refinedCriterion.testable === false;
        if (nonTestable || failedSet.has(acId) || (exitCode !== 0 && failedACs.length === 0)) {
          // Discard: non-testable implementation detail, failed, or test crashed
          toDiscard.push(refinedCriterion.original);
        } else {
          toPromote.push(refinedCriterion.original);
        }
      }

      // Promote passing criteria — deduplicate against existing ACs (#336 gap 5)
      if (toPromote.length > 0) {
        const existingACs = new Set(story.acceptanceCriteria);
        story.acceptanceCriteria = [...story.acceptanceCriteria, ...toPromote.filter((ac) => !existingACs.has(ac))];
        result.promoted.push(...toPromote);
      }
      result.discarded.push(...toDiscard);

      // Clean up suggestedCriteria
      story.suggestedCriteria = toDiscard.length > 0 ? toDiscard : undefined;
    }

    // 8. Save PRD with promotions
    if (result.promoted.length > 0) {
      await _hardeningDeps.savePRD(ctx.prd, ctx.prdPath);
    }

    logger?.info("acceptance", "Hardening pass complete", {
      storyIds: storiesWithSuggested.map((s) => s.id),
      storiesProcessed: storiesWithSuggested.length,
      promoted: result.promoted.length,
      discarded: result.discarded.length,
    });
  } catch (err) {
    logger?.warn("acceptance", "Hardening pass failed (non-blocking)", {
      storyIds: storiesWithSuggested.map((s) => s.id),
      storiesProcessed: storiesWithSuggested.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
