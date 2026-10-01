/**
 * Out-of-Scope Section
 *
 * Renders `story.outOfScope` — the spec's feature-level exclusions, propagated
 * onto every story by `propagateOutOfScopeToStories` (src/prd/out-of-scope.ts).
 *
 * Two audiences, two shapes:
 * - **Builders** (implementer / test-writer / verifier / rectifier) get an
 *   imperative "do NOT implement" block. They act on it.
 * - **Reviewers** (semantic / adversarial) get a *numbered* list, because a
 *   scope-violation finding cites `scopeIndex` (1-based) into it. They also get
 *   an explicit reminder that these are not acceptance criteria — quoting one as
 *   an `acQuote` is exactly the confusion this separation prevents.
 *
 * Both render nothing when the story declares no exclusions.
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

/**
 * Numbered block for a reviewer, with the AC-confusion guard. Returns `""` when
 * the story declares no exclusions, so callers can interpolate it unconditionally.
 *
 * The numbering is load-bearing: `scopeIndex` on a finding is a 1-based index
 * into this list (see `validateScopeQuote` in src/review/ac-quote-validator.ts).
 */
export function buildReviewOutOfScopeBlock(
  items: readonly string[] | undefined,
  opts: { citable?: boolean } = {},
): string {
  if (!items || items.length === 0) return "";

  const header = [
    "",
    "**Out of Scope (feature-level — NOT acceptance criteria):**",
    ...items.map((item, i) => `${i + 1}. ${item}`),
    "",
    "These state what the feature deliberately does not do. They are not acceptance criteria:",
    "never cite one as `acQuote`/`acIndex`, and never treat the absence of this work as a defect.",
  ];

  // Only the adversarial path can carry a scope finding: it owns the
  // `scopeQuote`/`scopeIndex` schema fields and the `filterByScopeQuote`
  // validator. Telling the semantic reviewer to emit one would produce a finding
  // its own schema cannot express and its AC-grounding filter then drops —
  // failing the story with an empty findings list (the #1347 shape).
  if (!opts.citable) {
    return [...header, "Report nothing against this list; it is context so you do not demand excluded work."].join(
      "\n",
    );
  }

  return [
    ...header,
    'To report work that crossed one of these boundaries, set `category` to `"out-of-scope"`, quote the',
    "entry verbatim in `scopeQuote`, and set `scopeIndex` to its number above. Emit these as",
    '`severity: "warning"` — never `"error"`. Set `scopeQuote`/`scopeIndex` ONLY on an `"out-of-scope"`',
    "finding; on any other finding they are ignored.",
  ].join("\n");
}
