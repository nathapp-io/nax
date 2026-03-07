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
      ["src/user.ts"], // s2 isolation
      ["src/user.ts"], // s2 getChangedFiles
      [], // s3 isolation
      ["src/user.ts"], // s3 getChangedFiles
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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    // Disable rectification to avoid test command being called for full-suite gate
    const configNoRectification = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: false },
      },
    };

    await runThreeSessionTdd({
      agent,
      story,
      config: configNoRectification,
      workdir: tmpDir,
      modelTier: "balanced",
    });
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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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
    await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    // Disable rectification to avoid test command being called for full-suite gate
    const configNoRectification = {
      ...DEFAULT_CONFIG,
      execution: {
        ...DEFAULT_CONFIG.execution,
        rectification: { ...DEFAULT_CONFIG.execution.rectification, enabled: false },
      },
    };

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: configNoRectification,
      workdir: tmpDir,
      modelTier: "balanced",
    });

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

    const result = await runThreeSessionTdd({
      agent,
      story,
      config: DEFAULT_CONFIG,
      workdir: tmpDir,
      modelTier: "balanced",
    });

    expect(result.success).toBe(false);
    expect(result.sessions).toHaveLength(1);
    // verdict is undefined (field not set) because we never got to session 3
    expect(result.verdict).toBeUndefined();
  });
});
