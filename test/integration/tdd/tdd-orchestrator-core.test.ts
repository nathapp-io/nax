import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AgentResult } from "../../../src/agents";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { runThreeSessionTdd } from "../../../src/tdd/orchestrator";
import { VERDICT_FILE } from "../../../src/tdd/verdict";
import { type SavedDeps, createMockAgent, mockAllSpawn, mockGitSpawn, restoreDeps, saveDeps } from "./_tdd-test-helpers";

let saved: SavedDeps;

beforeEach(() => {
  saved = saveDeps();
});

afterEach(() => {
  restoreDeps(saved);
});

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

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
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"]],
    });

    const agent = createMockAgent([{ success: false, exitCode: 1, estimatedCost: 0.01 }]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

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

    const agent = createMockAgent([{ success: true, estimatedCost: 0.01 }]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    // v0.9.2: implementer touching test files is a warning, not a failure
    expect(result.sessions).toHaveLength(3);
    expect(result.sessions[1].success).toBe(true);
    expect(result.sessions[1].isolation?.warnings).toContain("test/user.test.ts");
    expect(result.success).toBe(true);
  });

  test("dry-run mode logs sessions without executing", async () => {
    const agent = createMockAgent([]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
      dryRun: true,
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "powerful",
      contextMarkdown,
      dryRun: true,
    });

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

    mockAllSpawn(mock((cmd: string[], spawnOpts?: any) => {
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
      return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body };
    }));

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 }, // test-writer succeeds
      { success: true, estimatedCost: 0.02 }, // implementer succeeds
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier fails (e.g., fixed issues)
    ]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1); // Should stop after session 1
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files (greenfield project)");
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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files (greenfield project)");
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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(3); // All sessions run
    expect(result.needsHumanReview).toBe(false);
  });

  test("BUG-22: post-TDD verification does not override when tests actually fail", async () => {
    // Scenario: Sessions complete with failures AND independent test run also fails
    // Expected: Result should remain failed
    // The full-suite gate (first bun test call) passes so it does not consume
    // agent mock results via rectification. Only the post-verifier T9 check sees failures.

    let testCommandCalled = false;
    let revParseCount = 0;
    let diffCount = 0;
    let testRunCount = 0;

    const diffFiles = [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"], ["src/user.ts"]];

    mockAllSpawn(mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "/bin/sh" && cmd[2]?.includes("bun test")) {
        testCommandCalled = true;
        testRunCount++;
        // First call = full-suite gate (before verifier): pass so no rectification.
        if (testRunCount === 1) {
          return {
            pid: 9999,
            exited: Promise.resolve(0),
            stdout: new Response("3 pass 0 fail\n").body,
            stderr: new Response("").body,
          };
        }
        // Subsequent calls = post-TDD verification: still failing.
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
      return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body };
    }));

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
      { success: false, exitCode: 1, estimatedCost: 0.01 }, // verifier fails
    ]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(testCommandCalled).toBe(true);
    expect(result.success).toBe(false); // Should remain failed
    expect(result.needsHumanReview).toBe(true); // Needs review
    expect(result.reviewReason).toBeDefined();
  });
});

// ─── Lite-mode prompt tests ───────────────────────────────────────────────────

import {
  buildImplementerLitePrompt,
  buildImplementerPrompt,
  buildTestWriterLitePrompt,
  buildTestWriterPrompt,
  buildVerifierPrompt,
} from "../../../src/tdd/prompts";

