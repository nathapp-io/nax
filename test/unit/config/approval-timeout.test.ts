import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema } from "@/config/schemas";
import { ExecutionConfigSchema } from "@/config/schemas-execution";

const base = { ...DEFAULT_CONFIG.execution };

describe("execution.approvalTimeout", () => {
  test("defaults to 10 minutes", () => {
    const { approvalTimeout: _omitted, ...withoutApprovalTimeout } = base;
    expect(ExecutionConfigSchema.parse(withoutApprovalTimeout).approvalTimeout).toBe(600_000);
  });

  test("survives the top-level empty config (BUG-20 guard)", () => {
    expect(NaxConfigSchema.parse({}).execution.approvalTimeout).toBe(600_000);
  });

  test("accepts an explicit value", () => {
    expect(ExecutionConfigSchema.parse({ ...base, approvalTimeout: 90_000 }).approvalTimeout).toBe(90_000);
  });

  test("rejects a value below the 30s floor", () => {
    expect(() => ExecutionConfigSchema.parse({ ...base, approvalTimeout: 1_000 })).toThrow();
  });

  test("rejects a value above the 1h ceiling", () => {
    expect(() => ExecutionConfigSchema.parse({ ...base, approvalTimeout: 3_700_000 })).toThrow();
  });
});
