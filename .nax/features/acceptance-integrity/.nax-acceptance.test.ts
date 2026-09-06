import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
  cleanupTempDir,
  makeDispatchContext,
  makeMockAgentManager,
  makePRD,
  makeSessionManager,
  makeStory,
  makeTempDir,
  makeTestRuntime,
  makeTurnResult,
  withWarnSpy,
} from "../../../test/helpers";
import { generateSkeletonTests, isStubTestContent } from "../../../src/acceptance";
import { _groupDeps, groupStoriesByPackage } from "../../../src/acceptance/test-path";
import type { AdapterFailure } from "../../../src/context/engine";
import { DEFAULT_CONFIG, pickSelector } from "../../../src/config";
import {
  buildStatusSnapshot,
  writeStatusFile,
  type RunStateSnapshot,
} from "../../../src/execution/status-file";
import {
  _regenerateDeps,
  isStubTestFile,
  regenerateAcceptanceTest,
} from "../../../src/execution/lifecycle/acceptance-helpers";
import { callOp } from "../../../src/operations";
import { makeSelfHealStep, runSelfHealChain } from "../../../src/operations/self-heal";
import type { HopBodyContext, RunOperation } from "../../../src/operations/types";
import { acceptanceStage } from "../../../src/pipeline/stages/acceptance";
import {
  _acceptanceSetupDeps,
  acceptanceSetupStage,
} from "../../../src/pipeline/stages/acceptance-setup";
import type { PipelineContext } from "../../../src/pipeline/types";
import type { NaxRuntime } from "../../../src/runtime";
import type { Logger } from "../../../src/logger";
import type { TurnResult } from "../../../src/agents/types";

// ─── Shared fixtures ─────────────────────────────────────────────────────────

const FEATURE = "acceptance-integrity";

const SERVICE_DOWN: AdapterFailure = {
  category: "availability",
  outcome: "fail-service-down",
  message: "Upstream idle timeout exceeded",
  retriable: true,
};

const FAIL_TIMEOUT: AdapterFailure = {
  category: "quality",
  outcome: "fail-timeout",
  message: "Turn exceeded wall-clock deadline",
  retriable: true,
};

const FAIL_QUALITY: AdapterFailure = {
  category: "quality",
  outcome: "fail-quality",
  message: "Quality gate rejected the output",
  retriable: false,
};

const STORY_ACS = ["AC-1: the greeting module exports greet", "AC-2: greet returns a string"];

/** A real (non-stub) acceptance test body — isStubTestFile === false. */
const REAL_TEST_CODE = `import { describe, test, expect } from "bun:test";

describe("${FEATURE} - Acceptance Tests", () => {
  test("AC-1: greet is exported", () => {
    expect(1 + 1).toBe(2);
  });
});
`;

/** Local error-level spy helper (mirrors withWarnSpy from @test/helpers). */
async function withErrorSpy<T>(fn: (spy: Mock<Logger["error"]>) => Promise<T>): Promise<T> {
  const { resetLogger, initLogger } = await import("../../../src/logger");
  resetLogger();
  const spy: Mock<Logger["error"]> = spyOn(initLogger({ level: "silent" }), "error");
  try {
    return await fn(spy);
  } finally {
    spy.mockRestore();
    resetLogger();
  }
}

// ─── AC-1..4: runSelfHealChain adapterFailure propagation ────────────────────

describe("runSelfHealChain: adapterFailure propagation", () => {
  function makeHopCtx<I>(
    input: I,
    send: (prompt: string) => Promise<TurnResult>,
  ): HopBodyContext<I> {
    return {
      send,
      sendWithParseRetry: (prompt: string) => send(prompt),
      input,
    };
  }

  /** One self-heal step whose detector reports the given deviations. */
  function makeStep<I>(deviations: readonly string[]): ReturnType<
    typeof makeSelfHealStep<I, string>
  > {
    return makeSelfHealStep<I, string>({
      detect: async () => deviations,
      buildRepair: (devs) => `repair prompt for: ${devs.join(", ")}`,
    });
  }

  test("AC-1: corrective turn with no adapterFailure inherits the seed's adapterFailure", async () => {
    const seed = makeTurnResult({ output: "seed output", estimatedCostUsd: 0.01, adapterFailure: SERVICE_DOWN });
    const corrective = makeTurnResult({ output: "corrective output" });

    let sendCount = 0;
    const ctx = makeHopCtx({}, async () => {
      sendCount++;
      return corrective;
    });

    const result = await runSelfHealChain(ctx, seed, [makeStep(["deviation"])]);

    // Exactly one corrective turn was issued and it is the returned output.
    expect(sendCount).toBe(1);
    expect(result.output).toBe("corrective output");
    // The corrective turn's missing adapterFailure is backfilled from the seed.
    expect(result.adapterFailure).toEqual(SERVICE_DOWN);
    expect(result.adapterFailure?.outcome).toBe("fail-service-down");
  });

  test("AC-2: corrective turn carrying its own adapterFailure keeps it (seed's not copied over)", async () => {
    const seed = makeTurnResult({ output: "seed output", adapterFailure: SERVICE_DOWN });
    const corrective = makeTurnResult({ output: "corrective output", adapterFailure: FAIL_TIMEOUT });

    const ctx = makeHopCtx({}, async () => corrective);

    const result = await runSelfHealChain(ctx, seed, [makeStep(["deviation"])]);

    expect(result.output).toBe("corrective output");
    expect(result.adapterFailure?.outcome).toBe("fail-timeout");
    expect(result.adapterFailure).toEqual(FAIL_TIMEOUT);
  });

  test("AC-3: neither seed nor corrective turn carries adapterFailure — none is added", async () => {
    const seed = makeTurnResult({ output: "seed output" });
    const corrective = makeTurnResult({ output: "corrective output" });

    const ctx = makeHopCtx({}, async () => corrective);

    const result = await runSelfHealChain(ctx, seed, [makeStep(["deviation"])]);

    expect(result.output).toBe("corrective output");
    expect(result.adapterFailure).toBeUndefined();
  });

  test("AC-4: no issues detected — seed returned unchanged with its adapterFailure intact", async () => {
    const seed = makeTurnResult({ output: "healthy output", estimatedCostUsd: 0.02, adapterFailure: SERVICE_DOWN });

    let sendCount = 0;
    const ctx = makeHopCtx({}, async () => {
      sendCount++;
      return makeTurnResult({ output: "should never be sent" });
    });

    const result = await runSelfHealChain(ctx, seed, [makeStep([])]);

    expect(sendCount).toBe(0);
    expect(result.output).toBe("healthy output");
    expect(result.adapterFailure).toEqual(SERVICE_DOWN);
    expect(result.adapterFailure?.outcome).toBe("fail-service-down");
  });
});

// ─── AC-5..8: callOp run-kind adapterFailure attachment ──────────────────────

describe("callOp (kind:run): adapterFailure attachment to parsed output", () => {
  let runtime: NaxRuntime | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  type OpCfg = Pick<typeof DEFAULT_CONFIG, "routing">;

  function makeRunOp(parse: (output: string) => unknown): RunOperation<{ text: string }, unknown, OpCfg> {
    return {
      kind: "run",
      name: "acceptance-integrity-run-op",
      stage: "run",
      config: pickSelector("acceptance-integrity-run-op", "routing"),
      session: { role: "implementer", lifetime: "fresh" },
      build: (input) => ({
        role: { id: "role", content: "You are a test operation.", overridable: false },
        task: { id: "task", content: input.text, overridable: false },
      }),
      parse: (output) => parse(output),
    } as RunOperation<{ text: string }, unknown, OpCfg>;
  }

  function makeRunAgentManager(outcome: { output: string; adapterFailure?: AdapterFailure }) {
    return makeMockAgentManager({
      runWithFallbackFn: async () => ({
        result: {
          success: true,
          exitCode: 0,
          output: outcome.output,
          rateLimited: false,
          durationMs: 1,
          estimatedCostUsd: 0,
          agentFallbacks: [],
          ...(outcome.adapterFailure ? { adapterFailure: outcome.adapterFailure } : {}),
        },
        fallbacks: [],
      }),
    });
  }

  function makeCallCtx(rt: NaxRuntime) {
    return {
      runtime: rt,
      packageView: rt.packages.repo(),
      packageDir: "/tmp",
      agentName: "claude",
      storyId: "US-001",
    };
  }

  test("AC-5: dispatch adapterFailure attaches to parsed object that lacks its own", async () => {
    const agentManager = makeRunAgentManager({ output: "raw agent output", adapterFailure: SERVICE_DOWN });
    runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });

    const op = makeRunOp(() => ({ testCode: null }));

    const result = (await callOp(makeCallCtx(runtime), op, { text: "go" })) as {
      testCode: string | null;
      adapterFailure?: AdapterFailure;
    };

    expect(result).toEqual({ testCode: null, adapterFailure: SERVICE_DOWN });
    expect(result.adapterFailure?.outcome).toBe("fail-service-down");
  });

  test("AC-6: dispatch without adapterFailure — parsed value returned untouched, no adapterFailure added", async () => {
    const agentManager = makeRunAgentManager({ output: "raw agent output" });
    runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });

    const parsed = { testCode: "generated code", verdict: "pass" };
    const op = makeRunOp(() => parsed);

    const result = (await callOp(makeCallCtx(runtime), op, { text: "go" })) as Record<string, unknown>;

    expect(result).toEqual(parsed);
    expect(result.adapterFailure).toBeUndefined();
  });

  test("AC-7: parsed value's own adapterFailure is not overridden by the dispatch outcome's", async () => {
    const agentManager = makeRunAgentManager({ output: "raw agent output", adapterFailure: SERVICE_DOWN });
    runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });

    const op = makeRunOp(() => ({ testCode: "generated code", adapterFailure: FAIL_QUALITY }));

    const result = (await callOp(makeCallCtx(runtime), op, { text: "go" })) as {
      testCode: string;
      adapterFailure?: AdapterFailure;
    };

    expect(result.adapterFailure?.outcome).toBe("fail-quality");
    expect(result.adapterFailure).toEqual(FAIL_QUALITY);
    expect(result.testCode).toBe("generated code");
  });

  test("AC-8: parsed value is a string — returned exactly, no adapterFailure attached", async () => {
    const agentManager = makeRunAgentManager({ output: "raw agent output", adapterFailure: SERVICE_DOWN });
    runtime = makeTestRuntime({ agentManager, sessionManager: makeSessionManager() });

    const stringResult = "plain parsed string";
    const op = makeRunOp(() => stringResult);

    const result = await callOp(makeCallCtx(runtime), op, { text: "go" });

    expect(typeof result).toBe("string");
    expect(result).toBe(stringResult);
  });
});

// ─── AC-9..13: acceptanceSetupStage failure handling ─────────────────────────

describe("acceptanceSetupStage: adapterFailure-aware generation", () => {
  let savedDeps: typeof _acceptanceSetupDeps;
  let savedGroupDeps: { detectLanguage: typeof _groupDeps.detectLanguage; readPackageTestPath: typeof _groupDeps.readPackageTestPath };
  let tempDir: string;

  beforeEach(() => {
    savedDeps = { ..._acceptanceSetupDeps };
    savedGroupDeps = {
      detectLanguage: _groupDeps.detectLanguage,
      readPackageTestPath: _groupDeps.readPackageTestPath,
    };
    tempDir = makeTempDir("nax-acceptance-integrity-");
    // Deterministic grouping: no package-local config or language detection.
    _groupDeps.detectLanguage = async () => undefined;
    _groupDeps.readPackageTestPath = async () => undefined;
  });

  afterEach(() => {
    Object.assign(_acceptanceSetupDeps, savedDeps);
    _groupDeps.detectLanguage = savedGroupDeps.detectLanguage;
    _groupDeps.readPackageTestPath = savedGroupDeps.readPackageTestPath;
    cleanupTempDir(tempDir);
  });

  function makeSetupCtx(): PipelineContext {
    const story = makeStory({ id: "US-001", status: "pending", acceptanceCriteria: [...STORY_ACS] });
    const prd = makePRD({ feature: FEATURE, userStories: [story] });
    return {
      config: {
        ...DEFAULT_CONFIG,
        acceptance: {
          ...DEFAULT_CONFIG.acceptance,
          enabled: true,
          refinement: false,
          redGate: false,
        },
      },
      rootConfig: DEFAULT_CONFIG,
      prd,
      story,
      stories: prd.userStories,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      workdir: tempDir,
      projectDir: tempDir,
      featureDir: join(tempDir, ".nax", "features", FEATURE),
      hooks: { hooks: {} },
      ...makeDispatchContext(),
    };
  }

  /** Resolve the group's acceptance test path exactly as the stage does. */
  async function groupTestPath(ctx: PipelineContext): Promise<string> {
    const groups = await groupStoriesByPackage(
      ctx.prd,
      ctx.workdir,
      ctx.prd.feature,
      ctx.config.acceptance.testPath,
      ctx.config.project?.language,
    );
    expect(groups.length).toBe(1);
    const group = groups[0];
    expect(group).toBeDefined();
    return group!.testPath;
  }

  /**
   * Stub the stage's injectable deps so the acceptance-generate callOp returns
   * `genResult`. Returns the recorder array of writeFile calls. Disk-facing
   * deps (fileExists/copyFile/deleteFile) stay real so AC-13 can observe
   * genuine on-disk state.
   */
  function stubSetupDeps(
    genResult: { testCode: string | null; adapterFailure?: AdapterFailure },
  ): Array<{ path: string; content: string }> {
    const writes: Array<{ path: string; content: string }> = [];
    _acceptanceSetupDeps.readMeta = async () => null;
    _acceptanceSetupDeps.callOp = async (_ctx, _packageDir, op, _input) => {
      if (op.name === "acceptance-generate") return genResult;
      throw new Error(`unexpected op: ${op.name}`);
    };
    _acceptanceSetupDeps.fileExists = async (p) => Bun.file(p).exists();
    _acceptanceSetupDeps.writeFile = async (p, c) => {
      writes.push({ path: p, content: c });
    };
    _acceptanceSetupDeps.writeMeta = async () => {};
    _acceptanceSetupDeps.autoCommitIfDirty = async () => {};
    _acceptanceSetupDeps.runTest = async () => ({ exitCode: 1, output: "1 fail" });
    return writes;
  }

  test("AC-9: generate fails with adapterFailure — no writeFile targets the group's test path", async () => {
    const writes = stubSetupDeps({ testCode: null, adapterFailure: SERVICE_DOWN });
    const ctx = makeSetupCtx();
    const testPath = await groupTestPath(ctx);

    await acceptanceSetupStage.execute(ctx);

    expect(writes.length).toBeGreaterThan(0); // meta/refined-json writes still happen
    expect(writes.every((w) => w.path !== testPath)).toBe(true);
  });

  test("AC-10: generate fails with adapterFailure — one acceptance-setup warning carries failure metadata", async () => {
    stubSetupDeps({ testCode: null, adapterFailure: SERVICE_DOWN });
    const ctx = makeSetupCtx();
    const testPath = await groupTestPath(ctx);

    await withWarnSpy(async (warnSpy) => {
      await acceptanceSetupStage.execute(ctx);

      const setupWarns = warnSpy.mock.calls.filter((c) => c[0] === "acceptance-setup");
      expect(setupWarns).toHaveLength(1);
      const entry = setupWarns[0];
      expect(entry).toBeDefined();
      const [, message, data] = entry!;
      expect(message).not.toBe("agent did not produce test content; using skeleton");
      expect(data).toEqual(
        expect.objectContaining({
          outcome: "fail-service-down",
          failureMessage: "Upstream idle timeout exceeded",
          storyId: "US-001",
          testPath,
        }),
      );
    });
  });

  test("AC-11: generate returns null without adapterFailure — skeleton written and skeleton warning emitted", async () => {
    const writes = stubSetupDeps({ testCode: null });
    const ctx = makeSetupCtx();
    const testPath = await groupTestPath(ctx);

    const expectedSkeleton = generateSkeletonTests(
      FEATURE,
      STORY_ACS.map((text, i) => ({ id: `AC-${i + 1}`, text, lineNumber: i + 1 })),
      ctx.config.acceptance.testFramework,
      undefined,
    );
    expect(isStubTestContent(expectedSkeleton)).toBe(true);

    await withWarnSpy(async (warnSpy) => {
      await acceptanceSetupStage.execute(ctx);

      const testPathWrites = writes.filter((w) => w.path === testPath);
      expect(testPathWrites).toHaveLength(1);
      expect(testPathWrites[0]!.content).toBe(expectedSkeleton);

      const skeletonWarns = warnSpy.mock.calls.filter(
        (c) => c[0] === "acceptance-setup" && c[1] === "agent did not produce test content; using skeleton",
      );
      expect(skeletonWarns.length).toBeGreaterThan(0);
    });
  });

  test("AC-12: generate returns non-empty testCode — it is written verbatim despite adapterFailure", async () => {
    const writes = stubSetupDeps({ testCode: REAL_TEST_CODE, adapterFailure: SERVICE_DOWN });
    const ctx = makeSetupCtx();
    const testPath = await groupTestPath(ctx);

    await acceptanceSetupStage.execute(ctx);

    const testPathWrites = writes.filter((w) => w.path === testPath);
    expect(testPathWrites).toHaveLength(1);
    expect(testPathWrites[0]!.content).toBe(REAL_TEST_CODE);
  });

  test("AC-13: generate fails with adapterFailure over a pre-existing file — file content preserved", async () => {
    const preExisting = `// pre-existing acceptance test content\nimport { test } from "bun:test";\ntest("AC-1: pre-existing", () => { expect(2 + 2).toBe(4); });\n`;
    const writes = stubSetupDeps({ testCode: null, adapterFailure: SERVICE_DOWN });
    const ctx = makeSetupCtx();
    const testPath = await groupTestPath(ctx);

    await Bun.write(testPath, preExisting);
    expect(await Bun.file(testPath).text()).toBe(preExisting);

    await acceptanceSetupStage.execute(ctx);

    expect(writes.every((w) => w.path !== testPath)).toBe(true);
    const after = await Bun.file(testPath).text();
    expect(after).toBe(preExisting);
  });
});

// ─── AC-14: acceptanceStage missingTargets verdict ───────────────────────────

describe("acceptanceStage: missing acceptance target verdict", () => {
  /**
   * Mocks Bun.file().exists() to return false for every path, so every group
   * looks like a missing acceptance test file. Restored in `finally`.
   */
  function stubAllFilesMissing(): () => void {
    const origFile = Bun.file;
    Object.assign(Bun, {
      file: (_p: string) => ({
        exists: () => Promise.resolve(false),
        text: () => Promise.resolve(""),
      }),
    });
    return () => {
      Object.assign(Bun, { file: origFile });
    };
  }

  test("AC-14: missing test file for an acceptance-enabled package lands in missingTargets", async () => {
    const restoreFile = stubAllFilesMissing();
    try {
      const story = makeStory({
        id: "US-001",
        status: "passed",
        passes: true,
        attempts: 0,
        acceptanceCriteria: ["AC-1: criterion"],
      });
      const prd = makePRD({ feature: FEATURE, userStories: [story] });
      const pkgDir = join(tempRoot(), "packages/api");
      const ctx: PipelineContext = {
        config: {
          ...DEFAULT_CONFIG,
          acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, testPath: ".nax-acceptance.test.ts" },
        },
        rootConfig: DEFAULT_CONFIG,
        prd,
        story,
        stories: prd.userStories,
        routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
        workdir: tempRoot(),
        projectDir: tempRoot(),
        featureDir: join(tempRoot(), ".nax", "features", FEATURE),
        hooks: { hooks: {} },
        ...makeDispatchContext(),
        acceptanceTestPaths: [
          {
            testPath: join(pkgDir, ".nax-acceptance.test.ts"),
            packageDir: pkgDir,
            storyCount: 1,
            acceptanceEnabled: true,
          },
        ],
      };

      const result = await acceptanceStage.execute(ctx);

      expect(result.action).toBe("fail");
      // The acceptance verdict must name the package in its missingTargets —
      // recorded on the context's verdict object and/or the returned result.
      const returnedTargets = (result as { missingTargets?: string[] }).missingTargets ?? [];
      const verdictTargets = [...(ctx.acceptanceFailures?.missingTargets ?? []), ...returnedTargets];
      expect(verdictTargets).toContain(pkgDir);
    } finally {
      restoreFile();
    }
  });
});

/** Cheap unique root for AC-14's context paths (never touched on disk). */
let rootCounter = 0;
function tempRoot(): string {
  rootCounter++;
  return `/tmp/nax-acceptance-integrity-${rootCounter}`;
}

// ─── AC-15..19: regenerateAcceptanceTest stub / missing / .bak semantics ─────

describe("regenerateAcceptanceTest: stub detection, missing file, and .bak backup", () => {
  let savedRegenDeps: typeof _regenerateDeps;
  let tempDir: string;

  beforeEach(() => {
    savedRegenDeps = { ..._regenerateDeps };
    tempDir = makeTempDir("nax-acceptance-regen-");
  });

  afterEach(() => {
    Object.assign(_regenerateDeps, savedRegenDeps);
    cleanupTempDir(tempDir);
  });

  function makeRegenCtx(): PipelineContext {
    const story = makeStory({ id: "US-001", acceptanceCriteria: [...STORY_ACS] });
    const prd = makePRD({ feature: FEATURE, userStories: [story] });
    return {
      config: {
        ...DEFAULT_CONFIG,
        acceptance: { ...DEFAULT_CONFIG.acceptance, enabled: true, refinement: false, redGate: false },
      },
      rootConfig: DEFAULT_CONFIG,
      prd,
      story,
      stories: prd.userStories,
      routing: { complexity: "simple", modelTier: "fast", testStrategy: "test-after", reasoning: "" },
      workdir: tempDir,
      projectDir: tempDir,
      featureDir: join(tempDir, ".nax", "features", FEATURE),
      hooks: { hooks: {} },
      ...makeDispatchContext(),
    };
  }

  function testPath(): string {
    return join(tempDir, ".nax-acceptance.test.ts");
  }

  const STUB_CONTENT = generateSkeletonTests(
    FEATURE,
    [{ id: "AC-1", text: "some criterion", lineNumber: 1 }],
    undefined,
    undefined,
  );

  test("AC-15: regenerated content is a stub — regenerateAcceptanceTest resolves to false", async () => {
    const tp = testPath();
    await Bun.write(tp, REAL_TEST_CODE);
    expect(isStubTestFile(STUB_CONTENT)).toBe(true);

    // The acceptance-setup stage seam writes stub content to testPath.
    _regenerateDeps.acceptanceSetupExecute = async () => {
      await Bun.write(tp, STUB_CONTENT);
    };

    const result = await regenerateAcceptanceTest(tp, makeRegenCtx());
    expect(result).toBe(false);
  });

  test("AC-16: regenerated content is a real test — regenerateAcceptanceTest resolves to true", async () => {
    const tp = testPath();
    await Bun.write(tp, STUB_CONTENT);
    expect(isStubTestFile(REAL_TEST_CODE)).toBe(false);

    _regenerateDeps.acceptanceSetupExecute = async () => {
      await Bun.write(tp, REAL_TEST_CODE);
    };

    const result = await regenerateAcceptanceTest(tp, makeRegenCtx());
    expect(result).toBe(true);
  });

  test("AC-17: acceptance-setup does not create the file — regenerateAcceptanceTest resolves to false", async () => {
    const tp = testPath();
    await Bun.write(tp, REAL_TEST_CODE);

    // Stage runs but produces nothing — testPath stays missing after the
    // pre-regeneration unlink.
    _regenerateDeps.acceptanceSetupExecute = async () => {};

    const result = await regenerateAcceptanceTest(tp, makeRegenCtx());
    expect(result).toBe(false);
    expect(await Bun.file(tp).exists()).toBe(false);
  });

  test("AC-18: stub-content failure logs exactly one 'acceptance' error, distinct from the missing-file error", async () => {
    let stubErrorMessage: string | undefined;
    let missingErrorMessage: string | undefined;

    // Scenario 1: regenerated content is a stub.
    await withErrorSpy(async (errorSpy) => {
      const tp = testPath();
      await Bun.write(tp, REAL_TEST_CODE);
      _regenerateDeps.acceptanceSetupExecute = async () => {
        await Bun.write(tp, STUB_CONTENT);
      };
      await regenerateAcceptanceTest(tp, makeRegenCtx());

      const acceptanceErrors = errorSpy.mock.calls.filter((c) => c[0] === "acceptance");
      expect(acceptanceErrors).toHaveLength(1);
      stubErrorMessage = acceptanceErrors[0]![1];
    });

    // Scenario 2: the file is missing after regeneration.
    await withErrorSpy(async (errorSpy) => {
      const tp = testPath();
      await Bun.write(tp, REAL_TEST_CODE);
      _regenerateDeps.acceptanceSetupExecute = async () => {};
      await regenerateAcceptanceTest(tp, makeRegenCtx());

      const acceptanceErrors = errorSpy.mock.calls.filter((c) => c[0] === "acceptance");
      expect(acceptanceErrors).toHaveLength(1);
      missingErrorMessage = acceptanceErrors[0]![1];
    });

    expect(stubErrorMessage).toBeDefined();
    expect(missingErrorMessage).toBeDefined();
    expect(stubErrorMessage).not.toBe(missingErrorMessage);
  });

  test("AC-19: pre-existing content is backed up to testPath.bak before the setup stage, in all three resolution cases", async () => {
    const original = `// original pre-existing acceptance test\nimport { test } from "bun:test";\ntest("AC-1: original", () => { expect(3 + 3).toBe(6); });\n`;

    const scenarios: Array<{
      label: string;
      setupExecute: (tp: string) => Promise<void>;
      expected: boolean;
    }> = [
      {
        label: "returns true (real content written)",
        setupExecute: async (tp) => {
          await Bun.write(tp, REAL_TEST_CODE);
        },
        expected: true,
      },
      {
        label: "returns false due to stub content",
        setupExecute: async (tp) => {
          await Bun.write(tp, STUB_CONTENT);
        },
        expected: false,
      },
      {
        label: "returns false due to missing file",
        setupExecute: async () => {
          // stage creates nothing
        },
        expected: false,
      },
    ];

    for (const scenario of scenarios) {
      // Fresh temp dir per scenario so .bak state cannot leak between cases.
      const dir = makeTempDir("nax-acceptance-bak-");
      try {
        const tp = join(dir, ".nax-acceptance.test.ts");
        await Bun.write(tp, original);

        _regenerateDeps.acceptanceSetupExecute = () => scenario.setupExecute(tp);

        const result = await regenerateAcceptanceTest(tp, makeRegenCtx());
        expect(result).toBe(scenario.expected);

        const bakContent = await Bun.file(`${tp}.bak`).text();
        expect(bakContent).toBe(original);
      } finally {
        cleanupTempDir(dir);
      }
    }
  });
});

// ─── AC-20..26: buildStatusSnapshot gates + writeStatusFile round-trip ───────

describe("buildStatusSnapshot / writeStatusFile: acceptance & regression gates", () => {
  function makeState(overrides: Partial<RunStateSnapshot> = {}): RunStateSnapshot {
    return {
      runId: "run-acceptance-integrity",
      feature: FEATURE,
      startedAt: new Date(0).toISOString(),
      runStatus: "completed",
      dryRun: false,
      pid: 4242,
      prd: makePRD({ feature: FEATURE, userStories: [] }),
      totalCost: 0.5,
      costLimit: null,
      currentStory: null,
      iterations: 2,
      startTimeMs: 0,
      ...overrides,
    };
  }

  test("AC-20: failed acceptance + passed regression → gates reflects both", () => {
    const snapshot = buildStatusSnapshot(
      makeState({
        postRun: {
          acceptance: { status: "failed" },
          regression: { status: "passed" },
        },
      }),
    );

    const gates = (snapshot as unknown as { gates?: Record<string, string> }).gates;
    expect(gates).toBeDefined();
    expect(gates?.acceptance).toBe("failed");
    expect(gates?.regression).toBe("passed");
  });

  test("AC-21: no postRun — the 'gates' key is not emitted at all", () => {
    const snapshot = buildStatusSnapshot(makeState({ postRun: undefined }));

    expect((snapshot as unknown as { gates?: unknown }).gates).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(snapshot, "gates")).toBe(false);
  });

  test("AC-22: acceptance passed but skippedPackages non-empty → gates.acceptance is 'failed'", () => {
    const snapshot = buildStatusSnapshot(
      makeState({
        postRun: {
          acceptance: { status: "passed", skippedPackages: ["pkg-a"] },
          regression: { status: "passed" },
        },
      }),
    );

    const gates = (snapshot as unknown as { gates?: Record<string, string> }).gates;
    expect(gates).toBeDefined();
    expect(gates?.acceptance).toBe("failed");
  });

  test("AC-23: acceptance passed with no skippedPackages → gates.acceptance is 'passed'", () => {
    const snapshot = buildStatusSnapshot(
      makeState({
        postRun: {
          acceptance: { status: "passed" },
          regression: { status: "passed" },
        },
      }),
    );

    const gates = (snapshot as unknown as { gates?: Record<string, string> }).gates;
    expect(gates).toBeDefined();
    expect(gates?.acceptance).toBe("passed");
  });

  test("AC-24: failed acceptance does not alter run.status", () => {
    const snapshot = buildStatusSnapshot(
      makeState({
        runStatus: "completed",
        postRun: {
          acceptance: { status: "failed" },
          regression: { status: "passed" },
        },
      }),
    );

    expect(snapshot.run.status).toBe("completed");
  });

  test("AC-25: regression not-run → gates.regression is 'not-run'", () => {
    const snapshot = buildStatusSnapshot(
      makeState({
        postRun: {
          acceptance: { status: "passed" },
          regression: { status: "not-run" },
        },
      }),
    );

    const gates = (snapshot as unknown as { gates?: Record<string, string> }).gates;
    expect(gates).toBeDefined();
    expect(gates?.regression).toBe("not-run");
  });

  test("AC-26: writeStatusFile JSON round-trip preserves the gates object", async () => {
    const tempDir = makeTempDir("nax-acceptance-status-");
    try {
      const snapshot = buildStatusSnapshot(
        makeState({
          postRun: {
            acceptance: { status: "failed" },
            regression: { status: "passed" },
          },
        }),
      );

      const filePath = join(tempDir, "status.json");
      await writeStatusFile(filePath, snapshot);

      const parsed = JSON.parse(await Bun.file(filePath).text()) as {
        gates?: { acceptance?: string; regression?: string };
      };

      expect(parsed.gates).toBeDefined();
      expect(parsed.gates?.acceptance).toBe("failed");
      expect(parsed.gates?.regression).toBe("passed");
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});