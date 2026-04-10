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
import { diagnoseAcceptanceFailure } from "../../acceptance/fix-diagnosis";
import { executeSourceFix } from "../../acceptance/fix-executor";
import { loadSemanticVerdicts } from "../../acceptance/semantic-verdict";
import {
  findExistingAcceptanceTestPath as findExistingAcceptanceTestPathFromOptions,
  resolveAcceptanceTestCandidates,
} from "../../acceptance/test-path";
import { resolveAcceptanceFeatureTestPath } from "../../acceptance/test-path";
import type { DiagnosisResult } from "../../acceptance/types";
import { getAgent } from "../../agents/registry";
import type { AgentAdapter } from "../../agents/types";
import type { NaxConfig } from "../../config";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import type { PipelineEventEmitter } from "../../pipeline/events";
import type { AgentGetFn, PipelineContext } from "../../pipeline/types";
import type { PluginRegistry } from "../../plugins";
import type { PRD } from "../../prd/types";
import { hookCtx } from "../helpers";
import type { StatusWriter } from "../status-writer";
import {
  buildResult,
  isStubTestFile,
  isTestLevelFailure,
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
  executeTestRegen: async (
    ctx: AcceptanceLoopContext,
    acceptanceContext: PipelineContext,
    previousFailure?: string,
  ): Promise<"passed" | "failed" | "no_test_file"> => {
    const testPath = await findExistingAcceptanceTestPathFromOptions({
      acceptanceTestPaths: ctx.acceptanceTestPaths,
      featureDir: ctx.featureDir,
      testPathConfig: ctx.config.acceptance.testPath,
      language: ctx.config.project?.language,
    });
    if (!testPath) return "no_test_file";
    const regenerated = await regenerateAcceptanceTestFn(testPath, acceptanceContext, previousFailure);
    if (!regenerated) return "failed";
    const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
    const result = await acceptanceStage.execute(acceptanceContext);
    return result.action === "continue" ? "passed" : "failed";
  },
};

// _regenerateDeps, regenerateAcceptanceTest, generateAndAddFixStories, executeFixStory
// — extracted to acceptance-helpers.ts or deleted (dead code)

export interface FixRoutingOptions {
  ctx: AcceptanceLoopContext;
  failures: { failedACs: string[]; testOutput: string };
  prd?: PRD;
  acceptanceContext?: PipelineContext;
  semanticVerdicts?: Array<{
    storyId: string;
    passed: boolean;
    timestamp: string;
    acCount: number;
    findings: unknown[];
  }>;
}

interface FixRoutingResult {
  fixed: boolean;
  cost: number;
  prdDirty: boolean;
  verdict?: string;
  confidence?: number;
  reasoning?: string;
}

/**
 * Run fix routing based on strategy (diagnose-first or implement-only).
 *
 * When strategy is 'diagnose-first':
 * - Calls diagnoseAcceptanceFailure() to get diagnosis
 * - Routes based on verdict: source_bug → executeSourceFix, test_bug → regenerateAcceptanceTest, both → both
 *
 * When strategy is 'implement-only':
 * - Calls executeSourceFix() directly without diagnosis
 *
 * Emits JSONL events for acceptance.diagnosis, acceptance.source-fix, and acceptance.test-regen.
 */
export async function runFixRouting(options: FixRoutingOptions): Promise<FixRoutingResult> {
  const logger = getSafeLogger();
  const { ctx, failures, acceptanceContext } = options;
  const prd = options.prd ?? (ctx as unknown as { prd: PRD }).prd;

  // Fast path: when all semantic verdicts passed, skip diagnosis — it's a test bug
  const semanticVerdicts = options.semanticVerdicts;
  if (semanticVerdicts && semanticVerdicts.length > 0 && semanticVerdicts.every((v) => v.passed)) {
    const verdictCount = semanticVerdicts.length;
    const storyId = acceptanceContext?.story?.id ?? prd?.userStories?.[0]?.id ?? "unknown";
    logger?.info("acceptance", "All semantic verdicts passed — routing to test regeneration", {
      storyId,
      verdictCount,
    });

    // Guard: need featureDir and acceptanceContext to regenerate
    if (!ctx.featureDir || !acceptanceContext) {
      logger?.warn("acceptance", "Cannot regenerate test — featureDir or acceptanceContext missing", { storyId });
      return {
        fixed: false,
        cost: 0,
        prdDirty: false,
        verdict: "test_bug",
        confidence: 1.0,
        reasoning:
          "Semantic review confirmed all ACs are implemented — acceptance test failure is a test generation issue",
      };
    }

    const semanticFailureContext = `All semantic verdicts passed (${verdictCount} stories) but acceptance tests failed. This is a test generation bug, not a source bug.\n\nFailing test output:\n${failures.testOutput}`;
    const regenOutcome = await _acceptanceLoopDeps.executeTestRegen(ctx, acceptanceContext, semanticFailureContext);
    logger?.info("acceptance.test-regen", "Test regeneration completed", { storyId, outcome: regenOutcome });

    if (regenOutcome === "passed") {
      return { fixed: true, cost: 0, prdDirty: true };
    }
    return {
      fixed: false,
      cost: 0,
      prdDirty: regenOutcome !== "no_test_file",
      verdict: "test_bug",
      confidence: 1.0,
      reasoning:
        "Semantic review confirmed all ACs are implemented — acceptance test failure is a test generation issue",
    };
  }

  const agentName = ctx.config.autoMode.defaultAgent;
  const agent = (ctx.agentGetFn ?? _acceptanceLoopDeps.getAgent)(agentName);

  const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";
  const fixMaxRetries = ctx.config.acceptance.fix?.maxRetries ?? 2;

  const testPaths = ctx.acceptanceTestPaths;
  let testEntries: Array<{ content: string; path: string }>;
  if (testPaths && testPaths.length > 0) {
    const pathStrings = testPaths.map((p) => (typeof p === "string" ? p : p.testPath));
    const moduleEntries = await loadAcceptanceTestContentModule(pathStrings);
    testEntries = moduleEntries.map((e) => ({ content: e.content, path: e.testPath }));
  } else {
    const fallbackPath = ctx.featureDir
      ? resolveAcceptanceFeatureTestPath(ctx.featureDir, ctx.config.acceptance.testPath, ctx.config.project?.language)
      : undefined;
    const moduleEntries = await loadAcceptanceTestContentModule(fallbackPath);
    testEntries = moduleEntries.map((e) => ({ content: e.content, path: e.testPath }));
  }
  const primaryEntry = testEntries[0] ?? { content: "", path: "" };
  const testFileContent = primaryEntry.content;
  const acceptanceTestPath = primaryEntry.path;
  const firstStory = prd?.userStories?.[0];
  const storyId = firstStory?.id ?? "unknown";

  // No failures to fix — return early
  if (failures.failedACs.length === 0) {
    return { fixed: true, cost: 0, prdDirty: false };
  }

  if (strategy === "implement-only") {
    logger?.info("acceptance", "Strategy is implement-only — executing source fix directly");

    if (!agent) {
      logger?.error("acceptance", "Agent not found for fix routing");
      return { fixed: false, cost: 0, prdDirty: false };
    }

    let fixAttempts = 0;
    while (fixAttempts < fixMaxRetries) {
      fixAttempts++;
      logger?.info("acceptance", `Source fix attempt ${fixAttempts}/${fixMaxRetries}`);

      const defaultDiagnosis: DiagnosisResult = {
        verdict: "source_bug",
        reasoning: "implement-only strategy — skipping diagnosis",
        confidence: 1.0,
      };

      const fixResult = await executeSourceFix(agent, {
        testOutput: failures.testOutput,
        testFileContent,
        diagnosis: defaultDiagnosis,
        config: ctx.config,
        workdir: ctx.workdir,
        featureName: ctx.feature,
        storyId,
        acceptanceTestPath,
      });

      logger?.info("acceptance.source-fix", "Source fix completed", {
        success: fixResult.success,
        cost: fixResult.cost,
        attempt: fixAttempts,
      });

      if (fixResult.success) {
        return { fixed: true, cost: fixResult.cost, prdDirty: false };
      }
      logger?.warn("acceptance.source-fix", "Source fix attempt failed", {
        attempt: fixAttempts,
        maxRetries: fixMaxRetries,
        cost: fixResult.cost,
        willRetry: fixAttempts < fixMaxRetries,
      });

      if (fixAttempts >= fixMaxRetries) {
        logger?.error("acceptance", `Source fix failed after ${fixMaxRetries} attempts`);
        break;
      }
    }

    return { fixed: false, cost: 0, prdDirty: false };
  }

  logger?.info("acceptance", "Strategy is diagnose-first — running diagnosis");
  const diagnosis = await diagnoseAcceptanceFailure(agent as AgentAdapter, {
    testOutput: failures.testOutput,
    testFileContent,
    config: ctx.config,
    workdir: ctx.workdir,
    featureName: ctx.feature,
    storyId,
    semanticVerdicts: options.semanticVerdicts as import("../../acceptance/types").SemanticVerdict[] | undefined,
  });

  const diagnosisCost = diagnosis.cost ?? 0;

  logger?.info("acceptance.diagnosis", "Diagnosis complete", {
    verdict: diagnosis.verdict,
    confidence: diagnosis.confidence,
    reasoning: diagnosis.reasoning,
  });

  if (diagnosis.verdict === "source_bug") {
    logger?.info("acceptance", "Diagnosis: source_bug — executing source fix");

    if (!agent) {
      logger?.error("acceptance", "Agent not found for source fix execution");
      return { fixed: false, cost: diagnosisCost, prdDirty: false };
    }

    let fixAttempts = 0;
    while (fixAttempts < fixMaxRetries) {
      fixAttempts++;
      logger?.info("acceptance", `Source fix attempt ${fixAttempts}/${fixMaxRetries}`);

      const fixResult = await executeSourceFix(agent, {
        testOutput: failures.testOutput,
        testFileContent,
        diagnosis,
        config: ctx.config,
        workdir: ctx.workdir,
        featureName: ctx.feature,
        storyId,
        acceptanceTestPath,
      });

      logger?.info("acceptance.source-fix", "Source fix completed", {
        success: fixResult.success,
        cost: fixResult.cost,
        attempt: fixAttempts,
      });

      if (fixResult.success) {
        return { fixed: true, cost: fixResult.cost + diagnosisCost, prdDirty: false };
      }
      logger?.warn("acceptance.source-fix", "Source fix attempt failed", {
        attempt: fixAttempts,
        maxRetries: fixMaxRetries,
        cost: fixResult.cost,
        willRetry: fixAttempts < fixMaxRetries,
      });

      if (fixAttempts >= fixMaxRetries) {
        logger?.error("acceptance", `Source fix failed after ${fixMaxRetries} attempts`);
        break;
      }
    }

    return { fixed: false, cost: diagnosisCost, prdDirty: false };
  }

  if (diagnosis.verdict === "test_bug") {
    logger?.info("acceptance", "Diagnosis: test_bug — regenerating acceptance test");

    if (!ctx.featureDir) {
      logger?.error("acceptance", "Cannot regenerate test without featureDir");
      return { fixed: false, cost: diagnosisCost, prdDirty: false };
    }

    const testPath = await findExistingAcceptanceTestPathFromOptions({
      acceptanceTestPaths: ctx.acceptanceTestPaths,
      featureDir: ctx.featureDir,
      testPathConfig: ctx.config.acceptance.testPath,
      language: ctx.config.project?.language,
    });
    if (!testPath) {
      logger?.error("acceptance", "Acceptance test file not found for regeneration", {
        candidates: resolveAcceptanceTestCandidates({
          acceptanceTestPaths: ctx.acceptanceTestPaths,
          featureDir: ctx.featureDir,
          testPathConfig: ctx.config.acceptance.testPath,
          language: ctx.config.project?.language,
        }),
      });
      return { fixed: false, cost: diagnosisCost, prdDirty: false };
    }

    const failureContext = `Diagnosis: ${diagnosis.reasoning}\n\nFailing test output:\n${failures.testOutput}`;
    const regenerated = await regenerateAcceptanceTestFn(
      testPath,
      acceptanceContext as PipelineContext,
      failureContext,
    );

    logger?.info("acceptance.test-regen", "Test regeneration completed", {
      outcome: regenerated ? "success" : "failure",
    });

    if (!regenerated) {
      return { fixed: false, cost: diagnosisCost, prdDirty: false };
    }

    const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
    const acceptanceResult = await acceptanceStage.execute(acceptanceContext as PipelineContext);

    if (acceptanceResult.action === "continue") {
      logger?.info("acceptance", "Acceptance passed after test regeneration");
      return { fixed: true, cost: diagnosisCost, prdDirty: true };
    }

    logger?.warn("acceptance", "Acceptance still failing after test regeneration");
    return { fixed: false, cost: diagnosisCost, prdDirty: true };
  }

  if (diagnosis.verdict === "both") {
    logger?.info("acceptance", "Diagnosis: both — executing source fix then regenerating test if needed");

    if (!agent) {
      logger?.error("acceptance", "Agent not found for source fix execution");
      return { fixed: false, cost: diagnosisCost, prdDirty: false };
    }

    let sourceFixSuccess = false;
    let sourceFixCost = 0;

    let fixAttempts = 0;
    while (fixAttempts < fixMaxRetries && !sourceFixSuccess) {
      fixAttempts++;
      logger?.info("acceptance", `Source fix attempt ${fixAttempts}/${fixMaxRetries}`);

      const fixResult = await executeSourceFix(agent, {
        testOutput: failures.testOutput,
        testFileContent,
        diagnosis,
        config: ctx.config,
        workdir: ctx.workdir,
        featureName: ctx.feature,
        storyId,
        acceptanceTestPath,
      });

      logger?.info("acceptance.source-fix", "Source fix completed", {
        success: fixResult.success,
        cost: fixResult.cost,
        attempt: fixAttempts,
      });

      sourceFixSuccess = fixResult.success;
      sourceFixCost += fixResult.cost;

      if (fixResult.success) {
        break;
      }
      logger?.warn("acceptance.source-fix", "Source fix attempt failed", {
        attempt: fixAttempts,
        maxRetries: fixMaxRetries,
        cost: fixResult.cost,
        willRetry: fixAttempts < fixMaxRetries,
      });

      if (fixAttempts >= fixMaxRetries) {
        logger?.error("acceptance", `Source fix failed after ${fixMaxRetries} attempts`);
        break;
      }
    }

    if (!sourceFixSuccess) {
      return { fixed: false, cost: sourceFixCost + diagnosisCost, prdDirty: false };
    }

    logger?.info("acceptance", "Source fix succeeded — re-running acceptance to verify");

    const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
    const acceptanceResult = await acceptanceStage.execute(acceptanceContext as PipelineContext);

    if (acceptanceResult.action === "continue") {
      logger?.info("acceptance", "Acceptance passed after source fix");
      return { fixed: true, cost: sourceFixCost + diagnosisCost, prdDirty: false };
    }

    logger?.info("acceptance", "Acceptance still failing after source fix — regenerating test");

    if (!ctx.featureDir) {
      logger?.error("acceptance", "Cannot regenerate test without featureDir");
      return { fixed: false, cost: sourceFixCost + diagnosisCost, prdDirty: false };
    }

    const testPath = await findExistingAcceptanceTestPathFromOptions({
      acceptanceTestPaths: ctx.acceptanceTestPaths,
      featureDir: ctx.featureDir,
      testPathConfig: ctx.config.acceptance.testPath,
      language: ctx.config.project?.language,
    });
    if (!testPath) {
      logger?.error("acceptance", "Acceptance test file not found for regeneration", {
        candidates: resolveAcceptanceTestCandidates({
          acceptanceTestPaths: ctx.acceptanceTestPaths,
          featureDir: ctx.featureDir,
          testPathConfig: ctx.config.acceptance.testPath,
          language: ctx.config.project?.language,
        }),
      });
      return { fixed: false, cost: sourceFixCost + diagnosisCost, prdDirty: false };
    }

    const bothFailureContext = `Diagnosis: ${diagnosis.reasoning}\n\nFailing test output:\n${failures.testOutput}`;
    const regenerated = await regenerateAcceptanceTestFn(
      testPath,
      acceptanceContext as PipelineContext,
      bothFailureContext,
    );

    logger?.info("acceptance.test-regen", "Test regeneration completed", {
      outcome: regenerated ? "success" : "failure",
    });

    return { fixed: regenerated, cost: sourceFixCost + diagnosisCost, prdDirty: regenerated };
  }

  return { fixed: false, cost: diagnosisCost, prdDirty: false };
}

/**
 * Run the acceptance retry loop
 *
 * Executes acceptance tests and handles retry logic with fix story generation.
 */
export async function runAcceptanceLoop(ctx: AcceptanceLoopContext): Promise<AcceptanceLoopResult> {
  const logger = getSafeLogger();
  const maxRetries = ctx.config.acceptance.maxRetries;

  let acceptanceRetries = 0;
  const prd = ctx.prd;
  let totalCost = ctx.totalCost;
  const iterations = ctx.iterations;
  const storiesCompleted = ctx.storiesCompleted;
  const prdDirty = false;

  logger?.info("acceptance", "All stories complete, running acceptance validation");

  while (acceptanceRetries < maxRetries) {
    // Run acceptance validation — use per-package test paths when available (monorepo aware)
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

    // Handle acceptance test failures
    const failures = acceptanceContext.acceptanceFailures;
    if (!failures || failures.failedACs.length === 0) {
      logger?.error("acceptance", "Acceptance tests failed but no specific failures detected");
      logger?.warn("acceptance", "Manual intervention required");
      await fireHook(
        ctx.hooks,
        "on-pause",
        hookCtx(ctx.feature, { reason: "Acceptance tests failed (no failures detected)", cost: totalCost }),
        ctx.workdir,
      );
      return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
    }

    acceptanceRetries++;
    logger?.warn("acceptance", `Acceptance retry ${acceptanceRetries}/${maxRetries}`, {
      failedACs: failures.failedACs,
    });

    if (acceptanceRetries >= maxRetries) {
      logger?.error("acceptance", "Max acceptance retries reached");
      logger?.warn("acceptance", "Manual intervention required");
      logger?.debug("acceptance", 'Run: nax accept --override AC-N "reason" to skip specific ACs');
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

    // Check for stub test file before other checks
    if (ctx.featureDir) {
      const existingStubPath = await findExistingAcceptanceTestPathFromOptions({
        acceptanceTestPaths: ctx.acceptanceTestPaths,
        featureDir: ctx.featureDir,
        testPathConfig: ctx.config.acceptance.testPath,
        language: ctx.config.project?.language,
      });
      if (existingStubPath) {
        const testContent = await Bun.file(existingStubPath).text();
        if (isStubTestFile(testContent)) {
          logger?.warn("acceptance", "Stub tests detected — re-generating acceptance tests", {
            testPath: existingStubPath,
          });
          const { unlink } = await import("node:fs/promises");
          await unlink(existingStubPath);
          const { acceptanceSetupStage } = await import("../../pipeline/stages/acceptance-setup");
          await acceptanceSetupStage.execute(acceptanceContext);
          const newContent = await Bun.file(existingStubPath).text();
          if (isStubTestFile(newContent)) {
            logger?.error(
              "acceptance",
              "Acceptance test generation failed after retry — manual implementation required",
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
          continue;
        }
      }
    }

    // P1-D / D2: Detect test-level failure — regenerate instead of fixing
    // Count total ACs from non-fix stories only
    const totalACs = prd.userStories
      .filter((s) => !s.id.startsWith("US-FIX-"))
      .flatMap((s) => s.acceptanceCriteria).length;

    if (ctx.featureDir && isTestLevelFailure(failures.failedACs, totalACs)) {
      logger?.warn(
        "acceptance",
        `Test-level failure detected (${failures.failedACs.length}/${totalACs} ACs failed) — regenerating acceptance test`,
      );
      const testPath = await findExistingAcceptanceTestPathFromOptions({
        acceptanceTestPaths: ctx.acceptanceTestPaths,
        featureDir: ctx.featureDir,
        testPathConfig: ctx.config.acceptance.testPath,
        language: ctx.config.project?.language,
      });
      if (testPath) {
        const testLevelFailureContext = `Test-level failure: ${failures.failedACs.length}/${totalACs} ACs failed.\n\nFailing test output:\n${failures.testOutput}`;
        const regenerated = await regenerateAcceptanceTestFn(testPath, acceptanceContext, testLevelFailureContext);
        if (!regenerated) {
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
        continue; // retry with regenerated test
      }
    }

    // Run fix routing based on strategy
    const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";
    if (strategy === "diagnose-first" || strategy === "implement-only") {
      logger?.info("acceptance", `Running fix routing with strategy: ${strategy}`);

      const semanticVerdicts = ctx.featureDir ? await _acceptanceLoopDeps.loadSemanticVerdicts(ctx.featureDir) : [];
      const fixResult = await runFixRouting({
        ctx,
        failures,
        prd,
        acceptanceContext,
        semanticVerdicts,
      });

      totalCost += fixResult.cost;

      if (fixResult.fixed) {
        logger?.info("acceptance", "Fix succeeded — re-running acceptance tests...");
        continue;
      }

      logger?.error("acceptance", "Fix routing failed to resolve acceptance failures");
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

    // Legacy fallback path removed — strategy is always "diagnose-first" | "implement-only"
    // (enforced by Zod enum in AcceptanceFixConfigSchema). The if-block above is always entered.
  }

  return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
}
