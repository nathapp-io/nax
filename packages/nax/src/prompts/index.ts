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
export { type AdvisorBatchPromptInput, buildAdvisorBatchPrompt } from "./builders/advisor-batch-builder";
// Fix-review prompt builder — verdict-only review of a fix's own delta (ADR-033).
export { type AdvisorPromptInput, buildAdvisorPrompt } from "./builders/advisor-builder";
export type { SubagentInstructionsInput } from "./builders/agents-builder";
// Agents prompt builder — agent discovery index and nested-session instructions.
export {
  buildAgentsInstructions,
  buildSubagentInstructions,
  MAX_AGENTS_INDEX_ENTRIES,
} from "./builders/agents-builder";
export { buildBackgroundTaskNotice, buildBackgroundTasksInstructions } from "./builders/background-builder";
export { type CheckoutStateInput, PINNED_BASE_NOTE, renderCheckoutState } from "./builders/bot-checkout-state-builder";
export { type BotChecksExtractPromptInput, buildBotChecksExtractPrompt } from "./builders/bot-checks-extract-builder";
export { type BotPrFixPromptInput, buildBotPrFixPrompt } from "./builders/bot-pr-fix-builder";
export {
  type BotPrReviewPromptInput,
  type BotSettledRuling,
  buildBotPrReviewPrompt,
  buildBotTriageRetry,
  buildUntrustedRequestIssue,
  COULD_NOT_START_RULE,
  MAX_EARLIER_THREADS,
  MAX_SETTLED_RULINGS,
} from "./builders/bot-pr-review-builder";
export { buildBotRulingReadPrompt } from "./builders/bot-ruling-builder";
export {
  buildChatAcpInstructions,
  buildChatFeatureMessage,
  buildChatInstructions,
  type ChatAcpInstructionsInput,
  type ChatFeatureMessageInput,
  type ChatInstructionsInput,
} from "./builders/chat-builder";
export type { DecomposePromptInput } from "./builders/decompose-builder";
// Decompose prompt builder — prompt assembly for nax plan / decompose operations.
export { buildDecomposePromptSync } from "./builders/decompose-builder";
export type {
  FinishBranchReviewPromptInput,
  FinishSpecReviewPromptInput,
} from "./builders/finish-review-builder";
export {
  buildFinishBranchReviewPrompt,
  buildFinishFixPrompt,
  buildFinishHandoffPrompt,
  buildFinishReviewJsonRetry,
  buildFinishReviewJsonRetryCondensed,
  buildFinishSpecReviewPrompt,
} from "./builders/finish-review-builder";
export type { FixReviewPromptInput } from "./builders/fix-review-builder";
export { buildFixReviewPrompt } from "./builders/fix-review-builder";
export { buildForgeReadInstructions } from "./builders/forge-read-builder";
export type { NbfWorthCheckPromptInput } from "./builders/nbf-worth-check-builder";
export { buildNbfWorthCheckPrompt } from "./builders/nbf-worth-check-builder";
export type { OneShotRole } from "./builders/one-shot-builder";
// One-shot prompt builder — escape hatch for structurally trivial prompts.
// Used by router and decomposer.
export { OneShotPromptBuilder } from "./builders/one-shot-builder";
export type { PackageSummary, PlanningPromptParts } from "./builders/plan-builder";
// Plan prompt builder — centralises planning prompt construction.
export { PlanPromptBuilder } from "./builders/plan-builder";
// Prior iterations prompt block — ADR-022 §8; replaces legacy carry-forward blocks.
export { buildPriorIterationsBlock } from "./builders/prior-iterations-builder";
// US-007 (SPEC-lazy-rules-delivery) — the run's project-context override section,
// carried by the story brief and the branch review package.
export { buildProjectContextSection } from "./builders/project-context-builder";
export type { FailureRecord, RectifierTrigger, ReviewFinding } from "./builders/rectifier-builder";
// Rectifier prompt builder — cross-domain rectification for TDD, verify, and review triggers.
export { CONTRADICTION_ESCAPE_HATCH, RectifierPromptBuilder } from "./builders/rectifier-builder";
export { repoScopedRectification } from "./builders/rectifier-builder-helpers";
export type { SemanticReviewPromptOptions } from "./builders/review-builder";
// Review prompt builder — semantic review prompt construction.
export { ReviewPromptBuilder } from "./builders/review-builder";
export { reviewerCommandsSection } from "./builders/reviewer-commands-section";
export type { ChangedFileRuleGroup, RulesIndexEntry } from "./builders/rules-index-builder";
// US-003 (SPEC-lazy-rules-delivery) — the rules index section of a workflow brief.
// US-005 and US-006 add the delivered-rule and changed-file sections here.
// US-005 (SPEC-lazy-rules-delivery) — the delivered-rule text a native session
// is handed for a governed file. US-006 — the changed-file rules section a
// review package carries.
export {
  buildChangedFileRulesSection,
  buildRuleDeliveryText,
  buildRulesIndexSection,
  toRulesIndexEntry,
} from "./builders/rules-index-builder";
export { buildRunAskNotice } from "./builders/run-ask-builder";
// Setup prompt builder — LLM-driven nax init config generation.
export { SetupPromptBuilder } from "./builders/setup-builder";
export {
  buildCommandMessage,
  buildSkillInvocationMessage,
  buildSkillsInstructions,
  cleanIndexDescription,
  MAX_SKILLS_INDEX_ENTRIES,
} from "./builders/skills-builder";
export { buildSourceRootsSection } from "./builders/source-roots-builder";
// Primary export — use TddPromptBuilder for all TDD execution prompts
// Backwards-compatible alias — existing callsites continue to work without change.
// Migrate to TddPromptBuilder when touching adjacent code.
export { TddPromptBuilder, TddPromptBuilder as PromptBuilder } from "./builders/tdd-builder";
export type { TimeoutRetryInput } from "./builders/timeout-retry-builder";
// Timeout-retry prompt builder — informed retry prompt conditioned on whether the
// working tree changed during the timed-out attempt (US-003).
export { timeoutRetry } from "./builders/timeout-retry-builder";
// A5 workflow mode — story brief and implementer-session prompts (spec §6).
export type { BranchReviewPromptInput } from "./builders/workflow-branch-builder";
export {
  buildBranchPackageReadingNote,
  buildWorkflowBranchCoverageRetry,
  buildWorkflowBranchFixPrompt,
  buildWorkflowBranchReReviewPrompt,
  buildWorkflowBranchReviewPrompt,
} from "./builders/workflow-branch-builder";
// US-004 (chat-workflow-state) — the fixed "nax loop" section of a chat session.
export type { JobNoticeInput } from "./builders/workflow-builder";
export { buildJobNotice, buildJobsInstructions, buildWorkflowInstructions } from "./builders/workflow-builder";
// US-004 — the CI repair's own brief, and the two rules it must never break.
export {
  buildWorkflowCiRepairPrompt,
  CI_REPAIR_NO_SHORTCUTS_RULE,
  CI_REPAIR_STEP_REPRODUCTION_RULE,
} from "./builders/workflow-ci-repair-builder";
export type { WorkflowBriefInput, WorkflowPromptFinding } from "./builders/workflow-implementer-builder";
export {
  buildWorkflowAnswerPrompt,
  buildWorkflowBrief,
  buildWorkflowContinuePrompt,
  buildWorkflowFixPrompt,
  buildWorkflowImplementPrompt,
  buildWorkflowReportPrompt,
  buildWorkflowRestartPrompt,
  REPAIR_VERIFICATION_RULE,
  WORKFLOW_ARTIFACTS_RULE,
  WORKFLOW_REPLY_CONTRACT,
} from "./builders/workflow-implementer-builder";
// A5 workflow mode — the shared code-quality checklist both reviewer prompts embed (US-001).
export {
  WORKFLOW_BEYOND_DIFF_SECTION,
  WORKFLOW_DESIGN_DECISIONS_ITEM,
  WORKFLOW_ENUMERATION_INSTRUCTION,
  WORKFLOW_QUALITY_CHECKLIST,
} from "./builders/workflow-quality-checklist";
export { buildWorkflowReReviewPrompt } from "./builders/workflow-re-review-builder";
export type { WorkflowStoryGateStates } from "./builders/workflow-story-review-builder";
export {
  buildWorkflowReviewJsonRetry,
  buildWorkflowReviewJsonRetryCondensed,
  buildWorkflowStoryReviewPrompt,
} from "./builders/workflow-story-review-builder";
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

export { buildAcceptanceExecutionSection } from "./sections/acceptance";
