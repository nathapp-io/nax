/**
 * Three-Session TDD Orchestrator
 *
 * Orchestrates the three-session TDD pipeline:
 * 1. Session 1 (test-writer): Write tests only
 * 2. Session 2 (implementer): Implement code to pass tests
 * 3. Session 3 (verifier): Verify tests pass and changes are legitimate
 */

import type { AgentAdapter } from "../agents";
import type { UserStory } from "../prd";
import type { NaxConfig, ModelTier } from "../config";
import { resolveModel } from "../config";
import type {
  TddSessionResult,
  ThreeSessionTddResult,
  TddSessionRole,
} from "./types";
import {
  verifyTestWriterIsolation,
  verifyImplementerIsolation,
  getChangedFiles,
} from "./isolation";
import { executeWithTimeout } from "../execution/verification";
import { cleanupProcessTree } from "./cleanup";
import { getLogger } from "../logger";

/** Build prompt for test-writer session */
function buildTestWriterPrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Test-Driven Development — Session 1: Write Tests

You are in the first session of a three-session TDD workflow. Your ONLY job is to write comprehensive tests.

**Story:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**CRITICAL RULES:**
- ONLY create/modify test files (test/, tests/, __tests__/, *.test.ts, *.spec.ts)
- DO NOT create or modify any source files (src/, lib/, etc.)
- Write failing tests that verify all acceptance criteria
- Use descriptive test names and organize into logical test suites
- Follow TDD best practices: one assertion per test where reasonable
- Tests should be clear, comprehensive, and cover edge cases

The implementer in the next session will make these tests pass. Your job is ONLY to write the tests.

When done, commit your changes with message: "test: add tests for ${story.title}"`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/** Build prompt for implementer session */
function buildImplementerPrompt(story: UserStory, contextMarkdown?: string): string {
  const basePrompt = `# Test-Driven Development — Session 2: Implement Code

You are in the second session of a three-session TDD workflow. Tests have already been written in session 1.

**Story:** ${story.title}

**Description:**
${story.description}

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**CRITICAL RULES:**
- DO NOT modify any test files — tests are already written and correct
- ONLY create/modify source files (src/, lib/, etc.) to make the tests pass
- Run the tests frequently to verify your implementation
- Write minimal code to make tests pass (no over-engineering)
- Follow existing code patterns and conventions in the codebase
- Ensure all tests pass before finishing

The tests were written in session 1. Your job is to implement the code to make them pass.

When done, commit your changes with message: "feat: implement ${story.title}"`;

  if (contextMarkdown) {
    return `${basePrompt}

---

${contextMarkdown}`;
  }

  return basePrompt;
}

/** Build prompt for verifier session */
function buildVerifierPrompt(story: UserStory): string {
  return `# Test-Driven Development — Session 3: Verify

You are in the third session of a three-session TDD workflow. Tests and implementation are complete.

**Story:** ${story.title}

**Your tasks:**
1. Run all tests and verify they pass
2. Review the implementation for quality and correctness
3. Check that the implementation meets all acceptance criteria
4. Check if test files were modified by the implementer. If yes, verify the changes are legitimate fixes (e.g. fixing incorrect expectations) and NOT just loosening assertions to mask bugs.
5. If any issues exist, fix them minimally

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**Auto-approval criteria:**
- All tests pass
- Implementation is clean and follows conventions
- All acceptance criteria met
- Any test modifications by implementer are legitimate fixes

If everything looks good, you can approve automatically. If legitimate fixes are needed (e.g., minor test adjustments for legitimate reasons), make them and document why.

When done, commit any fixes with message: "fix: verify and adjust ${story.title}"`;
}

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
): Promise<TddSessionResult> {
  const startTime = Date.now();

  // Build prompt based on role
  let prompt: string;
  switch (role) {
    case "test-writer":
      prompt = buildTestWriterPrompt(story, contextMarkdown);
      break;
    case "implementer":
      prompt = buildImplementerPrompt(story, contextMarkdown);
      break;
    case "verifier":
      prompt = buildVerifierPrompt(story);
      break;
  }

  const logger = getLogger();
  logger.info("tdd", `→ Session: ${role}`, { role, storyId: story.id });

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

  // Check isolation based on role
  let isolation;
  if (role === "test-writer") {
    isolation = await verifyTestWriterIsolation(workdir, beforeRef);
  } else if (role === "implementer") {
    isolation = await verifyImplementerIsolation(workdir, beforeRef);
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
    if (isolation.warnings && isolation.warnings.length > 0) {
      logger.warn("tdd", "⚠ Isolation maintained with warnings", {
        role,
        storyId: story.id,
        warnings: isolation.warnings,
      });
    } else {
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
): Promise<ThreeSessionTddResult> {
  const logger = getLogger();
  logger.info("tdd", "🔄 Three-Session TDD", { storyId: story.id, title: story.title });

  // Dry-run mode: log what would happen without executing
  if (dryRun) {
    const modelDef = resolveModel(config.models[modelTier]);
    logger.info("tdd", "[DRY RUN] Would run 3-session TDD", {
      storyId: story.id,
      session1: { role: "test-writer", model: modelDef.model },
      session2: { role: "implementer", model: modelDef.model },
      session3: { role: "verifier", model: modelDef.model },
    });

    return {
      success: true,
      sessions: [],
      needsHumanReview: false,
      totalCost: 0,
    };
  }

  const sessions: TddSessionResult[] = [];
  let needsHumanReview = false;
  let reviewReason: string | undefined;

  // Capture initial git state
  const initialRef = await captureGitRef(workdir);

  // Session 1: Test Writer
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
    };
  }

  // BUG-20 Fix: Verify that test-writer session actually created test files
  // Check if any test files were created (*.test.ts, *.spec.ts, etc.)
  const testFilePatterns = /\.(test|spec)\.(ts|js|tsx|jsx)$/;
  const testFilesCreated = session1.filesChanged.filter((f) =>
    testFilePatterns.test(f),
  );

  if (testFilesCreated.length === 0) {
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
    };
  }

  // Capture state after session 2
  const session3Ref = await captureGitRef(workdir);

  // Session 3: Verifier
  const verifierTier = config.tdd.sessionTiers?.verifier ?? "fast";
  const session3 = await runTddSession(
    "verifier",
    agent,
    story,
    config,
    workdir,
    verifierTier,
    session3Ref,
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
  });

  return {
    success: allSuccessful,
    sessions,
    needsHumanReview,
    reviewReason,
    totalCost,
  };
}
