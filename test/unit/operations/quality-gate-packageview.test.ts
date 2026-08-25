import { describe, expect, test } from "bun:test";
import { makeMockRuntime, makeNaxConfig, makeStory } from "@test/helpers";
import type { ConfigSelector, NaxConfig } from "@/config";
import {
  _fullSuiteGateDeps,
  _verifyScopedDeps,
  type CallContext,
  type TypecheckCheckDeps,
  typecheckCheckOp,
  type VerifyScopedDeps,
  verifyScopedOp,
} from "@/operations";
import type { PackageView } from "@/runtime";

type QualityCommands = NonNullable<NonNullable<NaxConfig["quality"]>["commands"]>;

function packageViewWith(config: NaxConfig): PackageView {
  return {
    packageDir: "packages/agent",
    relativeFromRoot: "packages/agent",
    repoRoot: "/r",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
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
        seen = o.command;
        return {
          commandName: "typecheck",
          command: o.command,
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
    let sawTestCommand: string | undefined;
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
      packageView: {
        packageDir: "packages/agent",
        relativeFromRoot: "packages/agent",
        repoRoot: "/r",
        hasOverride: true,
        config: packageConfig,
        select: <C>(selector: ConfigSelector<C>) => selector.select(packageConfig),
      },
    };
    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w", story: makeStory({ id: "US-003", workdir: "packages/agent" }) },
      ctx,
    );
    expect(gateCtx.testCmd).toBe("pytest packages/agent/tests");
  });
});
