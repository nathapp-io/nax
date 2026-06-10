import { qualityConfigSelector } from "../config";
import type { QualityConfig } from "../config/selectors";
import { executionFailureToFinding, testSummaryToFindings } from "../findings";
import type { Finding } from "../findings/types";
import { getLogger } from "../logger";
import { _scopedSelectionDeps, parseTestOutput, selectScopedTests } from "../test-runners";
import type { ResolvedTestPatterns, SelectScopedTestsResult, TestSummary } from "../test-runners";
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
  /** Absolute repo root — anchor for changed-test detection / mapping in monorepos. */
  readonly repoRoot?: string;
  /** Story workdir relative to repoRoot (e.g. "packages/core") — scopes the git diff. */
  readonly packagePrefix?: string;
  /** ADR-009 resolved test patterns (language-agnostic, per-package override-aware). */
  readonly resolvedTestPatterns?: ResolvedTestPatterns;
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
    const quality = ctx.packageView.select(qualityConfigSelector);
    const baseCommand = quality.quality?.commands?.test;

    // No test command configured → skip (deferred run-end gate still covers regressions).
    if (!baseCommand) {
      logger.warn("quality", "No test command configured — skipping scoped verify", {
        storyId: input.storyId,
        packageDir: ctx.packageView.packageDir,
      });
      return {
        success: true,
        status: "skipped",
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
      testCommand: baseCommand,
      testScopedTemplate: quality.quality?.commands?.testScoped,
      // smartTestRunner lives at execution.smartTestRunner; QualityConfig includes execution
      // via qualityConfigSelector = pickSelector("quality", "quality", "execution").
      smartRunnerConfig: quality.execution?.smartTestRunner,
      scopeTestThreshold: quality.quality?.scopeTestThreshold,
      fallbackFullSuiteCommand: quality.quality?.commands?.test,
      naxIgnoreIndex: input.naxIgnoreIndex,
      repoRoot: input.repoRoot,
      packagePrefix: input.packagePrefix,
      resolvedTestPatterns: input.resolvedTestPatterns,
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
    const scopedTimeout = quality.execution?.regressionGate?.timeoutSeconds ?? 600;
    // Root-config fallback: command was not defined per-package, so run from repo root.
    const cmdWorkdir = ctx.packageView.hasOverride ? input.workdir : ctx.packageView.repoRoot;
    logger.info("verify[scoped]", "Running scoped tests", {
      storyId: input.storyId,
      packageDir: input.packageDir,
      cwd: cmdWorkdir,
      command: selection.effectiveCommand,
      timeoutSeconds: scopedTimeout,
      isFullSuite: selection.isFullSuite,
    });
    const runTests = async (command: string) => {
      const result = await deps.regression({
        workdir: cmdWorkdir,
        command,
        // regressionGate.timeoutSeconds lives in execution; QualityConfig includes execution.
        timeoutSeconds: scopedTimeout,
        // acceptOnTimeout is not consumed by runVerificationCore — the runner returns status="TIMEOUT"
        // and the caller (this op) decides accept-on-timeout policy. The op currently does not accept
        // scoped-test timeouts as pass; full-suite gate is the only place that does.
        forceExit: quality.quality?.forceExit,
        detectOpenHandles: quality.quality?.detectOpenHandles,
        detectOpenHandlesRetries: quality.quality?.detectOpenHandlesRetries,
        gracePeriodMs: quality.quality?.gracePeriodMs,
        drainTimeoutMs: quality.quality?.drainTimeoutMs,
        shell: quality.quality?.shell,
        stripEnvVars: quality.quality?.stripEnvVars,
      });
      const parsed = result.output ? deps.parseTestOutput(result.output) : { passed: 0, failed: 0, failures: [] };
      return { result, parsed };
    };

    const start = Date.now();
    let effectiveCommand = selection.effectiveCommand;
    let isFullSuite = selection.isFullSuite;
    let scopeTestFallback = selection.scopeTestFallback;
    let { result, parsed } = await runTests(effectiveCommand);

    // Scoped run failed without executing a single test (e.g. pytest exit 5
    // "no tests collected" when the scope probed a non-test file, or a
    // collection error confined to the scoped file). The scope is unusable as
    // a verdict — rerun the full suite, which is the actual arbiter (#1207).
    // TIMEOUT is excluded: a hung scoped run must not escalate into a second
    // long run. Cost note: the rerun pays regression()'s 2s cleanup sleep a
    // second time — accepted, the story genuinely needs the full-suite verdict.
    const ranNoTests = parsed.passed === 0 && parsed.failed === 0 && parsed.failures.length === 0;
    if (!result.success && result.status !== "TIMEOUT" && !isFullSuite && ranNoTests) {
      logger.warn("verify[scoped]", "Scoped run executed no tests — falling back to full suite", {
        storyId: input.storyId,
        command: effectiveCommand,
        exitCode: result.exitCode,
      });
      effectiveCommand = baseCommand;
      isFullSuite = true;
      scopeTestFallback = true;
      ({ result, parsed } = await runTests(effectiveCommand));
    }
    const durationMs = Date.now() - start;

    if (result.success) {
      logger.info("verify[scoped]", "Scoped tests passed", {
        storyId: input.storyId,
        passCount: parsed.passed,
        durationMs,
        scopeTestFallback: scopeTestFallback ?? false,
        isFullSuite,
      });
      return {
        success: true,
        status: "passed",
        findings: [],
        durationMs,
        passCount: parsed.passed,
        isFullSuite,
        scopeTestFallback,
      };
    }

    if (result.status === "TIMEOUT") {
      logger.warn("verify[scoped]", "Scoped tests timed out", {
        storyId: input.storyId,
        durationMs,
        scopeTestFallback: scopeTestFallback ?? false,
        isFullSuite,
      });
      return {
        success: false,
        status: "timeout",
        findings: [],
        durationMs,
        passCount: parsed.passed,
        isFullSuite,
        scopeTestFallback,
      };
    }

    logger.warn("verify[scoped]", "Scoped tests failed", {
      storyId: input.storyId,
      passCount: parsed.passed,
      failCount: parsed.failed,
      durationMs,
      scopeTestFallback: scopeTestFallback ?? false,
      isFullSuite,
    });
    let findings = deps.testSummaryToFindings(parsed);
    if (findings.length === 0) {
      // Runner exited non-zero but the parser found 0 structured failures
      // (environmental failure: config crash, missing dep, import error).
      // Without a finding, rectification no-ops on 0 findings and the story
      // fails terminally without ever dispatching a fix — mirror the
      // full-suite gate's synth finding (#1207, see full-suite-gate.ts).
      logger.warn("verify[scoped]", "Scoped verify execution-failed — emitting synth finding", {
        storyId: input.storyId,
        command: effectiveCommand,
        exitCode: result.exitCode,
        cwd: cmdWorkdir,
      });
      findings = [
        executionFailureToFinding({
          // Prefer the post-wrap shell command actually executed (parity with
          // full-suite-gate.ts) — falls back to the pre-wrap effective command.
          command: result.command ?? effectiveCommand,
          exitCode: result.exitCode,
          output: result.output ?? "",
          packageDir: input.packagePrefix,
          cwd: cmdWorkdir,
        }),
      ];
    }
    return {
      success: false,
      status: "failed",
      findings,
      durationMs,
      passCount: parsed.passed,
      isFullSuite,
      scopeTestFallback,
    };
  },
};
