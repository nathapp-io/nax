/**
 * Three-Session TDD Orchestrator
 *
 * Orchestrates the three-session TDD pipeline:
 * 1. Session 1 (test-writer): Write tests only
 * 2. Session 2 (implementer): Implement code to pass tests
 * 3. Session 3 (verifier): Verify tests pass and changes are legitimate
 */

import type { AgentAdapter } from "../agents";
import { resolveDefaultAgent, wrapAdapterAsManager } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModelForAgent } from "../config";
import { isGreenfieldStory } from "../context/greenfield";
import { buildInteractionBridge } from "../interaction/bridge-builder";
import type { InteractionChain } from "../interaction/chain";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { isTestFile } from "../test-runners";
import { resolveTestFilePatterns } from "../test-runners/resolver";
import { errorMessage } from "../utils/errors";
import { captureGitRef } from "../utils/git";
import { executeWithTimeout } from "../verification";
import { runFullSuiteGate } from "./rectification-gate";
import { rollbackToRef, runTddSession, truncateTestOutput } from "./session-runner";
import type { FailureCategory, TddSessionResult, TddSessionRole, ThreeSessionTddResult } from "./types";
import { categorizeVerdict, cleanupVerdict, readVerdict } from "./verdict";

/** Options for three-session TDD */
export interface ThreeSessionTddOptions {
  agent: AgentAdapter;
  story: UserStory;
  config: NaxConfig;
  workdir: string;
  modelTier: ModelTier;
  /** Feature name — used for ACP session naming (nax-<hash>-<feature>-<story>-<role>) */
  featureName?: string;
  contextMarkdown?: string;
  /** Raw (unfiltered) feature context markdown from context engine v1 */
  featureContextMarkdown?: string;
  /**
   * Per-session v2 context bundles (context engine v2, Finding 1+2 fix).
   * When present, each session uses the bundle's pushMarkdown directly
   * (bypasses filterContextByRole in the TDD prompt builder).
   */
  tddContextBundles?: {
    testWriter?: import("../context/engine").ContextBundle;
    implementer?: import("../context/engine").ContextBundle;
    verifier?: import("../context/engine").ContextBundle;
  };
  /**
   * Lazy bundle hook used by the v2 path so each TDD session can assemble
   * after the previous one has already produced scratch/digest output.
   */
  getTddContextBundle?: (role: TddSessionRole) => Promise<import("../context/engine").ContextBundle | undefined>;
  /** Persist per-session outcomes (scratch, digests, metrics) as soon as they exist. */
  recordTddSessionOutcome?: (result: TddSessionResult) => Promise<void>;
  /**
   * #541: Bind a TDD session's ACP protocolIds to a pre-created session descriptor.
   * Returns `{ sessionManager, sessionId }` when the orchestrator has a descriptor
   * for this role; undefined when no sessionManager is configured.
   */
  getTddSessionBinding?: (role: TddSessionRole) => import("./session-runner").TddSessionBinding | undefined;
  constitution?: string;
  dryRun?: boolean;
  lite?: boolean;
  _recursionDepth?: number;
  /** Interaction chain for multi-turn Q&A during test-writer and implementer sessions */
  interactionChain?: InteractionChain | null;
  /** Absolute path to repo root — forwarded to agent.run() for prompt audit fast path */
  projectDir?: string;
  /** Shutdown abort signal (Issue 5) — forwarded to each agent.run call */
  abortSignal?: AbortSignal;
}

/**
 * Sum TokenUsage values across TDD session results (#590).
 * Returns undefined when no session reported usage — mirrors the adapter
 * contract so `metrics.tracker` can emit a tokens block only when real data exists.
 */
function sumTddTokenUsage(sessions: TddSessionResult[]): import("../agents/cost").TokenUsage | undefined {
  const usages = sessions.map((s) => s.tokenUsage).filter((u): u is import("../agents/cost").TokenUsage => !!u);
  if (usages.length === 0) return undefined;
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  for (const u of usages) {
    total.inputTokens += u.inputTokens ?? 0;
    total.outputTokens += u.outputTokens ?? 0;
    total.cacheReadInputTokens += u.cacheReadInputTokens ?? 0;
    total.cacheCreationInputTokens += u.cacheCreationInputTokens ?? 0;
  }
  return {
    inputTokens: total.inputTokens,
    outputTokens: total.outputTokens,
    ...(total.cacheReadInputTokens > 0 && { cacheReadInputTokens: total.cacheReadInputTokens }),
    ...(total.cacheCreationInputTokens > 0 && { cacheCreationInputTokens: total.cacheCreationInputTokens }),
  };
}

/**
 * Run the full three-session TDD pipeline for a user story.
 */
export async function runThreeSessionTdd(options: ThreeSessionTddOptions): Promise<ThreeSessionTddResult> {
  const {
    agent,
    story,
    config,
    workdir,
    modelTier,
    featureName,
    contextMarkdown,
    featureContextMarkdown,
    tddContextBundles,
    getTddContextBundle,
    recordTddSessionOutcome,
    getTddSessionBinding,
    constitution,
    dryRun = false,
    lite = false,
    _recursionDepth = 0,
    interactionChain,
    projectDir,
    abortSignal,
  } = options;
  const logger = getLogger();

  // MED-7: Recursion guard to prevent infinite loops
  const MAX_RECURSION_DEPTH = 2;
  if (_recursionDepth >= MAX_RECURSION_DEPTH) {
    logger.error("tdd", "Recursion depth limit reached", {
      storyId: story.id,
      depth: _recursionDepth,
      maxDepth: MAX_RECURSION_DEPTH,
    });
    return {
      success: false,
      sessions: [],
      needsHumanReview: true,
      reviewReason: "Recursion depth limit exceeded (max 2 fallbacks)",
      failureCategory: "session-failure",
      totalCost: 0,
      lite,
    };
  }

  logger.info("tdd", "Three-Session TDD", {
    storyId: story?.id,
    title: story?.title,
    lite,
    recursionDepth: _recursionDepth,
  });

  // Dry-run mode
  if (dryRun) {
    const modelDef = resolveModelForAgent(
      config.models,
      story.routing?.agent ?? resolveDefaultAgent(config),
      modelTier,
      resolveDefaultAgent(config),
    );
    logger.info("tdd", "[DRY RUN] Would run 3-session TDD", {
      storyId: story.id,
      lite,
      session1: { role: "test-writer", model: modelDef.model },
      session2: { role: "implementer", model: modelDef.model },
      session3: { role: "verifier", model: modelDef.model },
    });

    return {
      success: true,
      sessions: [],
      needsHumanReview: false,
      totalCost: 0,
      lite,
    };
  }

  const sessions: TddSessionResult[] = [];
  let needsHumanReview = false;
  let reviewReason: string | undefined;

  const initialRef = (await captureGitRef(workdir)) ?? "HEAD";
  const shouldRollbackOnFailure = config.tdd.rollbackOnFailure ?? true;

  // Session 1: Test Writer
  // BUG-018 Fix: Skip test-writer on retry iterations — tests already exist from first attempt.
  // Saves ~3min per escalation by avoiding a no-op Claude Code session.
  // #410: Also skip when escalation came from review stage — tests were already written and
  // passing when review failed, so there is no need to re-run the test-writer on the new tier.
  // stage === "review" covers both review-stage and autofix-stage escalations: buildEscalationFailure
  // (tier-escalation.ts) records stage="review" whenever reviewFindings are present, which is true
  // when autofix exhausts its attempts without fixing review failures.
  const hasReviewEscalation = (story.priorFailures ?? []).some((f) => f.stage === "review");
  const isRetry = (story.attempts ?? 0) > 0 || hasReviewEscalation;
  const session1Ref = initialRef;

  if (isRetry) {
    const skipReason =
      (story.attempts ?? 0) > 0
        ? "attempt > 0, tests already exist"
        : "escalation from review stage, tests already passed";
    logger.info("tdd", "Skipping test-writer on retry", {
      storyId: story.id,
      attempt: story.attempts,
      reason: skipReason,
    });
  }

  let session1: TddSessionResult | undefined;

  if (!isRetry) {
    const testWriterTier = config.tdd.sessionTiers?.testWriter ?? "balanced";
    const testWriterBundle = (await getTddContextBundle?.("test-writer")) ?? tddContextBundles?.testWriter;
    session1 = await runTddSession(
      "test-writer",
      agent,
      story,
      config,
      workdir,
      testWriterTier,
      session1Ref,
      contextMarkdown,
      lite,
      lite,
      constitution,
      featureName,
      buildInteractionBridge(interactionChain, { featureName, storyId: story.id, stage: "execution" }),
      projectDir,
      featureContextMarkdown,
      testWriterBundle,
      getTddSessionBinding?.("test-writer"),
      abortSignal,
    );
    sessions.push(session1);
    await recordTddSessionOutcome?.(session1);
  }

  if (session1 && !session1.success) {
    needsHumanReview = true;
    reviewReason = "Test writer session failed or violated isolation";
    const failureCategory: FailureCategory =
      session1.isolation && !session1.isolation.passed ? "isolation-violation" : "session-failure";
    logger.warn("tdd", "[WARN] Test writer session failed", { storyId: story.id, reviewReason, failureCategory });

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      failureCategory,
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  // BUG-20 Fix: Verify that test-writer session actually created test files.
  // Uses the shared language-agnostic `isTestFile()` classifier — recognizes
  // .test.*, .spec.*, _test.go, test_*.py, test/ directory segments, etc.
  // On retry (BUG-018 fix), session1 is undefined — skip this check entirely.
  // ADR-009: pass user-configured testFilePatterns so custom patterns are recognised;
  // undefined → broad regex fallback for backward compat.
  const _tddTestFilePatterns =
    typeof config.execution?.smartTestRunner === "object" && config.execution.smartTestRunner !== null
      ? config.execution.smartTestRunner.testFilePatterns
      : undefined;
  const testFilesCreated = session1 ? session1.filesChanged.filter((f) => isTestFile(f, _tddTestFilePatterns)) : [];

  if (!isRetry && testFilesCreated.length === 0) {
    // BUG-012 Fix: Before declaring greenfield, check if test files already exist in the repo.
    // The test-writer may have produced 0 new files because tests were pre-written and committed
    // separately (e.g. during dogfooding or manual setup). If tests already exist, skip
    // test-writer phase and proceed directly to the implementer.
    // Resolve effective test patterns via SSOT (ADR-009) — replaces deprecated testPattern read.
    const resolvedForGreenfield = await resolveTestFilePatterns(config, workdir);

    // Scan directly for existing test files — don't use isGreenfieldStory() here because its
    // "safe fallback" returns false (not greenfield) on scan errors, which would incorrectly
    // allow proceeding to the implementer when the workdir is unreadable.
    let hasPreExistingTests = false;
    try {
      // isGreenfieldStory returns true when NO tests exist; we want the inverse
      hasPreExistingTests = !(await isGreenfieldStory(story, workdir, resolvedForGreenfield.globs));
      // Sanity check: if workdir doesn't exist, isGreenfieldStory returns false (safe fallback),
      // meaning hasPreExistingTests = true — wrong. Validate by checking if workdir is readable.
      const dirCheck = Bun.spawn(["test", "-d", workdir], { stdout: "pipe", stderr: "pipe" });
      if ((await dirCheck.exited) !== 0) {
        hasPreExistingTests = false;
      }
    } catch {
      hasPreExistingTests = false;
    }

    if (hasPreExistingTests) {
      // Tests exist in repo — test-writer correctly produced no new files.
      // Skip the pause, proceed to implementer.
      logger.info(
        "tdd",
        "Test writer created no new files but tests already exist in repo — skipping test-writer, proceeding to implementer (BUG-012 fix)",
        {
          storyId: story.id,
        },
      );
    } else {
      // Genuinely greenfield — no tests anywhere. Pause for human review.
      needsHumanReview = true;
      reviewReason = "Test writer session created no test files (greenfield project)";
      logger.warn("tdd", "[WARN] Test writer created no test files - greenfield detected", {
        storyId: story.id,
        reviewReason,
        filesChanged: session1?.filesChanged,
      });

      return {
        success: false,
        sessions,
        needsHumanReview,
        reviewReason,
        failureCategory: "greenfield-no-tests",
        totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
        lite,
      };
    }
  }

  logger.info("tdd", "Created test files", {
    storyId: story.id,
    testFilesCount: testFilesCreated.length,
    testFiles: testFilesCreated,
  });

  const session2Ref = (await captureGitRef(workdir)) ?? "HEAD";

  // Session 2: Implementer
  const implementerTier = config.tdd.sessionTiers?.implementer ?? modelTier;
  const implementerBundle = (await getTddContextBundle?.("implementer")) ?? tddContextBundles?.implementer;
  const session2 = await runTddSession(
    "implementer",
    agent,
    story,
    config,
    workdir,
    implementerTier,
    session2Ref,
    contextMarkdown,
    lite,
    lite,
    constitution,
    featureName,
    buildInteractionBridge(interactionChain, { featureName, storyId: story.id, stage: "execution" }),
    projectDir,
    featureContextMarkdown,
    implementerBundle,
    getTddSessionBinding?.("implementer"),
    abortSignal,
  );
  sessions.push(session2);
  await recordTddSessionOutcome?.(session2);

  if (!session2.success) {
    needsHumanReview = true;
    reviewReason = "Implementer session failed or violated isolation";
    logger.warn("tdd", "[WARN] Implementer session failed", { storyId: story.id, reviewReason });

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      failureCategory: "session-failure",
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  // Full-Suite Gate (v0.11 Rectification)
  // Pass initialRef so the gate can use git-diff to suppress pre-existing failures
  // in files the story never touched (BUG-TC-001).
  const { passed: fullSuiteGatePassed, cost: fullSuiteGateCost } = await runFullSuiteGate(
    story,
    config,
    workdir,
    wrapAdapterAsManager(agent),
    implementerTier,
    lite,
    logger,
    featureName,
    projectDir,
    initialRef,
  );

  // Session 3: Verifier
  const session3Ref = (await captureGitRef(workdir)) ?? "HEAD";
  const verifierTier = config.tdd.sessionTiers?.verifier ?? "fast";
  const verifierBundle = (await getTddContextBundle?.("verifier")) ?? tddContextBundles?.verifier;
  const session3 = await runTddSession(
    "verifier",
    agent,
    story,
    config,
    workdir,
    verifierTier,
    session3Ref,
    undefined,
    false,
    false,
    constitution,
    featureName,
    undefined,
    projectDir,
    featureContextMarkdown,
    verifierBundle,
    getTddSessionBinding?.("verifier"),
    abortSignal,
  );
  sessions.push(session3);
  await recordTddSessionOutcome?.(session3);

  // T9: Verdict-based post-TDD verification
  const verdict = await readVerdict(workdir);
  await cleanupVerdict(workdir);

  let allSuccessful = sessions.every((s) => s.success);
  let finalFailureCategory: FailureCategory | undefined;

  if (verdict !== null) {
    const categorization = categorizeVerdict(verdict, verdict.tests.allPassing);

    if (categorization.success) {
      logger.info("tdd", "[OK] Verifier verdict: approved", {
        storyId: story.id,
        verdictApproved: verdict.approved,
        testsAllPassing: verdict.tests.allPassing,
      });
      allSuccessful = true;
      needsHumanReview = false;
      reviewReason = undefined;
    } else {
      logger.warn("tdd", "[WARN] Verifier verdict: rejected", {
        storyId: story.id,
        verdictApproved: verdict.approved,
        failureCategory: categorization.failureCategory,
        reviewReason: categorization.reviewReason,
      });
      allSuccessful = false;
      finalFailureCategory = categorization.failureCategory;
      needsHumanReview = true;
      reviewReason = categorization.reviewReason;
    }
  } else {
    // Fallback path: no verdict file
    if (!allSuccessful) {
      logger.info("tdd", "-> Running post-TDD test verification (no verdict file)", { storyId: story.id });

      const testCmd = config.quality?.commands?.test ?? "bun test";
      const timeoutSeconds = 120;

      const postVerify = await executeWithTimeout(testCmd, timeoutSeconds, undefined, { cwd: workdir });
      const testsActuallyPass = postVerify.success && postVerify.exitCode === 0;

      const truncatedStdout = postVerify.output ? truncateTestOutput(postVerify.output) : "";
      const truncatedStderr = postVerify.error ? truncateTestOutput(postVerify.error) : "";

      if (testsActuallyPass) {
        logger.info("tdd", "Sessions had non-zero exits but tests pass - treating as success", {
          storyId: story.id,
          stdout: truncatedStdout,
        });
        allSuccessful = true;
        needsHumanReview = false;
        reviewReason = undefined;
      } else {
        logger.warn("tdd", "[WARN] Post-TDD verification: tests still failing", {
          storyId: story.id,
          stdout: truncatedStdout,
          stderr: truncatedStderr,
        });
        needsHumanReview = true;
        reviewReason = "Verifier session identified issues and tests still fail";
        finalFailureCategory = "tests-failing";
      }
    } else {
      needsHumanReview = false;
    }
  }

  const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCost, 0) + fullSuiteGateCost;
  const totalDurationMs = sessions.reduce((sum, s) => sum + s.durationMs, 0);
  // #590: sum tokenUsage across all sessions so metrics.tracker emits a tokens block
  // for TDD runs the same way single-session runs do.
  const totalTokenUsage = sumTddTokenUsage(sessions);

  logger.info("tdd", allSuccessful ? "[OK] Three-session TDD complete" : "[WARN] Three-session TDD needs review", {
    storyId: story.id,
    success: allSuccessful,
    totalCost,
    needsHumanReview,
    reviewReason,
    lite,
    verdictAvailable: verdict !== null,
  });

  // Rollback git changes if TDD failed
  if (!allSuccessful && shouldRollbackOnFailure) {
    try {
      await rollbackToRef(workdir, initialRef);
      logger.info("tdd", "Rolled back git changes due to TDD failure", {
        storyId: story.id,
        failureCategory: finalFailureCategory,
      });
    } catch (error) {
      logger.error("tdd", "Failed to rollback git changes after TDD failure", {
        storyId: story.id,
        error: errorMessage(error),
      });
    }
  }

  return {
    success: allSuccessful,
    sessions,
    needsHumanReview,
    reviewReason,
    ...(finalFailureCategory !== undefined ? { failureCategory: finalFailureCategory } : {}),
    verdict,
    totalCost,
    totalDurationMs,
    ...(totalTokenUsage && { totalTokenUsage }),
    lite,
    fullSuiteGatePassed,
  };
}
