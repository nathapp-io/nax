import { describe, expect, test } from "bun:test";
import { _verifyScopedDeps, typecheckCheckOp, verifyScopedOp } from "@/operations";

function ctxWithQuality(quality?: Record<string, unknown>) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-003",
    packageView: { packageDir: "packages/agent", config, select: (s: any) => s.select(config) },
  } as any;
}

describe("typecheckCheckOp via packageView", () => {
  test("runs the typecheck command from packageView", async () => {
    let seen = "";
    const deps = {
      runQualityCommand: async (o: any) => {
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
    } as any;
    await typecheckCheckOp.execute(
      { workdir: "/w", storyId: "US-003" },
      ctxWithQuality({ commands: { typecheck: "mypy packages/agent/src" } }),
      deps,
    );
    expect(seen).toBe("mypy packages/agent/src");
  });

  test("skips with success when no typecheck command configured", async () => {
    let called = false;
    const deps = {
      runQualityCommand: async () => {
        called = true;
        return {} as any;
      },
      parseTypecheckOutput: () => null,
    } as any;
    const out = await typecheckCheckOp.execute(
      { workdir: "/w", storyId: "US-003" },
      ctxWithQuality({ commands: {} }),
      deps,
    );
    expect(called).toBe(false);
    expect(out.success).toBe(true);
  });
});

describe("verifyScopedOp via packageView", () => {
  test("reads quality.commands.test from packageView (not phantom ctx.config)", async () => {
    let sawTestCommand: string | undefined;
    const deps = {
      ..._verifyScopedDeps,
      selectScopedTests: async (o: any) => {
        sawTestCommand = o.testCommand;
        return {
          isFullSuite: true,
          isMonorepoOrchestrator: false,
          thresholdFallback: false,
          files: [],
          command: o.testCommand,
          effectiveCommand: o.testCommand,
          scopeTestFallback: false,
        };
      },
      regression: async () => ({ success: true, status: "PASS" as any, output: "", exitCode: 0, durationMs: 0 }),
      parseTestOutput: () => ({ passed: 1, failed: 0, failures: [] }),
      testSummaryToFindings: () => [],
    } as any;

    await verifyScopedOp.execute(
      { workdir: "/w", storyId: "US-003", regressionMode: "per-story" } as any,
      ctxWithQuality({ commands: { test: "pytest packages/agent/tests" } }),
      deps,
    );
    expect(sawTestCommand).toBe("pytest packages/agent/tests");
  });
});

import { _fullSuiteGateDeps } from "@/operations";

describe("fullSuiteGateOp uses package config", () => {
  test("resolveGateContext resolves the PACKAGE test command, not root", async () => {
    const packageConfig = { quality: { commands: { test: "pytest packages/agent/tests" } }, execution: {} } as any;
    const rootConfig = { quality: { commands: { test: "pytest" } }, execution: {} } as any;
    const ctx = {
      runtime: { configLoader: { current: () => rootConfig } },
      storyId: "US-003",
      packageView: { packageDir: "packages/agent", config: packageConfig, select: (s: any) => s.select(packageConfig) },
    } as any;
    const gateCtx = await _fullSuiteGateDeps.resolveGateContext(
      { workdir: "/w", story: { id: "US-003", workdir: "packages/agent" } } as any,
      ctx,
    );
    expect(gateCtx.testCmd).toBe("pytest packages/agent/tests");
  });
});
