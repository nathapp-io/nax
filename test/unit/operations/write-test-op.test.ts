import { describe, expect, test } from "bun:test";
import type { RunOperation } from "@/operations";
import type { NaxConfig } from "@/config";

/**
 * Tests for testWriterOp — the full RunOperation shape for the test-writer role.
 *
 * AC-2: testWriterOp.session.role equals "test-writer" and
 * testWriterOp.session.lifetime equals "fresh".
 *
 * AC-4: Given testWriterOp.parse receives empty or unparseable output, when
 * parse executes, then it returns TestWriterOutput with success: false and
 * filesChanged: [].
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

  test("testWriterOp.session.lifetime equals 'fresh'", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(testWriterOp.session.lifetime).toBe("fresh");
  });

  test("testWriterOp has a name", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(typeof testWriterOp.name).toBe("string");
    expect(testWriterOp.name).toBeTruthy();
  });

  test("testWriterOp has a stage", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(typeof testWriterOp.stage).toBe("string");
    expect(testWriterOp.stage).toBeTruthy();
  });

  test("testWriterOp has a config selector", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(testWriterOp.config).toBeDefined();
  });

  test("testWriterOp has a build function", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(typeof testWriterOp.build).toBe("function");
  });

  test("testWriterOp has a parse function", async () => {
    const { testWriterOp } = await import("@/operations");
    expect(typeof testWriterOp.parse).toBe("function");
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

  test("returns TestWriterOutput with success=false when output is unparseable", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse("garbage output", input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns TestWriterOutput with success=false when output is malformed JSON", async () => {
    const { testWriterOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = testWriterOp.parse('{"success": ', input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
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
  });
});
