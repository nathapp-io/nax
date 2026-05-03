/**
 * src/prompts — public barrel
 *
 * All prompt-building code in nax lives under this directory.
 * Other subsystems import from here — never from internal paths
 * (src/prompts/core/*, src/prompts/builders/*).
 */

// Primary export — use TddPromptBuilder for all TDD execution prompts
export { TddPromptBuilder } from "./builders/tdd-builder";

// Backwards-compatible alias — existing callsites continue to work without change.
// Migrate to TddPromptBuilder when touching adjacent code.
export { TddPromptBuilder as PromptBuilder } from "./builders/tdd-builder";

// Debate prompt builder — centralises all debate and review-dialogue prompt construction.
export { DebatePromptBuilder } from "./builders/debate-builder";
export type { StageContext, PromptBuilderOptions, ReviewStoryContext } from "./builders/debate-builder";

// Review prompt builder — semantic review prompt construction.
export { ReviewPromptBuilder } from "./builders/review-builder";
export type { SemanticReviewPromptOptions } from "./builders/review-builder";

// Adversarial review prompt builder — adversarial reviewer prompt construction.
export { AdversarialReviewPromptBuilder } from "./builders/adversarial-review-builder";
export type { AdversarialReviewPromptOptions, TestInventory } from "./builders/adversarial-review-builder";

// Acceptance prompt builder — generator, diagnoser, and fix-executor prompt construction.
export { AcceptancePromptBuilder, MAX_FILE_LINES } from "./builders/acceptance-builder";
export type {
  AcceptanceRole,
  FixGeneratorParams,
  DiagnosisPromptParams,
  RefinementPromptOptions,
} from "./builders/acceptance-builder";

// Rectifier prompt builder — cross-domain rectification for TDD, verify, and review triggers.
export { RectifierPromptBuilder, CONTRADICTION_ESCAPE_HATCH } from "./builders/rectifier-builder";
export type { RectifierTrigger, FailureRecord, ReviewFinding } from "./builders/rectifier-builder";

// One-shot prompt builder — escape hatch for structurally trivial prompts.
// Used by router, decomposer, and auto-approver.
export { OneShotPromptBuilder } from "./builders/one-shot-builder";
export type { OneShotRole } from "./builders/one-shot-builder";
export type { RoutingCandidate } from "./core/sections/routing-candidates";
export type { SchemaDescriptor } from "./core/sections/json-schema";

// Plan prompt builder — centralises planning prompt construction.
export { PlanPromptBuilder } from "./builders/plan-builder";
export type { PlanningPromptParts, PackageSummary } from "./builders/plan-builder";

// Core types — re-exported for callsites that need them
export type { PromptRole, PromptSection, PromptOptions, SectionSlot } from "./core/types";
export { SLOT_ORDER } from "./core/types";

// Prior iterations prompt block — ADR-022 §8; replaces legacy carry-forward blocks.
export { buildPriorIterationsBlock } from "./builders/prior-iterations-builder";

// Wave 1 composition utilities — slot-ordered assembly and serialisation.
export { composeSections, join } from "./compose";
export type { ComposeInput } from "./compose";
