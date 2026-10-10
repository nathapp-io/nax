/**
 * Dedupe key for a finish judgment finding (spec §4.2, §4.8 caller 1):
 * `phase|title|first file path`. Rewording the problem keeps the key, so a
 * re-raised waived finding reuses the earlier decision without a new call.
 * Takes plain fields so the advisor never imports finish types.
 */
const PATH_PATTERN = /[\w./-]+\.\w+(?::\d+)?/;

function firstPath(text: string): string {
  const match = PATH_PATTERN.exec(text)?.[0] ?? "";
  return match.replace(/:\d+$/, "");
}

export function dedupeKeyFor(phase: string, finding: { title: string; problem: string }): string {
  return `${phase}|${finding.title}|${firstPath(finding.problem)}`;
}
