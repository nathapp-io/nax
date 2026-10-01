/**
 * Constitution system
 *
 * Provides project-level governance by injecting a constitution.md file
 * into every agent session prompt. The constitution defines coding standards,
 * architectural rules, testing requirements, and forbidden patterns.
 */

export { estimateTokens } from "../optimizer/types";
export { loadConstitution, truncateToTokens } from "./loader";
export type { ConstitutionConfig, ConstitutionResult } from "./types";
