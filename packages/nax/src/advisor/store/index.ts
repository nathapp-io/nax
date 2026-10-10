/**
 * Leaf surface of the advisor: the trusted ledger read and decision text forms.
 * A nested barrel so the context engine can read decisions without loading the
 * `@/advisor` barrel (which reaches `@/operations` and would close a cycle).
 */
export { type AdvisorSummary, describeTarget, isPromptSafe, summariseAdvisor } from "../format";
export { readTrustedDecisions } from "../ledger";
export type { AdviceDecision } from "../types";
