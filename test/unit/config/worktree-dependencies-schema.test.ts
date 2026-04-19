import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { NaxConfigSchema } from "../../../src/config/schemas";

function withWorktreeDependencies(value: unknown): Record<string, unknown> {
  return {
    ...(DEFAULT_CONFIG as unknown as Record<string, unknown>),
    execution: {
      ...(DEFAULT_CONFIG.execution as unknown as Record<string, unknown>),
      worktreeDependencies: value,
    },
  };
}

describe("execution.worktreeDependencies schema", () => {
  test("defaults mode to off when omitted", () => {
    const config = NaxConfigSchema.parse({});
    expect(config.execution.worktreeDependencies.mode).toBe("off");
    expect(config.execution.worktreeDependencies.setupCommand).toBeNull();
  });

  test.each(["inherit", "provision", "off"] as const)("accepts mode=%s", (mode) => {
    const result = NaxConfigSchema.safeParse(
      withWorktreeDependencies({
        mode,
        setupCommand: mode === "provision" ? "bun install" : null,
      }),
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.execution.worktreeDependencies.mode).toBe(mode);
  });

  test("rejects setupCommand outside provision mode", () => {
    const result = NaxConfigSchema.safeParse(
      withWorktreeDependencies({
        mode: "inherit",
        setupCommand: "bun install",
      }),
    );
    expect(result.success).toBe(false);
  });

  test("rejects invalid mode", () => {
    const result = NaxConfigSchema.safeParse(
      withWorktreeDependencies({
        mode: "symlink",
        setupCommand: null,
      }),
    );
    expect(result.success).toBe(false);
  });

  test("DEFAULT_CONFIG defaults mode to off", () => {
    expect(DEFAULT_CONFIG.execution.worktreeDependencies.mode).toBe("off");
    expect(DEFAULT_CONFIG.execution.worktreeDependencies.setupCommand).toBeNull();
  });
});
