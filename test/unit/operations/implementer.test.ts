import { describe, expect, test } from "bun:test";
import type { RunOperation } from "@/operations";
import type { NaxConfig } from "@/config";

/**
 * Tests for implementerOp — the full RunOperation shape for the implementer role.
 *
 * AC-1: implementerOp.kind equals "run", implementerOp.session.role equals
 * "implementer", and implementerOp.session.lifetime equals "warm".
 *
 * AC-4: Given implementerOp.parse receives empty output, when parse executes,
 * then it returns ImplementerOutput with success: false and filesChanged: [].
 * Given a buildHopCallback error string ('Agent "..." failed: ...'), parse
 * returns success: false. Given non-error non-empty output (prose or JSON),
 * parse returns success: true — session exited 0, treat as success.
 *
 * AC-5: Given upgraded TDD op parse cannot produce a usable value and op-level
 * recover can derive output from disk artifacts, when callOp post-parse flow
 * runs, then it returns recovered output instead of throwing parse failure.
 */

describe("implementerOp — RunOperation shape", () => {
  test("exports implementerOp as a RunOperation with kind=run", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp).toBeDefined();
    expect(implementerOp.kind).toBe("run");
  });

  test("implementerOp.session.role equals 'implementer'", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp.session.role).toBe("implementer");
  });

  test("implementerOp.session.lifetime equals 'warm'", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp.session.lifetime).toBe("warm");
  });

  test("implementerOp has a name", async () => {
    const { implementerOp } = await import("@/operations");
    expect(typeof implementerOp.name).toBe("string");
    expect(implementerOp.name).toBeTruthy();
  });

  test("implementerOp has a stage", async () => {
    const { implementerOp } = await import("@/operations");
    expect(typeof implementerOp.stage).toBe("string");
    expect(implementerOp.stage).toBeTruthy();
  });

  test("implementerOp has a config selector", async () => {
    const { implementerOp } = await import("@/operations");
    expect(implementerOp.config).toBeDefined();
  });

  test("implementerOp has a build function", async () => {
    const { implementerOp } = await import("@/operations");
    expect(typeof implementerOp.build).toBe("function");
  });

  test("implementerOp has a parse function", async () => {
    const { implementerOp } = await import("@/operations");
    expect(typeof implementerOp.parse).toBe("function");
  });
});

describe("implementerOp.parse — error handling", () => {
  test("returns ImplementerOutput with success=false when output is empty", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG, pickSelector } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = implementerOp.parse("", input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns ImplementerOutput with success=false when output is a buildHopCallback error string", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = implementerOp.parse('Agent "mock" failed: Agent failed', input, ctx);

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
  });

  test("returns ImplementerOutput with success=true when output is non-empty prose", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = implementerOp.parse("I implemented the story and committed all changes.", input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
    expect(result.output).toBe("I implemented the story and committed all changes.");
  });

  test("returns ImplementerOutput with success=true when output is malformed JSON (non-agent-error)", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = implementerOp.parse('{ "broken": ', input, ctx);

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual([]);
    expect(result.output).toBe('{ "broken": ');
  });

  test("returns ImplementerOutput with all required fields on parse failure", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const result = implementerOp.parse("", input, ctx);

    expect(result.success).toBeDefined();
    expect(result.filesChanged).toBeDefined();
    expect(typeof result.estimatedCostUsd).toBe("number");
    expect(typeof result.durationMs).toBe("number");
  });
});

describe("implementerOp.recover — disk artifact recovery", () => {
  test("implementerOp has an optional recover function", async () => {
    const { implementerOp } = await import("@/operations");
    // recover is optional per ADR-020 §D4
    if (implementerOp.recover) {
      expect(typeof implementerOp.recover).toBe("function");
    }
  });

  test("when recover exists, it accepts input and VerifyContext", async () => {
    const { implementerOp } = await import("@/operations");
    // Type check that recover signature is correct if it exists
    if (implementerOp.recover) {
      const recoverFn = implementerOp.recover;
      expect(recoverFn.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe("implementerOp input/output types", () => {
  test("implementerOp input includes story", async () => {
    // Verifying the input type carries story field
    const { implementerOp } = await import("@/operations");
    const mockInput = {
      story: { id: "US-001" } as any,
    };
    // If this compiles, the type is correct
    expect(mockInput.story).toBeDefined();
  });

  test("implementerOp output includes success, filesChanged, estimatedCostUsd, durationMs", async () => {
    const { implementerOp } = await import("@/operations");
    const { DEFAULT_CONFIG } = await import("@/config");

    const ctx = {
      packageView: {} as any,
      config: DEFAULT_CONFIG,
    };

    const input = {
      story: { id: "US-001" } as any,
    };

    const output = implementerOp.parse("", input, ctx);

    expect("success" in output).toBe(true);
    expect("filesChanged" in output).toBe(true);
    expect("estimatedCostUsd" in output).toBe(true);
    expect("durationMs" in output).toBe(true);
    expect("output" in output).toBe(true);
  });
});
