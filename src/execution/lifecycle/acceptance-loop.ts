/**
 * Acceptance Retry Loop
 *
 * Handles the acceptance testing retry loop after main execution completes:
 * 1. Runs acceptance validation
 * 2. Detects test-level failures (>80% fail or crash) and regenerates test (P1-D)
 * 3. Generates batched fix stories for implementation-level failures
 * 4. Executes fix stories through pipeline
 * 5. Retries until max retries or all tests pass
 */

import { loadAcceptanceTestContent as loadAcceptanceTestContentModule } from "../../acceptance/content-loader";
import { loadSemanticVerdicts } from "../../acceptance/semantic-verdict";
import { findExistingAcceptanceTestPath as findExistingAcceptanceTestPathFromOptions } from "../../acceptance/test-path";
import { getAgent, resolveDefaultAgent } from "../../agents";
import type { NaxConfig } from "../../config";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import type { PipelineEventEmitter } from "../../pipeline/events";
import type { AgentGetFn, PipelineContext } from "../../pipeline/types";
import type { PluginRegistry } from "../../plugins";
import type { PRD } from "../../prd/types";
import type { NaxIgnoreIndex } from "../../utils/path-filters";
import { hookCtx } from "../helpers";
import type { StatusWriter } from "../status-writer";
import { applyFix, resolveAcceptanceDiagnosis } from "./acceptance-fix";
import {
  buildResult,
  isStubTestFile,
  regenerateAcceptanceTest as regenerateAcceptanceTestFn,
} from "./acceptance-helpers";

export {
  buildResult,
  isStubTestFile,
  isTestLevelFailure,
  loadAcceptanceTestContent,
  loadSpecContent,
  regenerateAcceptanceTest,
  _regenerateDeps,
} from "./acceptance-helpers";

export interface AcceptanceLoopContext {
  config: NaxConfig;
  prd: PRD;
  prdPath: string;
  workdir: string;
  featureDir?: string;
  hooks: LoadedHooksConfig;
  feature: string;
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  allStoryMetrics: StoryMetrics[];
  pluginRegistry: PluginRegistry;
  eventEmitter?: PipelineEventEmitter;
  statusWriter: StatusWriter;
  /** Protocol-aware agent resolver — passed from registry at run start */
  agentGetFn?: AgentGetFn;
  /** Pre-resolved .naxignore matcher cache shared across run stages */
  naxIgnoreIndex?: NaxIgnoreIndex;
  /** Per-package acceptance test paths — used to load test content for fix routing */
  acceptanceTestPaths?: Array<{ testPath: string; packageDir: string }>;
}

export interface AcceptanceLoopResult {
  success: boolean;
  prd: PRD;
  totalCost: number;
  iterations: number;
  storiesCompleted: number;
  prdDirty: boolean;
  /** Acceptance criteria that failed — populated when success=false */
  failedACs?: string[];
  /** Number of acceptance retries performed */
  retries?: number;
}

// isStubTestFile, isTestLevelFailure, loadSpecContent, loadAcceptanceTestContent,
// buildResult — extracted to acceptance-helpers.ts (re-exported above)

export const _acceptanceLoopDeps = {
  getAgent,
  loadSemanticVerdicts,
};

// _regenerateDeps, regenerateAcceptanceTest, generateAndAddFixStories, executeFixStory
// — extracted to acceptance-helpers.ts or deleted (dead code)

const MAX_STUB_REGENS = 2;

/**
 * Run the acceptance retry loop.
 *
 * Each iteration:
 *   1. Run acceptance tests → PASS → done / FAIL → collect failures
 *   2. Stub guard (with stubRegenCount cap) → regen + continue
 *   3. Diagnose (fresh each iteration via resolveAcceptanceDiagnosis)
 *   4. applyFix(diagnosis) — single-attempt
 *   5. Accumulate previousFailure context
 *   6. continue (always — back to step 1)
 *
 * The outer loop owns ALL retry logic. Inner functions apply exactly one fix.
 */
export async function runAcceptanceLoop(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult> {
  const logger = getSafeLogger();
  const maxRetries = ctx.config.acceptance.maxRetries;

  let acceptanceRetries = 0;
  let stubRegenCount = 0;
  let previousFailure = "";
  const prd = ctx.prd;
  let totalCost = ctx.totalCost;
  const iterations = ctx.iterations;
  const storiesCompleted = ctx.storiesCompleted;
  const prdDirty = false;

  logger?.info("acceptance", "All stories complete, running acceptance validation");

  while (acceptanceRetries < maxRetries) {
    // ── 1. Run acceptance ────────────────────────────────────────────────
    const firstStory = prd.userStories[0];
    const acceptanceContext: PipelineContext = {
      config: ctx.config,
      rootConfig: ctx.config,
      prd,
      story: firstStory,
      stories: [firstStory],
      routing: {
        complexity: "simple",
        modelTier: "balanced",
        testStrategy: "test-after",
        reasoning: "Acceptance validation",
      },
      projectDir: ctx.workdir,
      workdir: ctx.workdir,
      naxIgnoreIndex: ctx.naxIgnoreIndex,
      featureDir: ctx.featureDir,
      hooks: ctx.hooks,
      plugins: ctx.pluginRegistry,
      agentGetFn: ctx.agentGetFn,
      acceptanceTestPaths: ctx.acceptanceTestPaths,
    };

    const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
    const acceptanceResult = await acceptanceStage.execute(acceptanceContext);

    if (acceptanceResult.action === "continue") {
      logger?.info("acceptance", "Acceptance validation passed!");
      return buildResult(true, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    if (acceptanceResult.action !== "fail") {
      logger?.warn("acceptance", `Unexpected acceptance result: ${acceptanceResult.action}`);
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    const failures = acceptanceContext.acceptanceFailures;
    if (!failures || failures.failedACs.length === 0) {
      logger?.error("acceptance", "Acceptance tests failed but no specific failures detected");
      await fireHook(
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, { reason: "Acceptance tests failed (no failures detected)", cost: totalCost }),
        ctx.workdir,
      );
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    // ── 2. retries++ ─────────────────────────────────────────────────────
    acceptanceRetries++;
    logger?.warn("acceptance", `Acceptance retry ${acceptanceRetries}/${maxRetries}`, {
      storyId: firstStory?.id,
      failedACs: failures.failedACs,
    });

    if (acceptanceRetries >= maxRetries) {
      logger?.error("acceptance", "Max acceptance retries reached", { storyId: firstStory?.id });
      await fireHook(
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, {
          reason: `Acceptance validation failed after ${maxRetries} retries: ${failures.failedACs.join(", ")}`,
          cost: totalCost,
        }),
        ctx.workdir,
      );
      return buildResult(
        false,
        prd,
        totalCost,
        iterations,
        storiesCompleted,
        prdDirty,
        failures.failedACs,
        acceptanceRetries,
      );
    }

    // ── 3. Stub guard (stubRegenCount capped at 2) ───────────────────────
    if (ctx.featureDir) {
      const existingStubPath = await findExistingAcceptanceTestPathFromOptions({
        acceptanceTestPaths: ctx.acceptanceTestPaths,
        featureDir: ctx.featureDir,
        testPathConfig: ctx.config.acceptance.testPath,
        language: ctx.config.project?.language,
      });
      if (existingStubPath && isStubTestFile(await Bun.file(existingStubPath).text())) {
        if (stubRegenCount >= MAX_STUB_REGENS) {
          logger?.error("acceptance", "Acceptance test generator cannot produce real tests — giving up", {
            storyId: firstStory?.id,
            stubRegenCount,
          });
          return buildResult(
            false,
            prd,
            totalCost,
            iterations,
            storiesCompleted,
            prdDirty,
            failures.failedACs,
            acceptanceRetries,
          );
        }
        stubRegenCount++;
        logger?.warn("acceptance", "Stub test detected — full regen", {
          storyId: firstStory?.id,
          attempt: stubRegenCount,
          maxStubRegens: MAX_STUB_REGENS,
        });
        await regenerateAcceptanceTestFn(existingStubPath, acceptanceContext);
        continue; // back to acceptance test
      }
    }

    // ── 4. Diagnose (fresh each iteration) ───────────────────────────────
    const semanticVerdicts = ctx.featureDir ? await _acceptanceLoopDeps.loadSemanticVerdicts(ctx.featureDir) : [];
    const totalACs = prd.userStories
      .filter((s) => !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria).length;

    const agentName = resolveDefaultAgent(ctx.config);
    const agent = (ctx.agentGetFn ?? _acceptanceLoopDeps.getAgent)(agentName);
    if (!agent) {
      logger?.error("acceptance", "Agent not found for diagnosis", { storyId: firstStory?.id, agentName });
      return buildResult(
        false,
        prd,
        totalCost,
        iterations,
        storiesCompleted,
        prdDirty,
        failures.failedACs,
        acceptanceRetries,
      );
    }

    // Load test file content for diagnosis
    const testEntries = ctx.acceptanceTestPaths
      ? await loadAcceptanceTestContentModule(ctx.acceptanceTestPaths.map((p) => p.testPath))
      : [];
    const testFileContent = testEntries[0]?.content ?? "";

    const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";
    const diagnosis = await resolveAcceptanceDiagnosis({
      agent,
      getAgent: (name: string) => (ctx.agentGetFn ?? _acceptanceLoopDeps.getAgent)(name),
      failures,
      totalACs,
      strategy,
      semanticVerdicts,
      diagnosisOpts: {
        testOutput: failures.testOutput,
        testFileContent,
        config: ctx.config,
        workdir: ctx.workdir,
        featureName: ctx.feature,
        storyId: firstStory?.id,
      },
      previousFailure,
    });

    logger?.info("acceptance.diagnosis", "Diagnosis resolved", {
      storyId: firstStory?.id,
      verdict: diagnosis.verdict,
      confidence: diagnosis.confidence,
      attempt: acceptanceRetries,
    });

    // ── 5. Apply fix (single attempt) ────────────────────────────────────
    const fixResult = await applyFix({
      ctx,
      failures,
      diagnosis,
      previousFailure,
    });
    totalCost += fixResult.cost;

    // ── 6. Accumulate previousFailure ────────────────────────────────────
    previousFailure += `\n---\nAttempt ${acceptanceRetries}/${maxRetries}: verdict=${diagnosis.verdict}, confidence=${diagnosis.confidence}\nReasoning: ${diagnosis.reasoning}\nFailed ACs: ${failures.failedACs.join(", ")}\n`;

    // ── 7. continue (always — back to step 1) ────────────────────────────
  }

  return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
}
