// RE-ARCH: keep
/**
 * quality.commands schema — testScoped and other optional command fields
 *
 * Regression test for BUG-043: testScoped was present in types.ts but missing
 * from schemas.ts, causing Zod to silently strip it during config parsing.
 * Result: testScopedTemplate was always undefined at runtime, so the {{files}}
 * template was never applied and scoped tests fell back to buildSmartTestCommand.
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "@/config/defaults";
import { NaxConfigSchema } from "@/config/schemas";

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
  test.each([
    ["testScoped (BUG-043 regression)", "testScoped", "bun test --timeout=60000 {{files}}"],
    ["lintScoped", "lintScoped", "biome check {{files}}"],
  ])("%s is preserved after schema parse", (_label, field, value) => {
    const input = buildConfigWithCommands({ [field]: value });
    const result = NaxConfigSchema.parse(input);
    expect((result.quality.commands as Record<string, string>)[field]).toBe(value);
  });

  test("testScoped is optional — absent when not provided", () => {
    const input = buildConfigWithCommands({});
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.testScoped).toBeUndefined();
  });

  test("all command fields coexist correctly", () => {
    const input = buildConfigWithCommands({
      test: "bun run test",
      testScoped: "bun test --timeout=60000 {{files}}",
      typecheck: "bun run typecheck",
      lint: "bun run lint",
      lintScoped: "biome check {{files}}",
    });
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.test).toBe("bun run test");
    expect(result.quality.commands.testScoped).toBe("bun test --timeout=60000 {{files}}");
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
    expect(result.quality.commands.lint).toBe("bun run lint");
    expect(result.quality.commands.lintScoped).toBe("biome check {{files}}");
  });

  test("build is preserved after schema parse", () => {
    const input = buildConfigWithCommands({ build: "bun run build" });
    const result = NaxConfigSchema.parse(input);
    expect((result.quality.commands as Record<string, string>).build).toBe("bun run build");
  });

  test("build is optional — absent when not provided", () => {
    const input = buildConfigWithCommands({});
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.build).toBeUndefined();
  });
});

describe("review.commands schema — lintScoped not stripped by Zod", () => {
  test("lintScoped in review.commands is preserved after schema parse", () => {
    const input = {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        commands: { ...DEFAULT_CONFIG.review.commands, lintScoped: "eslint {{files}}" },
      },
    };
    const result = NaxConfigSchema.parse(input);
    expect(result.review.commands.lintScoped).toBe("eslint {{files}}");
  });
});

describe("quality.lintOutput schema", () => {
  test("defaults lintOutput.format to auto", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.quality.lintOutput?.format).toBe("auto");
  });

  test("preserves explicit lintOutput.format", () => {
    const parsed = NaxConfigSchema.parse({
      quality: {
        ...DEFAULT_CONFIG.quality,
        lintOutput: { format: "eslint-json" },
      },
    });
    expect(parsed.quality.lintOutput?.format).toBe("eslint-json");
  });
});
