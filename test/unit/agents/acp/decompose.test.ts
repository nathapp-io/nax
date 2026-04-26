/**
 * Tests for AcpAgentAdapter.decompose() — deprecated (ADR-018 Wave 3)
 *
 * decompose() is deprecated in favour of callOp(ctx, decomposeOp, input).
 * The method now throws NaxError("ADAPTER_METHOD_DEPRECATED") immediately.
 *
 * Behavioral tests for the decompose flow live in:
 *   test/unit/operations/decompose.test.ts
 */

import { describe, expect, test } from "bun:test";
import { AcpAgentAdapter } from "../../../../src/agents/acp/adapter";
import type { DecomposeOptions } from "../../../../src/agents/types";
import { NaxError } from "../../../../src/errors";

function makeDecomposeOptions(overrides: Partial<DecomposeOptions> = {}): DecomposeOptions {
  return {
    specContent: "# Feature Spec",
    workdir: "/tmp/nax-test",
    codebaseContext: "TypeScript project",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    ...overrides,
  };
}

describe("decompose() — deprecated (ADR-018 Wave 3)", () => {
  test("throws NaxError with code ADAPTER_METHOD_DEPRECATED", async () => {
    const adapter = new AcpAgentAdapter("claude");
    await expect(adapter.decompose(makeDecomposeOptions())).rejects.toMatchObject({
      code: "ADAPTER_METHOD_DEPRECATED",
    });
  });

  test("error is a NaxError instance", async () => {
    const adapter = new AcpAgentAdapter("claude");
    let caught: unknown;
    try {
      await adapter.decompose(makeDecomposeOptions());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
  });

  test("error message references callOp and decomposeOp", async () => {
    const adapter = new AcpAgentAdapter("claude");
    let message = "";
    try {
      await adapter.decompose(makeDecomposeOptions());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("callOp");
    expect(message).toContain("decomposeOp");
  });
});
