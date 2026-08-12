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

// Out-of-scope section — shared by the story sections and both reviewer prompts.
export { buildOutOfScopeLines, buildReviewOutOfScopeBlock } from "./sections";

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
// fenceLangFor: no production call site yet — prepared for follow-up F3 (SSOT fence-lang across all prompt builders).
export { fenceLangFor, formatTestOutputForFix } from "./builders/acceptance-builder-helpers";

// Rectifier prompt builder — cross-domain rectification for TDD, verify, and review triggers.
export { RectifierPromptBuilder, CONTRADICTION_ESCAPE_HATCH } from "./builders/rectifier-builder";
export type { RectifierTrigger, FailureRecord, ReviewFinding } from "./builders/rectifier-builder";

// Timeout-retry prompt builder — informed retry prompt conditioned on whether the
// working tree changed during the timed-out attempt (US-003).
export { timeoutRetry } from "./builders/timeout-retry-builder";
export type { TimeoutRetryInput } from "./builders/timeout-retry-builder";

// One-shot prompt builder — escape hatch for structurally trivial prompts.
// Used by router and decomposer.
export { OneShotPromptBuilder } from "./builders/one-shot-builder";
export type { OneShotRole } from "./builders/one-shot-builder";
export type { RoutingCandidate } from "./core/sections/routing-candidates";
export type { SchemaDescriptor } from "./core/sections/json-schema";

// Plan prompt builder — centralises planning prompt construction.
export { PlanPromptBuilder } from "./builders/plan-builder";
export type { PlanningPromptParts, PackageSummary } from "./builders/plan-builder";

// Grounder prompt builder — facts manifest grounding prompt construction.
export { GrounderPromptBuilder } from "./builders/grounder-builder";
export { buildSourceRootsSection } from "./builders/source-roots-builder";

// Critic prompt builder — plan audit prompt construction for ac-testability and failure-mode coverage.
export { CriticPromptBuilder } from "./builders/critic-builder";

// Patch prompt builder — patch step prompt construction for verifier-pick selector.
export { PatchPromptBuilder } from "./builders/patch-builder";

// Core types — re-exported for callsites that need them
export type { PromptRole, PromptSection, PromptOptions, SectionSlot } from "./core/types";
export { SLOT_ORDER } from "./core/types";

// Prior iterations prompt block — ADR-022 §8; replaces legacy carry-forward blocks.
export { buildPriorIterationsBlock } from "./builders/prior-iterations-builder";

// Setup prompt builder — LLM-driven nax init config generation.
export { SetupPromptBuilder } from "./builders/setup-builder";

// Wave 1 composition utilities — slot-ordered assembly and serialisation.
export { composeSections, join } from "./compose";
export type { ComposeInput } from "./compose";

// Decompose prompt builder — prompt assembly for nax plan / decompose operations.
export { buildDecomposePromptSync, buildDecomposePromptAsync } from "./builders/decompose-builder";
export type { DecomposePromptInput } from "./builders/decompose-builder";
