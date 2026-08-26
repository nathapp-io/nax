import { describe, expect, test } from "bun:test";
import type { DeepPartial } from "@test/helpers";
import { makeNaxConfig, makeTestRuntime } from "@test/helpers";
import type { ConfigSelector, NaxConfig } from "@/config";
import type { QualityConfig } from "@/config/selectors";
import type { Finding } from "@/findings";
import type {
  CallContext,
  MechanicalFormatFixDeps,
  MechanicalFormatFixInput,
  MechanicalFormatFixOutput,
} from "@/operations";
import { _mechanicalFormatFixDeps, makeMechanicalFormatFixStrategy } from "@/operations";
import type { DeterministicOperation } from "@/operations/types";
import type { QualityCommandOptions } from "@/quality";

function ctxWithQuality(quality?: DeepPartial<NaxConfig["quality"]>): CallContext {
  const config = makeNaxConfig({ quality });
  return {
    runtime: makeTestRuntime({ config }),
    storyId: "US-004",
    packageDir: "packages/agent",
    agentName: "claude",
    packageView: {
      packageDir: "packages/agent",
      relativeFromRoot: "packages/agent",
      repoRoot: "/repo",
      hasOverride: false,
      config,
      select: <C>(selector: ConfigSelector<C>): C => selector.select(config),
    },
  };
}

/**
 * `FixStrategy.fixOp` is declared as the broad `Operation<I, O, C>` union, so
 * `.execute` needs narrowing. The guard discriminates on the union; the local
 * re-states the deterministic shape (with its real deps type) instead of
 * casting, so drift stays a compile error.
 */
function executeFixOp(
  strategy: ReturnType<typeof makeMechanicalFormatFixStrategy>,
  input: MechanicalFormatFixInput,
  ctx: CallContext,
  deps: MechanicalFormatFixDeps,
): Promise<MechanicalFormatFixOutput> {
  const { fixOp } = strategy;
  if (!("execute" in fixOp)) {
    throw new Error(`${strategy.name}.fixOp is not a deterministic op — no execute() to call`);
  }
  const op: DeterministicOperation<
    MechanicalFormatFixInput,
    MechanicalFormatFixOutput,
    QualityConfig,
    MechanicalFormatFixDeps
  > = fixOp;
  return op.execute(input, ctx, deps);
}

const passedResult = {
  commandName: "formatFix",
  command: "bun run format:fix",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 50,
  timedOut: false,
};

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    source: "lint",
    severity: "error",
    category: "lint-error",
    message: "error message",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<MechanicalFormatFixDeps> = {}): MechanicalFormatFixDeps {
  return {
    runQualityCommand: async () => passedResult,
    ...overrides,
  };
}

describe("makeMechanicalFormatFixStrategy — shape", () => {
  test("name is mechanical-formatfix", () => {
    const strategy = makeMechanicalFormatFixStrategy();
    expect(strategy.name).toBe("mechanical-formatfix");
  });

  test("maxAttempts is 1", () => {
    const strategy = makeMechanicalFormatFixStrategy();
    expect(strategy.maxAttempts).toBe(1);
  });

  test("coRun is exclusive", () => {
    const strategy = makeMechanicalFormatFixStrategy();
    expect(strategy.coRun).toBe("exclusive");
  });

  test("fixOp kind is deterministic", () => {
    const strategy = makeMechanicalFormatFixStrategy();
    expect(strategy.fixOp.kind).toBe("deterministic");
  });

  test("fixOp name is mechanical-formatfix", () => {
    const strategy = makeMechanicalFormatFixStrategy();
    expect(strategy.fixOp.name).toBe("mechanical-formatfix");
  });
});

describe("makeMechanicalFormatFixStrategy — appliesTo predicate", () => {
  test("returns true for findings with source=lint (format findings tagged as lint)", () => {
    const strategy = makeMechanicalFormatFixStrategy();
    expect(strategy.appliesTo(makeFinding({ source: "lint" }))).toBe(true);
  });

  test("returns false for findings with source=test-runner", () => {
    const strategy = makeMechanicalFormatFixStrategy();
    expect(strategy.appliesTo(makeFinding({ source: "test-runner" }))).toBe(false);
  });
});

describe("makeMechanicalFormatFixStrategy — execute invokes runQualityCommand", () => {
  test("calls runQualityCommand with commandName=formatFix when formatFix is configured", async () => {
    const strategy = makeMechanicalFormatFixStrategy();
    const ctxWithFormatFix = ctxWithQuality({ commands: { formatFix: "bun run format:fix" } });

    let capturedCommandName: string | undefined;
    let capturedCommand: string | undefined;
    const deps = makeDeps({
      runQualityCommand: async (opts: QualityCommandOptions) => {
        capturedCommandName = opts.commandName;
        capturedCommand = opts.command;
        return passedResult;
      },
    });

    await executeFixOp(strategy, { workdir: "/tmp", storyId: "US-004" }, ctxWithFormatFix, deps);

    expect(capturedCommandName).toBe("formatFix");
    expect(capturedCommand).toBe("bun run format:fix");
  });

  test("uses scoped template with substituted files when formatFixScoped is configured", async () => {
    const strategy = makeMechanicalFormatFixStrategy();
    const ctxWithScopedFormatFix = ctxWithQuality({ commands: { formatFixScoped: "biome format --write {{files}}" } });

    let capturedCommand: string | undefined;
    const deps = makeDeps({
      runQualityCommand: async (opts: QualityCommandOptions) => {
        capturedCommand = opts.command;
        return passedResult;
      },
    });

    await executeFixOp(
      strategy,
      { workdir: "/tmp", storyId: "US-004", scopeFiles: ["src/a.ts"] },
      ctxWithScopedFormatFix,
      deps,
    );

    expect(capturedCommand).toBe("biome format --write 'src/a.ts'");
  });
});

describe("makeMechanicalFormatFixStrategy — AC6: no-command early return", () => {
  test("AC6: returns { applied: true, exitCode: 0 } without calling runQualityCommand when formatFix is undefined", async () => {
    const strategy = makeMechanicalFormatFixStrategy();
    const ctxWithNoFormatFix = ctxWithQuality({ commands: { formatFix: undefined } });

    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });

    const output = await executeFixOp(strategy, { workdir: "/tmp", storyId: "US-004" }, ctxWithNoFormatFix, deps);

    expect(output.applied).toBe(true);
    expect(output.exitCode).toBe(0);
    expect(runQualityCalled).toBe(false);
  });

  test("AC6: returns { applied: true, exitCode: 0 } without calling runQualityCommand when config has no formatFix key", async () => {
    const strategy = makeMechanicalFormatFixStrategy();
    const ctxWithNoCommands = ctxWithQuality({ commands: {} });

    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });

    const output = await executeFixOp(strategy, { workdir: "/tmp", storyId: "US-004" }, ctxWithNoCommands, deps);

    expect(output.applied).toBe(true);
    expect(output.exitCode).toBe(0);
    expect(runQualityCalled).toBe(false);
  });
});

describe("_mechanicalFormatFixDeps", () => {
  test("exports runQualityCommand as default dep", () => {
    expect(typeof _mechanicalFormatFixDeps.runQualityCommand).toBe("function");
  });
});
