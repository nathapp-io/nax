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

  test("failure when implementer violates isolation", async () => {
    mockGitSpawn({
      diffFiles: [
        // Session 1 isolation: OK
        ["test/user.test.ts"],
        // Session 1 getChangedFiles
        ["test/user.test.ts"],
        // Session 2 isolation: implementer touched tests!
        ["test/user.test.ts", "src/user.ts"],
        // Session 2 getChangedFiles
        ["test/user.test.ts", "src/user.ts"],
      ],
    });

    const agent = createMockAgent([
      { success: true, estimatedCost: 0.01 },
      { success: true, estimatedCost: 0.02 },
    ]);

    const result = await runThreeSessionTdd(agent, story, DEFAULT_CONFIG, "/tmp/test", "balanced");

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[1].success).toBe(false);
    expect(result.needsHumanReview).toBe(true);
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
