/**
 * Prompt Core Sections
 *
 * Section builders shared across multiple prompt builders.
 * Builders import from here — consumers import from src/prompts (public barrel).
 */

export type { ReviewFinding } from "./findings";
export { findingsSection } from "./findings";
export { instructionsSection } from "./instructions";
export type { SchemaDescriptor } from "./json-schema";

export { jsonSchemaSection } from "./json-schema";
export type { FailureRecord } from "./prior-failures";
export { priorFailuresSection } from "./prior-failures";
export type { RoutingCandidate } from "./routing-candidates";
export { routingCandidatesSection } from "./routing-candidates";
