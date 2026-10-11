/**
 * The PR body's "What changed" prose: the degradation chain from the branch
 * reviewer's summary to the spec summary to nothing, and the spec reader.
 *
 * Standalone and import-free so both the PR context and the (legacy)
 * narrative op can use it without a cycle.
 */

/** Longest narrative rendered into a PR body, in characters, including the ellipsis. */
export const NARRATIVE_MAX_CHARS = 4000;

const TRUNCATION_SUFFIX = "…";

/** Headings a spec uses for its lead paragraph, in priority order. */
const SUMMARY_HEADINGS = ["summary", "overview"] as const;

function truncate(text: string): string {
  if (text.length <= NARRATIVE_MAX_CHARS) return text;
  return text.slice(0, NARRATIVE_MAX_CHARS - TRUNCATION_SUFFIX.length) + TRUNCATION_SUFFIX;
}

/**
 * Pick the narrative text, best source first.
 *
 * The spec summary is the fallback rather than the primary source because a
 * spec describes intent: when an implementation deviates and the deviation is
 * accepted, a spec-derived narrative confidently describes code that does not
 * exist.
 *
 * `undefined` means "render no section at all" — never an empty heading.
 */
export function resolveNarrative(agentText: string | undefined, specSummary: string | null): string | undefined {
  const fromAgent = agentText?.trim();
  if (fromAgent) return truncate(fromAgent);
  const fromSpec = specSummary?.trim();
  if (fromSpec) return truncate(fromSpec);
  return undefined;
}

function sectionBody(lines: string[], heading: string): string | null {
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const body = (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * First `## Summary` or `## Overview` block in the spec, or `null`.
 *
 * Both headings are accepted because both occur in this repository's real
 * specs — five of six use `## Summary`, the older `plugin-001` uses
 * `## Overview`. Fail-open on every read error: a missing or unreadable spec
 * costs the section, never the PR.
 *
 * `readText` is an injected reader, kept as an explicit parameter rather than
 * a direct `Bun.file` call — it is this function's test seam. The real caller
 * (plan 4) supplies `(path) => Bun.file(path).text().catch(() => null)`.
 */
export async function readSpecSummary(
  specPath: string | undefined,
  readText: (path: string) => Promise<string | null>,
): Promise<string | null> {
  if (!specPath) return null;
  let text: string | null;
  try {
    text = await readText(specPath);
  } catch {
    return null;
  }
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  for (const heading of SUMMARY_HEADINGS) {
    const body = sectionBody(lines, heading);
    if (body !== null) return body;
  }
  return null;
}
