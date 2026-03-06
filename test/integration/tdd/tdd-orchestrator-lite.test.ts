import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, AgentResult } from "../../../src/agents";
import { DEFAULT_CONFIG } from "../../../src/config";
import type { UserStory } from "../../../src/prd";
import { runThreeSessionTdd } from "../../../src/tdd/orchestrator";
import { VERDICT_FILE } from "../../../src/tdd/verdict";

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
  /** Optional: mock test command success (default: true) */
  testCommandSuccess?: boolean;
}) {
  let revParseCount = 0;
  let diffCount = 0;
  const testSuccess = opts.testCommandSuccess ?? true;

  // @ts-ignore — mocking global
  Bun.spawn = mock((cmd: string[], spawnOpts?: any) => {
    // Intercept test commands (bun test, npm test, etc.)
    if ((cmd[0] === "/bin/sh" || cmd[0] === "/bin/bash" || cmd[0] === "/bin/zsh") && cmd[1] === "-c") {
      return {
        pid: 9999,
        exited: Promise.resolve(testSuccess ? 0 : 1),
        stdout: new Response(testSuccess ? "tests pass\n" : "tests fail\n").body,
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


describe("runThreeSessionTdd — lite mode", () => {
  test("lite mode: result includes lite=true flag", async () => {
    // In lite mode all 3 sessions succeed
    // Lite skips isolation for sessions 1 and 2, so only 2 diff calls for those
    // Session 3 (verifier) always runs isolation: 2 diff calls (isolation + getChangedFiles)
    // Total: 1 (s1 getChangedFiles) + 1 (s2 getChangedFiles) + 2 (s3) = 4 diff calls
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"], // s1 getChangedFiles (no isolation in lite)
        ["src/user.ts"], // s2 getChangedFiles (no isolation in lite)
        [], // s3 isolation check (verifier always checks)
        ["src/user.ts"], // s3 getChangedFiles
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
      lite: true,
    });

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
        [], // s3 isolation
        ["src/user.ts"], // s3 getChangedFiles
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
      lite: false,
    });

    expect(result.lite).toBe(false);
    expect(result.success).toBe(true);
  });

  test("lite mode: test-writer session has no isolation check (isolation is undefined)", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"], // s1 getChangedFiles only (no isolation in lite)
        ["src/user.ts"], // s2 getChangedFiles only (no isolation in lite)
        [], // s3 isolation
        ["src/user.ts"], // s3 getChangedFiles
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
      lite: true,
    });

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
        ["test/user.test.ts"], // s1 getChangedFiles
        ["test/user.test.ts", "src/user.ts"], // s2 getChangedFiles
        [], // s3 isolation
        [], // s3 getChangedFiles
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
      lite: true,
    });

    expect(result.sessions[1].isolation).toBeUndefined(); // No isolation in lite
    expect(result.sessions[1].success).toBe(true); // Agent succeeded
    expect(result.success).toBe(true);
    expect(result.lite).toBe(true);
  });

  test("lite mode: verifier always runs isolation check (even in lite mode)", async () => {
    mockGitSpawn({
      diffFiles: [
        ["test/user.test.ts"], // s1 getChangedFiles
        ["src/user.ts"], // s2 getChangedFiles
        [], // s3 isolation (verifier always checks)
        [], // s3 getChangedFiles
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
      lite: true,
    });

    expect(result.sessions[2].isolation).toBeDefined();
    expect(result.sessions[2].isolation?.passed).toBe(true);
    expect(result.lite).toBe(true);
  });

  test("lite mode: dry-run returns lite=true", async () => {
    const agent = createMockAgent([]);
    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: "/tmp/test",
      modelTier: "balanced",
      dryRun: true,
      lite: true,
    });
    expect(result.lite).toBe(true);
    expect(result.success).toBe(true);
    expect(result.sessions).toHaveLength(0);
  });
});

// ─── T4: Zero-file fallback tests ────────────────────────────────────────────

