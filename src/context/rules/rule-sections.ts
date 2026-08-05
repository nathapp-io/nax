/**
 * Canonical rule section splitter (Phase 5.x).
 *
 * Splits a CanonicalRule into independently budgetable H2 sections while
 * preserving the owning rule's inherited metadata (priority, paths, appliesTo,
 * stages) and producing deterministic, unique slugs for provider chunk
 * identifiers.
 *
 * Sections split at `## ` (H2) only. Content preceding the first H2 becomes an
 * ordinal-0 preamble section. H3 and deeper headings stay inside their parent
 * H2 section. A rule with no H2 yields exactly one section whose content
 * equals the rule content.
 *
 * Slugs are derived from the heading text via lowercase + non-alphanumeric
 * collapse to `-`, with sequential suffixes (`-2`, `-3`, ...) appended on
 * duplicate headings to keep slugs unique within a single rule.
 *
 * See: docs/specs/SPEC-context-engine-v2.md §Section-level rule chunking
 */

import { estimateTokens } from "@/optimizer";
import type { CanonicalRule } from "./rules-frontmatter";

export interface RuleSection {
  /** Identity of the owning rule (e.g. the file id set by the loader). */
  ruleId?: string;
  /** Relative path of the owning rule file within the canonical store. */
  rulePath?: string;
  /** Section body content, inclusive of its own heading line when present. */
  content: string;
  /** Token estimate of this section's own content. */
  tokens: number;
  /** Priority inherited from the owning rule. */
  priority?: number;
  /** Paths scope inherited from the owning rule. */
  paths?: string[];
  /** appliesTo scope inherited from the owning rule. */
  appliesTo?: string[];
  /** Stages inherited from the owning rule. */
  stages?: string[];
  /** Zero-based position of this section within the owning rule. */
  ordinal: number;
  /** Heading text for this section; `undefined` for the preamble section. */
  heading?: string;
  /** Stable, unique slug usable in provider chunk identifiers. */
  slug: string;
}

const H2_LINE_PATTERN = /^## /;

/**
 * Convert heading text into a stable kebab-case slug component.
 * Lowercases ASCII letters, collapses non-alphanumeric runs into a single
 * `-`, and trims leading/trailing `-`.
 */
function headingToSlugComponent(heading: string): string {
  const slug = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "section";
}

function buildHeadingTitle(line: string): string {
  return line.replace(/^##\s+/, "").trim();
}

function buildSection(args: {
  rule: CanonicalRule;
  content: string;
  ordinal: number;
  heading?: string;
  slug: string;
}): RuleSection {
  return {
    ruleId: args.rule.id,
    rulePath: args.rule.path,
    content: args.content,
    tokens: estimateTokens(args.content),
    priority: args.rule.priority,
    paths: args.rule.paths,
    appliesTo: args.rule.appliesTo,
    stages: args.rule.stages,
    ordinal: args.ordinal,
    heading: args.heading,
    slug: args.slug,
  };
}

/**
 * Split a CanonicalRule into a list of RuleSection entries.
 *
 * Boundaries occur only at H2 (`## `) lines. Everything before the first H2
 * becomes a single preamble section at ordinal 0 with `heading` undefined.
 * Each H2 starts a new section that includes the H2 line itself and runs up
 * to (but not including) the next H2 line. H3+ headings remain inside their
 * parent H2 section. A rule with no H2 yields exactly one section whose
 * content equals the rule content.
 */
export function splitRuleIntoSections(rule: CanonicalRule): RuleSection[] {
  const content = rule.content;
  const lines = content.split("\n");

  const h2Indices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (H2_LINE_PATTERN.test(line)) {
      h2Indices.push(i);
    }
  }

  // No H2 boundaries — preserve today's behaviour: one section whose content
  // equals the rule content verbatim.
  if (h2Indices.length === 0) {
    return [
      buildSection({
        rule,
        content,
        ordinal: 0,
        slug: headingToSlugComponent(rule.id ?? rule.fileName ?? "rule"),
      }),
    ];
  }

  const sections: RuleSection[] = [];
  const usedSlugs = new Set<string>();

  // Preamble section — only when there is content before the first H2.
  const firstH2Line = h2Indices[0] ?? 0;
  const hasPreambleContent = firstH2Line > 0;
  if (hasPreambleContent) {
    const preambleContent = lines.slice(0, firstH2Line).join("\n");
    sections.push(
      buildSection({
        rule,
        content: preambleContent,
        ordinal: sections.length,
        slug: "preamble",
      }),
    );
    usedSlugs.add("preamble");
  }

  // H2 sections — each runs from its H2 line up to (but not including) the
  // next H2 line, or to end-of-content for the final section.
  for (let i = 0; i < h2Indices.length; i++) {
    const startIdx = h2Indices[i] ?? 0;
    const endIdx = i + 1 < h2Indices.length ? (h2Indices[i + 1] ?? lines.length) : lines.length;
    const sectionContent = lines.slice(startIdx, endIdx).join("\n");
    const heading = buildHeadingTitle(lines[startIdx] ?? "");

    const baseComponent = headingToSlugComponent(heading);
    let slug = baseComponent;
    let n = 1;
    while (usedSlugs.has(slug)) {
      n += 1;
      slug = `${baseComponent}-${n}`;
    }
    usedSlugs.add(slug);

    sections.push(
      buildSection({
        rule,
        content: sectionContent,
        ordinal: sections.length,
        heading,
        slug,
      }),
    );
  }

  return sections;
}
