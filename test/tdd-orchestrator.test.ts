import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { runThreeSessionTdd } from "../src/tdd/orchestrator";
import type { AgentAdapter, AgentResult } from "../src/agents";
import type { UserStory } from "../src/prd";
import { DEFAULT_CONFIG } from "../src/config";

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

  test("BUG-20: failure when test-writer creates no test files (strategy=strict)", async () => {
    // Scenario: Test-writer session succeeds and passes isolation but creates no test files
    // (e.g., creates requirements.md instead)
    // With strategy='strict', no lite fallback — should fail with needsHumanReview
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

    const strictConfig = { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const } };
    const result = await runThreeSessionTdd(agent, story, strictConfig, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1); // Should stop after session 1
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files");
  });

  test("BUG-20: failure when test-writer creates zero files (strategy=strict)", async () => {
    // Scenario: Test-writer session succeeds but creates no files at all
    // With strategy='strict', no lite fallback — should fail with needsHumanReview
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

    const strictConfig = { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const } };
    const result = await runThreeSessionTdd(agent, story, strictConfig, "/tmp/test", "balanced");

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

  test("zero-file fallback: strategy='auto' triggers lite mode re-run when 0 test files created", async () => {
    // Scenario: strict test-writer creates 0 test files but strategy='auto',
    // so it falls back to lite mode which successfully creates test files
    let revParseCount = 0;
    let diffCount = 0;
    let gitResetCalled = false;
    let callCount = 0;

    // First run (strict): session 1 creates no test files → triggers fallback
    // Second run (lite): session 1 creates test files, sessions 2-3 succeed
    const strictDiffFiles = [
      // Strict session 1: isolation check + getChangedFiles — no test files
      [],
      [],
    ];
    const liteDiffFiles = [
      // Lite session 1: getChangedFiles only (no isolation check in lite)
      ["test/user.test.ts"],
      // Lite session 2: getChangedFiles only (no isolation in lite)
      ["src/user.ts"],
      // Lite session 3: getChangedFiles
      ["src/user.ts"],
    ];

    // @ts-ignore — mocking global
    Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "git" && cmd[1] === "reset") {
        gitResetCalled = true;
        return { exited: Promise.resolve(0), stdout: new Response("").body, stderr: new Response("").body };
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
        // First 2 diff calls are for strict mode session 1
        const files = diffCount < 2 ? (strictDiffFiles[diffCount] || []) : (liteDiffFiles[diffCount - 2] || []);
        diffCount++;
        return {
          exited: Promise.resolve(0),
          stdout: new Response(files.join("\n") + "\n").body,
          stderr: new Response("").body,
        };
      }
      return originalSpawn(cmd, spawnOpts);
    });

    // Agent: first call (strict session 1) creates no test files,
    // then lite calls succeed
    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 }, // strict session 1 (triggers fallback)
      { success: true, estimatedCost: 0.01 }, // lite session 1
      { success: true, estimatedCost: 0.02 }, // lite session 2
      { success: true, estimatedCost: 0.01 }, // lite session 3
    ]);

    const autoConfig = { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, strategy: "auto" as const } };
    const result = await runThreeSessionTdd(agent, story, autoConfig, "/tmp/test", "balanced");

    expect(gitResetCalled).toBe(true); // Git was reset to undo strict session 1
    expect(result.lite).toBe(true); // Ran as lite mode
    expect(result.sessions).toHaveLength(3); // 3 sessions in lite mode
    expect(result.success).toBe(true);
  });

  test("zero-file fallback: strategy='strict' does NOT fall back — fails immediately", async () => {
    // With explicit strategy='strict', no fallback even when 0 test files
    mockGitSpawn({
      diffFiles: [
        // Session 1: isolation check — no test files
        [],
        // Session 1: getChangedFiles
        [],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
    ]);

    const strictConfig = { ...DEFAULT_CONFIG, tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const } };
    const result = await runThreeSessionTdd(agent, story, strictConfig, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1);
    expect(result.needsHumanReview).toBe(true);
    expect(result.reviewReason).toBe("Test writer session created no test files");
    expect(result.lite).toBe(false); // No lite fallback occurred
  });

  test("lite mode: uses lite prompts (test-writer gets lite prompt)", async () => {
    // Verify that when lite=true, the agent receives the lite-mode prompt
    let capturedPrompts: string[] = [];

    let revParseCount = 0;
    let diffCount = 0;
    const diffFiles = [
      // Lite mode: no isolation check for session 1, just getChangedFiles
      ["test/user.test.ts"],
      // Session 2: no isolation, just getChangedFiles
      ["src/user.ts"],
      // Session 3: getChangedFiles
      ["src/user.ts"],
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

    // Custom agent that captures prompts
    const agent: import("../src/agents").AgentAdapter = {
      name: "mock",
      displayName: "Mock Agent",
      binary: "mock",
      isInstalled: async () => true,
      buildCommand: () => ["mock"],
      run: mock(async (opts: any) => {
        capturedPrompts.push(opts.prompt);
        return {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 100,
          estimatedCost: 0.01,
        };
      }),
    };

    const result = await runThreeSessionTdd(
      agent,
      story,
      DEFAULT_CONFIG,
      "/tmp/test",
      "balanced",
      undefined, // no context
      false, // not dryRun
      true, // lite = true
    );

    expect(result.lite).toBe(true);
    expect(capturedPrompts).toHaveLength(3);

    // Session 1 prompt should be lite test-writer prompt
    expect(capturedPrompts[0]).toContain("Lite Mode");
    expect(capturedPrompts[0]).toContain("MAY read source files");
    expect(capturedPrompts[0]).not.toContain("DO NOT create or modify any source files");

    // Session 2 prompt should be lite implementer prompt
    expect(capturedPrompts[1]).toContain("Lite Mode");
    expect(capturedPrompts[1]).toContain("may adjust test files");
    expect(capturedPrompts[1]).not.toContain("DO NOT modify any test files");

    // Session 3 prompt should be standard verifier (unchanged)
    expect(capturedPrompts[2]).toContain("Session 3: Verify");
    expect(capturedPrompts[2].toLowerCase()).not.toContain("lite");
  });

  test("lite mode: skips isolation checks for test-writer and implementer", async () => {
    // In lite mode, isolation checks are skipped → no git diff for isolation
    // Only getChangedFiles is called (1 diff per session instead of 2)
    let diffCallCount = 0;

    let revParseCount = 0;
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
      if (cmd[0] === "git" && cmd[1] === "diff") {
        diffCallCount++;
        // Return test files for session 1, source files for sessions 2+3
        const files = diffCallCount === 1 ? ["test/user.test.ts"] : ["src/user.ts"];
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
      { success: true, estimatedCost: 0.01 },
    ]);

    const result = await runThreeSessionTdd(
      agent,
      story,
      DEFAULT_CONFIG,
      "/tmp/test",
      "balanced",
      undefined,
      false,
      true, // lite = true
    );

    expect(result.success).toBe(true);
    expect(result.lite).toBe(true);
    // In lite mode: 1 diff per session (only getChangedFiles, no isolation check)
    // 3 sessions × 1 diff = 3 total diff calls
    expect(diffCallCount).toBe(3);
    // Verify no isolation results in sessions 1 and 2
    expect(result.sessions[0].isolation).toBeUndefined();
    expect(result.sessions[1].isolation).toBeUndefined();
  });

  test("strict mode: uses strict prompts (test-writer does NOT get lite prompt)", async () => {
    // When lite=false (default), strict prompts are used
    let capturedPrompts: string[] = [];

    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"],
        ["test/user.test.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
        ["src/user.ts"],
      ],
    });

    // Custom agent that captures prompts
    const agent: import("../src/agents").AgentAdapter = {
      name: "mock",
      displayName: "Mock Agent",
      binary: "mock",
      isInstalled: async () => true,
      buildCommand: () => ["mock"],
      run: mock(async (opts: any) => {
        capturedPrompts.push(opts.prompt);
        return {
          success: true,
          exitCode: 0,
          output: "",
          rateLimited: false,
          durationMs: 100,
          estimatedCost: 0.01,
        };
      }),
    };

    const result = await runThreeSessionTdd(
      agent,
      story,
      DEFAULT_CONFIG,
      "/tmp/test",
      "balanced",
    );

    expect(result.lite).toBe(false);
    expect(capturedPrompts).toHaveLength(3);

    // Session 1 prompt should be strict test-writer prompt
    expect(capturedPrompts[0]).toContain("CRITICAL RULES");
    expect(capturedPrompts[0]).toContain("DO NOT create or modify any source files");
    expect(capturedPrompts[0]).not.toContain("MAY read source files");

    // Session 2 prompt should be strict implementer prompt
    expect(capturedPrompts[1]).toContain("CRITICAL RULES");
    expect(capturedPrompts[1]).toContain("DO NOT modify any test files");
    expect(capturedPrompts[1]).not.toContain("may adjust test files");
  });

  test("ThreeSessionTddResult includes lite flag", async () => {
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

    const strictResult = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");
    expect(strictResult.lite).toBe(false);
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
} from "../src/tdd/prompts";

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
  test("has no file restriction rules (does not say DO NOT modify test files)", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).not.toContain("DO NOT modify any test files");
  });

  test("has no file restriction rules (does not say ONLY create/modify source files)", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).not.toContain("ONLY create/modify source files");
  });

  test("allows adjusting test files", () => {
    const prompt = buildImplementerLitePrompt(story);
    expect(prompt).toContain("may adjust test files");
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
    expect(prompt).toContain("make");
    expect(prompt).toContain("tests pass");
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
    expect(strict).toContain("DO NOT create or modify any source files");
    expect(lite).not.toContain("DO NOT create or modify any source files");

    // Lite explicitly allows reading source files
    expect(lite).toContain("MAY read source files");
    expect(strict).not.toContain("MAY read source files");
  });

  test("strict implementer has harder isolation rules than lite", () => {
    const strict = buildImplementerPrompt(story);
    const lite = buildImplementerLitePrompt(story);

    // Strict bans test file modifications
    expect(strict).toContain("DO NOT modify any test files");
    expect(lite).not.toContain("DO NOT modify any test files");

    // Lite allows adjusting test files
    expect(lite).toContain("may adjust test files");
    expect(strict).not.toContain("may adjust test files");
  });
});
