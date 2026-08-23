import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "@/config";
import { testWriterOp } from "@/operations";
import type { RunOperation } from "@/operations";

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
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse("", input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=false when output is non-JSON (e.g. buildHopCallback error string)", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse('Agent "mock" failed: Agent failed', input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=true when output is non-error prose (no JSON envelope)", async () => {
    // Mirrors implementerOp: agents that reply in prose instead of the JSON
    // envelope are treated as successful — downstream gates catch real failures.
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse("Tests added to src/calc.test.ts — RED as expected.", input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=false when output is an injected agent-failure marker", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse('Agent "opencode" failed: timeout', input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=true when output is valid JSON envelope", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse('{"success":true,"filesChanged":["test/foo.test.ts"]}', input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual(["test/foo.test.ts"]);
    expect(result.output).toBe('{"success":true,"filesChanged":["test/foo.test.ts"]}');
  });

  test("returns TestWriterOutput with all required fields on parse failure", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse("", input, ctx);

    expect(result.success).toBeDefined();
    expect(result.filesChanged).toBeDefined();
    expect(typeof result.estimatedCostUsd).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });
});

describe("testWriterOp.verify — isolation", () => {
  test("attaches isolation result when beforeRef provided and only test files changed", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = ((_cmd: string[]) => ({
      stdout: new Response("test/foo.test.ts\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    })) as any;

    try {
      const parsed = {
        success: true,
        filesChanged: ["test/foo.test.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
      const ctx = {
        packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
        config: DEFAULT_CONFIG.tdd,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await testWriterOp.verify!(parsed, input, ctx as any);

      expect(result).not.toBeNull();
      expect(result!.isolation).toBeDefined();
      expect(result!.isolation!.passed).toBe(true);
      expect(result!.isolation!.violations).toEqual([]);
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("attaches isolation result with violations when source files changed", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");
    const { _isolationDeps } = await import("@/tdd");

    const origSpawn = _isolationDeps.spawn;
    _isolationDeps.spawn = ((_cmd: string[]) => ({
      stdout: new Response("src/foo.ts\ntest/foo.test.ts\n").body,
      stderr: new Response("").body,
      exited: Promise.resolve(0),
    })) as any;

    try {
      const parsed = {
        success: true,
        filesChanged: ["src/foo.ts", "test/foo.test.ts"],
        estimatedCostUsd: 0,
        durationMs: 0,
        output: "ok",
      };
      const input = { story: { id: "US-001" } as any, beforeRef: "HEAD~1" };
      const ctx = {
        packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
        config: DEFAULT_CONFIG.tdd,
        readFile: async () => null,
        fileExists: async () => false,
      };

      const result = await testWriterOp.verify!(parsed, input, ctx as any);

      expect(result!.isolation!.passed).toBe(false);
      expect(result!.isolation!.violations).toContain("src/foo.ts");
    } finally {
      _isolationDeps.spawn = origSpawn;
    }
  });

  test("returns parsed unchanged when beforeRef absent (skip isolation)", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const parsed = {
      success: true,
      filesChanged: [],
      estimatedCostUsd: 0,
      durationMs: 0,
      output: "ok",
    };
    const input = { story: { id: "US-001" } as any }; // no beforeRef
    const ctx = {
      packageView: { packageDir: "/tmp/x", config: DEFAULT_CONFIG } as any,
      config: DEFAULT_CONFIG.tdd,
      readFile: async () => null,
      fileExists: async () => false,
    };

    const result = await testWriterOp.verify!(parsed, input, ctx as any);
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
    const { testWriterOp } = await import("@/operations");
    const mockInput = {
      story: { id: "US-001" } as any,
    };
    expect(mockInput.story).toBeDefined();
  });

  test("testWriterOp output includes success, filesChanged, estimatedCostUsd, durationMs", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const output = testWriterOp.parse("", input, ctx);

    expect("success" in output).toBe(true);
    expect("filesChanged" in output).toBe(true);
    expect("estimatedCostUsd" in output).toBe(true);
    expect("durationMs" in output).toBe(true);
    expect("output" in output).toBe(true);
  });
});

function tddBuildCtx(sessionTiers?: Record<string, unknown>) {
  return { config: { tdd: { sessionTiers } }, packageView: {} as any };
}

describe("testWriterOp.model — tdd.sessionTiers.testWriter", () => {
  test("returns the configured testWriter tier", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ testWriter: "fast" }))).toBe("fast");
  });

  test("passes a ConfiguredModel object through unchanged", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx({ testWriter: { agent: "claude", model: "haiku" } }))).toEqual({
      agent: "claude",
      model: "haiku",
    });
  });

  test("returns undefined when sessionTiers is absent (callOp then defaults)", () => {
    const resolver = testWriterOp.model as (i: unknown, c: unknown) => unknown;
    expect(resolver({}, tddBuildCtx(undefined))).toBeUndefined();
  });
});
