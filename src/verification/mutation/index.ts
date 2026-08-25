/**
 * Mutation generation core — public surface.
 */

export type { RevertResult } from "./apply";
export { applyMutant, revertMutant } from "./apply";
export { classifyMutant } from "./classify";
export type { JournalRestoreResult, MutationJournalEntry } from "./journal";
export {
  clearInFlight,
  journalDir,
  journalPathFor,
  mayHaveJournal,
  recordInFlight,
  restoreInFlight,
} from "./journal";
export { generateMutants } from "./mutator";
export { getOperatorsForLanguage } from "./operators";
export { selectEvenlySpaced } from "./select";
export * from "./types";
