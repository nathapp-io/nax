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

import path, { join } from "node:path";
import { type FixStory, convertFixStoryToUserStory, generateFixStories } from "../../acceptance";
import { diagnoseAcceptanceFailure } from "../../acceptance/fix-diagnosis";
import { executeSourceFix } from "../../acceptance/fix-executor";
import type { DiagnosisResult } from "../../acceptance/types";
import { getAgent } from "../../agents/registry";
import type { AgentAdapter } from "../../agents/types";
import type { NaxConfig } from "../../config";
import { resolveModelForAgent } from "../../config";
import { loadConfigForWorkdir } from "../../config/loader";
import { type LoadedHooksConfig, fireHook } from "../../hooks";
import { getSafeLogger } from "../../logger";
import type { StoryMetrics } from "../../metrics";
import type { PipelineEventEmitter } from "../../pipeline/events";
import { runPipeline } from "../../pipeline/runner";
import { defaultPipeline } from "../../pipeline/stages";
import type { AgentGetFn } from "../../pipeline/types";
import type { PipelineContext, RoutingResult } from "../../pipeline/types";
import type { PluginRegistry } from "../../plugins";
import { loadPRD, savePRD } from "../../prd";
import type { PRD, UserStory } from "../../prd/types";
import { routeTask } from "../../routing";
import { hookCtx } from "../helpers";
import type { StatusWriter } from "../status-writer";

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

export function isStubTestFile(content: string): boolean {
  // Detect skeleton stubs: expect(true).toBe(false) or expect(true).toBe(true) in test bodies
  return /expect\s*\(\s*true\s*\)\s*\.\s*toBe\s*\(\s*(?:false|true)\s*\)/.test(content);
}

/**
 * Detect test-level failure (P1-D, D2).
 *
 * Returns true when the failure is likely a test bug rather than implementation gaps:
 * - All semantic verdicts passed (overrides ratio check)
 * - Test crashed with no ACs parsed ("AC-ERROR" sentinel)
 * - More than 80% of total ACs failed
 *
 * @param failedACs - ACs that failed in this run (or number of failed ACs)
 * @param totalACs - Total ACs across all non-fix stories
 * @param semanticVerdicts - Optional semantic verdicts; when all passed, returns true
 */
export function isTestLevelFailure(
  failedACs: string[] | number,
  totalACs: number,
  semanticVerdicts?: Array<{ passed: boolean }>,
): boolean {
  // When all semantic verdicts passed, this is a test-level failure
  if (semanticVerdicts && semanticVerdicts.length > 0 && semanticVerdicts.every((v) => v.passed)) {
    return true;
  }

  const failedCount = typeof failedACs === "number" ? failedACs : failedACs.length;
  const hasACError = Array.isArray(failedACs) && failedACs.includes("AC-ERROR");

  if (hasACError) return true;
  if (totalACs === 0) return false;
  return failedCount / totalACs > 0.8;
}

/** Load spec.md content for AC text */
async function loadSpecContent(featureDir?: string): Promise<string> {
  if (!featureDir) return "";
  const specPath = path.join(featureDir, "spec.md");
  const specFile = Bun.file(specPath);
  return (await specFile.exists()) ? await specFile.text() : "";
}

/**
 * Load acceptance test file content.
 *
 * When `testPaths` is provided, returns content for each per-package test file.
 * When `testPaths` is omitted, falls back to reading the single acceptance.test.ts
 * from `featureDir` (legacy behavior).
 *
 * @param featureDir - Feature directory (legacy fallback)
 * @param testPaths - Per-package test paths array (takes priority over featureDir)
 * @returns Array of { content, path } pairs
 */
export async function loadAcceptanceTestContent(
  featureDir?: string,
  testPaths?: Array<{ testPath: string; packageDir: string }>,
): Promise<Array<{ content: string; path: string }>> {
  if (!featureDir) return [];

  if (testPaths && testPaths.length > 0) {
    const results: Array<{ content: string; path: string }> = [];
    for (const { testPath } of testPaths) {
      const testFile = Bun.file(testPath);
      if (await testFile.exists()) {
        const content = await testFile.text();
        results.push({ content, path: testPath });
      }
    }
    return results;
  }

  const legacyPath = path.join(featureDir, "acceptance.test.ts");
  const testFile = Bun.file(legacyPath);
  const content = (await testFile.exists()) ? await testFile.text() : "";
  return [{ content, path: legacyPath }];
}

/** Build result object for loop exit */
function buildResult(
  success: boolean,
  prd: PRD,
  totalCost: number,
  iterations: number,
  storiesCompleted: number,
  prdDirty: boolean,
  failedACs?: string[],
  retries?: number,
): AcceptanceLoopResult {
  return { success, prd, totalCost, iterations, storiesCompleted, prdDirty, failedACs, retries };
}

export const _acceptanceLoopDeps = { getAgent };

/** Injectable dependencies for regenerateAcceptanceTest — allows tests to mock I/O without real disk or git. */
export const _regenerateDeps = {
  spawnGitDiff: async (workdir: string, gitRef: string): Promise<string> => {
    const proc = Bun.spawn(["git", "diff", "--name-only", gitRef], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return stdout.trim();
  },
  readFile: async (filePath: string): Promise<string> => Bun.file(filePath).text(),
  acceptanceSetupExecute: async (ctx: PipelineContext): Promise<void> => {
    const { acceptanceSetupStage } = await import("../../pipeline/stages/acceptance-setup");
    await acceptanceSetupStage.execute(ctx);
  },
};

/** Generate and add fix stories to PRD */
async function generateAndAddFixStories(
  ctx: AcceptanceLoopContext,
  failures: { failedACs: string[]; testOutput: string },
  prd: PRD,
): Promise<FixStory[] | null> {
  const logger = getSafeLogger();
  const agent = (ctx.agentGetFn ?? _acceptanceLoopDeps.getAgent)(ctx.config.autoMode.defaultAgent);
  if (!agent) {
    logger?.error("acceptance", "Agent not found, cannot generate fix stories");
    return null;
  }
  const modelDef = resolveModelForAgent(
    ctx.config.models,
    ctx.config.autoMode.defaultAgent,
    ctx.config.analyze.model,
    ctx.config.autoMode.defaultAgent,
  );
  const testFilePath = ctx.featureDir ? path.join(ctx.featureDir, "acceptance.test.ts") : undefined;
  const fixStories = await generateFixStories(agent, {
    failedACs: failures.failedACs,
    testOutput: failures.testOutput,
    prd,
    specContent: await loadSpecContent(ctx.featureDir),
    workdir: ctx.workdir,
    modelDef,
    config: ctx.config,
    testFilePath,
    timeoutMs: ctx.config.acceptance?.timeoutMs,
  });
  if (fixStories.length === 0) {
    logger?.error("acceptance", "Failed to generate fix stories");
    return null;
  }
  logger?.info("acceptance", `Generated ${fixStories.length} fix stories`);
  for (const fixStory of fixStories) {
    const userStory = convertFixStoryToUserStory(fixStory);
    prd.userStories.push(userStory);
    logger?.debug("acceptance", `Fix story added: ${userStory.id}: ${userStory.title}`);
  }
  return fixStories;
}

/** Execute a single fix story through the pipeline */
async function executeFixStory(
  ctx: AcceptanceLoopContext,
  story: UserStory,
  prd: PRD,
  iterations: number,
): Promise<{ success: boolean; cost: number; metrics?: StoryMetrics[] }> {
  const logger = getSafeLogger();
  const routing = routeTask(story.title, story.description, story.acceptanceCriteria, story.tags, ctx.config);
  logger?.info("acceptance", `Starting fix story: ${story.id}`, { storyId: story.id, storyTitle: story.title });
  await fireHook(
    ctx.hooks,
    "on-story-start",
    hookCtx(ctx.feature, {
      storyId: story.id,
      model: routing.modelTier,
      agent: ctx.config.autoMode.defaultAgent,
      iteration: iterations,
    }),
    ctx.workdir,
  );
  // PKG: resolve per-package effective config for fix stories (same as iteration-runner)
  const fixEffectiveConfig = story.workdir
    ? await loadConfigForWorkdir(join(ctx.workdir, ".nax", "config.json"), story.workdir)
    : ctx.config;
  const fixContext: PipelineContext = {
    config: ctx.config,
    effectiveConfig: fixEffectiveConfig,
    prd,
    story,
    stories: [story],
    routing: routing as RoutingResult,
    workdir: ctx.workdir,
    featureDir: ctx.featureDir,
    hooks: ctx.hooks,
    plugins: ctx.pluginRegistry,
    storyStartTime: new Date().toISOString(),
    agentGetFn: ctx.agentGetFn,
  };
  const result = await runPipeline(defaultPipeline, fixContext, ctx.eventEmitter);
  logger?.info("acceptance", `Fix story ${story.id} ${result.success ? "passed" : "failed"}`);
  return {
    success: result.success,
    cost: result.context.agentResult?.estimatedCost || 0,
    metrics: result.context.storyMetrics,
  };
}

/**
 * Back up and regenerate the acceptance test file (P1-D, D2).
 *
 * Steps:
 * 1. Copy acceptance.test.ts → acceptance.test.ts.bak
 * 2. Delete acceptance.test.ts
 * 3. Re-run acceptance-setup to generate fresh test
 *
 * @returns true if regeneration succeeded, false otherwise
 */
export async function regenerateAcceptanceTest(testPath: string, acceptanceContext: PipelineContext): Promise<boolean> {
  const logger = getSafeLogger();
  const bakPath = `${testPath}.bak`;

  const content = await Bun.file(testPath).text();
  await Bun.write(bakPath, content);
  logger?.info("acceptance", `Backed up acceptance test -> ${bakPath}`);

  const { unlink } = await import("node:fs/promises");
  await unlink(testPath);

  // Collect implementation context from git diff when storyGitRef is available
  let implementationContext: Array<{ path: string; content: string }> | undefined;
  const storyGitRef = acceptanceContext.storyGitRef;
  const workdir = acceptanceContext.workdir;

  if (storyGitRef) {
    try {
      const diffOutput = await _regenerateDeps.spawnGitDiff(workdir, storyGitRef);
      const changedFiles = diffOutput
        .split("\n")
        .map((f) => f.trim())
        .filter((f) => f.length > 0);

      const MAX_BYTES = 50 * 1024;
      let totalBytes = 0;
      const entries: Array<{ path: string; content: string }> = [];

      for (const file of changedFiles) {
        if (totalBytes >= MAX_BYTES) break;
        const filePath = path.join(workdir, file);
        try {
          const fileContent = await _regenerateDeps.readFile(filePath);
          const remaining = MAX_BYTES - totalBytes;
          const trimmed = fileContent.length > remaining ? fileContent.slice(0, remaining) : fileContent;
          entries.push({ path: file, content: trimmed });
          totalBytes += trimmed.length;
        } catch {
          // skip unreadable files
        }
      }

      if (entries.length > 0) {
        implementationContext = entries;
      }
    } catch {
      // git diff failed — proceed without implementation context
    }
  }

  const contextForSetup: PipelineContext & { implementationContext?: Array<{ path: string; content: string }> } = {
    ...acceptanceContext,
    ...(implementationContext ? { implementationContext } : {}),
  };

  await _regenerateDeps.acceptanceSetupExecute(contextForSetup as PipelineContext);

  if (!(await Bun.file(testPath).exists())) {
    logger?.error("acceptance", "Acceptance test regeneration failed — manual intervention required");
    return false;
  }

  logger?.info("acceptance", "Acceptance test regenerated successfully");
  return true;
}

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
    logger?.info("acceptance", "All semantic verdicts passed", { verdictCount: semanticVerdicts.length });
    return {
      fixed: false,
      cost: 0,
      prdDirty: false,
      verdict: "test_bug",
      confidence: 1.0,
      reasoning: "Semantic review confirmed all stories passed — failure is in the test",
    };
  }

  const agentName = ctx.config.autoMode.defaultAgent;
  const agent = (ctx.agentGetFn ?? _acceptanceLoopDeps.getAgent)(agentName);

  const strategy = ctx.config.acceptance.fix?.strategy ?? "diagnose-first";
  const fixMaxRetries = ctx.config.acceptance.fix?.maxRetries ?? 2;

  const { loadAcceptanceTestContent: loadContent } = await import("../../acceptance/content-loader");
  const testPaths = ctx.acceptanceTestPaths;
  const testEntries = testPaths
    ? await loadContent(testPaths as unknown as string[])
    : await loadContent(
        ctx.featureDir ? path.join(ctx.featureDir, ctx.config.acceptance.testPath ?? "acceptance.test.ts") : undefined,
      );
  const primaryEntry = testEntries[0] ?? { content: "", testPath: "" };
  const testFileContent = primaryEntry.content;
  const acceptanceTestPath = primaryEntry.testPath;
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
  });

  logger?.info("acceptance.diagnosis", "Diagnosis complete", {
    verdict: diagnosis.verdict,
    confidence: diagnosis.confidence,
    reasoning: diagnosis.reasoning,
  });

  if (diagnosis.verdict === "source_bug") {
    logger?.info("acceptance", "Diagnosis: source_bug — executing source fix");

    if (!agent) {
      logger?.error("acceptance", "Agent not found for source fix execution");
      return { fixed: false, cost: 0, prdDirty: false };
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
        return { fixed: true, cost: fixResult.cost, prdDirty: false };
      }

      if (fixAttempts >= fixMaxRetries) {
        logger?.error("acceptance", `Source fix failed after ${fixMaxRetries} attempts`);
        break;
      }
    }

    return { fixed: false, cost: 0, prdDirty: false };
  }

  if (diagnosis.verdict === "test_bug") {
    logger?.info("acceptance", "Diagnosis: test_bug — regenerating acceptance test");

    if (!ctx.featureDir) {
      logger?.error("acceptance", "Cannot regenerate test without featureDir");
      return { fixed: false, cost: 0, prdDirty: false };
    }

    const testPath = path.join(ctx.featureDir, "acceptance.test.ts");
    const testFile = Bun.file(testPath);
    if (!(await testFile.exists())) {
      logger?.error("acceptance", "Acceptance test file not found for regeneration");
      return { fixed: false, cost: 0, prdDirty: false };
    }

    const regenerated = await regenerateAcceptanceTest(testPath, acceptanceContext as PipelineContext);

    logger?.info("acceptance.test-regen", "Test regeneration completed", {
      outcome: regenerated ? "success" : "failure",
    });

    if (!regenerated) {
      return { fixed: false, cost: 0, prdDirty: false };
    }

    const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
    const acceptanceResult = await acceptanceStage.execute(acceptanceContext as PipelineContext);

    if (acceptanceResult.action === "continue") {
      logger?.info("acceptance", "Acceptance passed after test regeneration");
      return { fixed: true, cost: 0, prdDirty: true };
    }

    logger?.warn("acceptance", "Acceptance still failing after test regeneration");
    return { fixed: false, cost: 0, prdDirty: true };
  }

  if (diagnosis.verdict === "both") {
    logger?.info("acceptance", "Diagnosis: both — executing source fix then regenerating test if needed");

    if (!agent) {
      logger?.error("acceptance", "Agent not found for source fix execution");
      return { fixed: false, cost: 0, prdDirty: false };
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

      if (fixAttempts >= fixMaxRetries) {
        logger?.error("acceptance", `Source fix failed after ${fixMaxRetries} attempts`);
        break;
      }
    }

    if (!sourceFixSuccess) {
      return { fixed: false, cost: sourceFixCost, prdDirty: false };
    }

    logger?.info("acceptance", "Source fix succeeded — re-running acceptance to verify");

    const { acceptanceStage } = await import("../../pipeline/stages/acceptance");
    const acceptanceResult = await acceptanceStage.execute(acceptanceContext as PipelineContext);

    if (acceptanceResult.action === "continue") {
      logger?.info("acceptance", "Acceptance passed after source fix");
      return { fixed: true, cost: sourceFixCost, prdDirty: false };
    }

    logger?.info("acceptance", "Acceptance still failing after source fix — regenerating test");

    if (!ctx.featureDir) {
      logger?.error("acceptance", "Cannot regenerate test without featureDir");
      return { fixed: false, cost: sourceFixCost, prdDirty: false };
    }

    const testPath = path.join(ctx.featureDir, "acceptance.test.ts");
    const testFile = Bun.file(testPath);
    if (!(await testFile.exists())) {
      logger?.error("acceptance", "Acceptance test file not found for regeneration");
      return { fixed: false, cost: sourceFixCost, prdDirty: false };
    }

    const regenerated = await regenerateAcceptanceTest(testPath, acceptanceContext as PipelineContext);

    logger?.info("acceptance.test-regen", "Test regeneration completed", {
      outcome: regenerated ? "success" : "failure",
    });

    return { fixed: regenerated, cost: sourceFixCost, prdDirty: regenerated };
  }

  return { fixed: false, cost: 0, prdDirty: false };
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
  let prd = ctx.prd;
  let totalCost = ctx.totalCost;
  let iterations = ctx.iterations;
  let storiesCompleted = ctx.storiesCompleted;
  let prdDirty = false;

  logger?.info("acceptance", "All stories complete, running acceptance validation");

  while (acceptanceRetries < maxRetries) {
    // Run acceptance validation — always from repo root (covers single repo + monorepo)
    const firstStory = prd.userStories[0];
    const acceptanceContext: PipelineContext = {
      config: ctx.config,
      effectiveConfig: ctx.config,
      prd,
      story: firstStory,
      stories: [firstStory],
      routing: {
        complexity: "simple",
        modelTier: "balanced",
        testStrategy: "test-after",
        reasoning: "Acceptance validation",
      },
      workdir: ctx.workdir,
      featureDir: ctx.featureDir,
      hooks: ctx.hooks,
      plugins: ctx.pluginRegistry,
      agentGetFn: ctx.agentGetFn,
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
      const testPath = path.join(ctx.featureDir, "acceptance.test.ts");
      const testFile = Bun.file(testPath);
      if (await testFile.exists()) {
        const testContent = await testFile.text();
        if (isStubTestFile(testContent)) {
          logger?.warn("acceptance", "Stub tests detected — re-generating acceptance tests");
          const { unlink } = await import("node:fs/promises");
          await unlink(testPath);
          const { acceptanceSetupStage } = await import("../../pipeline/stages/acceptance-setup");
          await acceptanceSetupStage.execute(acceptanceContext);
          const newContent = await Bun.file(testPath).text();
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
      const testPath = path.join(ctx.featureDir, "acceptance.test.ts");
      const testFile = Bun.file(testPath);
      if (await testFile.exists()) {
        const regenerated = await regenerateAcceptanceTest(testPath, acceptanceContext);
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

      const fixResult = await runFixRouting({
        ctx,
        failures,
        prd,
        acceptanceContext,
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

    // Fallback: generate and add fix stories (legacy path)
    logger?.info("acceptance", "Generating fix stories...");
    const fixStories = await generateAndAddFixStories(ctx, failures, prd);
    if (!fixStories) {
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

    await savePRD(prd, ctx.prdPath);
    prdDirty = true;

    // Execute fix stories
    logger?.info("acceptance", "Running fix stories...");
    for (const fixStory of fixStories) {
      const userStory = prd.userStories.find((s) => s.id === fixStory.id);
      if (!userStory || userStory.status !== "pending") continue;

      iterations++;
      const result = await executeFixStory(ctx, userStory, prd, iterations);
      prd = await loadPRD(ctx.prdPath); // Reload to get updated PRD

      if (result.success) {
        storiesCompleted++;
        totalCost += result.cost;
        if (result.metrics) ctx.allStoryMetrics.push(...result.metrics);
      }

      await savePRD(prd, ctx.prdPath);
      prdDirty = true;
    }

    logger?.info("acceptance", "Re-running acceptance tests...");
  }

  return buildResult(false, prd, totalCost, iterations, storiesCompleted, prdDirty);
}
