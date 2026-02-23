import type {
	IPromptOptimizer,
	PromptOptimizerInput,
	PromptOptimizerResult,
} from "./types.js";
import { estimateTokens } from "./types.js";

interface RuleBasedConfig {
	stripWhitespace?: boolean;
	compactCriteria?: boolean;
	deduplicateContext?: boolean;
	maxPromptTokens?: number;
}

const DEFAULT_CONFIG: RuleBasedConfig = {
	stripWhitespace: true,
	compactCriteria: true,
	deduplicateContext: true,
	maxPromptTokens: 8000,
};

/**
 * Rule-based optimizer that applies deterministic transformations
 * to reduce token usage without external dependencies.
 */
export class RuleBasedOptimizer implements IPromptOptimizer {
	public readonly name = "rule-based";

	async optimize(input: PromptOptimizerInput): Promise<PromptOptimizerResult> {
		const originalTokens = estimateTokens(input.prompt);
		const appliedRules: string[] = [];

		let optimized = input.prompt;

		// Get config with defaults
		const config = {
			...DEFAULT_CONFIG,
			...input.config.optimizer?.strategies?.["rule-based"],
		};

		// Rule 1: Strip whitespace
		if (config.stripWhitespace) {
			const before = optimized;
			optimized = this.stripWhitespace(optimized);
			if (optimized !== before) {
				appliedRules.push("stripWhitespace");
			}
		}

		// Rule 2: Compact acceptance criteria
		if (config.compactCriteria) {
			const before = optimized;
			optimized = this.compactCriteria(optimized);
			if (optimized !== before) {
				appliedRules.push("compactCriteria");
			}
		}

		// Rule 3: Deduplicate context
		if (config.deduplicateContext && input.contextMarkdown) {
			const before = optimized;
			optimized = this.deduplicateContext(
				optimized,
				input.contextMarkdown,
			);
			if (optimized !== before) {
				appliedRules.push("deduplicateContext");
			}
		}

		// Rule 4: Enforce max prompt tokens
		if (config.maxPromptTokens) {
			const currentTokens = estimateTokens(optimized);
			if (currentTokens > config.maxPromptTokens) {
				optimized = this.trimToMaxTokens(
					optimized,
					config.maxPromptTokens,
				);
				appliedRules.push("maxPromptTokens");
			}
		}

		const optimizedTokens = estimateTokens(optimized);
		const savings =
			originalTokens > 0
				? (originalTokens - optimizedTokens) / originalTokens
				: 0;

		return {
			prompt: optimized,
			originalTokens,
			optimizedTokens,
			savings,
			appliedRules,
		};
	}

	/**
	 * Collapse multiple blank lines to single blank line and trim trailing whitespace.
	 */
	private stripWhitespace(prompt: string): string {
		return (
			prompt
				// Trim trailing whitespace from each line
				.split("\n")
				.map((line) => line.trimEnd())
				.join("\n")
				// Collapse 3+ consecutive newlines to 2
				.replace(/\n{3,}/g, "\n\n")
		);
	}

	/**
	 * Convert verbose acceptance criteria to terse bullet format.
	 */
	private compactCriteria(prompt: string): string {
		return (
			prompt
				// Remove verbose prefixes
				.replace(/The user should be able to /gi, "")
				.replace(/The system must /gi, "")
				.replace(/The system should /gi, "")
				.replace(/When the /gi, "")
				.replace(/When a /gi, "")
				// Compact common verbose patterns
				.replace(
					/it should validate all fields/gi,
					"validate all fields",
				)
				.replace(/display an error message/gi, "show error")
				.replace(/error message/gi, "error")
		);
	}

	/**
	 * Remove context sections that duplicate constitution content.
	 */
	private deduplicateContext(
		prompt: string,
		contextMarkdown: string,
	): string {
		// Find context section
		const contextSectionMatch = prompt.match(
			/# Context\n([\s\S]*?)(?=\n#|$)/i,
		);
		if (!contextSectionMatch) {
			return prompt;
		}

		const contextSection = contextSectionMatch[1];
		const contextLines = contextSection.split("\n");

		// Remove lines that appear in constitution
		const dedupedLines = contextLines.filter((line) => {
			const trimmed = line.trim();
			if (!trimmed) return true; // Keep blank lines for now
			// Check if this line appears in the context markdown (which may duplicate constitution)
			return !contextMarkdown.includes(trimmed);
		});

		// If we removed content, replace the context section
		if (dedupedLines.length < contextLines.length) {
			const newContextSection = dedupedLines.join("\n");
			return prompt.replace(contextSectionMatch[0], `# Context\n${newContextSection}`);
		}

		return prompt;
	}

	/**
	 * Trim context aggressively if prompt exceeds max tokens.
	 * Preserve Task and Acceptance Criteria sections.
	 */
	private trimToMaxTokens(prompt: string, maxTokens: number): string {
		const currentTokens = estimateTokens(prompt);
		if (currentTokens <= maxTokens) {
			return prompt;
		}

		// Extract sections
		const sections = this.extractSections(prompt);
		const targetChars = maxTokens * 4; // Reverse of token estimation
		const trimmedMessage = "\n... (context trimmed)";

		// Preserve task and AC, trim context
		let result = "";
		let remainingChars = targetChars;

		// Add task section (always preserve)
		if (sections.task) {
			result += sections.task;
			remainingChars -= sections.task.length;
		}

		// Add AC section (always preserve)
		if (sections.acceptanceCriteria) {
			result += sections.acceptanceCriteria;
			remainingChars -= sections.acceptanceCriteria.length;
		}

		// Add as much context as fits
		if (sections.context && remainingChars > 0) {
			// Reserve space for the trimmed message if we're going to add it
			const reserveForMessage = sections.context.length > remainingChars
				? trimmedMessage.length
				: 0;
			const maxContextChars = Math.max(0, remainingChars - reserveForMessage);
			const trimmedContext = sections.context.substring(
				0,
				maxContextChars,
			);
			result += trimmedContext;
			if (trimmedContext.length < sections.context.length) {
				result += trimmedMessage;
			}
		}

		// Add other sections if there's room
		if (sections.other && remainingChars > sections.other.length) {
			result += sections.other;
		}

		return result;
	}

	/**
	 * Extract common prompt sections for targeted trimming.
	 */
	private extractSections(prompt: string): {
		task?: string;
		context?: string;
		acceptanceCriteria?: string;
		other?: string;
	} {
		const sections: {
			task?: string;
			context?: string;
			acceptanceCriteria?: string;
			other?: string;
		} = {};

		const taskMatch = prompt.match(/# Task\n([\s\S]*?)(?=\n#|$)/i);
		if (taskMatch) {
			sections.task = taskMatch[0];
		}

		const contextMatch = prompt.match(/# Context\n([\s\S]*?)(?=\n#|$)/i);
		if (contextMatch) {
			sections.context = contextMatch[0];
		}

		const acMatch = prompt.match(
			/# Acceptance Criteria\n([\s\S]*?)(?=\n#|$)/i,
		);
		if (acMatch) {
			sections.acceptanceCriteria = acMatch[0];
		}

		// Collect everything else
		let other = prompt;
		if (sections.task) {
			other = other.replace(sections.task, "");
		}
		if (sections.context) {
			other = other.replace(sections.context, "");
		}
		if (sections.acceptanceCriteria) {
			other = other.replace(sections.acceptanceCriteria, "");
		}
		if (other.trim()) {
			sections.other = other;
		}

		return sections;
	}
}
