/**
 * Prompt Core Sections
 *
 * Section builders shared across multiple prompt builders.
 * Builders import from here — consumers import from src/prompts (public barrel).
 */

export { priorFailuresSection } from "./prior-failures";
export type { FailureRecord } from "./prior-failures";

export { findingsSection } from "./findings";
export type { ReviewFinding } from "./findings";
