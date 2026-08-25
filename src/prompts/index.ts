/**
 * src/prompts — public barrel
 *
 * All prompt-building code in nax lives under this directory.
 * Other subsystems import from here — never from internal paths
 * (src/prompts/core/*, src/prompts/builders/*).
 */

export type {
  AcceptanceRole,
  DiagnosisPromptParams,
  FixGeneratorParams,
  RefinementPromptOptions,
} from "./builders/acceptance-builder";
// Acceptance prompt builder — generator, diagnoser, and fix-executor prompt construction.
export { AcceptancePromptBuilder, MAX_FILE_LINES } from "./builders/acceptance-builder";
// fenceLangFor: no production call site yet — prepared for follow-up F3 (SSOT fence-lang across all prompt builders).
export { fenceLangFor, formatTestOutputForFix } from "./builders/acceptance-builder-helpers";
export type { AdversarialReviewPromptOptions, TestInventory } from "./builders/adversarial-review-builder";
// Adversarial review prompt builder — adversarial reviewer prompt construction.
export { AdversarialReviewPromptBuilder } from "./builders/adversarial-review-builder";
// Critic prompt builder — plan audit prompt construction for ac-testability and failure-mode coverage.
export { CriticPromptBuilder } from "./builders/critic-builder";
export type { PromptBuilderOptions, ReviewStoryContext, StageContext } from "./builders/debate-builder";
// Debate prompt builder — centralises all debate and review-dialogue prompt construction.
export { DebatePromptBuilder } from "./builders/debate-builder";
export type { DecomposePromptInput } from "./builders/decompose-builder";
// Decompose prompt builder — prompt assembly for nax plan / decompose operations.
export { buildDecomposePromptAsync, buildDecomposePromptSync } from "./builders/decompose-builder";
// Grounder prompt builder — facts manifest grounding prompt construction.
export { GrounderPromptBuilder } from "./builders/grounder-builder";
export type { OneShotRole } from "./builders/one-shot-builder";
// One-shot prompt builder — escape hatch for structurally trivial prompts.
// Used by router and decomposer.
export { OneShotPromptBuilder } from "./builders/one-shot-builder";
// Patch prompt builder — patch step prompt construction for verifier-pick selector.
export { PatchPromptBuilder } from "./builders/patch-builder";
export type { PackageSummary, PlanningPromptParts } from "./builders/plan-builder";
// Plan prompt builder — centralises planning prompt construction.
export { PlanPromptBuilder } from "./builders/plan-builder";
// Prior iterations prompt block — ADR-022 §8; replaces legacy carry-forward blocks.
export { buildPriorIterationsBlock } from "./builders/prior-iterations-builder";
export type { FailureRecord, RectifierTrigger, ReviewFinding } from "./builders/rectifier-builder";
// Rectifier prompt builder — cross-domain rectification for TDD, verify, and review triggers.
export { CONTRADICTION_ESCAPE_HATCH, RectifierPromptBuilder } from "./builders/rectifier-builder";
export { repoScopedRectification } from "./builders/rectifier-builder-helpers";
export type { SemanticReviewPromptOptions } from "./builders/review-builder";
// Review prompt builder — semantic review prompt construction.
export { ReviewPromptBuilder } from "./builders/review-builder";
// Setup prompt builder — LLM-driven nax init config generation.
export { SetupPromptBuilder } from "./builders/setup-builder";
export { buildSourceRootsSection } from "./builders/source-roots-builder";
// Primary export — use TddPromptBuilder for all TDD execution prompts
// Backwards-compatible alias — existing callsites continue to work without change.
// Migrate to TddPromptBuilder when touching adjacent code.
export { TddPromptBuilder, TddPromptBuilder as PromptBuilder } from "./builders/tdd-builder";
export type { TimeoutRetryInput } from "./builders/timeout-retry-builder";
// Timeout-retry prompt builder — informed retry prompt conditioned on whether the
// working tree changed during the timed-out attempt (US-003).
export { timeoutRetry } from "./builders/timeout-retry-builder";
export type { ComposeInput } from "./compose";
// Wave 1 composition utilities — slot-ordered assembly and serialisation.
export { composeSections, join } from "./compose";
export type { SchemaDescriptor } from "./core/sections/json-schema";
export type { RoutingCandidate } from "./core/sections/routing-candidates";
// Core types — re-exported for callsites that need them
export type { PromptOptions, PromptRole, PromptSection, SectionSlot } from "./core/types";
export { SLOT_ORDER } from "./core/types";
// Out-of-scope section — shared by the story sections and both reviewer prompts.
export { buildOutOfScopeLines, buildReviewOutOfScopeBlock } from "./sections";
