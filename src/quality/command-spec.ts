/**
 * A declared quality command. A plain string is one shell command (the
 * historical shape). A list means "run every entry, report every failure" —
 * the form that exists because `a && b` short-circuits, hiding each failure
 * after the first from an agent that pays a full round trip per invocation
 * (nax#1990).
 */
export type QualityCommandSpec = string | string[];

/**
 * Flatten a spec to the list of commands to actually run. Blank entries are
 * dropped so a stray "" in a list cannot spawn an empty shell; a spec that is
 * entirely blank returns [], which callers treat as "not declared".
 */
export function normalizeCommandSpec(spec: QualityCommandSpec | undefined): string[] {
  if (spec === undefined) return [];
  const entries = typeof spec === "string" ? [spec] : spec;
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * True when any entry chains with `&&`. Used only to warn: a chain still runs
 * exactly as it always did, it just hides later failures.
 */
export function containsShellChain(spec: QualityCommandSpec | undefined): boolean {
  return normalizeCommandSpec(spec).some((entry) => entry.includes("&&"));
}

/**
 * Render a spec as the single string that prompt and context surfaces show a
 * reader. `" && "` is what a human recognises and would type, even though a
 * list does not actually short-circuit when it runs.
 */
export function renderCommandSpec(spec: QualityCommandSpec | undefined): string | undefined {
  const steps = normalizeCommandSpec(spec);
  return steps.length === 0 ? undefined : steps.join(" && ");
}
