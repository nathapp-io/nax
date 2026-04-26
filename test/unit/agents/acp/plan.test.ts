/**
 * Tests for AcpAgentAdapter.plan() — deprecated (ADR-018 Wave 3)
 *
 * plan() is deprecated in favour of callOp(ctx, planOp, input).
 * The method now throws NaxError("ADAPTER_METHOD_DEPRECATED") immediately.
 *
 * Behavioral tests for the plan flow live in:
 *   test/unit/operations/plan.test.ts
 */

import { describe, expect, test } from "bun:test";
import { AcpAgentAdapter } from "../../../../src/agents/acp/adapter";
import type { PlanOptions } from "../../../../src/agents/types";
import { NaxError } from "../../../../src/errors";

function makePlanOptions(overrides: Partial<PlanOptions> = {}): PlanOptions {
  return {
    prompt: "Plan an authentication system",
    workdir: "/tmp/nax-test",
    interactive: false,
    codebaseContext: "TypeScript project",
    modelDef: { provider: "anthropic", model: "claude-sonnet-4-5", env: {} },
    ...overrides,
  };
}

describe("plan() — deprecated (ADR-018 Wave 3)", () => {
  test("throws NaxError with code ADAPTER_METHOD_DEPRECATED", async () => {
    const adapter = new AcpAgentAdapter("claude");
    await expect(adapter.plan(makePlanOptions())).rejects.toMatchObject({
      code: "ADAPTER_METHOD_DEPRECATED",
    });
  });

  test("error is a NaxError instance", async () => {
    const adapter = new AcpAgentAdapter("claude");
    let caught: unknown;
    try {
      await adapter.plan(makePlanOptions());
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NaxError);
  });

  test("error message references callOp and planOp", async () => {
    const adapter = new AcpAgentAdapter("claude");
    let message = "";
    try {
      await adapter.plan(makePlanOptions());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("callOp");
    expect(message).toContain("planOp");
  });
});
