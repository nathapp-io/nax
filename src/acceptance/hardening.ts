/**
 * Hardening Pass — test debater-suggested criteria after acceptance passes.
 *
 * Non-blocking: failures are informational, never block the pipeline.
 * Passing criteria are promoted from suggestedCriteria → acceptanceCriteria.
 */

import type { AgentAdapter } from "../agents/types";
import { type ModelDef, resolveModelForAgent } from "../config";
import type { NaxConfig } from "../config";
import { getSafeLogger } from "../logger";
import { parseTestFailures } from "../pipeline/stages/acceptance";
import { savePRD } from "../prd";
import type { PRD } from "../prd/types";
import { buildAcceptanceRunCommand } from "./generator";
import { generateFromPRD } from "./generator";
import { refineAcceptanceCriteria } from "./refinement";
import { resolveSuggestedPackageFeatureTestPath } from "./test-path";
import type { RefinedCriterion } from "./types";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface HardeningResult {
  /** Suggested ACs that passed — promoted to acceptanceCriteria */
  promoted: string[];
  /** Suggested ACs that failed — discarded */
  discarded: string[];
  /** Total cost of the hardening pass (USD) */
  costUsd: number;
}

export interface HardeningContext {
  prd: PRD;
  prdPath: string;
  featureDir: string;
  workdir: string;
  config: NaxConfig;
  agentGetFn?: (name: string) => AgentAdapter | undefined;
}

// ─── Injectable deps ────────────────────────────────────────────────────────

export const _hardeningDeps = {
  refine: refineAcceptanceCriteria,
  generate: generateFromPRD,
  savePRD: savePRD,
  spawn: Bun.spawn as typeof Bun.spawn,
  writeFile: async (p: string, c: string) => {
    await Bun.write(p, c);
  },
};

// ─── Main runner ────────────────────────────────────────────────────────────

export async function runHardeningPass(ctx: HardeningContext): Promise<HardeningResult> {
  const logger = getSafeLogger();
  const result: HardeningResult = { promoted: [], discarded: [], costUsd: 0 };

  // 1. Collect stories with suggestedCriteria
  const storiesWithSuggested = ctx.prd.userStories.filter((s) => s.suggestedCriteria && s.suggestedCriteria.length > 0);
  if (storiesWithSuggested.length === 0) return result;

  logger?.info("acceptance", "Starting hardening pass", {
    storyId: storiesWithSuggested[0].id,
    storiesWithSuggested: storiesWithSuggested.length,
    totalSuggestedACs: storiesWithSuggested.reduce((n, s) => n + (s.suggestedCriteria?.length ?? 0), 0),
  });

  try {
    // 2. Refine suggested criteria
    const allRefined: RefinedCriterion[] = [];
    for (const story of storiesWithSuggested) {
      const criteria = story.suggestedCriteria ?? [];
      const refined = await _hardeningDeps.refine(criteria, {
        storyId: story.id,
        featureName: ctx.prd.feature,
        workdir: ctx.workdir,
        codebaseContext: "",
        config: ctx.config,
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

    // 4. Resolve model
    let modelDef: ModelDef;
    try {
      modelDef = resolveModelForAgent(
        ctx.config.models,
        ctx.config.autoMode?.defaultAgent ?? "claude",
        ctx.config.acceptance?.model ?? "fast",
        ctx.config.autoMode?.defaultAgent ?? "claude",
      );
    } catch {
      modelDef = { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
    }

    // 5. Generate test file
    const genResult = await _hardeningDeps.generate(storiesWithSuggested, allRefined, {
      featureName: ctx.prd.feature,
      workdir: ctx.workdir,
      featureDir: ctx.featureDir,
      codebaseContext: "",
      modelTier: ctx.config.acceptance?.model ?? "fast",
      modelDef,
      config: ctx.config,
      language,
      targetTestFile: suggestedTestPath,
    });
    // 6. Write test file if returned as code (ACP writes directly)
    if (genResult.testCode) {
      await _hardeningDeps.writeFile(suggestedTestPath, genResult.testCode);
    }

    // 7. Run tests
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

    // 8. Parse results and promote/discard
    const failedACs = parseTestFailures(output);
    const failedSet = new Set(failedACs.map((ac) => ac.toUpperCase()));

    // Map AC indices back to suggested criteria
    let acIndex = 0;
    for (const story of storiesWithSuggested) {
      const suggested = story.suggestedCriteria ?? [];
      const toPromote: string[] = [];
      const toDiscard: string[] = [];

      for (const criterion of suggested) {
        acIndex++;
        const acId = `AC-${acIndex}`;
        if (failedSet.has(acId) || (exitCode !== 0 && failedACs.length === 0)) {
          // Failed or test crashed with no parsed ACs → discard all
          toDiscard.push(criterion);
        } else {
          toPromote.push(criterion);
        }
      }

      // Promote passing criteria
      if (toPromote.length > 0) {
        story.acceptanceCriteria = [...story.acceptanceCriteria, ...toPromote];
        result.promoted.push(...toPromote);
      }
      result.discarded.push(...toDiscard);

      // Clean up suggestedCriteria
      story.suggestedCriteria = toDiscard.length > 0 ? toDiscard : undefined;
    }

    // 9. Save PRD with promotions
    if (result.promoted.length > 0) {
      await _hardeningDeps.savePRD(ctx.prd, ctx.prdPath);
    }

    logger?.info("acceptance", "Hardening pass complete", {
      storyId: storiesWithSuggested[0].id,
      promoted: result.promoted.length,
      discarded: result.discarded.length,
      costUsd: result.costUsd,
    });
  } catch (err) {
    logger?.warn("acceptance", "Hardening pass failed (non-blocking)", {
      storyId: storiesWithSuggested[0].id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return result;
}
