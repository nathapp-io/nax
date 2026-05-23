import { describe, expect, test } from "bun:test";
import { typecheckCheckOp } from "@/operations";
import type { TypecheckCheckDeps } from "@/operations";
import type { Finding } from "@/findings";

const mockCtx = { runtime: {}, storyId: "US-003" } as any;

const passedResult = {
  commandName: "typecheck",
  command: "bun run typecheck",
  success: true,
  exitCode: 0,
  output: "",
  durationMs: 50,
  timedOut: false,
};

const failedResult = {
  commandName: "typecheck",
  command: "bun run typecheck",
  success: false,
  exitCode: 1,
  output: "src/foo.ts(1,1): error TS2304: Cannot find name 'foo'.",
  durationMs: 50,
  timedOut: false,
};

const mockFinding: Finding = {
  source: "typecheck",
  severity: "error",
  category: "typecheck-error",
  message: "Cannot find name 'foo'.",
  file: "src/foo.ts",
  line: 1,
};

function makeDeps(overrides: Partial<TypecheckCheckDeps> = {}): TypecheckCheckDeps {
  return {
    runQualityCommand: async () => passedResult,
    parseTypecheckOutput: () => null,
    ...overrides,
  };
}

describe("typecheckCheckOp — AC2: DeterministicOperation shape", () => {
  test("kind is deterministic", () => {
    expect(typecheckCheckOp.kind).toBe("deterministic");
  });

  test("name is typecheck-check", () => {
    expect(typecheckCheckOp.name).toBe("typecheck-check");
  });

  test("has execute function, not build/parse", () => {
    expect(typeof typecheckCheckOp.execute).toBe("function");
    expect((typecheckCheckOp as any).build).toBeUndefined();
    expect((typecheckCheckOp as any).parse).toBeUndefined();
  });
});

describe("typecheckCheckOp — AC4: execute returns success=true when command exits 0", () => {
  test("AC4: returns success=true and findings=[] when typecheck command exits 0", async () => {
    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      mockCtx,
      makeDeps({ runQualityCommand: async () => passedResult }),
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
  });

  test("AC4: returns success=false and non-empty findings when typecheck command exits non-zero", async () => {
    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      mockCtx,
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseTypecheckOutput: () => ({
          format: "tsc" as any,
          diagnostics: [],
          findings: [mockFinding],
        }),
      }),
    );
    expect(out.success).toBe(false);
    expect(out.findings.length).toBeGreaterThan(0);
  });

  test("AC4: every finding has source='typecheck' when command exits non-zero", async () => {
    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      mockCtx,
      makeDeps({
        runQualityCommand: async () => failedResult,
        parseTypecheckOutput: () => ({
          format: "tsc" as any,
          diagnostics: [],
          findings: [mockFinding],
        }),
      }),
    );
    expect(out.findings.every((f) => f.source === "typecheck")).toBe(true);
  });
});

describe("typecheckCheckOp — AC6: no-command early return", () => {
  test("AC6: returns success=true, findings=[], durationMs=0 when typecheck command is undefined", async () => {
    let runQualityCalled = false;
    const deps = makeDeps({
      runQualityCommand: async () => {
        runQualityCalled = true;
        return passedResult;
      },
    });

    const ctxWithNoCommand = {
      ...mockCtx,
      config: { quality: { commands: { typecheck: undefined } } },
    };

    const out = await typecheckCheckOp.execute(
      { workdir: "/tmp", storyId: "US-003" },
      ctxWithNoCommand,
      deps,
    );
    expect(out.success).toBe(true);
    expect(out.findings).toEqual([]);
    expect(out.durationMs).toBe(0);
    expect(runQualityCalled).toBe(false);
  });
});
