/**
 * PromptBuilder Types
 *
 * Shared types for the unified prompt building system.
 */

/** Role determining which default template body to use */
export type PromptRole = "test-writer" | "implementer" | "verifier" | "single-session" | "tdd-simple" | "batch";

/** A single section of a composed prompt */
export interface PromptSection {
  /** Unique section identifier */
  id: string;
  /** Section content */
  content: string;
  /** Whether this section can be removed by user override */
  overridable: boolean;
}

/** Options passed to PromptBuilder.for() */
export type PromptOptions = Record<string, unknown>;
