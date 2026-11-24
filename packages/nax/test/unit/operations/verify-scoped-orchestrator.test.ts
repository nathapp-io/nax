/**
 * verifyScopedOp — orchestrator promotion (US-004)
 *
 * A monorepo orchestrator (`turbo` / `nx`) carries its own scoping syntax, so
 * verify-scoped must hand the package-scoped variant of the configured command
 * to the runner instead of the repo-wide one. These tests drive `execute` with a
 * real package directory whose manifest names the package, and keep the real
 * shared resolver / `selectScopedTests` in the dependency chain so the assertion
 * proves the connection rather than a mocked outcome.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { QualityCommandSpec } from "@nathapp/nax-agent/internal";
import { cleanupTempDir, makeMockCallContext, makeMockRuntime, makeNaxConfig, makeTempDir } from "@test/helpers";
import type { ConfigSelector, NaxConfig } from "@/config";
import type { VerifyScopedDeps, VerifyScopedInput } from "@/operations";
import { _verifyScopedDeps, verifyScopedOp } from "@/operations";
import type { CallContext } from "@/operations/types";
import { resolveQualityTestCommands } from "@/quality/command-resolver";
import type { PackageView } from "@/runtime";
import type { SelectScopedTestsInput, SelectScopedTestsResult } from "@/test-runners";
import { selectScopedTests } from "@/test-runners";

const TURBO_TEST = "npx turbo test";
const TURBO_SCOPED = "npx turbo test --filter={{package}}";
const TURBO_PROMOTED = "npx turbo test --filter='@nathapp/nax'";
const PACKAGE_PREFIX = "packages/nax";

function ctxWithQuality(commands: { test?: QualityCommandSpec; testScoped?: QualityCommandSpec }): CallContext {
  const config: NaxConfig = makeNaxConfig({ quality: { commands } });
  const runtime = makeMockRuntime({ config });
  const packageView: PackageView = {
    packageDir: PACKAGE_PREFIX,
    relativeFromRoot: PACKAGE_PREFIX,
    repoRoot: "/repo",
    hasOverride: false,
    config,
    select: <C>(selector: ConfigSelector<C>) => selector.select(config),
  };
  return makeMockCallContext({ runtime, packageView, storyId: "US-004" });
}

interface Captured {
  /** The command the op handed to `selectScopedTests` (AC-2). */
  readonly selected: QualityCommandSpec[];
  /** The command `selectScopedTests` chose (its `effectiveCommand`). */
  readonly chosen: QualityCommandSpec[];
  /** The command the op handed to `regression` (AC-1 / AC-4 / AC-5 / AC-6). */
  readonly ran: QualityCommandSpec[];
  /** Selection inputs, kept for the control assertion on the template. */
  readonly inputs: SelectScopedTestsInput[];
}

function makeCaptured(): Captured {
  return { selected: [], chosen: [], ran: [], inputs: [] };
}

/**
 * Deps that record what the op passes while delegating to the real
 * `selectScopedTests` and the real full-suite resolver — a promotion the op
 * fails to apply cannot pass a captured-argument assertion by coincidence.
 */
function capturingDeps(captured: Captured): VerifyScopedDeps {
  return {
    selectScopedTests: async (input) => {
      captured.selected.push(input.testCommand);
      captured.inputs.push(input);
      const result: SelectScopedTestsResult = await selectScopedTests(input);
      captured.chosen.push(result.effectiveCommand);
      return result;
    },
    regression: async (opts) => {
      captured.ran.push(opts.command);
      return { status: "SUCCESS" as const, success: true, countsTowardEscalation: true, output: "1 pass\n0 fail" };
    },
    parseTestOutput: () => ({ passed: 1, failed: 0, failures: [] }),
    testSummaryToFindings: () => [],
    resolveFullSuiteCommand: _verifyScopedDeps.resolveFullSuiteCommand,
  };
}

function inputFor(workdir: string): VerifyScopedInput {
  return {
    workdir,
    storyId: "US-004",
    packageDir: PACKAGE_PREFIX,
    packagePrefix: PACKAGE_PREFIX,
    regressionMode: "per-story",
  };
}

let packageDir: string;

beforeEach(async () => {
  packageDir = makeTempDir("nax-verify-scoped-orchestrator-");
  await Bun.write(join(packageDir, "package.json"), JSON.stringify({ name: "@nathapp/nax", version: "0.0.0" }));
});

afterEach(() => cleanupTempDir(packageDir));

describe("verifyScopedOp — orchestrator promotion (US-004)", () => {
  test("AC-1: regression receives the package-scoped turbo command", async () => {
    const captured = makeCaptured();
    await verifyScopedOp.execute(
      inputFor(packageDir),
      ctxWithQuality({ test: TURBO_TEST, testScoped: TURBO_SCOPED }),
      capturingDeps(captured),
    );

    expect(captured.ran).toEqual([TURBO_PROMOTED]);
  });

  test("AC-2: selectScopedTests receives the package-scoped turbo command as testCommand", async () => {
    const captured = makeCaptured();
    await verifyScopedOp.execute(
      inputFor(packageDir),
      ctxWithQuality({ test: TURBO_TEST, testScoped: TURBO_SCOPED }),
      capturingDeps(captured),
    );

    expect(captured.selected).toEqual([TURBO_PROMOTED]);
    // The template handed to selection is the configured one, unresolved.
    expect(captured.inputs[0]?.testScopedTemplate).toBe(TURBO_SCOPED);
  });

  test("AC-3: coversFullSuite is true when the promoted command is also the full-suite command", async () => {
    const captured = makeCaptured();
    const out = await verifyScopedOp.execute(
      inputFor(packageDir),
      ctxWithQuality({ test: TURBO_TEST, testScoped: TURBO_SCOPED }),
      capturingDeps(captured),
    );

    expect(out.success).toBe(true);
    expect(out.coversFullSuite).toBe(true);
  });

  test("AC-4: (control) testScoped unset leaves the repo-wide orchestration command", async () => {
    const captured = makeCaptured();
    await verifyScopedOp.execute(inputFor(packageDir), ctxWithQuality({ test: TURBO_TEST }), capturingDeps(captured));

    expect(captured.selected).toEqual([TURBO_TEST]);
    expect(captured.ran).toEqual([TURBO_TEST]);
  });

  test("AC-5: (control) a non-orchestrator command reaches regression exactly as selection chose it", async () => {
    const captured = makeCaptured();
    await verifyScopedOp.execute(
      inputFor(packageDir),
      ctxWithQuality({ test: "bun test", testScoped: "bun test --filter={{package}}" }),
      capturingDeps(captured),
    );

    expect(captured.selected).toEqual(["bun test"]);
    expect(captured.chosen).toEqual(["bun test"]);
    expect(captured.ran).toEqual(["bun test"]);
  });

  test("AC-6: (control) no package name in the package directory leaves the repo-wide command", async () => {
    await Bun.write(join(packageDir, "package.json"), JSON.stringify({ version: "0.0.0" }));
    const captured = makeCaptured();
    await verifyScopedOp.execute(
      inputFor(packageDir),
      ctxWithQuality({ test: TURBO_TEST, testScoped: TURBO_SCOPED }),
      capturingDeps(captured),
    );

    expect(captured.selected).toEqual([TURBO_TEST]);
    expect(captured.ran).toEqual([TURBO_TEST]);
  });
});

describe("resolveQualityTestCommands — orchestrator promotion (US-004)", () => {
  test("AC-7: (control) promotes the scoped template and clears it for orchestrators", async () => {
    const config = makeNaxConfig({
      quality: { commands: { test: TURBO_TEST, testScoped: TURBO_SCOPED } },
    });

    const result = await resolveQualityTestCommands(config, packageDir, PACKAGE_PREFIX);

    expect(result.testCommand).toBe(TURBO_PROMOTED);
    expect(result.testScopedTemplate).toBeUndefined();
  });
});
