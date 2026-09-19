/**
 * Run-start baseline capture and sequential roll-forward (US-002).
 *
 * Owns the harness-side capture step at the top of `runExecutionPhase` and
 * the per-story roll-forward writes in the post-run story-completion path.
 * Delegates persistence to `writeRunBaseline` / `writeStoryBaseline` from
 * `src/verification/test-baseline.ts`; this module is the orchestration layer,
 * not the IO layer.
 *
 * Out of scope (see US-002 §Out of Scope): baseline types/classification
 * (US-001), attaching dispositions to gate findings (US-003), prompt
 * rendering (US-004). Parallel-mode re-capture after a dependency merge is
 * also out of scope — parallel stories inherit the run-start baseline.
 */

import type { NaxConfig } from "@/config";
import { type TestBaseline, writeRunBaseline, writeStoryBaseline } from "@/verification";

/** Subset of TestExecutionResult the capture step actually reads. */
export interface CaptureRunnerResult {
  readonly success: boolean;
  readonly output: string;
  readonly timedOut: boolean;
  readonly exitCode?: number;
}

/** Subset of TestSummary the capture step actually reads. */
export interface CaptureParsedSummary {
  readonly passed: number;
  readonly failed: number;
  readonly failures: readonly { file: string; testName: string }[];
}

/**
 * Injectable seams. Production wiring populates them from
 * `executeWithTimeout` / `parseTestOutput` / `captureRunStartRef` /
 * `writeRunBaseline` / `writeStoryBaseline` / `resolveQualityTestCommands`.
 * Tests override the whole object to avoid `mock.module()` contamination.
 *
 * Fields are non-readonly so tests can override individual members (the
 * established _deps pattern in this codebase — e.g. _fullSuiteGateDeps,
 * _regressionDeps — uses the same shape).
 */
export interface TestBaselineCaptureDeps {
  resolveTestCommands: (config: NaxConfig, workdir: string) => Promise<string | undefined>;
  runCommand: (command: string, timeoutSeconds: number) => Promise<CaptureRunnerResult>;
  captureGitRef: (workdir: string) => Promise<string>;
  parseTestOutput: (output: string) => CaptureParsedSummary;
  writeRunBaseline: (root: string, featureId: string, baseline: TestBaseline) => Promise<void>;
  writeStoryBaseline: (root: string, featureId: string, storyId: string, baseline: TestBaseline) => Promise<void>;
  now: () => string;
  /** Resolve the gate timeout: regressionGate.timeoutSeconds ?? rectification.fullSuiteTimeoutSeconds ?? schema default. */
  resolveGateTimeoutSeconds: (config: NaxConfig) => number;
  regressionGateEnabled: (config: NaxConfig) => boolean;
}

export const _captureDeps: TestBaselineCaptureDeps = {
  resolveTestCommands: async () => undefined,
  runCommand: async () => ({ success: false, output: "", timedOut: false }),
  captureGitRef: async () => "",
  parseTestOutput: () => ({ passed: 0, failed: 0, failures: [] }),
  writeRunBaseline,
  writeStoryBaseline,
  now: () => new Date().toISOString(),
  resolveGateTimeoutSeconds: () => 300,
  regressionGateEnabled: () => true,
};

/** Options for the run-start capture step. */
export interface CaptureRunBaselineOptions {
  readonly root: string;
  readonly featureId: string;
  readonly config: NaxConfig;
  readonly workdir: string;
}

/** Options for the sequential roll-forward write. */
export interface RollForwardOptions {
  readonly root: string;
  readonly featureId: string;
  readonly executionMode: "sequential" | "parallel";
  /** Populated only in sequential mode — the next story's id, or undefined if this is the last story. */
  readonly nextStoryId?: string;
  /** The summary the gate phase just produced, or undefined when the gate did not produce one. */
  readonly summary?: CaptureParsedSummary;
}

/** Resolve the story id that follows `currentStoryId` in the PRD's userStories array. */
export function resolveNextStoryId(
  userStories: ReadonlyArray<{ id: string }>,
  currentStoryId: string,
): string | undefined {
  const idx = userStories.findIndex((s) => s.id === currentStoryId);
  if (idx < 0 || idx >= userStories.length - 1) return undefined;
  return userStories[idx + 1]?.id;
}

/** Minimal shape the post-run story-completion path must forward to `persistNextStoryRollForward`. */
export interface RollForwardContext {
  /** Repository root — anchors the baseline artifact paths. */
  readonly root: string;
  /** Feature id — segments the artifact tree. */
  readonly featureId: string;
  /** The current story's userStories array, used to resolve the next story id. */
  readonly userStories: ReadonlyArray<{ id: string }>;
  /** The current story id. */
  readonly currentStoryId: string;
  /**
   * True when the story is running under a parallel batch orchestrator (concurrent worktrees,
   * no total order). False for shared / sequential-worktree modes.
   */
  readonly isParallelMode: boolean;
  /** Optional full-suite-gate summary produced by the gate phase, when available. */
  readonly gateSummary?: CaptureParsedSummary;
}

/**
 * Resolves the next story id, builds the roll-forward options, and delegates to
 * `persistNextStoryRollForward`. Single entry point the post-run story-completion
 * path calls — keeps post-run.ts's hook at one delegated call (AC12).
 */
export async function invokeRollForwardFromContext(ctx: RollForwardContext): Promise<void> {
  const nextStoryId = resolveNextStoryId(ctx.userStories, ctx.currentStoryId);
  await persistNextStoryRollForward({
    root: ctx.root,
    featureId: ctx.featureId,
    executionMode: ctx.isParallelMode ? "parallel" : "sequential",
    nextStoryId,
    summary: ctx.gateSummary,
  });
}

/**
 * Captures the suite once and persists the run-start baseline. Never blocks
 * or fails the run — every degraded path resolves normally with a `no-baseline`
 * marker so the capture step is observable but never a tripwire.
 *
 * STUB — implementer replaces this body with the full capture-and-persist
 * logic. The stub writes a `no-baseline` marker so the call sites in
 * `runExecutionPhase` are observable end-to-end (AC11) and so every other AC
 * fails its assertion rather than timing out.
 */
export async function captureRunBaseline(opts: CaptureRunBaselineOptions): Promise<void> {
  await _captureDeps.writeRunBaseline(opts.root, opts.featureId, {
    kind: "no-baseline",
    reason: "error",
    capturedAt: _captureDeps.now(),
  });
}

/**
 * Persists the next-story roll-forward baseline after a sequential story
 * completes. Skipped entirely in parallel mode (every parallel story inherits
 * the run-start baseline).
 *
 * STUB — implementer replaces this body. The stub only writes when
 * `nextStoryId` is set, so parallel mode is naturally a no-op (AC14) and the
 * remaining ACs fail their assertion on the wrong shape.
 */
export async function persistNextStoryRollForward(opts: RollForwardOptions): Promise<void> {
  if (opts.nextStoryId === undefined) return;
  if (opts.executionMode === "parallel") return;
  await _captureDeps.writeStoryBaseline(opts.root, opts.featureId, opts.nextStoryId, {
    kind: "no-baseline",
    reason: "error",
    capturedAt: _captureDeps.now(),
  });
}
