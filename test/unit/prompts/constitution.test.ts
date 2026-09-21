// RE-ARCH: keep
/**
 * Constitution system tests
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "@test/helpers";
import type { ConstitutionConfig } from "@/constitution";
import { estimateTokens, loadConstitution, truncateToTokens } from "@/constitution";
import { aiderGenerator } from "@/constitution/generators/aider";
import { claudeGenerator } from "@/constitution/generators/claude";
import { cursorGenerator } from "@/constitution/generators/cursor";
import { opencodeGenerator } from "@/constitution/generators/opencode";
import type { ConstitutionContent } from "@/constitution/generators/types";
import { windsurfGenerator } from "@/constitution/generators/windsurf";

let TEST_DIR: string;

beforeEach(() => {
  TEST_DIR = makeTempDir("nax-constitution-test-");
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

describe("estimateTokens", () => {
  test("estimates tokens using 1 token ≈ 4 chars", () => {
    expect(estimateTokens("abcd")).toBe(1); // 4 chars = 1 token
    expect(estimateTokens("abcdefgh")).toBe(2); // 8 chars = 2 tokens
    expect(estimateTokens("a".repeat(100))).toBe(25); // 100 chars = 25 tokens (rounded up)
  });

  test("handles empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("rounds up fractional tokens", () => {
    expect(estimateTokens("abc")).toBe(1); // 3 chars = 0.75 tokens → rounds up to 1
  });
});

describe("truncateToTokens", () => {
  test("returns full text if within token limit", () => {
    const text = "Hello world";
    const result = truncateToTokens(text, 100);
    expect(result).toBe(text);
  });

  test("truncates at word boundary", () => {
    const text = "The quick brown fox jumps over the lazy dog";
    const result = truncateToTokens(text, 5); // 5 tokens ≈ 15 chars
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result).not.toContain("fox"); // Should stop before "fox"
    // Result should be "The quick" which ends with a word character
    expect(result.trim()).toBe("The quick");
  });

  test("truncates at newline boundary", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4";
    const result = truncateToTokens(text, 3); // 3 tokens ≈ 9 chars
    expect(result).toContain("Line 1");
    expect(result).not.toContain("Line 3");
  });

  test("hard cuts if no word boundary found", () => {
    const text = "a".repeat(100);
    const result = truncateToTokens(text, 5); // 5 tokens ≈ 15 chars
    expect(result.length).toBe(15);
  });
});

describe("loadConstitution", () => {
  test("returns null if disabled", async () => {
    const config: ConstitutionConfig = {
      enabled: false,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).toBeNull();
  });

  test("returns null if file doesn't exist", async () => {
    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).toBeNull();
  });

  test("returns null if file is empty", async () => {
    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, "   \n\n  "); // Only whitespace

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).toBeNull();
  });

  test("loads constitution without truncation", async () => {
    const content = "# Project Constitution\n\nFollow these rules.";
    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.content).toBe(content);
    expect(result?.tokens).toBe(estimateTokens(content));
    expect(result?.truncated).toBe(false);
    expect(result?.originalTokens).toBeUndefined();
  });

  test("truncates constitution if exceeds maxTokens", async () => {
    const content = "A".repeat(300); // 300 chars = 75 tokens (1 token ≈ 4 chars)
    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 50, // Only allow 50 tokens
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.truncated).toBe(true);
    expect(result?.tokens).toBeLessThanOrEqual(50);
    expect(result?.originalTokens).toBe(75);
    expect(result?.content.length).toBeLessThan(content.length);
  });

  test("loads from custom path", async () => {
    const content = "# Custom Constitution";
    const customPath = join(TEST_DIR, "custom-rules.md");
    await Bun.write(customPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "custom-rules.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.content).toBe(content);
  });

  test("handles large constitution with meaningful content", async () => {
    const content = `# Project Constitution

## Coding Standards
- Use TypeScript strict mode
- Follow ESLint rules
- Write clear variable names

## Testing
- Write unit tests for all functions
- Aim for 80%+ coverage
- Use describe/test/expect pattern

## Architecture
- Keep functions small (<50 lines)
- Use dependency injection
- Follow SOLID principles

## Forbidden Patterns
- No any types
- No console.log
- No hardcoded secrets
`;

    const constitutionPath = join(TEST_DIR, "constitution.md");
    await Bun.write(constitutionPath, content);

    const config: ConstitutionConfig = {
      enabled: true,
      path: "constitution.md",
      maxTokens: 2000,
      skipGlobal: true,
    };

    const result = await loadConstitution(TEST_DIR, config);
    expect(result).not.toBeNull();
    expect(result?.content).toBe(content);
    expect(result?.truncated).toBe(false);
    expect(result?.tokens).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constitution Generators — agent-specific config files from constitution
// ─────────────────────────────────────────────────────────────────────────────

const sampleConstitution: ConstitutionContent = {
  markdown: `# Project Constitution

## Coding Standards
- Follow TypeScript best practices
- Use strict typing

## Testing Requirements
- 80% minimum coverage
- Write tests first (TDD)

## Architecture Rules
- Single responsibility principle
- Dependency injection
`,
  sections: {},
};

describe("Constitution Generators", () => {
  describe("Claude Generator", () => {
    test("should generate CLAUDE.md with correct format", () => {
      const result = claudeGenerator.generate(sampleConstitution);

      expect(result).toContain("# Project Constitution");
      expect(result).toContain("auto-generated from `.nax/constitution.md`");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Coding Standards");
      expect(result).toContain("Follow TypeScript best practices");
    });
  });

  describe("OpenCode Generator", () => {
    test("should generate AGENTS.md with correct format", () => {
      const result = opencodeGenerator.generate(sampleConstitution);

      expect(result).toContain("# Agent Instructions");
      expect(result).toContain("auto-generated from `.nax/constitution.md`");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Coding Standards");
    });
  });

  describe("Cursor Generator", () => {
    test("should generate .cursorrules with correct format", () => {
      const result = cursorGenerator.generate(sampleConstitution);

      expect(result).toContain("# Project Rules");
      expect(result).toContain("Auto-generated from .nax/constitution.md");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Coding Standards");
    });
  });

  describe("Windsurf Generator", () => {
    test("should generate .windsurfrules with correct format", () => {
      const result = windsurfGenerator.generate(sampleConstitution);

      expect(result).toContain("# Windsurf Project Rules");
      expect(result).toContain("Auto-generated from .nax/constitution.md");
      expect(result).toContain("DO NOT EDIT MANUALLY");
      expect(result).toContain("## Coding Standards");
    });
  });

  describe("Aider Generator", () => {
    test("should generate .aider.conf.yml with correct YAML format", () => {
      const result = aiderGenerator.generate(sampleConstitution);

      expect(result).toContain("# Aider Configuration");
      expect(result).toContain("# Auto-generated from .nax/constitution.md");
      expect(result).toContain("# DO NOT EDIT MANUALLY");
      expect(result).toContain("instructions: |");
      // Check YAML indentation
      expect(result).toContain("  # Project Constitution");
      expect(result).toContain("  ## Coding Standards");
    });
  });

  describe("Generator names and output filenames", () => {
    test.each([
      ["claude", claudeGenerator, "CLAUDE.md"],
      ["opencode", opencodeGenerator, "AGENTS.md"],
      ["cursor", cursorGenerator, ".cursorrules"],
      ["windsurf", windsurfGenerator, ".windsurfrules"],
      ["aider", aiderGenerator, ".aider.conf.yml"],
    ] as const)("should have correct generator name: %s", (name, generator) => {
      expect(generator.name).toBe(name);
    });

    test.each([
      ["claude", claudeGenerator, "CLAUDE.md"],
      ["opencode", opencodeGenerator, "AGENTS.md"],
      ["cursor", cursorGenerator, ".cursorrules"],
      ["windsurf", windsurfGenerator, ".windsurfrules"],
      ["aider", aiderGenerator, ".aider.conf.yml"],
    ] as const)("should have correct output filename: %s", (_name, generator, outputFile) => {
      expect(generator.outputFile).toBe(outputFile);
    });
  });

  describe("All Generators", () => {
    test("should preserve original constitution content", () => {
      const generators = [claudeGenerator, opencodeGenerator, cursorGenerator, windsurfGenerator, aiderGenerator];

      for (const generator of generators) {
        const result = generator.generate(sampleConstitution);
        expect(result).toContain("Follow TypeScript best practices");
        expect(result).toContain("80% minimum coverage");
        expect(result).toContain("Single responsibility principle");
      }
    });

    test("should handle empty constitution", () => {
      const emptyConstitution: ConstitutionContent = {
        markdown: "",
        sections: {},
      };

      const generators = [claudeGenerator, opencodeGenerator, cursorGenerator, windsurfGenerator, aiderGenerator];

      for (const generator of generators) {
        const result = generator.generate(emptyConstitution);
        // Should still have header
        expect(result.length).toBeGreaterThan(0);
      }
    });
  });
});
