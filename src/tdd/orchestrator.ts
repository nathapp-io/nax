/**
 * Three-Session TDD Orchestrator
 *
 * Orchestrates the three-session TDD pipeline:
 * 1. Session 1 (test-writer): Write tests only
 * 2. Session 2 (implementer): Implement code to pass tests
 * 3. Session 3 (verifier): Verify tests pass and changes are legitimate
 */

import chalk from "chalk";
import type { AgentAdapter } from "../agents";
import type { UserStory } from "../prd";
import type { NgentConfig, ModelTier } from "../config";
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

/** Build prompt for test-writer session */
function buildTestWriterPrompt(story: UserStory): string {
  return `# Test-Driven Development — Session 1: Write Tests

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
}

/** Build prompt for implementer session */
function buildImplementerPrompt(story: UserStory): string {
  return `# Test-Driven Development — Session 2: Implement Code

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
4. Verify no test files were modified by the implementer
5. If any issues exist, fix them minimally

**Acceptance Criteria:**
${story.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")}

**Auto-approval criteria:**
- All tests pass
- No test files modified in session 2
- Implementation is clean and follows conventions
- All acceptance criteria met

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
  config: NgentConfig,
  workdir: string,
  modelTier: ModelTier,
  beforeRef: string,
): Promise<TddSessionResult> {
  const startTime = Date.now();

  // Build prompt based on role
  let prompt: string;
  switch (role) {
    case "test-writer":
      prompt = buildTestWriterPrompt(story);
      break;
    case "implementer":
      prompt = buildImplementerPrompt(story);
      break;
    case "verifier":
      prompt = buildVerifierPrompt(story);
      break;
  }

  console.log(chalk.cyan(`\n   → Session: ${role}`));

  // Run the agent
  const result = await agent.run({
    prompt,
    workdir,
    modelTier,
    modelDef: resolveModel(config.models[modelTier]),
    timeoutSeconds: config.execution.sessionTimeoutSeconds,
  });

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
    console.log(chalk.red(`   ✗ Isolation violated: ${isolation.description}`));
    console.log(chalk.red(`     Violations: ${isolation.violations.join(", ")}`));
  } else if (isolation) {
    console.log(chalk.green(`   ✓ Isolation maintained`));
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

/**
 * Run the full three-session TDD pipeline
 */
export async function runThreeSessionTdd(
  agent: AgentAdapter,
  story: UserStory,
  config: NgentConfig,
  workdir: string,
  modelTier: ModelTier,
): Promise<ThreeSessionTddResult> {
  console.log(chalk.cyan(`\n🔄 Three-Session TDD: ${story.title}`));

  const sessions: TddSessionResult[] = [];
  let needsHumanReview = false;
  let reviewReason: string | undefined;

  // Capture initial git state
  const initialRef = await captureGitRef(workdir);

  // Session 1: Test Writer
  const session1Ref = initialRef;
  const session1 = await runTddSession(
    "test-writer",
    agent,
    story,
    config,
    workdir,
    modelTier,
    session1Ref,
  );
  sessions.push(session1);

  if (!session1.success) {
    needsHumanReview = true;
    reviewReason = "Test writer session failed or violated isolation";
    console.log(chalk.yellow(`\n⚠️  ${reviewReason}`));

    return {
      success: false,
      sessions,
      needsHumanReview,
      reviewReason,
      totalCost: sessions.reduce((sum, s) => sum + s.estimatedCost, 0),
    };
  }

  // Capture state after session 1
  const session2Ref = await captureGitRef(workdir);

  // Session 2: Implementer
  const session2 = await runTddSession(
    "implementer",
    agent,
    story,
    config,
    workdir,
    modelTier,
    session2Ref,
  );
  sessions.push(session2);

  if (!session2.success) {
    needsHumanReview = true;
    reviewReason = "Implementer session failed or violated isolation";
    console.log(chalk.yellow(`\n⚠️  ${reviewReason}`));

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
  const session3 = await runTddSession(
    "verifier",
    agent,
    story,
    config,
    workdir,
    modelTier,
    session3Ref,
  );
  sessions.push(session3);

  // Verifier auto-approves if successful
  const allSuccessful = sessions.every((s) => s.success);
  if (!allSuccessful) {
    needsHumanReview = true;
    reviewReason = "Verifier session identified issues";
  }

  const totalCost = sessions.reduce((sum, s) => sum + s.estimatedCost, 0);

  console.log(
    allSuccessful
      ? chalk.green(`\n✅ Three-session TDD complete`)
      : chalk.yellow(`\n⚠️  Three-session TDD needs review`),
  );
  console.log(chalk.dim(`   Total cost: $${totalCost.toFixed(4)}`));

  return {
    success: allSuccessful,
    sessions,
    needsHumanReview,
    reviewReason,
    totalCost,
  };
}
