import { describe, expect, test } from "bun:test";
import type { NaxConfig } from "../../src/config/schema.js";
import type {
	PromptOptimizerInput,
	PromptOptimizerResult,
} from "../../src/optimizer/types.js";

// NoopOptimizer implementation is imported here
// We're writing tests FIRST, so this will fail until we implement it
import { NoopOptimizer } from "../../src/optimizer/noop.optimizer.js";

describe("NoopOptimizer", () => {
	const mockConfig: NaxConfig = {
		modelTier: "fast",
		provider: "anthropic",
		apiKeys: {},
		optimizer: {
			enabled: false,
			strategy: "noop",
		},
	};

	test("should have name 'noop'", () => {
		const optimizer = new NoopOptimizer();
		expect(optimizer.name).toBe("noop");
	});

	test("should return prompt unchanged", async () => {
		const optimizer = new NoopOptimizer();
		const input: PromptOptimizerInput = {
			prompt: "This is a test prompt with some content.",
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.prompt).toBe(input.prompt);
	});

	test("should return zero savings", async () => {
		const optimizer = new NoopOptimizer();
		const input: PromptOptimizerInput = {
			prompt: "Any prompt content here.",
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.savings).toBe(0);
	});

	test("should return equal original and optimized token counts", async () => {
		const optimizer = new NoopOptimizer();
		const input: PromptOptimizerInput = {
			prompt: "A prompt with several words to estimate tokens.",
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.originalTokens).toBe(result.optimizedTokens);
		expect(result.originalTokens).toBeGreaterThan(0);
	});

	test("should return empty applied rules", async () => {
		const optimizer = new NoopOptimizer();
		const input: PromptOptimizerInput = {
			prompt: "Test prompt",
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.appliedRules).toEqual([]);
	});

	test("should handle empty prompt", async () => {
		const optimizer = new NoopOptimizer();
		const input: PromptOptimizerInput = {
			prompt: "",
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.prompt).toBe("");
		expect(result.originalTokens).toBe(0);
		expect(result.optimizedTokens).toBe(0);
		expect(result.savings).toBe(0);
	});

	test("should handle very long prompt", async () => {
		const optimizer = new NoopOptimizer();
		const longPrompt = "a".repeat(10000);
		const input: PromptOptimizerInput = {
			prompt: longPrompt,
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.prompt).toBe(longPrompt);
		expect(result.originalTokens).toBe(result.optimizedTokens);
	});

	test("should preserve multiline prompts", async () => {
		const optimizer = new NoopOptimizer();
		const multilinePrompt = `Line 1
Line 2

Line 4 with blank line above`;
		const input: PromptOptimizerInput = {
			prompt: multilinePrompt,
			stories: [],
			config: mockConfig,
		};

		const result = await optimizer.optimize(input);

		expect(result.prompt).toBe(multilinePrompt);
	});
});
