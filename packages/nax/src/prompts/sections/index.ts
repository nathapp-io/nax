/**
 * Prompt Sections
 *
 * Non-overridable section builders shared by the composed prompt builders.
 */

export { buildAgentScopeSection } from "./agent-scope";
export type { GuardrailLevel, GuardrailRole } from "./behavioral-guardrails";
export { buildBehavioralGuardrailsSection } from "./behavioral-guardrails";
export { buildConventionsSection } from "./conventions";
export { buildIsolationSection } from "./isolation";
export { buildModifiedFilesLines } from "./modified-files";
export { buildNaxArtifactsSection } from "./nax-artifacts";
export { buildOutOfScopeLines } from "./out-of-scope";
export type {
  AffordanceNativeRenderer,
  ApplyProtocolRegionsOpts,
  CommitSpec,
  RunCommandSpec,
  RunCommandTestSpec,
} from "./protocol-region";
export { applyProtocolRegions, PROTOCOL_REGION_MARKER_PREFIX, wrapAffordance } from "./protocol-region";
export { buildScratchpadSection } from "./scratchpad";
export { buildStorySection } from "./story";
