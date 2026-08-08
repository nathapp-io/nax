/**
 * Prompt Sections
 *
 * Non-overridable section builders for the PromptBuilder.
 */

export { buildHermeticSection } from "./hermetic";
export { buildIsolationSection } from "./isolation";
export { buildRoleTaskSection } from "./role-task";
export { buildBatchStorySection, buildStoryReminderSection, buildStorySection } from "./story";
export { buildOutOfScopeLines, buildReviewOutOfScopeBlock } from "./out-of-scope";
export { buildModifiedFilesLines } from "./modified-files";
export { buildVerdictSection } from "./verdict";
export { buildConventionsSection } from "./conventions";
export { buildTddLanguageSection } from "./tdd-conventions";
export { buildAcceptanceSection } from "./acceptance";
export type { AcceptanceEntry } from "./acceptance";
export { buildSelfVerificationSection } from "./self-verification";
export { buildBehavioralGuardrailsSection } from "./behavioral-guardrails";
export { buildNaxArtifactsSection } from "./nax-artifacts";
export { buildTestQualitySection } from "./test-quality";
export type { GuardrailLevel, GuardrailRole } from "./behavioral-guardrails";
