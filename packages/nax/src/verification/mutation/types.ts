/**
 * Mutation generation core — types.
 *
 * Pure, deterministic, language-aware mutation primitives. The
 * mutation-spot-check pipeline uses these to inject deterministic bugs
 * into just-implemented code so the story's own tests can notice.
 */

export interface Mutant {
  /** Path of the file the mutant was generated for. */
  file: string;
  /** 1-indexed line number where the mutated token appears. */
  line: number;
  /** The original snippet the operator matched against. */
  before: string;
  /** The replacement snippet the operator produces. */
  after: string;
  /** Stable identifier for the mutation operator that produced this mutant. */
  operatorId: string;
}

export type MutantOutcome = "killed" | "survived" | "errored";

export interface SurvivingMutant extends Mutant {
  outcome: "survived";
}

export interface MutationOperator {
  /** Stable, language-scoped identifier (e.g. "ts:cmp-flip", "ts:bool-flip"). */
  id: string;
  /**
   * Apply the operator to a matched snippet and return the replacement.
   * Operators that produce more than one replacement may return an array.
   */
  apply(snippet: string): string | string[];
}
