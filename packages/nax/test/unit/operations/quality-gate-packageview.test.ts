import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeConfigSlice, makeMockRuntime, makeNaxConfig, makeStory } from "@test/helpers";
import type { ConfigSelector, NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import {
  _fullSuiteGateDeps,
  _verifyScopedDeps,
  type CallContext,
  type TypecheckCheckDeps,
  typecheckCheckOp,
  type VerifyScopedDeps,
  verifyScopedOp,
} from "@/operations";
import { _commandDefaultsDeps, clearCommandDefaultsCache } from "@/quality";
import type { PackageView } from "@/runtime";

type QualityCommands = NonNullable<NonNullable<NaxConfig["quality"]>["commands"]>;

function packageViewWith(
  config: NaxConfig,
  opts: { hasOverride?: boolean; overlay?: Partial<NaxConfig> } = {},
): PackageView {
  return {
    packageDir: "packages/agent",
    relativeFromRoot: "packages/agent",
    repoRoot: "/r",
    hasOverride: opts.hasOverride ?? false,
    ...(opts.overlay !== undefined ? { overlay: opts.overlay } : {}),
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
}

/**
 * A raw per-package overlay declaring exactly the given `quality.commands` —
 * the shape `.nax/mono/<pkg>/config.json` produces before merging.
 */
function rawOverlay(commands: Partial<QualityCommands>): Partial<NaxConfig> {
  return { quality: makeConfigSlice("quality", { commands }) };
}

function ctxWithQuality(commands: Partial<QualityCommands> = {}): CallContext {
  const config = makeNaxConfig({ quality: { commands } });
  return {
    runtime: makeMockRuntime(),
    agentName: "test-agent",
    packageDir: "/w",
    storyId: "US-003",
    packageView: packageViewWith(config),
  };
}

describe("typecheckCheckOp via packageView", () => {
  test("runs the typecheck command from packageView", async () => {
    let seen = "";
    const deps: TypecheckCheckDeps = {
      runQualityCommand: async (o) => {
        seen = o.command as string;
        return {
          commandName: "typecheck",
          command: o.command as string,
          success: true,
          exitCode: 0,
          output: "",
          durationMs: 1,
          timedOut: false,
        };
      },
      parseTypecheckOutput: () => null,
    };
    await typecheckCheckOp.execute(
      { workdir: "/w", storyId: "US-003" },
      ctxWithQuality({ typecheck: "mypy packages/agent/src" }),
      deps,
    );
    expect(seen).toBe("mypy packages/agent/src");
  });

  test("skips with success when no typecheck command configured", async () => {
    let called = false;
    const deps: TypecheckCheckDeps = {
      runQualityCommand: async () => {
        called = true;
        return {
          commandName: "typecheck",
          command: "",
          success: true,
          exitCode: 0,
          output: "",
          durationMs: 0,
          timedOut: false,
        };
      },
      parseTypecheckOutput: () => null,
    };
    const out = await typecheckCheckOp.execute({ workdir: "/w", storyId: "US-003" }, ctxWithQuality(), deps);
    expect(called).toBe(false);
    expect(out.success).toBe(true);
  });
});

describe("verifyScopedOp via packageView", () => {
  test("reads quality.commands.test from packageView (not phantom ctx.config)", async () => {
    let sawTestCommand: NaxConfig["quality"]["commands"]["test"];
    const deps: VerifyScopedDeps = {
      ..._verifyScopedDeps,
      selectScopedTests: async (o) => {
        sawTestCommand = o.testCommand;
        return {
          isFullSuite: true,
          isMonorepoOrchestrator: false,
          thresholdFallback: false,
          effectiveCommand: o.testCommand,
          scopeTestFallback: false,
        };
      },
      regression: async () => ({
        success: true,
        status: "SUCCESS",
        output: "",
        exitCode: 0,
        countsTowardEscalation: false,
      }),
      parseTestOutput: () => ({ passed: 1, failed: 0, failures: [] }),
      testSummaryToFindings: () => [],
    };

    await verifyScopedOp.execute(
      { workdir: "/w", storyId: "US-003", regressionMode: "per-story" },
      ctxWithQuality({ test: "pytest packages/agent/tests" }),
      deps,
    );
    expect(sawTestCommand).toBe("pytest packages/agent/tests");
  });
});

describe("fullSuiteGateOp uses package config", () => {
  test("resolveGateContext resolves the PACKAGE test command, not root", async () => {
    const packageConfig = makeNaxConfig({ quality: { commands: { test: "pytest packages/agent/tests" } } });
    const rootConfig = makeNaxConfig({ quality: { commands: { test: "pytest" } } });
    const ctx: CallContext = {
      // Root config stays reachable through runtime.configLoader — the gate must
      // ignore it in favour of packageView.config (the claim under test).
      runtime: makeMockRuntime({ config: rootConfig }),
      agentName: "test-agent",
      packageDir: "/w",
      storyId: "US-003",
      packageView: packageViewWith(packageConfig, {
        hasOverride: true,
        overlay: rawOverlay({ test: "pytest packages/agent/tests" }),
      }),
    };
    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w", story: makeStory({ id: "US-003", workdir: "packages/agent" }) },
      ctx,
    );
    expect(gateCtx.testCmd).toBe("pytest packages/agent/tests");
  });
});

describe("_fullSuiteGateDeps.resolveGateContext — US-002: cwd provenance", () => {
  test("US-002 AC16: overlay declaring only quality.commands.lint runs the root test command from repoRoot", async () => {
    const config = makeNaxConfig({ quality: { commands: { test: "bun run test" } } });
    const ctx: CallContext = {
      runtime: makeMockRuntime({ config }),
      agentName: "test-agent",
      packageDir: "/w",
      storyId: "US-003",
      packageView: packageViewWith(config, { hasOverride: true, overlay: rawOverlay({ lint: "eslint ." }) }),
    };

    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w/packages/lib", story: makeStory({ id: "US-003", workdir: "packages/lib" }) },
      ctx,
    );

    expect(gateCtx.cmdWorkdir).toBe("/r");
    expect(gateCtx.cmdProvenance).toBe("root");
  });

  test("US-002 AC17: overlay declaring quality.commands.test runs from the story workdir with provenance 'overlay'", async () => {
    const config = makeNaxConfig({ quality: { commands: { test: "pytest packages/agent/tests" } } });
    const ctx: CallContext = {
      runtime: makeMockRuntime({ config }),
      agentName: "test-agent",
      packageDir: "/w",
      storyId: "US-003",
      packageView: packageViewWith(config, {
        hasOverride: true,
        overlay: rawOverlay({ test: "pytest packages/agent/tests" }),
      }),
    };

    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w", story: makeStory({ id: "US-003", workdir: "packages/agent" }) },
      ctx,
    );

    expect(gateCtx.cmdWorkdir).toBe("/w");
    expect(gateCtx.cmdProvenance).toBe("overlay");
  });
});

const savedDetectLanguage = _commandDefaultsDeps.detectLanguage;
const savedFileExists = _commandDefaultsDeps.fileExists;
const savedReadJson = _commandDefaultsDeps.readJson;

/** Force the detection fallback to yield `bun test` (a bun JS package with no test script). */
function detectBunTest(): void {
  _commandDefaultsDeps.detectLanguage = async () => "typescript";
  _commandDefaultsDeps.fileExists = async (p) => p.endsWith("bun.lock");
  _commandDefaultsDeps.readJson = async () => null;
}

/** Force the detection fallback to yield nothing at all. */
function detectNothing(): void {
  _commandDefaultsDeps.detectLanguage = async () => undefined;
  _commandDefaultsDeps.fileExists = async () => false;
  _commandDefaultsDeps.readJson = async () => null;
}

describe("_fullSuiteGateDeps.resolveGateContext — US-003: shared suite command", () => {
  beforeEach(clearCommandDefaultsCache);

  afterEach(() => {
    _commandDefaultsDeps.detectLanguage = savedDetectLanguage;
    _commandDefaultsDeps.fileExists = savedFileExists;
    _commandDefaultsDeps.readJson = savedReadJson;
    clearCommandDefaultsCache();
  });

  test("AC-6: no configured and no detected test command throws TEST_COMMAND_MISSING", async () => {
    detectNothing();
    const config = makeNaxConfig();
    const ctx: CallContext = {
      runtime: makeMockRuntime({ config }),
      agentName: "test-agent",
      packageDir: "/w/packages/a",
      storyId: "US-003",
      packageView: packageViewWith(config),
    };

    const run = _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w/packages/a", story: makeStory({ id: "US-003", workdir: "packages/a" }) },
      ctx,
    );

    const caught = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(caught).toBeInstanceOf(NaxError);
    if (!(caught instanceof NaxError)) throw new Error(`expected a NaxError, got ${String(caught)}`);
    expect(caught.code).toBe("TEST_COMMAND_MISSING");
  });

  test("AC-7: an overlay-declared test command runs from the package's absolute dir", async () => {
    const config = makeNaxConfig({ quality: { commands: { test: "custom test" } } });
    const ctx: CallContext = {
      runtime: makeMockRuntime({ config }),
      agentName: "test-agent",
      packageDir: "/w/packages/a",
      storyId: "US-003",
      packageView: packageViewWith(config, { hasOverride: true, overlay: rawOverlay({ test: "custom test" }) }),
    };

    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w/packages/a", story: makeStory({ id: "US-003", workdir: "packages/a" }) },
      ctx,
    );

    expect(gateCtx.testCmd).toBe("custom test");
    expect(gateCtx.cmdWorkdir).toBe("/w/packages/a");
    expect(gateCtx.cmdProvenance).toBe("overlay");
  });

  test("AC-8: a detected test command carries provenance 'detected'", async () => {
    detectBunTest();
    const config = makeNaxConfig();
    const ctx: CallContext = {
      runtime: makeMockRuntime({ config }),
      agentName: "test-agent",
      packageDir: "/w/packages/a",
      storyId: "US-003",
      packageView: packageViewWith(config),
    };

    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w/packages/a", story: makeStory({ id: "US-003", workdir: "packages/a" }) },
      ctx,
    );

    expect(gateCtx.testCmd).toBe("bun test");
    expect(gateCtx.cmdWorkdir).toBe("/w/packages/a");
    expect(gateCtx.cmdProvenance).toBe("detected");
  });
});
