/**
 * Context Generators Tests (v0.16.1)
 *
 * Tests for generating agent-specific config files from nax/context.md.
 */

import { describe, expect, test } from "bun:test";
import { claudeGenerator } from "../../../src/context/generators/claude";
import { opencodeGenerator } from "../../../src/context/generators/opencode";
import { codexGenerator } from "../../../src/context/generators/codex";
import { geminiGenerator } from "../../../src/context/generators/gemini";
import { aiderGenerator } from "../../../src/context/generators/aider";
import type { ContextContent } from "../../../src/context/types";

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
    test("should generate CLAUDE.md with correct format", () => {
      const result = claudeGenerator.generate(sampleContext);

      expect(result).toContain("# Project Context");
      expect(result).toContain("auto-generated from `nax/context.md`");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Architecture");
      expect(result).toContain("Microservices with Docker");
    });

    test("should have correct output filename", () => {
      expect(claudeGenerator.outputFile).toBe("CLAUDE.md");
    });

    test("should have correct generator name", () => {
      expect(claudeGenerator.name).toBe("claude");
    });

    test("should include metadata section when provided", () => {
      const result = claudeGenerator.generate(contextWithMetadata);

      expect(result).toContain("## Project Metadata");
      expect(result).toContain("@myapp/core");
      expect(result).toContain("TypeScript");
      expect(result).toContain("express");
    });
  });

  describe("OpenCode Generator", () => {
    test("should generate AGENTS.md with correct format", () => {
      const result = opencodeGenerator.generate(sampleContext);

      expect(result).toContain("# Agent Instructions");
      expect(result).toContain("auto-generated from `nax/context.md`");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Architecture");
    });

    test("should have correct output filename", () => {
      expect(opencodeGenerator.outputFile).toBe("AGENTS.md");
    });

    test("should have correct generator name", () => {
      expect(opencodeGenerator.name).toBe("opencode");
    });
  });

  describe("Codex Generator", () => {
    test("should generate codex.md with correct format", () => {
      const result = codexGenerator.generate(sampleContext);

      expect(result).toContain("# Codex Instructions");
      expect(result).toContain("auto-generated from `nax/context.md`");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Architecture");
      expect(result).toContain("Microservices with Docker");
    });

    test("should have correct output filename", () => {
      expect(codexGenerator.outputFile).toBe("codex.md");
    });

    test("should have correct generator name", () => {
      expect(codexGenerator.name).toBe("codex");
    });

    test("should include metadata section when provided", () => {
      const result = codexGenerator.generate(contextWithMetadata);

      expect(result).toContain("## Project Metadata");
      expect(result).toContain("@myapp/core");
      expect(result).toContain("TypeScript");
      expect(result).toContain("express, zod, prisma");
    });

    test("should preserve context content correctly", () => {
      const result = codexGenerator.generate(sampleContext);

      expect(result).toContain("## Testing Requirements");
      expect(result).toContain("## Development Workflow");
      expect(result).toContain("Feature branches");
      expect(result).toContain("Conventional commits");
    });

    test("should handle empty context", () => {
      const emptyContext: ContextContent = { markdown: "" };
      const result = codexGenerator.generate(emptyContext);

      // Should still have header and basic structure
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("# Codex Instructions");
      expect(result).toContain("DO NOT EDIT MANUALLY");
    });
  });

  describe("All Generators", () => {
    test("should preserve original context content", () => {
      const generators = [claudeGenerator, opencodeGenerator, codexGenerator];

      for (const generator of generators) {
        const result = generator.generate(sampleContext);
        expect(result).toContain("## Architecture");
        expect(result).toContain("Microservices with Docker");
      }
    });

    test("should have unique output filenames", () => {
      const filenames = [claudeGenerator.outputFile, opencodeGenerator.outputFile, codexGenerator.outputFile];
      const uniqueFilenames = new Set(filenames);

      expect(uniqueFilenames.size).toBe(3);
    });

    test("should have unique generator names", () => {
      const names = [claudeGenerator.name, opencodeGenerator.name, codexGenerator.name];
      const uniqueNames = new Set(names);

      expect(uniqueNames.size).toBe(3);
    });
  });

  describe("Gemini Generator", () => {
    test("should generate GEMINI.md with correct format", () => {
      const result = geminiGenerator.generate(sampleContext);

      expect(result).toContain("# Gemini CLI Context");
      expect(result).toContain("auto-generated from `nax/context.md`");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Architecture");
      expect(result).toContain("Microservices with Docker");
    });

    test("should have correct output filename", () => {
      expect(geminiGenerator.outputFile).toBe("GEMINI.md");
    });

    test("should have correct generator name", () => {
      expect(geminiGenerator.name).toBe("gemini");
    });

    test("should include metadata section when provided", () => {
      const result = geminiGenerator.generate(contextWithMetadata);

      expect(result).toContain("## Project Metadata");
      expect(result).toContain("@myapp/core");
      expect(result).toContain("TypeScript");
      expect(result).toContain("express");
    });

    test("should preserve context content correctly", () => {
      const result = geminiGenerator.generate(sampleContext);

      expect(result).toContain("## Testing Requirements");
      expect(result).toContain("## Development Workflow");
      expect(result).toContain("Feature branches");
      expect(result).toContain("Conventional commits");
    });

    test("should handle empty context", () => {
      const emptyContext: ContextContent = { markdown: "" };
      const result = geminiGenerator.generate(emptyContext);

      // Should still have header and basic structure
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("# Gemini CLI Context");
      expect(result).toContain("DO NOT EDIT MANUALLY");
    });
  });

  describe("Codex Naming Conventions", () => {
    test("should support codex.md naming convention", () => {
      expect(codexGenerator.outputFile).toBe("codex.md");
    });

    test("should support AGENTS.md naming convention via OpenCode", () => {
      expect(opencodeGenerator.outputFile).toBe("AGENTS.md");
    });

    test("should allow choosing between naming conventions", () => {
      const codexResult = codexGenerator.generate(sampleContext);
      const agentsResult = opencodeGenerator.generate(sampleContext);

      // Both should have the context but different headers
      expect(codexResult).toContain("# Codex Instructions");
      expect(agentsResult).toContain("# Agent Instructions");

      // Both should include the actual context
      expect(codexResult).toContain("## Architecture");
      expect(agentsResult).toContain("## Architecture");
    });
  });

  describe("Aider Generator", () => {
    test("should generate .aider.conf.yml with correct format", () => {
      const result = aiderGenerator.generate(sampleContext);

      expect(result).toContain("# Aider Configuration");
      expect(result).toContain("Auto-generated from nax/context.md");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Architecture");
      expect(result).toContain("Microservices with Docker");
    });

    test("should have correct output filename", () => {
      expect(aiderGenerator.outputFile).toBe(".aider.conf.yml");
    });

    test("should have correct generator name", () => {
      expect(aiderGenerator.name).toBe("aider");
    });

    test("should include metadata section when provided", () => {
      const result = aiderGenerator.generate(contextWithMetadata);

      expect(result).toContain("## Project Metadata");
      expect(result).toContain("@myapp/core");
      expect(result).toContain("TypeScript");
      expect(result).toContain("express");
    });

    test("should preserve context content correctly", () => {
      const result = aiderGenerator.generate(sampleContext);

      expect(result).toContain("## Testing Requirements");
      expect(result).toContain("## Development Workflow");
      expect(result).toContain("Feature branches");
      expect(result).toContain("Conventional commits");
    });

    test("should handle empty context", () => {
      const emptyContext: ContextContent = { markdown: "" };
      const result = aiderGenerator.generate(emptyContext);

      // Should still have header and basic structure
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("# Aider Configuration");
      expect(result).toContain("DO NOT EDIT MANUALLY");
    });
  });

  describe("All New Generators", () => {
    test("should have new agents codex, opencode, gemini, aider registered", () => {
      const newAgentGenerators = [codexGenerator, opencodeGenerator, geminiGenerator, aiderGenerator];

      for (const generator of newAgentGenerators) {
        expect(generator.name).toBeDefined();
        expect(generator.outputFile).toBeDefined();
        expect(generator.generate).toBeDefined();
      }
    });

    test("should support all required new agents", () => {
      const generatorMap = {
        codex: codexGenerator,
        opencode: opencodeGenerator,
        gemini: geminiGenerator,
        aider: aiderGenerator,
      };

      expect(Object.keys(generatorMap)).toContain("codex");
      expect(Object.keys(generatorMap)).toContain("opencode");
      expect(Object.keys(generatorMap)).toContain("gemini");
      expect(Object.keys(generatorMap)).toContain("aider");
    });

    test("should generate content for all new agents", () => {
      const generators = [codexGenerator, opencodeGenerator, geminiGenerator, aiderGenerator];

      for (const generator of generators) {
        const result = generator.generate(sampleContext);
        expect(result.length).toBeGreaterThan(0);
        expect(result).toContain("DO NOT EDIT MANUALLY");
        // Aider uses different format
        if (generator.name === "aider") {
          expect(result).toContain("Auto-generated from nax/context.md");
        } else {
          expect(result).toContain("auto-generated from `nax/context.md`");
        }
      }
    });
  });
});
