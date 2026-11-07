/**
 * Out-of-Scope Section
 *
 * Renders `story.outOfScope` — the spec's feature-level exclusions, propagated
 * onto every story by `propagateOutOfScopeToStories` (src/prd/out-of-scope.ts).
 *
 * Builders (implementer / test-writer / verifier / rectifier) get an imperative
 * "do NOT implement" block. Renders nothing when the story declares no exclusions.
 */

/**
 * Imperative block for a story-implementing role. Returned as lines so callers
 * can spread it into an existing section array; `[]` when there is nothing to
 * render.
 */
export function buildOutOfScopeLines(items: readonly string[] | undefined): string[] {
  if (!items || items.length === 0) return [];
  return [
    "",
    "**Out of Scope — do NOT implement these:**",
    ...items.map((item) => `- ${item}`),
    "",
    "Treat the list above as a hard boundary. If satisfying an acceptance criterion appears to require",
    "one of these, implement only what the criterion states and note the tension in your final message —",
    "do not expand into the excluded work.",
  ];
}
