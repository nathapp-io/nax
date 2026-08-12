import type { NaxConfig } from "@/config";
import type { TestStrategy } from "@/config/schema-types";
/**
 * E2E-only: drives the REAL Story Orchestrator end-to-end with scripted agents +
 * attempt-aware gate _deps. Records an ordered phase log by wrapping the single
 * chokepoint every phase passes through: _storyOrchestratorDeps.callOp.
 *
 * Pattern: save → replace _deps → run → restore in finally.
 * The runtime is closed in finally to prevent idle-watchdog timer leaks.
 */
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import { _fullSuiteGateDeps, _lintCheckDeps, _typecheckCheckDeps } from "@/operations";
import type { UserStory } from "@/prd/types";
import type { QualityCommandResult } from "@/quality/runner";
import {
  cleanupTempDir,
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeRuntimeWithFakeAgent,
  makeStory,
  makeTempDir,
} from "../index";
import { type ScriptedAgentSpec, makeScriptedAgent } from "./scripted-agent";

type GateFn<T> = (attempt: number) => T;

const PASS_QC = (name: string): QualityCommandResult => ({
  commandName: name,
  command: `${name}-cmd`,
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 1,
  timedOut: false,
});

export interface E2EGates {
  lint?: GateFn<QualityCommandResult>;
  typecheck?: GateFn<QualityCommandResult>;
  /**
   * `failures` is optional. When omitted, `parsedSummary.failures` is left undefined
   * (preserving the legacy behavior where a `failed > 0` gate crashes the gate parse and
   * is swallowed as `validator-error`). Provide structured failures to drive the gate's
   * real finding path (`source: "test-runner"`, `category: "failed-test"`) — e.g. to
   * exercise the full-suite-rectify strategy.
   */
  fullSuite?: GateFn<{
    passed: boolean;
    failed: number;
    output?: string;
    failures?: Array<{ testName: string; file?: string; error: string }>;
  }>;
}

export interface E2EOptions {
  strategy: TestStrategy;
  agent: ScriptedAgentSpec;
  gates?: E2EGates;
  story?: Partial<UserStory>;
  config?: Partial<NaxConfig>;
  /**
   * Seed `test/placeholder.test.ts` so greenfield-gate detects pre-existing tests
   * and does NOT pause with "greenfield-no-tests". Defaults to `true`. Set to
   * `false` to drive the greenfield-no-tests pause branch (three-session only).
   */
  seedPlaceholderTest?: boolean;
  /**
   * Source-diff metrics the spied `runNonBlockingFix` reports for the ADR-024
   * best-effort pass. Defaults to `{ fileCount: 0, sourceLineCount: 0 }` (within
   * any cap → kept). Set above the configured `sourceDiffCap` to drive the
   * cap-exceeded → restored fail-safe branch. The harness always stubs the
   * git-backed snapshot/rollback deps so nbf works in the non-git temp workdir.
   */
  nonBlockingFixDiff?: { fileCount: number; sourceLineCount: number };
  /**
   * Overrides for the rectification phase options. Defaults: maxAttempts 3,
   * abortOnIncreasingFailures false. Set `abortOnIncreasingFailures: true` (with an
   * optional `consecutiveIncreasesToBail`) to drive the increasing-failures bail-when path.
   */
  rectification?: {
    maxAttempts?: number;
    abortOnIncreasingFailures?: boolean;
    consecutiveIncreasesToBail?: number;
  };
}

/** Surfaced non-blocking-fix outcome (ADR-024). Captured by spying
 * `_storyOrchestratorDeps.runNonBlockingFix`, whose return value is otherwise
 * discarded by ExecutionPlan. `undefined` when the nbf path never invoked it. */
export interface E2ENonBlockingFix {
  ran: boolean;
  kept: boolean;
  restored: boolean;
}

export interface E2EResult {
  result: {
    success: boolean;
    phaseOutputs: Record<string, unknown>;
    rectificationExhausted?: boolean;
    gateRegressedDuringRect?: boolean;
    unresolvedDetail?: string;
    liteScopeIncomplete?: boolean;
    missingRequiredReviewPhases?: readonly string[];
    unfixedFindings?: readonly unknown[];
  };
  phaseLog: string[];
  strategiesFired: string[];
  /** nbf outcome when the non-blocking-fix path ran; undefined otherwise. */
  nonBlockingFix?: E2ENonBlockingFix;
}

function makeE2EConfig(overrides?: Partial<NaxConfig>): NaxConfig {
  // Spread overrides at the sub-key level so a partial `quality` or `review` override
  // does not wipe out the harness-required keys (e.g. `lintFix: "lint --fix"` for
  // mechanical-lintfix, or `enabled/checks` for review). Other top-level overrides
  // pass through directly.
  const { quality: qualityOverride, review: reviewOverride, ...topLevelRest } = overrides ?? {};
  // `makeNaxConfig` deep-merges against DEFAULT_CONFIG, so a partial `review.adversarial`
  // override (e.g. `{ nonBlockingFix: { enabled: true } }`) merges into — rather than
  // wipes — the default adversarial config (diffMode etc. survive for makeMockPlanInputs).
  return makeNaxConfig({
    quality: {
      commands: { lint: "lint", typecheck: "tc", test: "true", lintFix: "lint --fix" },
      autofix: { enabled: true },
      ...(qualityOverride ?? {}),
    },
    review: {
      enabled: true,
      checks: ["lint", "typecheck"],
      ...(reviewOverride ?? {}),
    },
    ...topLevelRest,
  } as Partial<NaxConfig>);
}

export async function runOrchestratorE2E(opts: E2EOptions): Promise<E2EResult> {
  const workdir = makeTempDir("nax-e2e-");
  const config = makeE2EConfig(opts.config);

  // Seed a placeholder test file so the greenfield-gate detects pre-existing tests
  // and does not pause with "greenfield-no-tests". The gate uses Bun.Glob for
  // non-git workdirs (temp dirs created by makeTempDir are not git repos).
  // Opt out (seedPlaceholderTest: false) to drive the greenfield-no-tests pause branch.
  if (opts.seedPlaceholderTest !== false) {
    await Bun.write(`${workdir}/test/placeholder.test.ts`, "// E2E seed\n");
  }
  const story = makeStory({ id: "US-001", ...opts.story });

  const { runtime } = makeRuntimeWithFakeAgent(makeScriptedAgent(opts.agent), { config, workdir });

  // --- save originals ---
  const origCallOp = _storyOrchestratorDeps.callOp;
  const origRunNbf = _storyOrchestratorDeps.runNonBlockingFix;
  const origLint = _lintCheckDeps.runQualityCommand;
  const origTc = _typecheckCheckDeps.runQualityCommand;
  const origRunTests = _fullSuiteGateDeps.runTests;

  const phaseLog: string[] = [];
  const PHASE_NAMES = new Set([
    "test-writer",
    "greenfield-gate",
    "implementer",
    "full-suite-gate",
    "verifier",
    "verify-scoped",
    "lint-check",
    "typecheck-check",
    "semantic-review",
    "adversarial-review",
  ]);
  const strategiesFired: string[] = [];

  // Wrap callOp to record phase order — use type assertion to satisfy the
  // generic signature which can't be expressed concisely without losing information.
  // biome-ignore lint/suspicious/noExplicitAny: E2E instrumentation wrapper — all calls pass through to origCallOp
  (_storyOrchestratorDeps as { callOp: (...args: any[]) => any }).callOp = async (
    ctx: unknown,
    op: unknown,
    input: unknown,
  ) => {
    const opName = (op as { name?: string }).name ?? "";
    if (PHASE_NAMES.has(opName)) {
      phaseLog.push(opName);
    } else if (opName) {
      strategiesFired.push(opName);
    }
    return origCallOp(
      ctx as Parameters<typeof origCallOp>[0],
      op as Parameters<typeof origCallOp>[1],
      input as Parameters<typeof origCallOp>[2],
    );
  };

  // ExecutionPlan discards runNonBlockingFix's return — spy it so the nbf outcome
  // ({ ran, kept, restored }) is observable. Delegates to the real implementation.
  let nonBlockingFix: E2ENonBlockingFix | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: E2E instrumentation wrapper — passes through to origRunNbf
  (_storyOrchestratorDeps as { runNonBlockingFix: (...args: any[]) => any }).runNonBlockingFix = async (
    nbfArgs: unknown,
    nbfDeps: unknown,
  ) => {
    // Stub the git-backed snapshot/rollback/diff deps so nbf works in the non-git
    // temp workdir and the source-diff cap path is deterministic. Merged AFTER the
    // execution-plan's deps so these wins (the plan only supplies measureSourceDiff).
    const stubDeps = {
      captureSnapshotRef: async () => ({ sha: "e2e-nbf-snapshot", untrackedBefore: [] }),
      rollbackToRef: async () => {},
      measureSourceDiff: async () => opts.nonBlockingFixDiff ?? { fileCount: 0, sourceLineCount: 0 },
    };
    const out = await origRunNbf(nbfArgs as Parameters<typeof origRunNbf>[0], {
      ...(nbfDeps as object),
      ...stubDeps,
    } as Parameters<typeof origRunNbf>[1]);
    nonBlockingFix = { ran: out.ran, kept: out.kept, restored: out.restored };
    return out;
  };

  const lintAttempts = { n: 0 };
  const tcAttempts = { n: 0 };
  const fsAttempts = { n: 0 };

  _lintCheckDeps.runQualityCommand = async () => opts.gates?.lint?.(lintAttempts.n++) ?? PASS_QC("lint");
  _typecheckCheckDeps.runQualityCommand = async () => opts.gates?.typecheck?.(tcAttempts.n++) ?? PASS_QC("typecheck");
  _fullSuiteGateDeps.runTests = async (_input, _gateCtx) => {
    const g = opts.gates?.fullSuite?.(fsAttempts.n++) ?? { passed: true, failed: 0 };
    return {
      passed: g.passed,
      failed: g.failed,
      output: g.output ?? "",
      // TestSummary has a complex shape; cast via unknown to avoid importing its full type.
      // `failures` is only set when the caller supplies it — otherwise it stays undefined
      // to preserve the legacy gate-parse-crash → validator-error behavior some tests rely on.
      // biome-ignore lint/suspicious/noExplicitAny: minimal test summary for gate mock
      parsedSummary: {
        passed: g.passed ? 1 : 0,
        failed: g.failed,
        skipped: 0,
        ...(g.failures ? { failures: g.failures } : {}),
        // biome-ignore lint/suspicious/noExplicitAny: minimal test summary for gate mock
      } as any,
      timedOut: false,
    };
  };

  // Build minimal PlanInputs via makeMockPlanInputs (handles defaults) with
  // overrides for each slot. Review inputs use the defaults baked into makeE2EConfig
  // via DEFAULT_CONFIG — semantic/adversarial configs have all required fields.
  const rtp = {
    globs: ["**/*.test.ts"],
    regex: [/\.test\.ts$/],
    pathspec: [] as string[],
    testDirs: ["test"],
    resolution: "detected" as const,
  };

  const sem = config.review?.semantic;
  const adv = config.review?.adversarial;

  const inputs = makeMockPlanInputs({
    story,
    config,
    resolvedTestPatterns: rtp,
    testWriter: { story, resolvedTestPatterns: rtp },
    greenfieldGate: { story, workdir, resolvedTestPatterns: rtp },
    implementer: { story },
    fullSuiteGate: { story, workdir },
    verifier: { story },
    verifyScoped: {
      workdir,
      storyId: story.id,
      storyGitRef: undefined,
      naxIgnoreIndex: undefined,
      regressionMode: "per-story",
      repoRoot: workdir,
      packagePrefix: "",
      resolvedTestPatterns: rtp,
    },
    lintCheck: { workdir, storyId: story.id },
    typecheckCheck: { workdir, storyId: story.id },
    ...(sem
      ? {
          semanticReview: {
            workdir,
            story,
            semanticConfig: sem,
            mode: sem.diffMode,
            storyGitRef: undefined,
            stat: "",
            diff: "",
            excludePatterns: [],
            blockingThreshold: config.review?.blockingThreshold,
          },
        }
      : {}),
    ...(adv
      ? {
          adversarialReview: {
            workdir,
            story,
            adversarialConfig: adv,
            mode: adv.diffMode,
            storyGitRef: undefined,
            stat: "",
            diff: "",
            testInventory: undefined,
            testGlobs: [],
            excludePatterns: [],
            refExcludePatterns: [],
            blockingThreshold: config.review?.blockingThreshold,
          },
        }
      : {}),
    rectification: {
      maxAttempts: opts.rectification?.maxAttempts ?? 3,
      strategies: [],
      abortOnIncreasingFailures: opts.rectification?.abortOnIncreasingFailures ?? false,
      ...(opts.rectification?.consecutiveIncreasesToBail !== undefined
        ? { consecutiveIncreasesToBail: opts.rectification.consecutiveIncreasesToBail }
        : {}),
    },
  });

  const ctx = makeMockCallContext({ runtime, packageDir: workdir });

  try {
    const plan = await buildPlanForStrategy(ctx, story, config, opts.strategy, inputs);
    const result = await plan.run();
    return { result: result as E2EResult["result"], phaseLog, strategiesFired, nonBlockingFix };
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
    _storyOrchestratorDeps.runNonBlockingFix = origRunNbf;
    _lintCheckDeps.runQualityCommand = origLint;
    _typecheckCheckDeps.runQualityCommand = origTc;
    _fullSuiteGateDeps.runTests = origRunTests;
    await runtime.close();
    cleanupTempDir(workdir);
  }
}
