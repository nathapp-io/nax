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

    const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("isolation-violation");
  });

  test("test-writer zero files (non-auto strategy) sets failureCategory='isolation-violation'", async () => {
    // In strict strategy, zero test files → greenfield-no-tests category (BUG-010 behavior)
    mockGitSpawn({
      diffFiles: [
        ["requirements.md"], // s1 isolation — no source violations
        ["requirements.md"], // s1 getChangedFiles — 0 test files
      ],
    });

    const agent = createMockAgent([{ success: true, estimatedCostUsd: 0.01 }]);

    const configWithStrictStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "strict" as const },
    };

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: configWithStrictStrategy,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("greenfield-no-tests");
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
      { success: false, exitCode: 1, estimatedCostUsd: 0.01 }, // Agent crash
    ]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

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
      { success: true, estimatedCostUsd: 0.01 }, // test-writer OK
      { success: false, exitCode: 1, estimatedCostUsd: 0.02 }, // implementer fails
    ]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("session-failure");
  });

  test("post-TDD test failure sets failureCategory='tests-failing'", async () => {
    // Verifier session fails AND independent post-TDD test run also fails.
    // The full-suite gate (runs before the verifier) must PASS so it doesn't
    // consume agent mock results via rectification. Only the post-verifier T9
    // check should see failures.
    let revParseCount = 0;
    let diffCount = 0;
    let testRunCount = 0;

    const diffFiles = [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"], ["src/user.ts"]];

    mockAllSpawn(mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "/bin/sh" && cmd[2]?.includes("bun test")) {
        testRunCount++;
        // First call = full-suite gate (before verifier): pass cleanly so no rectification.
        if (testRunCount === 1) {
          return {
            pid: 9999,
            exited: Promise.resolve(0),
            stdout: new Response("3 pass 0 fail\n").body,
            stderr: new Response("").body,
          };
        }
        // Subsequent calls = post-TDD verification (after verifier fails): still failing.
        return {
          pid: 9999,
          exited: Promise.resolve(1),
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
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: false, exitCode: 1, estimatedCostUsd: 0.01 }, // verifier fails
    ]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.failureCategory).toBe("tests-failing");
  });

  test("success path has no failureCategory", async () => {
    mockGitSpawn({
      diffFiles: [["test/user.test.ts"], ["test/user.test.ts"], ["src/user.ts"], ["src/user.ts"], ["src/user.ts"]],
    });

    const agent = createMockAgent([
      { success: true, estimatedCostUsd: 0.01 },
      { success: true, estimatedCostUsd: 0.02 },
      { success: true, estimatedCostUsd: 0.01 },
    ]);

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(true);
    expect(result.failureCategory).toBeUndefined();
  });

  test("zero-file scenario (auto strategy) returns greenfield-no-tests (BUG-010 removed auto-fallback)", async () => {
    // BUG-010: In auto strategy, zero test files → return greenfield-no-tests (no more fallback)
    let diffCount = 0;

    const diffFiles = [
      ["requirements.md"], // s1 isolation (strict) — no source violations
      ["requirements.md"], // s1 getChangedFiles (strict) — 0 test files → return greenfield-no-tests
    ];


    mockAllSpawn(mock((cmd: string[], spawnOpts?: any) => {
      if (cmd[0] === "git" && cmd[1] === "rev-parse") {
        return {
          exited: Promise.resolve(0),
          stdout: new Response("ref-1\n").body,
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
      { success: true, estimatedCostUsd: 0.01 }, // s1 strict test-writer
    ]);

    const configWithAutoStrategy = {
      ...DEFAULT_CONFIG,
      tdd: { ...DEFAULT_CONFIG.tdd, strategy: "auto" as const },
    };

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: configWithAutoStrategy,
      workdir: "/tmp/test",
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.lite).toBe(false);
    expect(result.failureCategory).toBe("greenfield-no-tests");
  });
});

// ─── T9: Verdict integration tests ───────────────────────────────────────────

