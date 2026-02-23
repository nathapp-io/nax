import type { NaxConfig } from "../config/schema.js";
import type { UserStory } from "../prd/types.js";

/**
 * Interface for prompt optimizers.
 *
 * Optimizers transform assembled prompts to reduce token usage while
 * preserving semantic meaning and all technical requirements.
 */
export interface IPromptOptimizer {
	/** Unique optimizer name */
	name: string;

	/**
	 * Optimize a prompt before it is sent to the coding agent.
	 *
	 * Implementations MUST preserve all technical requirements,
	 * acceptance criteria semantics, and code references.
	 */
	optimize(input: PromptOptimizerInput): Promise<PromptOptimizerResult>;
}

export interface PromptOptimizerInput {
	/** Assembled prompt from promptStage */
	prompt: string;
	/** Stories being executed (for context) */
	stories: UserStory[];
	/** Raw context markdown (pre-assembly, for dedup detection) */
	contextMarkdown?: string;
	/** Nax configuration */
	config: NaxConfig;
}

export interface PromptOptimizerResult {
	/** Optimized prompt */
	prompt: string;
	/** Estimated token count before optimization */
	originalTokens: number;
	/** Estimated token count after optimization */
	optimizedTokens: number;
	/** Savings percentage (0-1) */
	savings: number;
	/** List of applied optimization rules/passes */
	appliedRules: string[];
}

/**
 * Estimate token count using simple heuristic.
 * ~4 chars per token for English text (rough estimate).
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
