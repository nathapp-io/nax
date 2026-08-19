/**
 * The PR title — sentinel, sanitiser, and the fallback chain.
 *
 * `buildFinishTitle` used to return `feat: <feature>` unconditionally, so every
 * finish-opened PR was titled with its feature slug: `feat: schema-drift-gate`
 * describes the run, not the change. The narrative node has already read the
 * whole diff by the time the body is amended, so a real conventional-commit
 * subject costs one extra sentinel in a prompt that was being sent anyway.
 *
 * No deterministic source can replace it. The spec's H1 is the slug in prose
 * (`# SPEC: Schema drift gate`), the PRD carries no feature-level title, and
 * concatenating story titles reads worse than the slug it replaces — which is
 * why this is the one part of the PR metadata that is model-derived, and why
 * everything below assumes the model may return junk.
 */

/** Sentinel wrapping the title. See `narrative-op.ts` for why a delimiter is required at all. */
export const TITLE_OPEN_TAG = "<title>";
export const TITLE_CLOSE_TAG = "</title>";

/**
 * Longest title rendered onto a PR.
 *
 * 72 is the conventional-commit subject norm, and GitHub truncates around this
 * width in list views.
 */
export const TITLE_MAX_CHARS = 72;

/**
 * Conventional-commit prefix, split into the type-with-scope and the subject.
 *
 * Types mirror the list in `.claude/rules/project-conventions.md`, plus
 * `revert`. Captured rather than merely tested so the two halves can be
 * rejoined with exactly one space — `feat:no space` and `feat:` both reach
 * here, and testing alone let the latter become `feat: feat:`.
 *
 * A title arriving without any prefix is prefixed rather than rejected: the
 * prose is usually right even when the model forgets the ceremony.
 */
const CONVENTIONAL_PREFIX_RE =
  /^((?:feat|fix|refactor|perf|docs|test|chore|ci|build|style|revert)(?:\([^)]*\))?!?):\s*([\s\S]*)$/i;

const DEFAULT_TYPE = "feat";

/** Wrapping quotes/backticks the model adds when it treats the title as a quoted string. */
const WRAPPING_CHARS = new Set(['"', "'", "`", "*", "_"]);

function stripWrapping(text: string): string {
  let out = text;
  // Loop: models nest these ("`fix: thing`" arrives quoted *and* fenced).
  while (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first !== undefined && first === last && WRAPPING_CHARS.has(first)) {
      out = out.slice(1, -1).trim();
      continue;
    }
    break;
  }
  return out;
}

/**
 * Cut to `TITLE_MAX_CHARS` on a word boundary where one is available.
 *
 * A mid-word cut reads as corruption rather than brevity; falling back to a
 * hard slice only matters for a title with no spaces at all.
 */
function clamp(text: string): string {
  if (text.length <= TITLE_MAX_CHARS) return text;
  const cut = text.slice(0, TITLE_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  // Guard against a long type prefix eating the whole budget: only honour a
  // word boundary that leaves a meaningful subject behind.
  const MIN_KEEP = 20;
  return (lastSpace >= MIN_KEEP ? cut.slice(0, lastSpace) : cut).trimEnd();
}

/**
 * Normalise a model-supplied title, or `undefined` if nothing usable survives.
 *
 * Never throws — this feeds `parse` on an op's reply, and the finish's PR is
 * already open by the time it runs.
 */
export function sanitizeTitle(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") return undefined;

  // First non-empty line: a title is single-line by definition, and a model
  // that adds a rationale below it must not push that onto the PR.
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (firstLine === undefined) return undefined;

  // Collapse internal runs of whitespace before measuring, so the length cap
  // reflects what a reader sees.
  let title = stripWrapping(firstLine.trim()).replace(/\s+/g, " ");
  // Markdown heading marks, for a model that answers the "write a title" ask
  // with a heading.
  title = title.replace(/^#+\s*/, "").trim();
  title = stripWrapping(title);
  // Trailing sentence punctuation — conventional-commit subjects carry none.
  title = title.replace(/[.\s]+$/, "");
  if (!title) return undefined;

  const match = CONVENTIONAL_PREFIX_RE.exec(title);
  const type = match?.[1] ?? DEFAULT_TYPE;
  const subject = (match?.[2] ?? title).trim();
  // A bare `feat:` carries no subject, and a type alone is not a title.
  if (!subject) return undefined;

  return clamp(`${type}: ${subject}`);
}

/**
 * Extract the title from the narrative node's reply.
 *
 * Last opening tag wins, mirroring `parseNarrative` — a model that narrates the
 * tag before emitting it must not beat the real one.
 */
export function parseTitle(text: string): string | undefined {
  if (typeof text !== "string") return undefined;
  const open = text.lastIndexOf(TITLE_OPEN_TAG);
  if (open === -1) return undefined;
  const from = open + TITLE_OPEN_TAG.length;
  const close = text.indexOf(TITLE_CLOSE_TAG, from);
  return sanitizeTitle(close === -1 ? text.slice(from) : text.slice(from, close));
}

/**
 * The title to render, best source first.
 *
 * `feat: <feature>` remains the floor: it is what shipped before, it is what
 * the auto-PR plugin opens with, and it is always available.
 */
export function resolveTitle(agentTitle: string | undefined, feature: string): string {
  return sanitizeTitle(agentTitle) ?? `${DEFAULT_TYPE}: ${feature}`;
}
