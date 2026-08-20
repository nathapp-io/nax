/**
 * Semantic finding category taxonomy — SSOT for both the reviewer prompt enum
 * and the read-path normalizer.
 *
 * The July 2026 harness audit found every semantic blocking finding carrying an
 * empty `category` (269 × none), which left ~53% of review rounds invisible to
 * recurrence-demotion fingerprinting, curator aggregation, and review-audit
 * telemetry — all of which key on category.
 *
 * The vocabulary is deliberately NOT adversarial's. Semantic review judges
 * whether production code fulfils each acceptance criterion; test coverage and
 * conventions are explicitly out of its scope (see `SEMANTIC_ROLE`). These six
 * axes mirror, one-for-one, the conditions the semantic prompt already tells the
 * reviewer to flag. Keeping the two vocabularies disjoint also means a semantic
 * finding can never trip the `test-gap` carve-out in recurrence-demotion.
 */

/** Closed semantic taxonomy, in prompt order. */
export const SEMANTIC_CATEGORIES = [
  /** An AC has no implementation at all. */
  "unimplemented",
  /** An AC is implemented for some inputs/paths but not all it specifies. */
  "partial",
  /** The implementation does something the AC says it must not, or the opposite of it. */
  "contradiction",
  /** Stubs, noops, or unreachable branches that will never execute. */
  "dead-path",
  /** New code that exists but is not wired into callers or exports. */
  "unwired",
  /** Genuinely AC-related, but none of the above. */
  "other",
] as const;

export type SemanticCategory = (typeof SEMANTIC_CATEGORIES)[number];

const SEMANTIC_CATEGORY_SET: ReadonlySet<string> = new Set<string>(SEMANTIC_CATEGORIES);

function isSemanticCategory(value: string): value is SemanticCategory {
  return SEMANTIC_CATEGORY_SET.has(value);
}

/** The category union as rendered into the reviewer's output schema. */
export const SEMANTIC_CATEGORY_ENUM_LINE: string = SEMANTIC_CATEGORIES.map((c) => `"${c}"`).join(" | ");

/**
 * Normalize a reviewer-supplied category.
 *
 * - Missing / blank / non-string -> `""`. This is the pre-taxonomy shape, kept
 *   deliberately distinct from `"other"` so telemetry can tell "the model never
 *   emitted a category" from "the model chose none of the axes".
 * - Known category (case- and whitespace-insensitive) -> itself.
 * - Anything else -> `"other"`, so an invented category cannot fragment
 *   recurrence fingerprints or leak another reviewer's vocabulary.
 */
export function normalizeSemanticCategory(raw: unknown): SemanticCategory | "" {
  if (typeof raw !== "string") return "";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "") return "";
  return isSemanticCategory(normalized) ? normalized : "other";
}
