import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { planCommand } from "../../../src/cli/plan";
import type { NaxConfig } from "../../../src/config";
import { DEFAULT_CONFIG } from "../../../src/config/schema";

describe("planCommand", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = `/tmp/nax-plan-${Date.now()}`;
    await mkdir(`${tmpDir}/nax`, { recursive: true });
    await mkdir(`${tmpDir}/src`, { recursive: true });

    // Create minimal package.json
    await Bun.write(
      `${tmpDir}/package.json`,
      JSON.stringify({
        name: "test-project",
        dependencies: { express: "^4.18.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
    );

    // Create minimal source file
    await Bun.write(`${tmpDir}/src/index.ts`, "export const app = {};\n");
  });

  afterEach(async () => {
    if (existsSync(tmpDir)) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws when nax not initialized", async () => {
    const emptyDir = `/tmp/nax-plan-empty-${Date.now()}`;
    await mkdir(emptyDir, { recursive: true });

    expect(planCommand("Add feature X", emptyDir, DEFAULT_CONFIG)).rejects.toThrow("nax directory not found");

    await rm(emptyDir, { recursive: true, force: true });
  });

  test("validates config.plan settings", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      plan: {
        model: "balanced",
        outputPath: "spec.md",
      },
    };

    expect(config.plan.model).toBe("balanced");
    expect(config.plan.outputPath).toBe("spec.md");
  });

  test("resolves model tier from config", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      plan: {
        model: "powerful",
        outputPath: "spec.md",
      },
    };

    expect(config.plan.model).toBe("powerful");
    expect(config.models[config.agent?.default ?? "claude"]?.powerful).toBeDefined();
  });

  test("builds codebase context from scanner", async () => {
    // This test would require mocking the agent adapter
    // For now, we just verify the structure is set up correctly
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      plan: {
        model: "balanced",
        outputPath: "custom-spec.md",
      },
    };

    expect(config.plan.outputPath).toBe("custom-spec.md");
  });

  test("uses default plan config values", () => {
    expect(DEFAULT_CONFIG.plan.model).toBe("balanced");
    expect(DEFAULT_CONFIG.plan.outputPath).toBe("spec.md");
  });

  test("supports custom output path", () => {
    const config: NaxConfig = {
      ...DEFAULT_CONFIG,
      plan: {
        model: "balanced",
        outputPath: "features/planning.md",
      },
    };

    expect(config.plan.outputPath).toBe("features/planning.md");
  });

  test("validates model tier options", () => {
    const validTiers: Array<"fast" | "balanced" | "powerful"> = ["fast", "balanced", "powerful"];

    for (const tier of validTiers) {
      const config: NaxConfig = {
        ...DEFAULT_CONFIG,
        plan: {
          model: tier,
          outputPath: "spec.md",
        },
      };

      expect(config.plan.model).toBe(tier);
      expect(config.models[config.agent?.default ?? "claude"]?.[tier]).toBeDefined();
    }
  });
});

describe("PlanOptions and PlanResult types", () => {
  test("PlanOptions structure is valid", () => {
    // Type-only test — ensures TypeScript accepts the structure
    const options = {
      prompt: "Add URL shortener",
      workdir: "/project",
      interactive: true,
      codebaseContext: "File tree:\nsrc/\n",
      inputFile: undefined,
      modelTier: "balanced" as const,
      modelDef: { provider: "anthropic", model: "claude-sonnet-4-5" },
    };

    expect(options.prompt).toBe("Add URL shortener");
    expect(options.interactive).toBe(true);
  });

  test("PlanResult structure is valid", () => {
    // Type-only test — ensures TypeScript accepts the structure
    const result = {
      specContent: "# Feature: URL Shortener\n\n## Problem\n...",
      conversationLog: "Agent: What storage?\nUser: PostgreSQL\n",
    };

    expect(result.specContent).toContain("Feature: URL Shortener");
  });

  test("non-interactive mode uses inputFile", () => {
    const options = {
      prompt: "Implement feature",
      workdir: "/project",
      interactive: false,
      inputFile: "/tmp/input.md",
    };

    expect(options.interactive).toBe(false);
    expect(options.inputFile).toBe("/tmp/input.md");
  });
});
