/**
 * Three-Session TDD Orchestrator
 *
 * Orchestrates the three-session TDD pipeline:
 * 1. Session 1 (test-writer): Write tests only
 * 2. Session 2 (implementer): Implement code to pass tests
 * 3. Session 3 (verifier): Verify tests pass and changes are legitimate
 */

import type { AgentAdapter } from "../agents";
import type { ModelTier, NaxConfig } from "../config";
import { resolveModel } from "../config";
import { executeWithTimeout } from "../execution/verification";
import { getLogger } from "../logger";
import type { UserStory } from "../prd";
import { cleanupProcessTree } from "./cleanup";
import { getChangedFiles, verifyImplementerIsolation, verifyTestWriterIsolation } from "./isolation";
import {
  buildImplementerLitePrompt,
  buildImplementerPrompt,
  buildTestWriterLitePrompt,
  buildTestWriterPrompt,
  buildVerifierPrompt,
} from "./prompts";
import type { TddSessionResult, TddSessionRole, ThreeSessionTddResult } from "./types";

/** Capture git state for isolation checking */
async function captureGitRef(workdir: string): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
    cwd: workdir,
    stdout: "pipe",
    stderr: "pipe",
  });

  await proc.exited;
  const output = await new Response(proc.stdout).text();
  return output.trim();
}

/** Run a single TDD session */
async function runTddSession(
  role: TddSessionRole,
  agent: AgentAdapter,
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  modelTier: ModelTier,
  beforeRef: string,
  contextMarkdown?: string,
  lite = false,
  skipIsolation = false,
): Promise<TddSessionResult> {
  const startTime = Date.now();

  // Build prompt based on role and mode (lite vs strict)
  let prompt: string;
  switch (role) {
    case "test-writer":
      prompt = lite
        ? buildTestWriterLitePrompt(story, contextMarkdown)
        : buildTestWriterPrompt(story, contextMarkdown);
      break;
    case "implementer":
      prompt = lite
        ? buildImplementerLitePrompt(story, contextMarkdown)
        : buildImplementerPrompt(story, contextMarkdown);
      break;
    case "verifier":
      prompt = buildVerifierPrompt(story);
      break;
  }

  const logger = getLogger();
  logger.info("tdd", `→ Session: ${role}`, { role, storyId: story.id, lite });

  // Run the agent
  const result = await agent.run({
    prompt,
    workdir,
    modelTier,
    modelDef: resolveModel(config.models[modelTier]),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
  });

  // BUG-21 Fix: Clean up orphaned child processes if agent failed
  if (!result.success && result.pid) {
    await cleanupProcessTree(result.pid);
  }

  // Check isolation based on role and skipIsolation flag.
  // Verifier always runs isolation check regardless of lite mode.
  let isolation;
  if (!skipIsolation) {
    if (role === "test-writer") {
      const allowedPaths = config.tdd.testWriterAllowedPaths ?? ["src/index.ts", "src/**/index.ts"];
      isolation = await verifyTestWriterIsolation(workdir, beforeRef, allowedPaths);
    } else if (role === "implementer" || role === "verifier") {
      isolation = await verifyImplementerIsolation(workdir, beforeRef);
    }
  }

  // Get changed files
  const filesChanged = await getChangedFiles(workdir, beforeRef);

  const durationMs = Date.now() - startTime;

  if (isolation && !isolation.passed) {
    logger.error("tdd", "✗ Isolation violated", {
      role,
      storyId: story.id,
      description: isolation.description,
      violations: isolation.violations,
    });
  } else if (isolation) {
    if (isolation.softViolations && isolation.softViolations.length > 0) {
      logger.warn("tdd", "⚠ Isolation soft violations (allowed files modified)", {
        role,
        storyId: story.id,
        softViolations: isolation.softViolations,
      });
    }
    if (isolation.warnings && isolation.warnings.length > 0) {
      logger.warn("tdd", "⚠ Isolation maintained with warnings", {
        role,
        storyId: story.id,
        warnings: isolation.warnings,
      });
    }
    if (!isolation.softViolations?.length && !isolation.warnings?.length) {
      logger.info("tdd", "✓ Isolation maintained", { role, storyId: story.id });
    }
  }

  return {
    role,
    success: result.success && (!isolation || isolation.passed),
    isolation,
    filesChanged,
    durationMs,
    estimatedCost: result.estimatedCost,
  };
}

/** Options for three-session TDD */
export interface ThreeSessionTddOptions {
  /** Agent adapter to use */
  agent: AgentAdapter;
  /** User story to implement */
  story: UserStory;
  /** Ngent configuration */
  config: NaxConfig;
  /** Working directory */
  workdir: string;
  /** Model tier for all sessions */
  modelTier: ModelTier;
  /** Optional context markdown */
  contextMarkdown?: string;
  /** Dry-run mode: log what would happen without executing */
  dryRun?: boolean;
  /** Lite mode: use relaxed prompts and skip test-writer/implementer isolation */
  lite?: boolean;
}

/**
 * Run the full three-session TDD pipeline for a user story.
 *
 * Orchestrates the complete TDD workflow:
 * 1. Session 1 (test-writer): Agent writes tests only, no source changes
 * 2. Session 2 (implementer): Agent implements code to pass tests, no test changes
 * 3. Session 3 (verifier): Agent runs tests and verifies implementation quality
 *
 * Each session enforces file isolation via git diff checking. If any session fails
 * isolation or exits with error, the workflow stops and flags for human review.
 *
 * @param agent - Agent adapter to use for all three sessions
 * @param story - User story with title, description, acceptance criteria
 * @param config - nax configuration for timeouts and model settings
 * @param workdir - Working directory (git repository root)
 * @param modelTier - Model tier for all sessions (fast/balanced/powerful)
 * @param contextMarkdown - Optional context from PRD (dependencies, progress)
 * @param dryRun - If true, log what would happen without executing sessions
 * @returns Three-session TDD result with success status, session details, and cost
 *
 * @example
 * ```ts
 * const result = await runThreeSessionTdd(
 *   claudeAdapter,
 *   {
 *     id: "US-001",
 *     title: "Add user authentication",
 *     description: "Implement JWT-based authentication",
 *     acceptanceCriteria: ["Secure token storage", "Token refresh"],
 *     // ...
 *   },
 *   config,
 *   "/project",
 *   "balanced",
 *   "## Dependencies\n- US-000: Database setup\n",
 *   false // not a dry run
 * );
 *
 * if (result.success) {
 *   console.log(`✅ TDD complete, cost: $${result.totalCost.toFixed(4)}`);
 * } else if (result.needsHumanReview) {
 *   console.log(`⚠️ Needs review: ${result.reviewReason}`);
 * }
 * ```
 */
export async function runThreeSessionTdd(
  agent: AgentAdapter,
  story: UserStory,
  config: NaxConfig,
  workdir: string,
  modelTier: ModelTier,
  contextMarkdown?: string,
  dryRun = false,
  lite = false,
): Promise<ThreeSessionTddResult> {
  const logger = getLogger();
  logger.info("tdd", "🔄 Three-Session TDD", { storyId: story.id, title: story.title, lite });

  // Dry-run mode: log what would happen without executing
  if (dryRun) {
    const modelDef = resolveModel(config.models[modelTier]);
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

  // Capture initial git state
  const initialRef = await captureGitRef(workdir);

  // Session 1: Test Writer
  // In lite mode: use lite prompt and skip isolation check
  const session1Ref = initialRef;
  const testWriterTier = config.tdd.sessionTiers?.testWriter ?? "balanced";
  const session1 = await runTddSession(
    "test-writer",
    agent,
    story,
    config,
    workdir,
    testWriterTier,
    session1Ref,
    contextMarkdown,
    lite,
    lite, // skipIsolation = lite (skip test-writer isolation in lite mode)
  );
  sessions.push(session1);

  if (!session1.success) {
    needsHumanReview = true;
    reviewReason = "Test writer session failed or violated isolation";
    logger.warn("tdd", "⚠️ Test writer session failed", { storyId: story.id, reviewReason });

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  // BUG-20 Fix: Verify that test-writer session actually created test files
  // Check if any test files were created (*.test.ts, *.spec.ts, etc.)
  const testFilePatterns = /\.(test|spec)\.(ts|js|tsx|jsx)$/;
  const testFilesCreated = session1.filesChanged.filter((f) => testFilePatterns.test(f));

  if (testFilesCreated.length === 0) {
    // Zero-file fallback: in strict mode with strategy='auto', downgrade to lite
    const tddStrategy = config.tdd.strategy ?? "auto";
    if (!lite && tddStrategy === "auto") {
      logger.warn("tdd", `Zero test files in strict mode; falling back to tdd-lite for story ${story.id}`, {
        storyId: story.id,
        filesChanged: session1.filesChanged,
      });

      // Reset changed files to pre-test-writer state (safer than git checkout .)
      if (session1.filesChanged.length > 0) {
        const resetProc = Bun.spawn(["git", "checkout", "HEAD", "--", ...session1.filesChanged], {
          cwd: workdir,
          stdout: "pipe",
          stderr: "pipe",
        });
        await resetProc.exited;
      }

      // Re-run as lite mode
      return runThreeSessionTdd(agent, story, config, workdir, modelTier, contextMarkdown, false, true);
    }

    needsHumanReview = true;
    reviewReason = "Test writer session created no test files";
    logger.warn("tdd", "⚠️ Test writer created no test files", {
      storyId: story.id,
      reviewReason,
      filesChanged: session1.filesChanged,
    });

    // Return early — no point running implementer without tests
    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  logger.info("tdd", "✓ Created test files", {
    storyId: story.id,
    testFilesCount: testFilesCreated.length,
    testFiles: testFilesCreated,
  });

  // Capture state after session 1
  const session2Ref = await captureGitRef(workdir);

  // Session 2: Implementer (uses story's routed tier by default)
  // In lite mode: use lite prompt and skip isolation check
  const implementerTier = config.tdd.sessionTiers?.implementer ?? modelTier;
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
    lite, // skipIsolation = lite (skip implementer isolation in lite mode)
  );
  sessions.push(session2);

  if (!session2.success) {
    needsHumanReview = true;
    reviewReason = "Implementer session failed or violated isolation";
    logger.warn("tdd", "⚠️ Implementer session failed", { storyId: story.id, reviewReason });

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
      lite,
    };
  }

  // Capture state after session 2
  const session3Ref = await captureGitRef(workdir);

  // Session 3: Verifier — ALWAYS runs with isolation regardless of lite flag
  const verifierTier = config.tdd.sessionTiers?.verifier ?? "fast";
  const session3 = await runTddSession(
    "verifier",
    agent,
    story,
    config,
    workdir,
    verifierTier,
    session3Ref,
    undefined,
    false, // verifier always uses strict prompt
    false, // verifier always runs isolation check
  );
  sessions.push(session3);

  // Check if all sessions succeeded based on their individual results
  let allSuccessful = sessions.every((s) => s.success);

  // BUG-22 Fix: Post-TDD independent test verification
  // If sessions had failures but we need to verify if tests actually pass,
  // run an independent test verification to check final state
  if (!allSuccessful) {
    logger.info("tdd", "→ Running post-TDD test verification", { storyId: story.id });

    const testCmd = config.quality?.commands?.test ?? "bun test";
    const timeoutSeconds = 120;

    const postVerify = await executeWithTimeout(testCmd, timeoutSeconds, undefined, {
      cwd: workdir,
    });
    const testsActuallyPass = postVerify.success && postVerify.exitCode === 0;

    if (testsActuallyPass) {
      logger.info("tdd", "ℹ️ Sessions had non-zero exits but tests pass — treating as success", {
        storyId: story.id,
      });
      allSuccessful = true;
      needsHumanReview = false;
      reviewReason = undefined;
    } else {
      logger.warn("tdd", "⚠️ Post-TDD verification: tests still failing", { storyId: story.id });
      needsHumanReview = true;
      reviewReason = "Verifier session identified issues and tests still fail";
    }
  } else {
    // All sessions succeeded — no need for independent verification
    needsHumanReview = false;
  }

  const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCost, 0);

  logger.info("tdd", allSuccessful ? "✅ Three-session TDD complete" : "⚠️ Three-session TDD needs review", {
    storyId: story.id,
    success: allSuccessful,
    totalCost,
    needsHumanReview,
    reviewReason,
    lite,
  });

  return {
    success: allSuccessful,
    sessions,
    needsHumanReview,
    reviewReason,
    totalCost,
    lite,
  };
}
