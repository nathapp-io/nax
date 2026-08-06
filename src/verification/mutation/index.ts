/**
 * Mutation generation core — public surface.
 */

export * from "./types";
export { generateMutants } from "./mutator";
export { getOperatorsForLanguage } from "./operators";
export { applyMutant, revertMutant } from "./apply";
export type { RevertResult } from "./apply";
export {
  clearInFlight,
  journalDir,
  journalPathFor,
  mayHaveJournal,
  recordInFlight,
  restoreInFlight,
} from "./journal";
export type { JournalRestoreResult, MutationJournalEntry } from "./journal";
export { classifyMutant } from "./classify";
export { selectEvenlySpaced } from "./select";
