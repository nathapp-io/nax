// RE-ARCH: keep
/**
 * Unified Verification Orchestrator Types (ADR-005, Phase 1)
 *
 * Defines the shared types used by the VerificationOrchestrator and all
 * verification strategies. Coexists with existing types.ts — these types
 * are additive and do not replace existing interfaces until Phase 3.
 */

import type { NaxConfig } from "../config";
import type { SmartTestRunnerConfig } from "../config/types";
import type { NaxIgnoreIndex } from "../utils/path-filters";

// ---------------------------------------------------------------------------
// Strategy enum
// ---------------------------------------------------------------------------

export type VerifyStrategy = "scoped" | "regression" | "deferred-regression" | "acceptance";

// ---------------------------------------------------------------------------
// Input context
// ---------------------------------------------------------------------------

export interface VerifyContext {
  workdir: string;
  testCommand: string;
  /** Scoped test command template with {{files}} placeholder — overrides buildSmartTestCommand heuristic */
  testScopedTemplate?: string;
  timeoutSeconds: number;
  storyId: string;
  storyGitRef?: string;
  smartRunnerConfig?: SmartTestRunnerConfig;
  regressionMode?: string;
  acceptOnTimeout?: boolean;
  acceptanceTestPath?: string;
  config?: NaxConfig;
  naxIgnoreIndex?: NaxIgnoreIndex;
}

// ---------------------------------------------------------------------------
// Structured failure
// ---------------------------------------------------------------------------

export interface StructuredTestFailure {
  file: string;
  testName: string;
  error: string;
  stackTrace: string[];
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type VerifyStatus =
  | "PASS"
  | "TEST_FAILURE"
  | "TIMEOUT"
  | "BUILD_ERROR"
  | "SKIPPED"
  | "ASSET_CHECK_FAILED"
  | "RUNTIME_CRASH";

export interface VerifyResult {
  success: boolean;
  status: VerifyStatus;
  storyId: string;
  strategy: VerifyStrategy;
  passCount: number;
  failCount: number;
  totalCount: number;
  failures: StructuredTestFailure[];
  rawOutput?: string;
  durationMs: number;
  countsTowardEscalation: boolean;
  /** #89: Exit code from the test command (to distinguish passing from infra failure) */
  exitCode?: number;
  /** When ScopedStrategy.verify() falls back to full suite due to threshold, set to true (US-002) */
  scopeTestFallback?: boolean;
}

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

export interface IVerificationStrategy {
  readonly name: VerifyStrategy;
  execute(ctx: VerifyContext): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeSkippedResult(
  storyId: string,
  strategy: VerifyStrategy,
  scopeTestFallback?: boolean,
): VerifyResult {
  return {
    success: true,
    status: "SKIPPED",
    storyId,
    strategy,
    passCount: 0,
    failCount: 0,
    totalCount: 0,
    failures: [],
    durationMs: 0,
    countsTowardEscalation: false,
    scopeTestFallback,
  };
}

export function makeFailResult(
  storyId: string,
  strategy: VerifyStrategy,
  status: VerifyStatus,
  opts: {
    rawOutput?: string;
    failures?: StructuredTestFailure[];
    passCount?: number;
    failCount?: number;
    durationMs?: number;
    countsTowardEscalation?: boolean;
    exitCode?: number;
    scopeTestFallback?: boolean;
  } = {},
): VerifyResult {
  return {
    success: false,
    status,
    storyId,
    strategy,
    passCount: opts.passCount ?? 0,
    failCount: opts.failCount ?? 0,
    totalCount: (opts.passCount ?? 0) + (opts.failCount ?? 0),
    failures: opts.failures ?? [],
    rawOutput: opts.rawOutput,
    durationMs: opts.durationMs ?? 0,
    countsTowardEscalation: opts.countsTowardEscalation ?? true,
    exitCode: opts.exitCode,
    scopeTestFallback: opts.scopeTestFallback,
  };
}

export function makePassResult(
  storyId: string,
  strategy: VerifyStrategy,
  opts: {
    rawOutput?: string;
    passCount?: number;
    durationMs?: number;
    scopeTestFallback?: boolean;
  } = {},
): VerifyResult {
  return {
    success: true,
    status: "PASS",
    storyId,
    strategy,
    passCount: opts.passCount ?? 0,
    failCount: 0,
    totalCount: opts.passCount ?? 0,
    failures: [],
    rawOutput: opts.rawOutput,
    durationMs: opts.durationMs ?? 0,
    countsTowardEscalation: false,
    ...(opts.scopeTestFallback !== undefined && {
      scopeTestFallback: opts.scopeTestFallback,
    }),
  };
}
