// RE-ARCH: keep
/**
 * quality.commands schema — testScoped and other optional command fields
 *
 * Regression test for BUG-043: testScoped was present in types.ts but missing
 * from schemas.ts, causing Zod to silently strip it during config parsing.
 * Result: testScopedTemplate was always undefined at runtime, so the {{files}}
 * template was never applied and scoped tests fell back to buildSmartTestCommand.
 */

import { describe, test, expect } from "bun:test";
import { NaxConfigSchema } from "../../../src/config/schemas";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";

function buildConfigWithCommands(commands: Record<string, unknown>) {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: {
        ...DEFAULT_CONFIG.quality.commands,
        ...commands,
      },
    },
  };
}

describe("quality.commands schema", () => {
  test("testScoped is preserved after schema parse (BUG-043 regression)", () => {
    const input = buildConfigWithCommands({
      testScoped: "bun test --timeout=60000 {{files}}",
    });
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.testScoped).toBe("bun test --timeout=60000 {{files}}");
  });

  test("testScoped is optional — absent when not provided", () => {
    const input = buildConfigWithCommands({});
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.testScoped).toBeUndefined();
  });

  test("lintFix is preserved after schema parse", () => {
    const input = buildConfigWithCommands({ lintFix: "bun run lint --fix" });
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.lintFix).toBe("bun run lint --fix");
  });

  test("formatFix is preserved after schema parse", () => {
    const input = buildConfigWithCommands({ formatFix: "bun run format --write" });
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.formatFix).toBe("bun run format --write");
  });

  test("all command fields coexist correctly", () => {
    const input = buildConfigWithCommands({
      test: "bun run test",
      testScoped: "bun test --timeout=60000 {{files}}",
      typecheck: "bun run typecheck",
      lint: "bun run lint",
      lintFix: "bun run lint --fix",
      formatFix: "bun run format --write",
    });
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.test).toBe("bun run test");
    expect(result.quality.commands.testScoped).toBe("bun test --timeout=60000 {{files}}");
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
    expect(result.quality.commands.lint).toBe("bun run lint");
    expect(result.quality.commands.lintFix).toBe("bun run lint --fix");
    expect(result.quality.commands.formatFix).toBe("bun run format --write");
  });
});
