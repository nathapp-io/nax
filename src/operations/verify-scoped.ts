import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import { testSummaryToFindings } from "../findings";
import type { Finding } from "../findings/types";
import { getLogger } from "../logger";
import { parseTestOutput, selectScopedTests, _scopedSelectionDeps } from "../test-runners";
import type { SelectScopedTestsResult, TestSummary } from "../test-runners";
import type { NaxIgnoreIndex } from "../utils/path-filters";
import { regression } from "../verification/runners";
import type { VerificationGateOptions, VerificationResult } from "../verification/types";
import type { CallContext, DeterministicOperation } from "./types";


export interface VerifyScopedInput {
  readonly workdir: string;
  readonly storyId: string;
  readonly packageDir?: string;
  /** Git ref to diff against for smart-runner change detection. Required for change-aware scoping. */
  readonly storyGitRef?: string;
  /** Resolved `.naxignore` index passed through to smart-runner. */
  readonly naxIgnoreIndex?: NaxIgnoreIndex;
  /** Regression-gate mode — controls SKIPPED behavior when no tests are mapped. */
  readonly regressionMode?: "deferred" | "per-story";
}

export type VerifyScopedStatus = "passed" | "failed" | "skipped" | "timeout";

export interface VerifyScopedOutput {
  readonly success: boolean;
  readonly status: VerifyScopedStatus;
  readonly findings: Finding[];
  readonly durationMs: number;
  readonly passCount: number;
  readonly isFullSuite: boolean;
  readonly scopeTestFallback?: boolean;
}

export interface VerifyScopedDeps {
  selectScopedTests: (input: Parameters<typeof selectScopedTests>[0]) => Promise<SelectScopedTestsResult>;
  regression: (opts: VerificationGateOptions) => Promise<VerificationResult>;
  parseTestOutput: (output: string) => TestSummary;
  testSummaryToFindings: (summary: TestSummary) => Finding[];
}

export const _verifyScopedDeps: VerifyScopedDeps = {
  selectScopedTests,
  regression,
  parseTestOutput,
  testSummaryToFindings,
};

export const verifyScopedOp: DeterministicOperation<VerifyScopedInput, VerifyScopedOutput, QualityConfig> = {
  kind: "deterministic",
  name: "verify-scoped",
  stage: "verify",
  config: qualityConfigSelector,
  async execute(
    input: VerifyScopedInput,
    ctx: CallContext,
    deps: VerifyScopedDeps = _verifyScopedDeps,
  ): Promise<VerifyScopedOutput> {
    const logger = getLogger();
    const ctxConfig = (ctx as unknown as { config?: QualityConfig }).config;
    const baseCommand = ctxConfig?.quality?.commands?.test;

    // Guard: no config at all, or config present but no test command → no-op.
    if (!ctxConfig || !baseCommand) {
      return {
        success: true,
        status: "passed",
        findings: [],
        durationMs: 0,
        passCount: 0,
        isFullSuite: true,
      };
    }

    const regressionMode = input.regressionMode ?? "deferred";
    // Note: smart-runner config lives at execution.smartTestRunner (not quality.smartRunner).
    // qualityConfigSelector picks both "quality" and "execution" keys (see src/config/selectors.ts:74).
    const selection = await deps.selectScopedTests({
      workdir: input.workdir,
      storyId: input.storyId,
      storyGitRef: input.storyGitRef,
      testCommand: baseCommand ?? "",
      testScopedTemplate: ctxConfig.quality?.commands?.testScoped,
      // smartTestRunner lives at execution.smartTestRunner; QualityConfig includes execution
      // via qualityConfigSelector = pickSelector("quality", "quality", "execution").
      smartRunnerConfig: ctxConfig.execution?.smartTestRunner,
      scopeTestThreshold: ctxConfig.quality?.scopeTestThreshold,
      fallbackFullSuiteCommand: ctxConfig.quality?.commands?.test,
      naxIgnoreIndex: input.naxIgnoreIndex,
    });

    // Deferred mode + no mapped tests + not a monorepo orchestrator → SKIP.
    if (
      selection.isFullSuite &&
      regressionMode === "deferred" &&
      !selection.isMonorepoOrchestrator &&
      !selection.thresholdFallback
    ) {
      logger.info("verify[scoped]", "No mapped tests — deferring to run-end (mode: deferred)", {
        storyId: input.storyId,
      });
      return {
        success: true,
        status: "skipped",
        findings: [],
        durationMs: 0,
        passCount: 0,
        isFullSuite: true,
        scopeTestFallback: selection.scopeTestFallback,
      };
    }

    if (selection.isFullSuite && !selection.isMonorepoOrchestrator) {
      logger.info("verify[scoped]", "No mapped tests — falling back to full suite", {
        storyId: input.storyId,
      });
    } else if (selection.isMonorepoOrchestrator) {
      logger.info("verify[scoped]", "Monorepo orchestrator detected — delegating scoping to tool", {
        storyId: input.storyId,
        command: selection.effectiveCommand,
      });
    }

    // NOTE: regression() includes a 2s sleep before running tests (src/verification/runners.ts:142-145)
    // for agent-cleanup. The legacy ScopedStrategy also used regression(), so this preserves parity
    // — it is NOT a new perf regression introduced by this port.
    const start = Date.now();
    const result = await deps.regression({
      workdir: input.workdir,
      command: selection.effectiveCommand,
      // regressionGate.timeoutSeconds lives in execution; QualityConfig includes execution.
      timeoutSeconds: ctxConfig.execution?.regressionGate?.timeoutSeconds ?? 600,
      // acceptOnTimeout is not consumed by runVerificationCore — the runner returns status="TIMEOUT"
      // and the caller (this op) decides accept-on-timeout policy. The op currently does not accept
      // scoped-test timeouts as pass; full-suite gate is the only place that does.
      forceExit: ctxConfig.quality?.forceExit,
      detectOpenHandles: ctxConfig.quality?.detectOpenHandles,
      detectOpenHandlesRetries: ctxConfig.quality?.detectOpenHandlesRetries,
      gracePeriodMs: ctxConfig.quality?.gracePeriodMs,
      drainTimeoutMs: ctxConfig.quality?.drainTimeoutMs,
      shell: ctxConfig.quality?.shell,
      stripEnvVars: ctxConfig.quality?.stripEnvVars,
    });
    const durationMs = Date.now() - start;
    const parsed = result.output ? deps.parseTestOutput(result.output) : { passed: 0, failed: 0, failures: [] };

    if (result.success) {
      logger.info("verify[scoped]", "Scoped tests passed", {
        storyId: input.storyId,
        passCount: parsed.passed,
        durationMs,
        scopeTestFallback: selection.scopeTestFallback ?? false,
        isFullSuite: selection.isFullSuite,
      });
      return {
        success: true,
        status: "passed",
        findings: [],
        durationMs,
        passCount: parsed.passed,
        isFullSuite: selection.isFullSuite,
        scopeTestFallback: selection.scopeTestFallback,
      };
    }

    if (result.status === "TIMEOUT") {
      logger.warn("verify[scoped]", "Scoped tests timed out", {
        storyId: input.storyId,
        durationMs,
        scopeTestFallback: selection.scopeTestFallback ?? false,
        isFullSuite: selection.isFullSuite,
      });
      return {
        success: false,
        status: "timeout",
        findings: [],
        durationMs,
        passCount: parsed.passed,
        isFullSuite: selection.isFullSuite,
        scopeTestFallback: selection.scopeTestFallback,
      };
    }

    logger.warn("verify[scoped]", "Scoped tests failed", {
      storyId: input.storyId,
      passCount: parsed.passed,
      failCount: parsed.failed,
      durationMs,
      scopeTestFallback: selection.scopeTestFallback ?? false,
      isFullSuite: selection.isFullSuite,
    });
    return {
      success: false,
      status: "failed",
      findings: deps.testSummaryToFindings(parsed),
      durationMs,
      passCount: parsed.passed,
      isFullSuite: selection.isFullSuite,
      scopeTestFallback: selection.scopeTestFallback,
    };
  },
};
