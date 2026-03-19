/**
 * Shared test helpers for TDD orchestrator tests.
 *
 * Provides mockGitSpawn, createMockAgent, and setup/teardown for injectable deps.
 * Uses _isolationDeps, _gitDeps, _executorDeps, _sessionRunnerDeps instead of
 * global Bun.spawn to avoid cross-file contamination in parallel test runs.
 */
import { mock } from "bun:test";
import type { AgentAdapter, AgentResult } from "../../../src/agents";
import { _isolationDeps } from "../../../src/tdd/isolation";
import { _executorDeps } from "../../../src/verification/executor";
import { _gitDeps } from "../../../src/utils/git";
import { _sessionRunnerDeps } from "../../../src/tdd/session-runner";

/** Saved originals for teardown */
export interface SavedDeps {
  isolationSpawn: typeof _isolationDeps.spawn;
  executorSpawn: typeof _executorDeps.spawn;
  gitSpawn: typeof _gitDeps.spawn;
  sessionRunnerSpawn: typeof _sessionRunnerDeps.spawn;
}

/** Save current deps state */
export function saveDeps(): SavedDeps {
  return {
    isolationSpawn: _isolationDeps.spawn,
    executorSpawn: _executorDeps.spawn,
    gitSpawn: _gitDeps.spawn,
    sessionRunnerSpawn: _sessionRunnerDeps.spawn,
  };
}

/** Restore deps from saved state */
export function restoreDeps(saved: SavedDeps): void {
  _isolationDeps.spawn = saved.isolationSpawn;
  _executorDeps.spawn = saved.executorSpawn;
  _gitDeps.spawn = saved.gitSpawn;
  _sessionRunnerDeps.spawn = saved.sessionRunnerSpawn;
}

/** Create a mock agent that returns sequential results */
export function createMockAgent(results: Partial<AgentResult>[]): AgentAdapter {
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

/** Standard mock response for Bun.spawn */
function mockResponse(text: string) {
  return new Response(text).body;
}

/**
 * Set all spawn deps to a single mock function.
 * Use for inline mocks that need custom behavior across all spawn points.
 */
export function mockAllSpawn(mockFn: any): void {
  _isolationDeps.spawn = mockFn;
  _executorDeps.spawn = mockFn;
  _gitDeps.spawn = mockFn;
  _sessionRunnerDeps.spawn = mockFn;
}

/**
 * Mock all injectable deps to intercept git/test commands.
 * Replaces the old `mockGitSpawn` that mutated global Bun.spawn.
 */
export function mockGitSpawn(opts: {
  /** Files returned by git diff for each session (indexed by git-diff call number) */
  diffFiles: string[][];
  /** Optional: mock test command success (default: true) */
  testCommandSuccess?: boolean;
}) {
  let revParseCount = 0;
  let diffCount = 0;
  const testSuccess = opts.testCommandSuccess ?? true;

  // Mock git diff calls (isolation checks + getChangedFiles)
  _isolationDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
    if (cmd[0] === "git" && cmd[1] === "diff") {
      const files = opts.diffFiles[diffCount] || [];
      diffCount++;
      return {
        exited: Promise.resolve(0),
        stdout: mockResponse(files.join("\n") + "\n"),
        stderr: mockResponse(""),
      };
    }
    // Fallback — shouldn't happen in normal test flow
    return {
      exited: Promise.resolve(0),
      stdout: mockResponse(""),
      stderr: mockResponse(""),
    };
  }) as any;

  // Mock git rev-parse, checkout, reset, clean, status, add, commit (captureGitRef, rollback, autoCommit)
  const gitMock = mock((cmd: string[], spawnOpts?: any) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      if (cmd[2] === "--show-toplevel") {
        // autoCommitIfDirty guard — return the workdir so it passes
        return {
          exited: Promise.resolve(0),
          stdout: mockResponse((spawnOpts?.cwd ?? "/tmp/test") + "\n"),
          stderr: mockResponse(""),
        };
      }
      revParseCount++;
      return {
        exited: Promise.resolve(0),
        stdout: mockResponse(`ref-${revParseCount}\n`),
        stderr: mockResponse(""),
      };
    }
    // Default: succeed silently (git checkout, reset, clean, status, add, commit)
    return {
      exited: Promise.resolve(0),
      stdout: mockResponse(""),
      stderr: mockResponse(""),
    };
  }) as any;

  _gitDeps.spawn = gitMock;
  _sessionRunnerDeps.spawn = gitMock;

  // Mock test command execution (executeWithTimeout)
  _executorDeps.spawn = mock((cmd: string[], spawnOpts?: any) => {
    return {
      pid: 9999,
      exited: Promise.resolve(testSuccess ? 0 : 1),
      stdout: mockResponse(testSuccess ? "tests pass\n" : "tests fail\n"),
      stderr: mockResponse(""),
    };
  }) as any;
}
