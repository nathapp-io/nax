import { describe, expect, test } from "bun:test";
import type { Finding } from "@/findings";
import { _mechanicalLintFixDeps, makeMechanicalLintFixStrategy } from "@/operations";
import type { MechanicalLintFixDeps } from "@/operations";
import type { QualityCommandOptions } from "@/quality";

const mockCtx = { runtime: {}, storyId: "US-004" } as any;

function ctxWithQuality(quality?: Record<string, unknown>) {
  const config = { quality, execution: {} } as any;
  return {
    runtime: {},
    storyId: "US-004",
    packageView: { packageDir: "packages/agent", config, select: (s: any) => s.select(config) },
  } as any;
}

const passedResult = {
  commandName: "lintFix",
  command: "bun run lint:fix",
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

function makeDeps(overrides: Partial<MechanicalLintFixDeps> = {}): MechanicalLintFixDeps {
  return {
    runQualityCommand: async () => passedResult,
    ...overrides,
  };
}

describe("makeMechanicalLintFixStrategy — shape", () => {
  test("name is mechanical-lintfix", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.name).toBe("mechanical-lintfix");
  });

  test("maxAttempts is 1", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.maxAttempts).toBe(1);
  });

  test("coRun is exclusive", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.coRun).toBe("exclusive");
  });

  test("fixOp kind is deterministic", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.fixOp.kind).toBe("deterministic");
  });

  test("fixOp name is mechanical-lintfix", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.fixOp.name).toBe("mechanical-lintfix");
  });
});

describe("makeMechanicalLintFixStrategy — AC7: appliesTo predicate", () => {
  test("AC7: returns true for findings with source=lint", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.appliesTo(makeFinding({ source: "lint" }))).toBe(true);
  });

  test("AC7: returns false for findings with source=test-runner", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.appliesTo(makeFinding({ source: "test-runner" }))).toBe(false);
  });

  test("AC7: returns false for findings with source=typecheck", () => {
    const strategy = makeMechanicalLintFixStrategy();
    expect(strategy.appliesTo(makeFinding({ source: "typecheck" }))).toBe(false);
  });
});

describe("makeMechanicalLintFixStrategy — AC5: execute invokes runQualityCommand", () => {
  test("AC5: calls runQualityCommand with commandName=lintFix when lintFix is configured", async () => {
    const strategy = makeMechanicalLintFixStrategy();
    const ctxWithLintFix = ctxWithQuality({ commands: { lintFix: "bun run lint:fix" } });

    let capturedCommandName: string | undefined;
    let capturedCommand: string | undefined;
    const deps = makeDeps({
      runQualityCommand: async (opts: QualityCommandOptions) => {
        capturedCommandName = opts.commandName;
        capturedCommand = opts.command;
        return passedResult;
      },
    });

    await (strategy.fixOp as any).execute({ workdir: "/tmp", storyId: "US-004" }, ctxWithLintFix, deps);

    expect(capturedCommandName).toBe("lintFix");
    expect(capturedCommand).toBe("bun run lint:fix");
  });

  test("AC5: returns { applied: true, exitCode } from the quality command result", async () => {
    const strategy = makeMechanicalLintFixStrategy();
    const ctxWithLintFix = ctxWithQuality({ commands: { lintFix: "bun run lint:fix" } });
    const deps = makeDeps({
      runQualityCommand: async () => ({ ...passedResult, exitCode: 0 }),
    });

    const output = await (strategy.fixOp as any).execute(
      { workdir: "/tmp", storyId: "US-004" },
      ctxWithLintFix,
      deps,
    );
    expect(output.applied).toBe(true);
    expect(output.exitCode).toBe(0);
  });

  test("AC5: scoped template uses {{files}} substitution when scopeFiles are present", async () => {
    const strategy = makeMechanicalLintFixStrategy();
    const ctxWithScopedLintFix = ctxWithQuality({ commands: { lintFixScoped: "biome check --write {{files}}" } });

    let capturedCommand: string | undefined;
    const deps = makeDeps({
      runQualityCommand: async (opts: QualityCommandOptions) => {
        capturedCommand = opts.command;
        return passedResult;
      },
    });

    await (strategy.fixOp as any).execute(
      { workdir: "/tmp", storyId: "US-004", scopeFiles: ["src/a.ts", "src/b.ts"] },
      ctxWithScopedLintFix,
      deps,
    );

    expect(capturedCommand).toBe("biome check --write 'src/a.ts' 'src/b.ts'");
  });

  test("AC5: scoped-only config without scopeFiles returns early instead of executing raw template", async () => {
    const strategy = makeMechanicalLintFixStrategy();
    const ctxWithScopedLintFix = ctxWithQuality({ commands: { lintFixScoped: "biome check --write {{files}}" } });

    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });

    const output = await (strategy.fixOp as any).execute(
      { workdir: "/tmp", storyId: "US-004" },
      ctxWithScopedLintFix,
      deps,
    );

    expect(output).toEqual({ applied: true, exitCode: 0 });
    expect(runQualityCalled).toBe(false);
  });
});

describe("makeMechanicalLintFixStrategy — AC6: no-command early return", () => {
  test("AC6: returns { applied: true, exitCode: 0 } without calling runQualityCommand when lintFix is undefined", async () => {
    const strategy = makeMechanicalLintFixStrategy();
    const ctxWithNoLintFix = ctxWithQuality({ commands: { lintFix: undefined } });

    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });

    const output = await (strategy.fixOp as any).execute(
      { workdir: "/tmp", storyId: "US-004" },
      ctxWithNoLintFix,
      deps,
    );

    expect(output.applied).toBe(true);
    expect(output.exitCode).toBe(0);
    expect(runQualityCalled).toBe(false);
  });

  test("AC6: returns { applied: true, exitCode: 0 } without calling runQualityCommand when config has no lintFix key", async () => {
    const strategy = makeMechanicalLintFixStrategy();
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

describe("_mechanicalLintFixDeps", () => {
  test("exports runQualityCommand as default dep", () => {
    expect(typeof _mechanicalLintFixDeps.runQualityCommand).toBe("function");
  });
});
