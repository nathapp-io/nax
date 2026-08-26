/**
 * Shared test helpers for TDD orchestrator tests.
 *
 * Provides mockGitSpawn, createMockAgent, and setup/teardown for injectable deps.
 * Uses _isolationDeps, _gitDeps, _executorDeps, _rollbackDeps instead of
 * global Bun.spawn to avoid cross-file contamination in parallel test runs.
 */
import { mock } from "bun:test";
import { makeNaxConfig, makeSpawn } from "@test/helpers";
import type { AgentAdapter, AgentResult } from "@/agents";
import { _fullSuiteGateDeps } from "@/operations/full-suite-gate";
import { _isolationDeps } from "@/tdd/isolation";
import { _rollbackDeps } from "@/tdd/rollback";
import { _gitDeps } from "@/utils/git";
import { _executorDeps } from "@/verification/executor";
import { _regressionRunnerDeps } from "@/verification/runners";

/** Saved originals for teardown */
export interface SavedDeps {
  isolationSpawn: typeof _isolationDeps.spawn;
  executorSpawn: typeof _executorDeps.spawn;
  gitSpawn: typeof _gitDeps.spawn;
  rollbackSpawn: typeof _rollbackDeps.spawn;
  fullSuiteGateResolveCtx: typeof _fullSuiteGateDeps.resolveGateContext;
  regressionSleep: typeof _regressionRunnerDeps.sleep;
}

/** Save current deps state */
export function saveDeps(): SavedDeps {
  return {
    isolationSpawn: _isolationDeps.spawn,
    executorSpawn: _executorDeps.spawn,
    gitSpawn: _gitDeps.spawn,
    rollbackSpawn: _rollbackDeps.spawn,
    fullSuiteGateResolveCtx: _fullSuiteGateDeps.resolveGateContext,
    regressionSleep: _regressionRunnerDeps.sleep,
  };
}

/** Restore deps from saved state */
export function restoreDeps(saved: SavedDeps): void {
  _isolationDeps.spawn = saved.isolationSpawn;
  _executorDeps.spawn = saved.executorSpawn;
  _gitDeps.spawn = saved.gitSpawn;
  _rollbackDeps.spawn = saved.rollbackSpawn;
  _fullSuiteGateDeps.resolveGateContext = saved.fullSuiteGateResolveCtx;
  _regressionRunnerDeps.sleep = saved.regressionSleep;
}

/**
 * Stub `_fullSuiteGateDeps.resolveGateContext` for integration tests that exercise
 * the full-suite gate without a real .nax/config.json. The TEST_COMMAND_MISSING
 * NaxError thrown by the production resolver is intentional at runtime — tests
 * bypass it by short-circuiting config resolution.
 *
 * Also stubs `_regressionRunnerDeps.sleep` to eliminate the 2s agent-cleanup delay
 * that regression() inserts before every test run — without this, each fullSuiteGate
 * call adds 2s of wall-clock time to integration tests.
 */
export function stubFullSuiteGateContext(testCmd = "bun test"): void {
  _fullSuiteGateDeps.resolveGateContext = async (input) => ({
    config: makeNaxConfig(),
    testCmd,
    fullSuiteTimeout: 60,
    cmdWorkdir: input.workdir,
  });
  _regressionRunnerDeps.sleep = async () => {};
}

/** Create a mock agent that returns sequential results */
export function createMockAgent(results: Partial<AgentResult>[]): AgentAdapter {
  let callCount = 0;
  return {
    name: "mock",
    displayName: "Mock Agent",
    binary: "mock",
    capabilities: {
      supportedTiers: ["fast", "balanced", "powerful"],
      maxContextTokens: 200_000,
      features: new Set<"tdd" | "review" | "refactor" | "batch">(),
    },
    isInstalled: async () => true,
    buildCommand: () => ["mock"],
    complete: mock(async () => ({ output: "", tokenUsage: { inputTokens: 0, outputTokens: 0 }, estimatedCostUsd: 0 })),
    closePhysicalSession: mock(async () => {}),
    openSession: mock(async () => ({ id: "mock-session", agentName: "mock" })),
    sendTurn: mock(async () => {
      const r = results[callCount] || {};
      callCount++;
      if (r.success === false) {
        throw new Error(`Agent "mock" failed: ${r.output ?? "Agent failed"}`);
      }
      // Default to a parseable JSON envelope so callOp's CALL_OP_NO_OUTPUT
      // guard accepts the response. Callers supplying explicit `output` (e.g.
      // for parser-specific assertions) override this default.
      // Include `approved` so verifierOp.parse (which uses coerceVerdict) can
      // derive the correct approval status from the same envelope. Also
      // include a `tests` object with real (albeit fake) pass/fail evidence
      // — coerceVerdict (BUG-1, D-1) no longer seeds `tests.allPassing` from
      // `approved` alone; it requires actual test evidence, and this generic
      // envelope is reused for the verifier session role too.
      const approved = !!(r.success ?? true);
      const defaultOutput = JSON.stringify({
        success: r.success ?? true,
        filesChanged: [],
        approved,
        tests: { allPassing: approved, passCount: approved ? 1 : 0, failCount: approved ? 0 : 1 },
      });
      return {
        output: r.output ?? defaultOutput,
        tokenUsage: { inputTokens: 0, outputTokens: 0 },
        internalRoundTrips: 1,
        estimatedCostUsd: r.estimatedCostUsd ?? 0,
      };
    }),
    closeSession: mock(async () => {}),
  };
}

/**
 * The subset of a subprocess that inline spawn mocks provide and the source
 * actually reads — same contract as makeSpawn's FakeProcSpec, expressed from
 * the fake side. Everything else on Subprocess (kill/ref/unref/…) is never
 * touched on these paths.
 */
interface PartialSubprocess {
  exited?: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | null;
  stderr?: ReadableStream<Uint8Array> | null;
  pid?: number;
}

/**
 * Present a partially-shaped spawn fake at the type the `_xDeps.spawn` slots
 * declare — same overload move as makeSpawnResult: the public signature is
 * what the slots require, while the implementation hands the fake through
 * untouched, because the source reads only the PartialSubprocess subset.
 */
function presentAsSpawn(mockFn: (cmd: string[], opts?: Record<string, unknown>) => PartialSubprocess): typeof Bun.spawn;
function presentAsSpawn(mockFn: (cmd: string[], opts?: Record<string, unknown>) => PartialSubprocess): unknown {
  return (cmd: string[], opts?: Record<string, unknown>) => mockFn(cmd, opts);
}

/**
 * Set all spawn deps to a single mock function.
 * Use for inline mocks that need custom behavior across all spawn points.
 */
export function mockAllSpawn(mockFn: (cmd: string[], opts?: Record<string, unknown>) => PartialSubprocess): void {
  const presented = presentAsSpawn(mockFn);
  _isolationDeps.spawn = presented;
  _executorDeps.spawn = presented;
  _gitDeps.spawn = presented;
  _rollbackDeps.spawn = presented;
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
  _isolationDeps.spawn = makeSpawn(({ cmd }) => {
    if (cmd[0] === "git" && cmd[1] === "diff") {
      const files = opts.diffFiles[diffCount] || [];
      diffCount++;
      return `${files.join("\n")}\n`;
    }
    // Fallback — shouldn't happen in normal test flow
    return "";
  }).spawn;

  // Mock git rev-parse, checkout, reset, clean, status, add, commit (captureGitRef, rollback, autoCommit)
  const gitStub = makeSpawn(({ cmd, opts }) => {
    if (cmd[0] === "git" && cmd[1] === "rev-parse") {
      if (cmd[2] === "--show-toplevel") {
        // autoCommitIfDirty guard — return the workdir so it passes
        return `${typeof opts.cwd === "string" ? opts.cwd : "/tmp/test"}\n`;
      }
      revParseCount++;
      return `ref-${revParseCount}\n`;
    }
    // Default: succeed silently (git checkout, reset, clean, status, add, commit)
    return "";
  });
  _gitDeps.spawn = gitStub.spawn;
  _rollbackDeps.spawn = gitStub.spawn;

  // Mock test command execution (executeWithTimeout)
  _executorDeps.spawn = makeSpawn(() => ({
    pid: 9999,
    exitCode: testSuccess ? 0 : 1,
    stdout: testSuccess ? "tests pass\n" : "tests fail\n",
  })).spawn;
}
