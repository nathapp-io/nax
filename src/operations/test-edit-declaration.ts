/**
 * Structured representation of a TEST_EDIT_REASON block emitted by the implementer
 * under one of the three escape valves in CONTRADICTION_ESCAPE_HATCH.
 *
 * The implementer emits this block in plain text; we parse it into a structured
 * record so the autofix cycle can route on it (see runAgentRectificationV2).
 *
 * Currently only `prd_contract` declarations are routed. `lint_only` and
 * `sibling_scope` declarations are parsed for telemetry but not routed.
 */
export interface TestEditDeclaration {
  reason: "prd_contract" | "lint_only" | "sibling_scope";
  /** Test file path, relative to packageDir. Always present (Exception 1, 2, 3 all require FILE/SIBLING_FILE). */
  file: string;
  /** Verbatim signature line from story description or acceptance criteria. Only set for prd_contract. */
  prdQuote?: string;
  /** Pre-edit line of the test, only set for prd_contract. */
  testBefore?: string;
  /** Post-edit line of the test, only set for prd_contract. */
  testAfter?: string;
  /** Lint rule / error summary, only set for lint_only / sibling_scope. */
  finding?: string;
  /** True when prdQuote was found verbatim (whitespace-normalised) in story.description + AC text. */
  prdQuoteValid?: boolean;
}
