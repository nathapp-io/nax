import { describe, expect, test } from "bun:test";
import { assertDefined, makeSpawn, makeStory, makeTestRuntime } from "@test/helpers";
import { tddConfigSelector } from "@/config";
import { testWriterOp } from "@/operations";
import type { BuildContext, VerifyContext } from "@/operations/types";
import type { TestWriterInput, TestWriterOutput } from "@/operations/write-test";
import type { UserStory } from "@/prd";

type TestWriterOpConfig = ReturnType<typeof tddConfigSelector.select>;

/**
 * Tests for testWriterOp — the full RunOperation shape for the test-writer role.
 *
 * AC-2: testWriterOp.session.role equals "test-writer" and
 * testWriterOp.session.lifetime equals "warm" (keepOpen resolver gates actual retention).
 *
 * AC-4: Given testWriterOp.parse receives empty output, when parse executes,
 * then it returns TestWriterOutput with success: false and filesChanged: [].
 * Given a valid JSON envelope with success:true, parse returns success: true.
 * Given non-JSON or malformed output (e.g. buildHopCallback error strings),
 * parse returns success: false — agent failure must not be masked as success.
 */

function makeParseCtx(): BuildContext<TestWriterOpConfig> {
  const view = makeTestRuntime().packages.repo();
  return { packageView: view, config: view.select(tddConfigSelector) };
}

function makeInput(story: Partial<UserStory> = {}): TestWriterInput {
  return { story: makeStory({ id: "US-001", ...story }) };
}

async function runVerify(
  parsed: Parameters<NonNullable<typeof testWriterOp.verify>>[0],
  input: Parameters<NonNullable<typeof testWriterOp.verify>>[1],
  ctx: Parameters<NonNullable<typeof testWriterOp.verify>>[2],
) {
  assertDefined(testWriterOp.verify, "testWriterOp.verify");
  return testWriterOp.verify(parsed, input, ctx);
}

describe("testWriterOp — RunOperation shape", () => {
  test("exports testWriterOp as a RunOperation with kind=run", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(testWriterOp).toBeDefined();
    expect(testWriterOp.kind).toBe("run");
  });

  test("testWriterOp.session.role equals 'test-writer'", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(testWriterOp.session.role).toBe("test-writer");
  });

  test("testWriterOp.session.lifetime equals 'warm'", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(testWriterOp.session.lifetime).toBe("warm");
  });

  test("testWriterOp declares a keepOpen resolver", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(typeof testWriterOp.keepOpen).toBe("function");
  });

  test.each([["name" as const], ["stage" as const]])("testWriterOp has a non-empty %s string", async (field) => {
    const { testWriterOp } = await import("@/operations");
    expect(typeof testWriterOp[field]).toBe("string");
    expect(testWriterOp[field]).toBeTruthy();
  });

  test("testWriterOp has a config selector", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(testWriterOp.config).toBeDefined();
  });

  test.each([["build" as const], ["parse" as const]])("testWriterOp has a %s function", async (method) => {
    const { testWriterOp } = await import("@/operations");
    expect(typeof testWriterOp[method]).toBe("function");
  });
});

describe("testWriterOp.parse — error handling", () => {
  test("returns TestWriterOutput with success=false when output is empty", async () => {
    const { testWriterOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = makeInput();
    const result = testWriterOp.parse("", input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=false when output is non-JSON (e.g. buildHopCallback error string)", async () => {
    const { testWriterOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = makeInput();
    const result = testWriterOp.parse('Agent "mock" failed: Agent failed', input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=true when output is non-error prose (no JSON envelope)", async () => {
    // Mirrors implementerOp: agents that reply in prose instead of the JSON
    // envelope are treated as successful — downstream gates catch real failures.
    const { testWriterOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = makeInput();
    const result = testWriterOp.parse("Tests added to src/calc.test.ts — RED as expected.", input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=false when output is an injected agent-failure marker", async () => {
    const { testWriterOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = makeInput();
    const result = testWriterOp.parse('Agent "opencode" failed: timeout', input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=true when output is valid JSON envelope", async () => {
    const { testWriterOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = makeInput();
    const result = testWriterOp.parse('{"success":true,"filesChanged":["test/foo.test.ts"]}', input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual(["test/foo.test.ts"]);
    expect(result.output).toBe('{"success":true,"filesChanged":["test/foo.test.ts"]}');
  });

  test("returns TestWriterOutput with all required fields on parse failure", async () => {
    const { testWriterOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = makeInput();
    const result = testWriterOp.parse("", input, ctx);

    expect(result.success).toBeDefined();
    expect(result.filesChanged).toBeDefined();
    expect(typeof result.estimatedCostUsd).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });
});

describe("testWriterOp.verify — isolation", () => {
  function makeVerifyCtx(): VerifyContext<TestWriterOpConfig> {
    const view = makeTestRuntime().packages.repo();
    return {
      packageView: view,
      config: view.select(tddConfigSelector),
      readFile: async () => null,
      fileExists: async () => false,
    };
  }

  test("attaches isolation result when beforeRef provided and only test files changed", async () => {
    const { testWriterOp } = await import("@/operations");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = makeSpawn(() => ({ stdout: "test/foo.test.ts\n" })).spawn;

    try {
      const parsed: TestWriterOutput = {
        success: true,
        filesChanged: ["test/foo.test.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input: TestWriterInput = { story: makeStory({ id: "US-001" }), beforeRef: "HEAD~1" };
      const ctx = makeVerifyCtx();

      const result = await runVerify(parsed, input, ctx);

      assertDefined(result, "verify() result");
      const isolation = result.isolation;
      assertDefined(isolation, "verify().isolation");
      expect(isolation.passed).toBe(true);
      expect(isolation.violations).toEqual([]);
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("attaches isolation result with violations when source files changed", async () => {
    const { testWriterOp } = await import("@/operations");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = makeSpawn(() => ({ stdout: "src/foo.ts\ntest/foo.test.ts\n" })).spawn;

    try {
      const parsed: TestWriterOutput = {
        success: true,
        filesChanged: ["src/foo.ts", "test/foo.test.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input: TestWriterInput = { story: makeStory({ id: "US-001" }), beforeRef: "HEAD~1" };
      const ctx = makeVerifyCtx();

      const result = await runVerify(parsed, input, ctx);

      assertDefined(result, "verify() result");
      const isolation = result.isolation;
      assertDefined(isolation, "verify().isolation");
      expect(isolation.passed).toBe(false);
      expect(isolation.violations).toContain("src/foo.ts");
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("returns parsed unchanged when beforeRef absent (skip isolation)", async () => {
    const { testWriterOp } = await import("@/operations");

    const parsed: TestWriterOutput = {
      success: true,
      filesChanged: [],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "ok",
    };
    const input: TestWriterInput = { story: makeStory({ id: "US-001" }) }; // no beforeRef
    const ctx = makeVerifyCtx();

    const result = await runVerify(parsed, input, ctx);
    expect(result).toEqual(parsed);
  });
});

describe("testWriterOp.recover — disk artifact recovery", () => {
  test("testWriterOp has an optional recover function", async () => {
    const { testWriterOp } = await import("@/operations");
    // recover is optional per ADR-020 §D4
    if (testWriterOp.recover) {
      expect(typeof testWriterOp.recover).toBe("function");
    }
  });
});

describe("testWriterOp input/output types", () => {
  test("testWriterOp input includes story", async () => {
    const mockInput = makeInput();
    expect(mockInput.story).toBeDefined();
    const { testWriterOp } = await import("@/operations");
    expect(testWriterOp).toBeDefined();
  });

  test("testWriterOp output includes success, filesChanged, estimatedCostUsd, durationMs", async () => {
    const { testWriterOp } = await import("@/operations");

    const ctx = makeParseCtx();
    const input = makeInput();
    const output = testWriterOp.parse("", input, ctx);

    expect("success" in output).toBe(true);
    expect("filesChanged" in output).toBe(true);
    expect("estimatedCostUsd" in output).toBe(true);
    expect("durationMs" in output).toBe(true);
    expect("output" in output).toBe(true);
  });
});

function tddBuildCtx(sessionTiers?: TestWriterOpConfig["tdd"]["sessionTiers"]): BuildContext<TestWriterOpConfig> {
  const view = makeTestRuntime().packages.repo();
  const base = view.select(tddConfigSelector);
  return {
    packageView: view,
    config: { ...base, tdd: { ...base.tdd, sessionTiers } },
  };
}

describe("testWriterOp.model — tdd.sessionTiers.testWriter", () => {
  function callModel(ctx: BuildContext<TestWriterOpConfig>) {
    if (typeof testWriterOp.model !== "function") throw new Error("testWriterOp.model must be a resolver");
    return testWriterOp.model(makeInput(), ctx);
  }

  test("returns the configured testWriter tier", () => {
    expect(callModel(tddBuildCtx({ testWriter: "fast" }))).toBe("fast");
  });

  test("passes a ConfiguredModel object through unchanged", () => {
    expect(callModel(tddBuildCtx({ testWriter: { agent: "claude", model: "haiku" } }))).toEqual({
      agent: "claude",
      model: "haiku",
    });
  });

  test("returns undefined when sessionTiers is absent (callOp then defaults)", () => {
    expect(callModel(tddBuildCtx(undefined))).toBeUndefined();
  });
});
