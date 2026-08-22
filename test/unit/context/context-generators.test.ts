/**
 * Context Generators Tests (v0.16.1)
 *
 * Tests for generating agent-specific config files from nax/context.md.
 */

import { describe, expect, test } from "bun:test";
import { aiderGenerator } from "@/context/generators/aider";
import { claudeGenerator } from "@/context/generators/claude";
import { codexGenerator } from "@/context/generators/codex";
import { geminiGenerator } from "@/context/generators/gemini";
import { opencodeGenerator } from "@/context/generators/opencode";
import type { ContextContent } from "@/context/types";

const sampleContext: ContextContent = {
  markdown: `# Project Context

## Architecture
- Microservices with Docker
- TypeScript + Node.js

## Testing Requirements
- 80% minimum coverage
- Write tests first (TDD)

## Development Workflow
- Feature branches
- Conventional commits
`,
};

const contextWithMetadata: ContextContent = {
  markdown: `# Project Context

## Architecture
- Microservices with Docker
`,
  metadata: {
    name: "@myapp/core",
    language: "TypeScript",
    dependencies: ["express", "zod", "prisma"],
    testCommand: "bun test",
    lintCommand: "bun run lint",
  },
};

describe("Context Generators", () => {
  describe("Claude Generator", () => {
    test("generates CLAUDE.md with correct format, preserves context, and includes metadata when provided", () => {
      const r = claudeGenerator.generate(sampleContext);
      expect(r).toContain("# Project Context");
      expect(r).toContain("auto-generated from `.nax/context.md`");
      expect(r).toContain("DO NOT EDIT MANUALLY");
      expect(r).toContain("## Architecture");
      expect(r).toContain("Microservices with Docker");

      const rm = claudeGenerator.generate(contextWithMetadata);
      expect(rm).toContain("## Project Metadata");
      expect(rm).toContain("@myapp/core");
      expect(rm).toContain("TypeScript");
      expect(rm).toContain("express");
    });
  });

  describe("OpenCode Generator", () => {
    test("should generate AGENTS.md with correct format", () => {
      const result = opencodeGenerator.generate(sampleContext);

      expect(result).toContain("# Agent Instructions");
      expect(result).toContain("auto-generated from `.nax/context.md`");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Architecture");
    });
  });

  describe("Codex Generator", () => {
    test("generates codex.md with correct format, metadata, preserved content, and empty context", () => {
      const r = codexGenerator.generate(sampleContext);
      expect(r).toContain("# Codex Instructions");
      expect(r).toContain("auto-generated from `.nax/context.md`");
      expect(r).toContain("DO NOT EDIT MANUALLY");
      expect(r).toContain("## Architecture");
      expect(r).toContain("## Testing Requirements");
      expect(r).toContain("## Development Workflow");
      expect(r).toContain("Feature branches");
      expect(r).toContain("Conventional commits");

      const rm = codexGenerator.generate(contextWithMetadata);
      expect(rm).toContain("## Project Metadata");
      expect(rm).toContain("@myapp/core");
      expect(rm).toContain("TypeScript");
      expect(rm).toContain("express, zod, prisma");

      const re = codexGenerator.generate({ markdown: "" });
      expect(re.length).toBeGreaterThan(0);
      expect(re).toContain("# Codex Instructions");
      expect(re).toContain("DO NOT EDIT MANUALLY");
    });
  });

  describe("All Generators", () => {
    test("preserve original context content; have unique output filenames and generator names", () => {
      for (const generator of [claudeGenerator, opencodeGenerator, codexGenerator]) {
        const result = generator.generate(sampleContext);
        expect(result, generator.name).toContain("## Architecture");
        expect(result, generator.name).toContain("Microservices with Docker");
      }

      const filenames = [claudeGenerator.outputFile, opencodeGenerator.outputFile, codexGenerator.outputFile];
      expect(new Set(filenames).size).toBe(3);

      const names = [claudeGenerator.name, opencodeGenerator.name, codexGenerator.name];
      expect(new Set(names).size).toBe(3);
    });
  });

  describe("Gemini Generator", () => {
    test("generates GEMINI.md with correct format, metadata, preserved content, and empty context", () => {
      const r = geminiGenerator.generate(sampleContext);
      expect(r).toContain("# Gemini CLI Context");
      expect(r).toContain("auto-generated from `.nax/context.md`");
      expect(r).toContain("DO NOT EDIT MANUALLY");
      expect(r).toContain("## Architecture");
      expect(r).toContain("## Testing Requirements");
      expect(r).toContain("## Development Workflow");
      expect(r).toContain("Feature branches");
      expect(r).toContain("Conventional commits");

      const rm = geminiGenerator.generate(contextWithMetadata);
      expect(rm).toContain("## Project Metadata");
      expect(rm).toContain("@myapp/core");
      expect(rm).toContain("TypeScript");
      expect(rm).toContain("express");

      const re = geminiGenerator.generate({ markdown: "" });
      expect(re.length).toBeGreaterThan(0);
      expect(re).toContain("# Gemini CLI Context");
      expect(re).toContain("DO NOT EDIT MANUALLY");
    });
  });

  describe("Codex Naming Conventions", () => {
    test("codex uses codex.md, opencode uses AGENTS.md, both include context with distinct headers", () => {
      expect(codexGenerator.outputFile).toBe("codex.md");
      expect(opencodeGenerator.outputFile).toBe("AGENTS.md");

      const codexResult = codexGenerator.generate(sampleContext);
      const agentsResult = opencodeGenerator.generate(sampleContext);
      expect(codexResult).toContain("# Codex Instructions");
      expect(agentsResult).toContain("# Agent Instructions");
      expect(codexResult).toContain("## Architecture");
      expect(agentsResult).toContain("## Architecture");
    });
  });

  describe("Aider Generator", () => {
    test("generates .aider.conf.yml with correct format, metadata, preserved content, and empty context", () => {
      const r = aiderGenerator.generate(sampleContext);
      expect(r).toContain("# Aider Configuration");
      expect(r).toContain("Auto-generated from .nax/context.md");
      expect(r).toContain("DO NOT EDIT MANUALLY");
      expect(r).toContain("## Architecture");
      expect(r).toContain("## Testing Requirements");
      expect(r).toContain("## Development Workflow");
      expect(r).toContain("Feature branches");
      expect(r).toContain("Conventional commits");

      const rm = aiderGenerator.generate(contextWithMetadata);
      expect(rm).toContain("## Project Metadata");
      expect(rm).toContain("@myapp/core");
      expect(rm).toContain("TypeScript");
      expect(rm).toContain("express");

      const re = aiderGenerator.generate({ markdown: "" });
      expect(re.length).toBeGreaterThan(0);
      expect(re).toContain("# Aider Configuration");
      expect(re).toContain("DO NOT EDIT MANUALLY");
    });
  });

  describe("All New Generators", () => {
    test("codex, opencode, gemini, aider are registered with name/outputFile/generate; all produce content with DO NOT EDIT MANUALLY", () => {
      for (const generator of [codexGenerator, opencodeGenerator, geminiGenerator, aiderGenerator]) {
        expect(generator.name, generator.name).toBeDefined();
        expect(generator.outputFile, generator.name).toBeDefined();
        expect(generator.generate, generator.name).toBeDefined();

        const result = generator.generate(sampleContext);
        expect(result.length, generator.name).toBeGreaterThan(0);
        expect(result, generator.name).toContain("DO NOT EDIT MANUALLY");
        if (generator.name === "aider") {
          expect(result, generator.name).toContain("Auto-generated from .nax/context.md");
        } else {
          expect(result, generator.name).toContain("auto-generated from `.nax/context.md`");
        }
      }

      const generatorNames = ["codex", "opencode", "gemini", "aider"];
      for (const name of generatorNames) {
        expect([codexGenerator.name, opencodeGenerator.name, geminiGenerator.name, aiderGenerator.name]).toContain(
          name,
        );
      }
    });
  });

  describe("Generator names and output filenames", () => {
    test.each([
      ["claude", claudeGenerator, "CLAUDE.md"],
      ["opencode", opencodeGenerator, "AGENTS.md"],
      ["codex", codexGenerator, "codex.md"],
      ["gemini", geminiGenerator, "GEMINI.md"],
      ["aider", aiderGenerator, ".aider.conf.yml"],
    ] as const)("should have correct generator name: %s", (name, generator) => {
      expect(generator.name).toBe(name);
    });

    test.each([
      ["claude", claudeGenerator, "CLAUDE.md"],
      ["opencode", opencodeGenerator, "AGENTS.md"],
      ["codex", codexGenerator, "codex.md"],
      ["gemini", geminiGenerator, "GEMINI.md"],
      ["aider", aiderGenerator, ".aider.conf.yml"],
    ] as const)("should have correct output filename: %s", (_name, generator, outputFile) => {
      expect(generator.outputFile).toBe(outputFile);
    });
  });
});
