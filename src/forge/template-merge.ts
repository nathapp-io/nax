/**
 * Merge nax's generated PR/MR body into the repository's own PR template.
 *
 * ## Why this exists
 *
 * `gh pr create --body` / `glab mr create --description` suppress the repo's
 * template, so a generated body has to account for it. The first attempt
 * appended the template verbatim after the generated content, which shipped a
 * *blank form* below a filled one: placeholder comments, a dangling `Closes #`,
 * duplicated headings, and an unchecked "`bun test` passes" box sitting under a
 * Verification section that already said the gates were green (nax#1504).
 *
 * A PR template is an input form, not decoration. So the template is treated as
 * **shape** and nax's content as **fill**:
 *
 * - a template heading nax can fill  → keep the heading, replace its body
 * - a template heading nax cannot    → drop it (`merge`) or empty it (`strict`)
 * - nax content with no home         → append under nax's own heading
 *
 * The governing invariant is **never emit a field that was not filled**. That
 * is the same rule `buildFinishBody` already followed for its own sections
 * (nax#1477 forbids a bare heading with nothing under it); this module extends
 * it to template-derived text. `strict` mode is the one deliberate exception,
 * for repos whose CI asserts a set of headings exists.
 *
 * ## Why deterministic
 *
 * Placement is decided by a heading-alias table, not by a model. The facts in
 * the body — gate results, story counts, diffstat, review rounds — stay a pure
 * string join, which is what keeps a finish body greppable in PR history. A
 * repo whose headings the table does not know loses nothing: its sections are
 * dropped and nax's own headings are used instead, and `sectionMap` pins the
 * mapping explicitly when a team wants its headings honoured.
 *
 * Lives in `src/forge/` because both consumers are here: the auto-PR plugin's
 * body builder and `src/finish/pr/body.ts`. `flows/nax-finish/` keeps a
 * byte-identical copy because it cannot import `src/`; that copy and this
 * comment both go when plan 5 deletes the flow. Until then, edit neither
 * without editing the other — `test/unit/forge/template-merge.test.ts` has an
 * equivalence test that fails if they drift.
 */

/** One nax-authored section of the body. */
export interface BodySection {
  /**
   * Stable id matched against the alias table. Independent of `heading` so
   * renaming nax's own heading does not silently break template matching.
   */
  key: string;
  /**
   * nax's H2 text, used when the section is appended rather than merged.
   * Empty means headingless (the run footer) — such a section is rendered as
   * bare text and is never matched to a template heading, so a stray alias
   * cannot bury the footer under someone's `## Notes`.
   */
  heading: string;
  /** Markdown body without its heading line. Callers omit empty sections. */
  body: string;
}

/**
 * - `merge`  — template headings nax cannot fill are dropped. Default.
 * - `strict` — they are kept, empty, for repos with heading-checking CI.
 * - `ignore` — the template is not consulted at all.
 */
export type TemplateMode = "merge" | "strict" | "ignore";

export interface MergeOptions {
  mode?: TemplateMode;
  /**
   * Normalised template heading → `BodySection.key`, layered over
   * `DEFAULT_SECTION_ALIASES`. An empty value suppresses a default alias,
   * which is how a repo says "do not put anything under this heading".
   */
  sectionMap?: Record<string, string>;
}

/**
 * Normalised heading → section key.
 *
 * Deliberately partial. `why`, `notes`, `screenshots` and friends are absent
 * because nax has nothing truthful to put under them — an alias that mapped
 * them to some loosely-related section would reintroduce exactly the
 * unfilled-field problem this module exists to remove.
 */
export const DEFAULT_SECTION_ALIASES: Record<string, string> = {
  // → narrative
  what: "narrative",
  "what changed": "narrative",
  "whats changed": "narrative",
  summary: "narrative",
  description: "narrative",
  overview: "narrative",
  changes: "narrative",
  "what does this do": "narrative",
  "what does this mr do and why": "narrative",
  "what does this pr do": "narrative",
  // → stories
  how: "stories",
  implementation: "stories",
  "implementation details": "stories",
  "changes made": "stories",
  approach: "stories",
  design: "stories",
  // → verification
  testing: "verification",
  tests: "verification",
  "test plan": "verification",
  verification: "verification",
  qa: "verification",
  validation: "verification",
  "how to test": "verification",
  "how has this been tested": "verification",
  "how to set up and validate locally": "verification",
};

const HEADING_RE = /^##[ \t]+(.+?)[ \t]*$/;
const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
/** `Closes #`, `Fixes # (issue)` — an issue reference with no issue. */
const DANGLING_ISSUE_RE = /^[ \t]*(?:closes?|fixe?s?|resolves?)[ \t]*:?[ \t]*#[ \t]*(?:\([^)]*\))?[ \t]*$/i;
/** An unticked task-list item — an unfilled field wherever it appears. */
const UNCHECKED_BOX_RE = /^[ \t]*[-*+][ \t]+\[[ \t]\]/;

interface TemplateSection {
  heading: string;
  body: string;
}

interface ParsedTemplate {
  frontmatter: string;
  preamble: string;
  sections: TemplateSection[];
}

/** Lowercase, drop punctuation, collapse whitespace — so `## Testing:` matches `testing`. */
function normalizeHeading(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip placeholders from template-derived prose.
 *
 * Only ever applied to the preamble — the one template region that survives
 * into the body. Text under a matched heading is replaced wholesale and text
 * under an unmatched one is discarded, so a checklist or a stale `Closes #`
 * *inside a section* never reaches this function, which is why there is no
 * checkbox-versus-gate reconciliation anywhere in this module.
 *
 * The preamble is the exception, because a template may open with a
 * contributor checklist before its first heading. An unticked box there is an
 * unfilled field like any other, so it is dropped while the prose around it is
 * kept.
 */
function cleanTemplateText(text: string): string {
  return text
    .replace(HTML_COMMENT_RE, "")
    .split("\n")
    .filter((line) => !DANGLING_ISSUE_RE.test(line) && !UNCHECKED_BOX_RE.test(line))
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
}

function parseTemplate(rawText: string): ParsedTemplate {
  // Normalised up front so a CRLF template (anything authored on Windows, or
  // fetched through a forge web editor) cannot leak a stray carriage return
  // into a heading this module re-emits.
  const text = rawText.replace(/\r\n/g, "\n");
  const frontmatterMatch = FRONTMATTER_RE.exec(text);
  const frontmatter = frontmatterMatch ? frontmatterMatch[0].trimEnd() : "";
  const rest = frontmatterMatch ? text.slice(frontmatterMatch[0].length) : text;

  const preambleLines: string[] = [];
  const sections: TemplateSection[] = [];
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of rest.split("\n")) {
    const heading = HEADING_RE.exec(line);
    if (heading) {
      if (current) sections.push({ heading: current.heading, body: current.lines.join("\n") });
      current = { heading: heading[1], lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
    else preambleLines.push(line);
  }
  if (current) sections.push({ heading: current.heading, body: current.lines.join("\n") });

  return { frontmatter, preamble: preambleLines.join("\n"), sections };
}

function renderSection(heading: string, body: string): string {
  if (heading.length === 0) return body;
  return body.length === 0 ? `## ${heading}` : `## ${heading}\n\n${body}`;
}

/** Nax-only body: every section under its own heading, in the order given. */
function renderSections(sections: BodySection[]): string {
  return sections
    .filter((s) => s.body.trim().length > 0)
    .map((s) => renderSection(s.heading, s.body.trim()))
    .join("\n\n")
    .trim();
}

export function mergeTemplate(
  template: string | null | undefined,
  sections: BodySection[],
  opts: MergeOptions = {},
): string {
  const mode = opts.mode ?? "merge";
  if (mode === "ignore" || !template || template.trim().length === 0) return renderSections(sections);

  const parsed = parseTemplate(template);
  // No H2 anywhere: the template is prose, or nests everything under H1/H3.
  // There is no shape to merge into, and appending it unparsed is the defect
  // this module removes — so fall back to the body nax would have written.
  if (parsed.sections.length === 0) return renderSections(sections);

  // Override keys go through the same normalisation as the template headings
  // they are matched against, so a repo pins a heading by pasting it —
  // `"What does this MR do and why?"` — not by hand-normalising it first.
  const aliases = { ...DEFAULT_SECTION_ALIASES };
  for (const [heading, key] of Object.entries(opts.sectionMap ?? {})) aliases[normalizeHeading(heading)] = key;
  const fillable = sections.filter((s) => s.heading.length > 0 && s.body.trim().length > 0);
  const consumed = new Set<string>();
  const parts: string[] = [];

  if (parsed.frontmatter.length > 0) parts.push(parsed.frontmatter);
  const preamble = cleanTemplateText(parsed.preamble);
  if (preamble.length > 0) parts.push(preamble);

  for (const templateSection of parsed.sections) {
    const key = aliases[normalizeHeading(templateSection.heading)];
    const match = key ? fillable.find((s) => s.key === key && !consumed.has(s.key)) : undefined;
    if (match) {
      consumed.add(match.key);
      parts.push(renderSection(templateSection.heading, match.body.trim()));
    } else if (mode === "strict") {
      parts.push(renderSection(templateSection.heading, ""));
    }
  }

  for (const section of sections) {
    if (consumed.has(section.key) || section.body.trim().length === 0) continue;
    parts.push(renderSection(section.heading, section.body.trim()));
  }

  return parts.join("\n\n").trim();
}
