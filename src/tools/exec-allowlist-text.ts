/**
 * Renders a compiled Exec grant's raw patterns as prose, one sentence
 * fragment reused everywhere an agent needs to know whether "argv" can
 * actually serve a given request.
 *
 * #1937, first half: name the permitted argv forms instead of the bare "only
 * some commands and forms are permitted", which the model guessed against 32
 * times, denied every time, across three runs. `patterns` must be the ACTUAL
 * compiled Exec grant for this project/stage, never the built-in constant, so
 * an overridden grant is described honestly.
 *
 * run-2026-09-14T05-55-54-734Z, Shape B: the same text is also what makes a
 * RunCommand subcommand denial honest about "argv" rather than recommending
 * a branch the compiled grant will not actually honour (src/tools/policy.ts
 * `verbBranch`) -- extracted here so both call sites render the identical
 * grant the same way, instead of two texts that could drift apart.
 */
export function describeExecAllowlist(patterns: readonly string[]): string {
  if (patterns.includes("*")) return "any command is permitted";
  if (patterns.length === 0) return "no forms are currently granted";
  return `permitted forms: ${patterns.join(", ")}`;
}
