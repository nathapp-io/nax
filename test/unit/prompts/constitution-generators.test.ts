// RE-ARCH: keep
/**
 * Constitution Generators Tests
 *
 * Tests for generating agent-specific config files from constitution.
 */

import { describe, expect, test } from "bun:test";
import { aiderGenerator } from "../../../src/constitution/generators/aider";
import { claudeGenerator } from "../../../src/constitution/generators/claude";
import { cursorGenerator } from "../../../src/constitution/generators/cursor";
import { opencodeGenerator } from "../../../src/constitution/generators/opencode";
import type { ConstitutionContent } from "../../../src/constitution/generators/types";
import { windsurfGenerator } from "../../../src/constitution/generators/windsurf";

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
