/**
 * Constitution system
 *
 * Provides project-level governance by injecting a constitution.md file
 * into every agent session prompt. The constitution defines coding standards,
 * architectural rules, testing requirements, and forbidden patterns.
 */

export type { ConstitutionConfig, ConstitutionResult } from "./types";
export { loadConstitution, estimateTokens, truncateToTokens } from "./loader";
