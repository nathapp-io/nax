import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings";
import { _mechanicalFormatFixDeps, makeMechanicalFormatFixStrategy } from "@/operations";
import type { MechanicalFormatFixDeps } from "@/operations";
import type { QualityCommandOptions } from "@/quality";

function ctxWithQuality(quality?: Record<string, unknown>) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-004",
    packageView: { packageDir: "packages/agent", config, select: (s: any) => s.select(config) },
  } as any;
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

    await (strategy.fixOp as any).execute({ workdir: "/tmp", storyId: "US-004" }, ctxWithFormatFix, deps);

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

    await (strategy.fixOp as any).execute(
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

    const output = await (strategy.fixOp as any).execute(
      { workdir: "/tmp", storyId: "US-004" },
      ctxWithNoFormatFix,
      deps,
    );

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

    const output = await (strategy.fixOp as any).execute(
      { workdir: "/tmp", storyId: "US-004" },
      ctxWithNoCommands,
      deps,
    );

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
