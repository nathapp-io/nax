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
    ["lintFix", "lintFix", "bun run lint --fix"],
    ["lintFixScoped", "lintFixScoped", "biome check --fix {{files}}"],
    ["formatFix", "formatFix", "bun run format --write"],
    ["formatFixScoped", "formatFixScoped", "biome format --write {{files}}"],
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
      lintFix: "bun run lint --fix",
      lintFixScoped: "biome check --fix {{files}}",
      formatFix: "bun run format --write",
      formatFixScoped: "biome format --write {{files}}",
    });
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.test).toBe("bun run test");
    expect(result.quality.commands.testScoped).toBe("bun test --timeout=60000 {{files}}");
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
    expect(result.quality.commands.lint).toBe("bun run lint");
    expect(result.quality.commands.lintScoped).toBe("biome check {{files}}");
    expect(result.quality.commands.lintFix).toBe("bun run lint --fix");
    expect(result.quality.commands.lintFixScoped).toBe("biome check --fix {{files}}");
    expect(result.quality.commands.formatFix).toBe("bun run format --write");
    expect(result.quality.commands.formatFixScoped).toBe("biome format --write {{files}}");
  });

  test("build is preserved after schema parse", () => {
    const input = buildConfigWithCommands({ build: "bun run build" });
    const result = NaxConfigSchema.parse(input);
    expect((result.quality.commands as Record<string, string>)["build"]).toBe("bun run build");
  });

  test("build is optional — absent when not provided", () => {
    const input = buildConfigWithCommands({});
    const result = NaxConfigSchema.parse(input);
    expect(result.quality.commands.build).toBeUndefined();
  });
});

describe("review.commands schema — lintFix/formatFix not stripped by Zod", () => {
  function buildConfigWithReviewCommands(commands: Record<string, unknown>) {
    return {
      ...DEFAULT_CONFIG,
      review: {
        ...DEFAULT_CONFIG.review,
        commands: {
          ...DEFAULT_CONFIG.review.commands,
          ...commands,
        },
      },
    };
  }

  test.each([
    ["lintFix", "lintFix", "bun run lint:fix"],
    ["lintFixScoped", "lintFixScoped", "eslint --fix {{files}}"],
    ["formatFix", "formatFix", "bun run format --write"],
    ["formatFixScoped", "formatFixScoped", "prettier --write {{files}}"],
    ["lintScoped", "lintScoped", "eslint {{files}}"],
  ])("%s in review.commands is preserved after schema parse", (_label, field, value) => {
    const input = buildConfigWithReviewCommands({ [field]: value });
    const result = NaxConfigSchema.parse(input);
    expect((result.review.commands as Record<string, string>)[field]).toBe(value);
  });

  test("lintFix and formatFix coexist with standard review commands", () => {
    const input = buildConfigWithReviewCommands({
      lint: "bun run lint",
      lintScoped: "eslint {{files}}",
      typecheck: "bun run typecheck",
      lintFix: "bun run lint:fix",
      lintFixScoped: "eslint --fix {{files}}",
      formatFix: "bun run format --write",
      formatFixScoped: "prettier --write {{files}}",
    });
    const result = NaxConfigSchema.parse(input);
    expect(result.review.commands.lint).toBe("bun run lint");
    expect(result.review.commands.lintScoped).toBe("eslint {{files}}");
    expect(result.review.commands.typecheck).toBe("bun run typecheck");
    expect(result.review.commands.lintFix).toBe("bun run lint:fix");
    expect(result.review.commands.lintFixScoped).toBe("eslint --fix {{files}}");
    expect(result.review.commands.formatFix).toBe("bun run format --write");
    expect(result.review.commands.formatFixScoped).toBe("prettier --write {{files}}");
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

describe("quality.typecheckOutput schema", () => {
  test("defaults typecheckOutput.format to auto", () => {
    const parsed = NaxConfigSchema.parse({});
    expect(parsed.quality.typecheckOutput?.format).toBe("auto");
  });

  test("preserves explicit typecheckOutput.format", () => {
    const parsed = NaxConfigSchema.parse({
      quality: {
        ...DEFAULT_CONFIG.quality,
        typecheckOutput: { format: "tsc" },
      },
    });
    expect(parsed.quality.typecheckOutput?.format).toBe("tsc");
  });
});
