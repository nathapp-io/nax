import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "../../src/config/schema.js";
import type { PromptOptimizerInput } from "../../src/optimizer/types.js";
import { RuleBasedOptimizer } from "../../src/optimizer/rule-based.optimizer.js";

describe("RuleBasedOptimizer", () => {
	const mockConfig: NaxConfig = {
		modelTier: "fast",
		provider: "anthropic",
		apiKeys: {},
		optimizer: {
			enabled: true,
			strategy: "rule-based",
			strategies: {
				"rule-based": {
					stripWhitespace: true,
					compactCriteria: true,
					deduplicateContext: true,
					maxPromptTokens: 8000,
				},
			},
		},
	};

	test("should have name 'rule-based'", () => {
		const optimizer = new RuleBasedOptimizer();
		expect(optimizer.name).toBe("rule-based");
	});

	describe("stripWhitespace rule", () => {
		test("should collapse multiple blank lines to single blank line", async () => {
			const optimizer = new RuleBasedOptimizer();
			const input: PromptOptimizerInput = {
				prompt: "Line 1\n\n\n\nLine 2\n\n\n\n\nLine 3",
				stories: [],
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			expect(result.prompt).toBe("Line 1\n\nLine 2\n\nLine 3");
			expect(result.appliedRules).toContain("stripWhitespace");
		});

		test("should trim trailing whitespace from lines", async () => {
			const optimizer = new RuleBasedOptimizer();
			const input: PromptOptimizerInput = {
				prompt: "Line 1   \nLine 2\t\t\nLine 3    ",
				stories: [],
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			expect(result.prompt).toBe("Line 1\nLine 2\nLine 3");
			expect(result.appliedRules).toContain("stripWhitespace");
		});

		test("should not apply if disabled in config", async () => {
			const optimizer = new RuleBasedOptimizer();
			const configWithoutStrip = {
				...mockConfig,
				optimizer: {
					enabled: true,
					strategy: "rule-based" as const,
					strategies: {
						"rule-based": {
							stripWhitespace: false,
							compactCriteria: false,
							deduplicateContext: false,
							maxPromptTokens: 8000,
						},
					},
				},
			};
			const input: PromptOptimizerInput = {
				prompt: "Line 1\n\n\n\nLine 2",
				stories: [],
				config: configWithoutStrip,
			};

			const result = await optimizer.optimize(input);

			expect(result.prompt).toBe("Line 1\n\n\n\nLine 2");
			expect(result.appliedRules).not.toContain("stripWhitespace");
		});
	});

	describe("compactCriteria rule", () => {
		test("should convert verbose acceptance criteria to terse bullets", async () => {
			const optimizer = new RuleBasedOptimizer();
			const input: PromptOptimizerInput = {
				prompt: `## Acceptance Criteria

- The user should be able to click the button and see a modal
- When the form is submitted, it should validate all fields
- The system must display an error message if validation fails`,
				stories: [],
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			// Should remove verbose wording like "should be able to", "When", "The system must"
			expect(result.prompt).toContain("## Acceptance Criteria");
			expect(result.appliedRules).toContain("compactCriteria");
			// Verify some compaction occurred
			expect(result.prompt.length).toBeLessThan(input.prompt.length);
		});

		test("should not apply if disabled in config", async () => {
			const optimizer = new RuleBasedOptimizer();
			const configWithoutCompact = {
				...mockConfig,
				optimizer: {
					enabled: true,
					strategy: "rule-based" as const,
					strategies: {
						"rule-based": {
							stripWhitespace: false,
							compactCriteria: false,
							deduplicateContext: false,
							maxPromptTokens: 8000,
						},
					},
				},
			};
			const input: PromptOptimizerInput = {
				prompt: "The user should be able to click the button",
				stories: [],
				config: configWithoutCompact,
			};

			const result = await optimizer.optimize(input);

			expect(result.appliedRules).not.toContain("compactCriteria");
		});
	});

	describe("deduplicateContext rule", () => {
		test("should remove context that duplicates constitution", async () => {
			const optimizer = new RuleBasedOptimizer();
			const input: PromptOptimizerInput = {
				prompt: `# Constitution
Always use TypeScript

# Context
Use TypeScript for all code

# Task
Implement feature X`,
				stories: [],
				contextMarkdown: "Use TypeScript for all code",
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			expect(result.appliedRules).toContain("deduplicateContext");
			// Context section should be reduced or removed
			expect(result.prompt.length).toBeLessThan(input.prompt.length);
		});

		test("should not apply if contextMarkdown is not provided", async () => {
			const optimizer = new RuleBasedOptimizer();
			const input: PromptOptimizerInput = {
				prompt: "Test prompt",
				stories: [],
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			expect(result.appliedRules).not.toContain("deduplicateContext");
		});

		test("should not apply if disabled in config", async () => {
			const optimizer = new RuleBasedOptimizer();
			const configWithoutDedup = {
				...mockConfig,
				optimizer: {
					enabled: true,
					strategy: "rule-based" as const,
					strategies: {
						"rule-based": {
							stripWhitespace: false,
							compactCriteria: false,
							deduplicateContext: false,
							maxPromptTokens: 8000,
						},
					},
				},
			};
			const input: PromptOptimizerInput = {
				prompt: "Duplicate content here",
				stories: [],
				contextMarkdown: "Duplicate content",
				config: configWithoutDedup,
			};

			const result = await optimizer.optimize(input);

			expect(result.appliedRules).not.toContain("deduplicateContext");
		});
	});

	describe("maxPromptTokens rule", () => {
		test("should trim context if prompt exceeds threshold", async () => {
			const optimizer = new RuleBasedOptimizer();
			// Create a very long prompt that exceeds 8000 tokens (~32000 chars)
			const longPrompt = `# Task
Implement feature X

# Context
${"Lorem ipsum dolor sit amet. ".repeat(5000)}

# Acceptance Criteria
- AC 1
- AC 2`;
			const input: PromptOptimizerInput = {
				prompt: longPrompt,
				stories: [],
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			expect(result.appliedRules).toContain("maxPromptTokens");
			expect(result.optimizedTokens).toBeLessThanOrEqual(8000);
			// Should preserve task and AC sections
			expect(result.prompt).toContain("# Task");
			expect(result.prompt).toContain("# Acceptance Criteria");
		});

		test("should not apply if prompt is under threshold", async () => {
			const optimizer = new RuleBasedOptimizer();
			const input: PromptOptimizerInput = {
				prompt: "Short prompt that is well under 8000 tokens",
				stories: [],
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			expect(result.appliedRules).not.toContain("maxPromptTokens");
		});

		test("should use custom threshold from config", async () => {
			const optimizer = new RuleBasedOptimizer();
			const configWithLowThreshold = {
				...mockConfig,
				optimizer: {
					enabled: true,
					strategy: "rule-based" as const,
					strategies: {
						"rule-based": {
							stripWhitespace: false,
							compactCriteria: false,
							deduplicateContext: false,
							maxPromptTokens: 10, // Very low threshold
						},
					},
				},
			};
			const input: PromptOptimizerInput = {
				prompt: "This prompt will definitely exceed 10 tokens",
				stories: [],
				config: configWithLowThreshold,
			};

			const result = await optimizer.optimize(input);

			expect(result.appliedRules).toContain("maxPromptTokens");
			expect(result.optimizedTokens).toBeLessThanOrEqual(10);
		});
	});

	describe("savings calculation", () => {
		test("should calculate savings correctly", async () => {
			const optimizer = new RuleBasedOptimizer();
			const input: PromptOptimizerInput = {
				prompt: "Line 1\n\n\n\nLine 2   \n\n\n\nLine 3   ",
				stories: [],
				config: mockConfig,
			};

			const result = await optimizer.optimize(input);

			expect(result.originalTokens).toBeGreaterThan(
				result.optimizedTokens,
			);
			expect(result.savings).toBeGreaterThan(0);
			expect(result.savings).toBeLessThanOrEqual(1);
		});

		test("should return 0 savings if no optimization applied", async () => {
			const optimizer = new RuleBasedOptimizer();
			const configWithNoRules = {
				...mockConfig,
				optimizer: {
					enabled: true,
					strategy: "rule-based" as const,
					strategies: {
						"rule-based": {
							stripWhitespace: false,
							compactCriteria: false,
							deduplicateContext: false,
							maxPromptTokens: 999999,
						},
					},
				},
			};
			const input: PromptOptimizerInput = {
				prompt: "Simple prompt",
				stories: [],
				config: configWithNoRules,
			};

			const result = await optimizer.optimize(input);

			expect(result.savings).toBe(0);
			expect(result.originalTokens).toBe(result.optimizedTokens);
		});
	});

	describe("default config", () => {
		test("should use default rules when config is missing", async () => {
			const optimizer = new RuleBasedOptimizer();
			const minimalConfig: NaxConfig = {
				modelTier: "fast",
				provider: "anthropic",
				apiKeys: {},
			};
			const input: PromptOptimizerInput = {
				prompt: "Line 1\n\n\n\nLine 2   ",
				stories: [],
				config: minimalConfig,
			};

			const result = await optimizer.optimize(input);

			// Should apply default rules (all enabled)
			expect(result.appliedRules).toContain("stripWhitespace");
		});
	});

	test("should handle empty prompt", async () => {
		const optimizer = new RuleBasedOptimizer();
		const input: PromptOptimizerInput = {
			prompt: "",
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.prompt).toBe("");
		expect(result.savings).toBe(0);
	});
});
