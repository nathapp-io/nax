import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { runThreeSessionTdd } from "../../src/tdd/orchestrator";
import type { AgentAdapter, AgentResult } from "../../src/agents";
import type { UserStory } from "../../src/prd";
import { DEFAULT_CONFIG } from "../../src/config";
import { VERDICT_FILE } from "../../src/tdd/verdict";

let originalSpawn: typeof Bun.spawn;

beforeEach(() => {
  originalSpawn = Bun.spawn;
});

afterEach(() => {
  Bun.spawn = originalSpawn;
});

/** Create a mock agent that returns sequential results */
function createMockAgent(results: Partial<AgentResult>[]): AgentAdapter {
  let callCount = 0;
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    isInstalled: async () => true,
    buildCommand: () => ["mock"],
    run: mock(async () => {
      const r = results[callCount] || {};
      callCount++;
      return {
        success: r.success ?? true,
        exitCode: r.exitCode ?? 0,
        output: r.output ?? "",
        rateLimited: r.rateLimited ?? false,
        durationMs: r.durationMs ?? 100,
        estimatedCost: r.estimatedCost ?? 0.01,
      };
    }),
  };
}

/** Mock Bun.spawn to intercept git commands */
function mockGitSpawn(opts: {
  /** Files returned by git diff for each session (indexed by git-diff call number) */
  diffFiles: string[][];
}) {
  let revParseCount = 0;
  let diffCount = 0;

  // @ts-ignore — mocking global
  Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      revParseCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(`ref-${revParseCount}\n`).body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && cmd[1] === "checkout") {
      // Intercept git checkout (used in zero-file fallback) — silently succeed
      return {
        exited: Promise.resolve(0),
        stdout: new Response("").body,
        stderr: new Response("").body,
      };
    }
    if (cmd[0] === "git" && cmd[1] === "diff") {
      const files = opts.diffFiles[diffCount] || [];
      diffCount++;
      return {
        exited: Promise.resolve(0),
        stdout: new Response(files.join("\n") + "\n").body,
        stderr: new Response("").body,
      };
    }
    return originalSpawn(cmd, spawnOpts);
  });
}

const story: UserStory = {
  id: "US-001",
  title: "Add user validation",
  description: "Add validation to user input",
  acceptanceCriteria: ["Validation works", "Errors are clear"],
  dependencies: [],
  tags: [],
  status: "pending",
  passes: false,
  escalations: [],
  attempts: 0,
};

describe("runThreeSessionTdd", () => {
  test("happy path: all 3 sessions succeed", async () => {
    // Each session triggers: captureGitRef (rev-parse) + isolation check (git diff) + getChangedFiles (git diff)
    // Session 1: test-writer → verifyTestWriterIsolation calls getChangedFiles (1 diff) + getChangedFiles for result (1 diff) = 2 diffs
    // Session 2: implementer → verifyImplementerIsolation (1 diff) + getChangedFiles (1 diff) = 2 diffs
    // Session 3: verifier → no isolation check + getChangedFiles (1 diff) = 1 diff
    // But actually looking at the code: isolation + getChangedFiles share the same call in runTddSession
    // isolation calls getChangedFiles internally, then runTddSession calls getChangedFiles separately
    // Actually no — look at orchestrator.ts runTddSession:
    //   1. verifyTestWriterIsolation (calls getChangedFiles) → 1 diff call
    //   2. getChangedFiles → 1 diff call
    // So per session with isolation: 2 diff calls. Without isolation (verifier): 1 diff call.
    // Total: 2 + 2 + 1 = 5 diff calls
    mockGitSpawn({
      diffFiles: [
        // Session 1 isolation check: test files only (OK)
        ["test/user.test.ts"],
        // Session 1 getChangedFiles
        ["test/user.test.ts"],
        // Session 2 isolation check: source files only (OK)
        ["src/user.ts"],
        // Session 2 getChangedFiles
        ["src/user.ts"],
        // Session 3 getChangedFiles (no isolation check for verifier)
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[0].role).toBe("test-writer");
    expect(result.sessions[1].role).toBe("implementer");
    expect(result.sessions[2].role).toBe("verifier");
    expect(result.needsHumanReview).toBe(false);
    expect(result.totalCost).toBe(0.04);
  });

  test("failure when test-writer session fails", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: false, exitCode: 1, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1);
    expect(result.needsHumanReview).toBe(true);
  });

  test("failure when test-writer violates isolation", async () => {
    mockGitSpawn({
      diffFiles: [
        // Isolation check: test-writer touched source files!
        ["src/user.ts", "test/user.test.ts"],
        // getChangedFiles
        ["src/user.ts", "test/user.test.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].success).toBe(false);
    expect(result.needsHumanReview).toBe(true);
  });

  test("failure when implementer session fails", async () => {
    mockGitSpawn({
      diffFiles: [
        // Session 1 isolation: OK
        ["test/user.test.ts"],
        // Session 1 getChangedFiles
        ["test/user.test.ts"],
        // Session 2 isolation: OK
        ["src/user.ts"],
        // Session 2 getChangedFiles
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: false, exitCode: 1, estimatedCost: 0.02 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(2);
    expect(result.needsHumanReview).toBe(true);
  });

  test("implementer touching test files is a warning (soft-pass), not failure", async () => {
    mockGitSpawn({
      diffFiles: [
        // Session 1 isolation: OK
        ["test/user.test.ts"],
        // Session 1 getChangedFiles
        ["test/user.test.ts"],
        // Session 2 isolation: implementer touched tests (warning, not violation)
        ["test/user.test.ts", "src/user.ts"],
        // Session 2 getChangedFiles
        ["test/user.test.ts", "src/user.ts"],
        // Session 3 isolation: OK
        [],
        // Session 3 getChangedFiles
        [],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    // v0.9.2: implementer touching test files is a warning, not a failure
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[1].success).toBe(true);
    expect(result.sessions[1].isolation?.warnings).toContain("test/user.test.ts");
    expect(result.success).toBe(true);
  });

  test("dry-run mode logs sessions without executing", async () => {
    const agent = createMockAgent([]);

    const result = await runThreeSessionTdd(
      agent,
      story,
      DEFAULT_CONFIG,
      "/tmp/test",
      "balanced",
      undefined,
      true, // dryRun = true
    );

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(0);
    expect(result.needsHumanReview).toBe(false);
    expect(result.totalCost).toBe(0);
    // Agent should not have been called
    expect(agent.run).not.toHaveBeenCalled();
  });

  test("dry-run mode works with context markdown", async () => {
    const agent = createMockAgent([]);
    const contextMarkdown = "## Dependencies\n- US-000: Setup database\n";

    const result = await runThreeSessionTdd(
      agent,
      story,
      DEFAULT_CONFIG,
      "/tmp/test",
      "powerful",
      contextMarkdown,
      true, // dryRun = true
    );

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(0);
    expect(result.totalCost).toBe(0);
    // Agent should not have been called
    expect(agent.run).not.toHaveBeenCalled();
  });

  test("BUG-22: post-TDD verification overrides session failures when tests pass", async () => {
    // Scenario: All 3 sessions complete but verifier has non-zero exit code
    // However, when we run tests independently, they pass
    // Expected: allSuccessful should be overridden to true

    let testCommandCalled = false;
    let revParseCount = 0;
    let diffCount = 0;

    const diffFiles = [
      // Session 1 isolation + getChangedFiles
      ["test/user.test.ts"],
      ["test/user.test.ts"],
      // Session 2 isolation + getChangedFiles
      ["src/user.ts"],
      ["src/user.ts"],
      // Session 3 getChangedFiles
      ["src/user.ts"],
    ];

    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      // Intercept the post-TDD test command (bun test)
      if (cmd[0] === "/bin/sh" && cmd[2]?.includes("bun test")) {
        testCommandCalled = true;
        return {
          pid: 9999,
          exited: Promise.resolve(0), // Tests pass!
          stdout: new Response("5 pass, 0 fail\n").body,
          stderr: new Response("").body,
        };
      }
      // Git rev-parse
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        revParseCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`ref-${revParseCount}\n`).body,
          stderr: new Response("").body,
        };
      }
      // Git diff
      if (cmd[0] === "git" && cmd[1] === "diff") {
        const files = diffFiles[diffCount] || [];
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(files.join("\n") + "\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },   // test-writer succeeds
      { success: true, estimatedCost: 0.02 },   // implementer succeeds
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier fails (e.g., fixed issues)
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    // Assertions
    expect(testCommandCalled).toBe(true); // Post-TDD test was executed
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[2].success).toBe(false); // Verifier session itself failed
    expect(result.success).toBe(true); // But overall result is success (overridden)
    expect(result.needsHumanReview).toBe(false); // No human review needed
    expect(result.reviewReason).toBeUndefined();
  });

  test("BUG-20: failure when test-writer creates no test files", async () => {
    // Scenario: Test-writer session succeeds and passes isolation but creates no test files
    // (e.g., creates requirements.md instead)
    // Expected: Should fail with needsHumanReview and specific reason
    mockGitSpawn({
      diffFiles: [
        // Isolation check: only non-test files
        ["requirements.md", "docs/plan.md"],
        // getChangedFiles
        ["requirements.md", "docs/plan.md"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 }, // test-writer succeeds but creates wrong files
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1); // Should stop after session 1
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files");
  });

  test("BUG-20: failure when test-writer creates zero files", async () => {
    // Scenario: Test-writer session succeeds but creates no files at all
    // Expected: Should fail with needsHumanReview
    mockGitSpawn({
      diffFiles: [
        // Isolation check: no files
        [],
        // getChangedFiles: no files
        [],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 }, // test-writer succeeds but creates nothing
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files");
  });

  test("BUG-20: success when test-writer creates test files with various extensions", async () => {
    // Scenario: Test-writer creates test files with different valid extensions
    // Expected: Should succeed and continue to session 2
    mockGitSpawn({
      diffFiles: [
        // Isolation check: various test file formats
        ["test/user.test.ts", "test/auth.spec.js", "test/api.test.tsx"],
        // getChangedFiles
        ["test/user.test.ts", "test/auth.spec.js", "test/api.test.tsx"],
        // Session 2 isolation
        ["src/user.ts", "src/auth.js"],
        // Session 2 getChangedFiles
        ["src/user.ts", "src/auth.js"],
        // Session 3 getChangedFiles
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(3); // All sessions run
    expect(result.needsHumanReview).toBe(false);
  });

  test("BUG-22: post-TDD verification does not override when tests actually fail", async () => {
    // Scenario: Sessions complete with failures AND independent test run also fails
    // Expected: Result should remain failed

    let testCommandCalled = false;
    let revParseCount = 0;
    let diffCount = 0;

    const diffFiles = [
      ["test/user.test.ts"],
      ["test/user.test.ts"],
      ["src/user.ts"],
      ["src/user.ts"],
      ["src/user.ts"],
    ];

    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "/bin/sh" && cmd[2]?.includes("bun test")) {
        testCommandCalled = true;
        return {
          pid: 9999,
          exited: Promise.resolve(1), // Tests FAIL!
          stdout: new Response("3 pass, 2 fail\n").body,
          stderr: new Response("Test errors...\n").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        revParseCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`ref-${revParseCount}\n`).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "diff") {
        const files = diffFiles[diffCount] || [];
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(files.join("\n") + "\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier fails
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(testCommandCalled).toBe(true);
    expect(result.success).toBe(false); // Should remain failed
    expect(result.needsHumanReview).toBe(true); // Needs review
    expect(result.reviewReason).toBeDefined();
  });
});

// ─── Lite-mode prompt tests ───────────────────────────────────────────────────

import {
  buildTestWriterLitePrompt,
  buildImplementerLitePrompt,
  buildVerifierPrompt,
  buildTestWriterPrompt,
  buildImplementerPrompt,
} from "../../src/tdd/prompts";

describe("buildTestWriterLitePrompt", () => {
  test("tells agent it CAN read source files", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toContain("MAY read source files");
  });

  test("tells agent it CAN import from source files", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toContain("MAY import from source files");
  });

  test("still instructs agent to only CREATE test files", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toMatch(/[Oo]nly\s+[Cc][Rr][Ee][Aa][Tt][Ee]\s+test files|CREATE test files/);
  });

  test("does NOT say DO NOT create or modify any source files (strict isolation rule)", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).not.toContain("DO NOT create or modify any source files");
  });

  test("does NOT say ONLY create/modify test files (strict isolation rule)", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).not.toContain("ONLY create/modify test files");
  });

  test("includes story title and acceptance criteria", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt).toContain(story.title);
    expect(prompt).toContain("Validation works");
    expect(prompt).toContain("Errors are clear");
  });

  test("includes context markdown when provided", () => {
    const ctx = "## Relevant Files\n- src/user.ts";
    const prompt = buildTestWriterLitePrompt(story, ctx);
    expect(prompt).toContain("## Relevant Files");
    expect(prompt).toContain("src/user.ts");
  });

  test("does not include context separator when no context provided", () => {
    const prompt = buildTestWriterLitePrompt(story);
    // Should still have content but no trailing separator
    expect(prompt).not.toMatch(/---\s*$/);
  });

  test("uses lite mode label in heading", () => {
    const prompt = buildTestWriterLitePrompt(story);
    expect(prompt.toLowerCase()).toContain("lite");
  });
});

describe("buildImplementerLitePrompt", () => {
  test("has no file restriction rules (does not say Only create or modify files in the test/ directory)", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).not.toContain("Only create or modify files in the test/ directory");
  });

  test("has no file restriction rules (does not say Implement source code in src/ to make tests pass)", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).not.toContain("Implement source code in src/ to make tests pass");
  });

  test("allows writing tests and implementing", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).toContain("Write tests AND implement");
  });

  test("includes story title and acceptance criteria", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).toContain(story.title);
    expect(prompt).toContain("Validation works");
    expect(prompt).toContain("Errors are clear");
  });

  test("includes context markdown when provided", () => {
    const ctx = "## Context\n- Use existing patterns";
    const prompt = buildImplementerLitePrompt(story, ctx);
    expect(prompt).toContain("## Context");
    expect(prompt).toContain("Use existing patterns");
  });

  test("uses lite mode label in heading", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt.toLowerCase()).toContain("lite");
  });

  test("still instructs to make tests pass", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt.toLowerCase()).toContain("all tests must pass");
  });
});

describe("buildVerifierPrompt (unchanged)", () => {
  test("is unchanged — still has isolation-focused verification rules", () => {
    const prompt = buildVerifierPrompt(story);
    expect(prompt).toContain("Session 3: Verify");
    expect(prompt).toContain("Check if test files were modified by the implementer");
    expect(prompt).toContain(story.title);
  });

  test("does NOT mention lite mode", () => {
    const prompt = buildVerifierPrompt(story);
    expect(prompt.toLowerCase()).not.toContain("lite");
  });

  test("still verifies acceptance criteria", () => {
    const prompt = buildVerifierPrompt(story);
    expect(prompt).toContain("Validation works");
    expect(prompt).toContain("Errors are clear");
  });
});

describe("strict vs lite prompt comparison", () => {
  test("strict test-writer has harder isolation rules than lite", () => {
    const strict = buildTestWriterPrompt(story);
    const lite = buildTestWriterLitePrompt(story);

    // Strict has hard NO rule on source files
    expect(strict).toContain("Only create or modify files in the test/ directory");
    expect(lite).not.toContain("Only create or modify files in the test/ directory");

    // Lite explicitly allows reading source files
    expect(lite).toContain("You may create minimal stubs in src/");
    expect(strict).not.toContain("You may create minimal stubs in src/");
  });

  test("strict implementer has harder isolation rules than lite", () => {
    const strict = buildImplementerPrompt(story);
    const lite = buildImplementerLitePrompt(story);

    // Strict bans test file modifications
    expect(strict).toContain("Do NOT modify test files");
    expect(lite).not.toContain("Do NOT modify test files");

    // Lite allows adjusting test files
    expect(lite).toContain("Write tests AND implement");
    expect(strict).not.toContain("Write tests AND implement");
  });
});

// ─── T4: Lite mode orchestration tests ───────────────────────────────────────

describe("runThreeSessionTdd — lite mode", () => {
  test("lite mode: result includes lite=true flag", async () => {
    // In lite mode all 3 sessions succeed
    // Lite skips isolation for sessions 1 and 2, so only 2 diff calls for those
    // Session 3 (verifier) always runs isolation: 2 diff calls (isolation + getChangedFiles)
    // Total: 1 (s1 getChangedFiles) + 1 (s2 getChangedFiles) + 2 (s3) = 4 diff calls
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],  // s1 getChangedFiles (no isolation in lite)
        ["src/user.ts"],        // s2 getChangedFiles (no isolation in lite)
        [],                     // s3 isolation check (verifier always checks)
        ["src/user.ts"],        // s3 getChangedFiles
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
      undefined, false, true /* lite=true */,
    );

    expect(result.lite).toBe(true);
    expect(result.success).toBe(true);
  });

  test("strict mode: result includes lite=false flag", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
        [],                     // s3 isolation
        ["src/user.ts"],        // s3 getChangedFiles
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
      undefined, false, false /* lite=false (default) */,
    );

    expect(result.lite).toBe(false);
    expect(result.success).toBe(true);
  });

  test("lite mode: test-writer session has no isolation check (isolation is undefined)", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],  // s1 getChangedFiles only (no isolation in lite)
        ["src/user.ts"],        // s2 getChangedFiles only (no isolation in lite)
        [],                     // s3 isolation
        ["src/user.ts"],        // s3 getChangedFiles
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
      undefined, false, true /* lite=true */,
    );

    expect(result.sessions).toHaveLength(3);
    // In lite mode, test-writer and implementer skip isolation
    expect(result.sessions[0].isolation).toBeUndefined();
    expect(result.sessions[1].isolation).toBeUndefined();
    // Verifier always runs isolation
    expect(result.sessions[2].isolation).toBeDefined();
  });

  test("lite mode: implementer modifying test files does NOT appear in isolation warnings (no isolation check)", async () => {
    // In strict mode, implementer touching test files produces warnings.
    // In lite mode, isolation is skipped entirely, so there are no warnings.
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],              // s1 getChangedFiles
        ["test/user.test.ts", "src/user.ts"], // s2 getChangedFiles
        [],                                 // s3 isolation
        [],                                 // s3 getChangedFiles
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
      undefined, false, true /* lite=true */,
    );

    expect(result.sessions[1].isolation).toBeUndefined(); // No isolation in lite
    expect(result.sessions[1].success).toBe(true); // Agent succeeded
    expect(result.success).toBe(true);
    expect(result.lite).toBe(true);
  });

  test("lite mode: verifier always runs isolation check (even in lite mode)", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],  // s1 getChangedFiles
        ["src/user.ts"],        // s2 getChangedFiles
        [],                     // s3 isolation (verifier always checks)
        [],                     // s3 getChangedFiles
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
      undefined, false, true /* lite=true */,
    );

    expect(result.sessions[2].isolation).toBeDefined();
    expect(result.sessions[2].isolation?.passed).toBe(true);
    expect(result.lite).toBe(true);
  });

  test("lite mode: dry-run returns lite=true", async () => {
    const agent = createMockAgent([]);
    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
      undefined, true /* dryRun */, true /* lite=true */,
    );
    expect(result.lite).toBe(true);
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(0);
  });
});

// ─── T4: Zero-file fallback tests ────────────────────────────────────────────

describe("runThreeSessionTdd — zero-file fallback", () => {
  /** Extended git mock that also handles `git checkout .` */
  function mockGitSpawnWithCheckout(opts: {
    diffFiles: string[][];
    onCheckout?: () => void;
  }) {
    let revParseCount = 0;
    let diffCount = 0;

    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        revParseCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`ref-${revParseCount}\n`).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "checkout") {
        opts.onCheckout?.();
        return {
          exited: Promise.resolve(0),
          stdout: new Response("").body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "diff") {
        const files = opts.diffFiles[diffCount] || [];
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(files.join("\n") + "\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });
  }

  test("fallback triggers when strategy='auto' and 0 test files in strict mode", async () => {
    let checkoutCalled = false;

    // Strict mode:
    //   s1 isolation: non-test files (passes) → diff[0]
    //   s1 getChangedFiles: non-test files → diff[1] → 0 test files → FALLBACK
    //   git checkout .
    // Lite mode (recursive):
    //   s1 getChangedFiles: test files → diff[2]
    //   s2 getChangedFiles: src files → diff[3]
    //   s3 isolation: → diff[4]
    //   s3 getChangedFiles: → diff[5]
    mockGitSpawnWithCheckout({
      diffFiles: [
        ["requirements.md"],    // s1 isolation (strict) — no source violations
        ["requirements.md"],    // s1 getChangedFiles (strict) — 0 test files → fallback
        ["test/user.test.ts"], // s1 getChangedFiles (lite re-run)
        ["src/user.ts"],       // s2 getChangedFiles (lite re-run)
        [],                    // s3 isolation (lite re-run)
        [],                    // s3 getChangedFiles (lite re-run)
      ],
      onCheckout: () => { checkoutCalled = true; },
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 }, // s1 strict test-writer
      { success: true, estimatedCost: 0.01 }, // s1 lite test-writer
      { success: true, estimatedCost: 0.02 }, // s2 lite implementer
      { success: true, estimatedCost: 0.01 }, // s3 lite verifier
    ]);

    const configWithAutoStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "auto" as const },
    };

    const result = await runThreeSessionTdd(
      agent, story, configWithAutoStrategy, "/tmp/test", "balanced",
    );

    expect(checkoutCalled).toBe(true); // git checkout . was called
    expect(result.lite).toBe(true);    // result is from lite mode
    expect(result.success).toBe(true);
  });

  test("fallback result has lite=true (confirms lite mode was used)", async () => {
    mockGitSpawnWithCheckout({
      diffFiles: [
        ["docs/plan.md"],      // s1 isolation (strict)
        ["docs/plan.md"],      // s1 getChangedFiles (strict) → 0 test files
        ["test/feature.test.ts"], // s1 getChangedFiles (lite)
        ["src/feature.ts"],    // s2 getChangedFiles (lite)
        [],                    // s3 isolation (lite)
        [],                    // s3 getChangedFiles (lite)
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
    );

    expect(result.lite).toBe(true);
  });

  test("fallback does NOT trigger when strategy='strict' (explicit strict mode)", async () => {
    // In strategy='strict', no fallback — should return failure
    mockGitSpawn({
      diffFiles: [
        ["requirements.md"],  // s1 isolation — no source violations
        ["requirements.md"],  // s1 getChangedFiles — 0 test files
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
    ]);

    const configWithStrictStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const },
    };

    const result = await runThreeSessionTdd(
      agent, story, configWithStrictStrategy, "/tmp/test", "balanced",
    );

    // Should fail (no fallback in strict mode)
    expect(result.success).toBe(false);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files");
    expect(result.lite).toBe(false); // Was called in strict mode, no fallback
  });

  test("fallback does NOT trigger when already in lite mode", async () => {
    // Calling with lite=true — if 0 test files, should return failure (not recurse again)
    mockGitSpawn({
      diffFiles: [
        ["requirements.md"],  // s1 getChangedFiles (lite, no isolation) — 0 test files
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced",
      undefined, false, true /* lite=true */,
    );

    // Should fail — no further fallback from lite mode
    expect(result.success).toBe(false);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files");
    expect(result.lite).toBe(true);
  });

  test("fallback does NOT trigger when strategy='lite' config", async () => {
    // When strategy='lite', runThreeSessionTdd is called with lite=true (from execution stage)
    // So !lite = false → no fallback
    mockGitSpawn({
      diffFiles: [
        [],  // s1 getChangedFiles (lite, no isolation) — 0 test files
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
    ]);

    const configWithLiteStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "lite" as const },
    };

    const result = await runThreeSessionTdd(
      agent, story, configWithLiteStrategy, "/tmp/test", "balanced",
      undefined, false, true /* lite=true (router sets this for lite strategy) */,
    );

    expect(result.success).toBe(false);
    expect(result.lite).toBe(true);
  });
});

// ─── T4: failureCategory tests ────────────────────────────────────────────────

describe("runThreeSessionTdd — failureCategory", () => {
  test("test-writer isolation failure sets failureCategory='isolation-violation'", async () => {
    // Test-writer modifies source files → isolation violation
    mockGitSpawn({
      diffFiles: [
        // Isolation check: test-writer touched source files!
        ["src/user.ts", "test/user.test.ts"],
        // getChangedFiles
        ["src/user.ts", "test/user.test.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("isolation-violation");
  });

  test("test-writer zero files (non-auto strategy) sets failureCategory='isolation-violation'", async () => {
    // In strict strategy, zero test files → isolation-violation category
    mockGitSpawn({
      diffFiles: [
        ["requirements.md"],  // s1 isolation — no source violations
        ["requirements.md"],  // s1 getChangedFiles — 0 test files
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
    ]);

    const configWithStrictStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const },
    };

    const result = await runThreeSessionTdd(
      agent, story, configWithStrictStrategy, "/tmp/test", "balanced",
    );

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("isolation-violation");
  });

  test("test-writer crash/timeout (non-isolation failure) sets failureCategory='session-failure'", async () => {
    // Test-writer agent crashes/times out but isolation is clean
    mockGitSpawn({
      diffFiles: [
        // Isolation check: only test files (passes)
        ["test/user.test.ts"],
        // getChangedFiles
        ["test/user.test.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // Agent crash
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    // isolation.passed=true but agent failed → session-failure
    expect(result.failureCategory).toBe("session-failure");
  });

  test("implementer failure sets failureCategory='session-failure'", async () => {
    mockGitSpawn({
      diffFiles: [
        // Session 1 isolation: OK
        ["test/user.test.ts"],
        // Session 1 getChangedFiles
        ["test/user.test.ts"],
        // Session 2 isolation: OK
        ["src/user.ts"],
        // Session 2 getChangedFiles
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },   // test-writer OK
      { success: false, exitCode: 1, estimatedCost: 0.02 }, // implementer fails
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("session-failure");
  });

  test("post-TDD test failure sets failureCategory='tests-failing'", async () => {
    // Verifier session fails AND independent test run also fails
    let revParseCount = 0;
    let diffCount = 0;

    const diffFiles = [
      ["test/user.test.ts"],
      ["test/user.test.ts"],
      ["src/user.ts"],
      ["src/user.ts"],
      ["src/user.ts"],
    ];

    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "/bin/sh" && cmd[2]?.includes("bun test")) {
        return {
          pid: 9999,
          exited: Promise.resolve(1), // Tests FAIL
          stdout: new Response("3 pass, 2 fail\n").body,
          stderr: new Response("Test errors...\n").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        revParseCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`ref-${revParseCount}\n`).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "diff") {
        const files = diffFiles[diffCount] || [];
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(files.join("\n") + "\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier fails
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
  });

  test("success path has no failureCategory", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
  });

  test("zero-file auto-fallback (auto strategy) still works and succeeds without failureCategory", async () => {
    // In auto strategy, zero test files → downgrade to lite → success
    let revParseCount = 0;
    let diffCount = 0;

    const diffFiles = [
      ["requirements.md"],    // s1 isolation (strict) — no source violations
      ["requirements.md"],    // s1 getChangedFiles (strict) — 0 test files → fallback
      ["test/user.test.ts"], // s1 getChangedFiles (lite re-run)
      ["src/user.ts"],       // s2 getChangedFiles (lite re-run)
      [],                    // s3 isolation (lite re-run)
      [],                    // s3 getChangedFiles (lite re-run)
    ];

    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        revParseCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`ref-${revParseCount}\n`).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "checkout") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("").body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "diff") {
        const files = diffFiles[diffCount] || [];
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(files.join("\n") + "\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 }, // s1 strict test-writer
      { success: true, estimatedCost: 0.01 }, // s1 lite test-writer
      { success: true, estimatedCost: 0.02 }, // s2 lite implementer
      { success: true, estimatedCost: 0.01 }, // s3 lite verifier
    ]);

    const configWithAutoStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "auto" as const },
    };

    const result = await runThreeSessionTdd(
      agent, story, configWithAutoStrategy, "/tmp/test", "balanced",
    );

    expect(result.success).toBe(true);
    expect(result.lite).toBe(true);
    expect(result.failureCategory).toBeUndefined(); // No failure category on success
  });
});

// ─── T9: Verdict integration tests ───────────────────────────────────────────

describe("runThreeSessionTdd — T9: verdict integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/nax-t9-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    Bun.spawn = originalSpawn;
  });

  /** Write a valid verdict file to tmpDir */
  async function writeVerdictToDir(opts: {
    approved: boolean;
    failReason?: "tests-failing" | "illegitimate-mods" | "criteria-not-met" | "poor-quality";
  }) {
    const verdict = {
      version: 1,
      approved: opts.approved,
      tests: {
        allPassing: opts.failReason !== "tests-failing",
        passCount: opts.failReason === "tests-failing" ? 5 : 10,
        failCount: opts.failReason === "tests-failing" ? 3 : 0,
      },
      testModifications: {
        detected: opts.failReason === "illegitimate-mods",
        files: opts.failReason === "illegitimate-mods" ? ["test/foo.test.ts"] : [],
        legitimate: opts.failReason !== "illegitimate-mods",
        reasoning: opts.failReason === "illegitimate-mods" ? "Implementer cheated" : "No mods",
      },
      acceptanceCriteria: {
        allMet: opts.failReason !== "criteria-not-met",
        criteria:
          opts.failReason === "criteria-not-met"
            ? [{ criterion: "Must work", met: false }]
            : [{ criterion: "Works", met: true }],
      },
      quality: {
        rating: opts.failReason === "poor-quality" ? "poor" : "good",
        issues: opts.failReason === "poor-quality" ? ["Security issue"] : [],
      },
      fixes: [],
      reasoning: opts.approved ? "All good." : "Implementation rejected.",
    };
    await writeFile(path.join(tmpDir, VERDICT_FILE), JSON.stringify(verdict, null, 2));
  }

  /**
   * Mock Bun.spawn for a full 3-session T9 run.
   * Provides 6 git diff calls (isolation + getChangedFiles per session)
   * and optionally intercepts the post-TDD shell command (bun test).
   */
  function mockGitAndTestForT9(opts: {
    diffFiles?: string[][];
    onTestCmd?: () => { exitCode: number; stdout: string };
  }) {
    const files = opts.diffFiles ?? [
      ["test/user.test.ts"], // s1 isolation
      ["test/user.test.ts"], // s1 getChangedFiles
      ["src/user.ts"],       // s2 isolation
      ["src/user.ts"],       // s2 getChangedFiles
      [],                    // s3 isolation
      ["src/user.ts"],       // s3 getChangedFiles
    ];
    let revParseCount = 0;
    let diffCount = 0;

    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "/bin/sh" && cmd[2]?.includes("bun test")) {
        const r = opts.onTestCmd?.() ?? { exitCode: 0, stdout: "5 pass, 0 fail\n" };
        return {
          pid: 9999,
          exited: Promise.resolve(r.exitCode),
          stdout: new Response(r.stdout).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        revParseCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(`ref-${revParseCount}\n`).body,
          stderr: new Response("").body,
        };
      }
      if (cmd[0] === "git" && cmd[1] === "diff") {
        const f = files[diffCount] || [];
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(f.join("\n") + "\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });
  }

  test("verdict approved=true: overall success even when verifier session failed", async () => {
    await writeVerdictToDir({ approved: true });
    mockGitAndTestForT9({});

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier exits non-zero
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.success).toBe(true);
    expect(result.needsHumanReview).toBe(false);
    expect(result.failureCategory).toBeUndefined();
    expect(result.reviewReason).toBeUndefined();
  });

  test("verdict approved=true: skips the post-TDD independent test check", async () => {
    await writeVerdictToDir({ approved: true });
    let testCommandCalled = false;
    mockGitAndTestForT9({
      onTestCmd: () => {
        testCommandCalled = true;
        return { exitCode: 0, stdout: "" };
      },
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier fails
    ]);

    await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");
    expect(testCommandCalled).toBe(false); // Test was NOT run when verdict present
  });

  test("verdict approved=false + tests-failing → failureCategory='tests-failing'", async () => {
    await writeVerdictToDir({ approved: false, failReason: "tests-failing" });
    mockGitAndTestForT9({});

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 }, // sessions succeed but verdict says rejected
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.success).toBe(false);
    expect(result.needsHumanReview).toBe(true);
    expect(result.failureCategory).toBe("tests-failing");
    expect(result.reviewReason).toContain("failure(s)");
  });

  test("verdict approved=false + illegitimate test mods → failureCategory='verifier-rejected'", async () => {
    await writeVerdictToDir({ approved: false, failReason: "illegitimate-mods" });
    mockGitAndTestForT9({});

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("illegitimate test modifications");
  });

  test("verdict approved=false + criteria not met → failureCategory='verifier-rejected'", async () => {
    await writeVerdictToDir({ approved: false, failReason: "criteria-not-met" });
    mockGitAndTestForT9({});

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("verifier-rejected");
    expect(result.reviewReason).toContain("Must work");
  });

  test("no verdict file → fallback: post-TDD test check is run on session failures", async () => {
    // No verdict file — when verifier fails, falls back to running tests independently
    let testCommandCalled = false;
    mockGitAndTestForT9({
      onTestCmd: () => {
        testCommandCalled = true;
        return { exitCode: 0, stdout: "5 pass, 0 fail\n" }; // Tests pass in fallback
      },
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier fails
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(testCommandCalled).toBe(true); // Fallback test run was executed
    expect(result.success).toBe(true); // Tests pass in fallback → success
    expect(result.verdict).toBeNull(); // No verdict available
  });

  test("malformed verdict → fallback: post-TDD test check is run", async () => {
    // Write invalid JSON — should trigger fallback
    await writeFile(path.join(tmpDir, VERDICT_FILE), "{ this is not valid json }");
    let testCommandCalled = false;
    mockGitAndTestForT9({
      onTestCmd: () => {
        testCommandCalled = true;
        return { exitCode: 0, stdout: "5 pass\n" };
      },
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: false, exitCode: 1, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(testCommandCalled).toBe(true); // Fallback used when verdict is malformed
    expect(result.verdict).toBeNull(); // Malformed = null
  });

  test("verdict stored in result.verdict for logging/debugging (approved=true)", async () => {
    await writeVerdictToDir({ approved: true });
    mockGitAndTestForT9({});

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.verdict).toBeDefined();
    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.version).toBe(1);
    expect(result.verdict!.approved).toBe(true);
    expect(result.verdict!.tests.allPassing).toBe(true);
    expect(result.verdict!.tests.passCount).toBe(10);
    expect(result.verdict!.reasoning).toBe("All good.");
  });

  test("verdict stored in result.verdict for logging/debugging (approved=false)", async () => {
    await writeVerdictToDir({ approved: false, failReason: "tests-failing" });
    mockGitAndTestForT9({});

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.verdict).not.toBeNull();
    expect(result.verdict!.approved).toBe(false);
    expect(result.verdict!.tests.failCount).toBe(3);
  });

  test("verdict file is deleted after reading (cleanup enforced)", async () => {
    await writeVerdictToDir({ approved: true });
    mockGitAndTestForT9({});

    const verdictPath = path.join(tmpDir, VERDICT_FILE);
    expect(existsSync(verdictPath)).toBe(true); // File exists before run

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);
    await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(existsSync(verdictPath)).toBe(false); // File cleaned up after run
  });

  test("no verdict + all sessions succeed → success without running test check", async () => {
    // All sessions succeed, no verdict → should succeed and NOT run the test command
    let testCommandCalled = false;
    mockGitAndTestForT9({
      onTestCmd: () => {
        testCommandCalled = true;
        return { exitCode: 0, stdout: "" };
      },
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.success).toBe(true);
    expect(testCommandCalled).toBe(false); // Not needed when sessions all succeed
    expect(result.verdict).toBeNull(); // No verdict
    expect(result.failureCategory).toBeUndefined();
  });

  test("early-exit before session 3 (session 1 fails) → verdict is undefined (not attempted)", async () => {
    // If we exit before session 3, verdict reading is never attempted
    mockGitAndTestForT9({
      diffFiles: [
        ["test/user.test.ts"], // s1 isolation
        ["test/user.test.ts"], // s1 getChangedFiles
      ],
    });

    const agent = createMockAgent([
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // session 1 fails
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, tmpDir, "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1);
    // verdict is undefined (field not set) because we never got to session 3
    expect(result.verdict).toBeUndefined();
  });
});
