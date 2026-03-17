/**
 * Unit tests for mergePackageConfig (MW-008)
 */

import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../../src/config/defaults";
import { mergePackageConfig } from "../../../src/config/merge";
import type { NaxConfig } from "../../../src/config/schema";

function makeRoot(): NaxConfig {
  return {
    ...DEFAULT_CONFIG,
    quality: {
      ...DEFAULT_CONFIG.quality,
      commands: {
        test: "bun test",
        testScoped: "bun test {{files}}",
        typecheck: "bun run typecheck",
        lint: "bun run lint",
      },
    },
  };
}

describe("mergePackageConfig", () => {
  test("returns root unchanged when packageOverride has no quality.commands", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {});
    expect(result).toBe(root);
  });

  test("returns root unchanged when packageOverride.quality has no commands", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { ...DEFAULT_CONFIG.quality, commands: undefined as unknown as NaxConfig["quality"]["commands"] },
    } as Partial<NaxConfig>);
    // quality.commands is undefined/missing → returns root unchanged
    expect(result).toBe(root);
  });

  test("merges quality.commands when packageOverride provides them", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "npm test" } },
    } as Partial<NaxConfig>);

    expect(result.quality.commands.test).toBe("npm test");
    // Other commands preserved from root
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
    expect(result.quality.commands.lint).toBe("bun run lint");
    expect(result.quality.commands.testScoped).toBe("bun test {{files}}");
  });

  test("partial override: only specified commands are replaced", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: {
        commands: {
          test: "npm run test:unit",
          testScoped: "npm test -- {{files}}",
        },
      },
    } as Partial<NaxConfig>);

    expect(result.quality.commands.test).toBe("npm run test:unit");
    expect(result.quality.commands.testScoped).toBe("npm test -- {{files}}");
    expect(result.quality.commands.typecheck).toBe("bun run typecheck");
    expect(result.quality.commands.lint).toBe("bun run lint");
  });

  test("does not mutate root config", () => {
    const root = makeRoot();
    const originalTest = root.quality.commands.test;
    mergePackageConfig(root, {
      quality: { commands: { test: "changed" } },
    } as Partial<NaxConfig>);

    expect(root.quality.commands.test).toBe(originalTest);
  });

  test("non-quality sections from packageOverride are ignored", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "npm test" } },
      routing: { strategy: "keyword" } as NaxConfig["routing"],
    } as Partial<NaxConfig>);

    // routing not changed
    expect(result.routing).toBe(root.routing);
    // quality.commands merged
    expect(result.quality.commands.test).toBe("npm test");
  });

  test("returns new object (not same reference)", () => {
    const root = makeRoot();
    const result = mergePackageConfig(root, {
      quality: { commands: { test: "npm test" } },
    } as Partial<NaxConfig>);

    expect(result).not.toBe(root);
    expect(result.quality).not.toBe(root.quality);
    expect(result.quality.commands).not.toBe(root.quality.commands);
  });
});
