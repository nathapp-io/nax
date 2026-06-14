/**
 * E2E-only: drives the REAL Story Orchestrator end-to-end with scripted agents +
 * attempt-aware gate _deps. Records an ordered phase log by wrapping the single
 * chokepoint every phase passes through: _storyOrchestratorDeps.callOp.
 *
 * Pattern: save → replace _deps → run → restore in finally.
 * The runtime is closed in finally to prevent idle-watchdog timer leaks.
 */
import { _storyOrchestratorDeps, buildPlanForStrategy } from "@/execution";
import { _lintCheckDeps, _typecheckCheckDeps, _fullSuiteGateDeps } from "@/operations";
import type { NaxConfig } from "@/config";
import type { TestStrategy } from "@/config/schema-types";
import type { UserStory } from "@/prd/types";
import type { QualityCommandResult } from "@/quality/runner";
import {
  makeMockCallContext,
  makeMockPlanInputs,
  makeNaxConfig,
  makeRuntimeWithFakeAgent,
  makeStory,
  makeTempDir,
  cleanupTempDir,
} from "../index";
import { makeScriptedAgent, type ScriptedAgentSpec } from "./scripted-agent";

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
  fullSuite?: GateFn<{ passed: boolean; failed: number; output?: string }>;
}

export interface E2EOptions {
  strategy: TestStrategy;
  agent: ScriptedAgentSpec;
  gates?: E2EGates;
  story?: Partial<UserStory>;
  config?: Partial<NaxConfig>;
}

export interface E2EResult {
  result: {
    success: boolean;
    phaseOutputs: Record<string, unknown>;
    rectificationExhausted?: boolean;
    gateRegressedDuringRect?: boolean;
  };
  phaseLog: string[];
  strategiesFired: string[];
}

function makeE2EConfig(overrides?: Partial<NaxConfig>): NaxConfig {
  // Spread overrides at the sub-key level so a partial `quality` or `review` override
  // does not wipe out the harness-required keys (e.g. `lintFix: "lint --fix"` for
  // mechanical-lintfix, or `enabled/checks` for review). Other top-level overrides
  // pass through directly.
  const { quality: qualityOverride, review: reviewOverride, ...topLevelRest } = overrides ?? {};
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
  await Bun.write(`${workdir}/test/placeholder.test.ts`, "// E2E seed\n");
  const story = makeStory({ id: "US-001", ...opts.story });

  const { runtime } = makeRuntimeWithFakeAgent(makeScriptedAgent(opts.agent), { config, workdir });

  // --- save originals ---
  const origCallOp = _storyOrchestratorDeps.callOp;
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
    return origCallOp(ctx as Parameters<typeof origCallOp>[0], op as Parameters<typeof origCallOp>[1], input as Parameters<typeof origCallOp>[2]);
  };

  const lintAttempts = { n: 0 };
  const tcAttempts = { n: 0 };
  const fsAttempts = { n: 0 };

  _lintCheckDeps.runQualityCommand = async () =>
    opts.gates?.lint?.(lintAttempts.n++) ?? PASS_QC("lint");
  _typecheckCheckDeps.runQualityCommand = async () =>
    opts.gates?.typecheck?.(tcAttempts.n++) ?? PASS_QC("typecheck");
  _fullSuiteGateDeps.runTests = async (_input, _gateCtx) => {
    const g = opts.gates?.fullSuite?.(fsAttempts.n++) ?? { passed: true, failed: 0 };
    return {
      passed: g.passed,
      failed: g.failed,
      output: g.output ?? "",
      // TestSummary has a complex shape; cast via unknown to avoid importing its full type.
      // biome-ignore lint/suspicious/noExplicitAny: minimal test summary for gate mock
      parsedSummary: { passed: g.passed ? 1 : 0, failed: g.failed, skipped: 0 } as any,
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
      maxAttempts: 3,
      strategies: [],
      abortOnIncreasingFailures: false,
    },
  });

  const ctx = makeMockCallContext({ runtime, packageDir: workdir });

  try {
    const plan = await buildPlanForStrategy(ctx, story, config, opts.strategy, inputs);
    const result = await plan.run();
    return { result: result as E2EResult["result"], phaseLog, strategiesFired };
  } finally {
    _storyOrchestratorDeps.callOp = origCallOp;
    _lintCheckDeps.runQualityCommand = origLint;
    _typecheckCheckDeps.runQualityCommand = origTc;
    _fullSuiteGateDeps.runTests = origRunTests;
    await runtime.close();
    cleanupTempDir(workdir);
  }
}
