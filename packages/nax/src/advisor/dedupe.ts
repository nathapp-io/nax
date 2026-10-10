/**
 * Dedupe key for a finish judgment finding (spec §4.2, §4.8 caller 1):
 * `phase|title|<file path or problem hash>`. With a file path, rewording the
 * problem keeps the key, so a re-raised waived finding reuses the earlier
 * decision. Without one, a hash of the normalised problem stands in, so two
 * generic findings ("Missing error handling") never share a key. Takes plain
 * fields so the advisor never imports finish types.
 */
import { createHash } from "node:crypto";

/** A path needs a directory separator: "e.g." and "v1.2" are not paths. */
const PATH_PATTERN = /[\w.-]*\/[\w./-]*\.\w+/;
const HASH_CHARS = 12;

function firstPath(text: string): string | undefined {
  return PATH_PATTERN.exec(text)?.[0];
}

function problemHash(text: string): string {
  const normalised = text.toLowerCase().replace(/\s+/g, " ").trim();
  return `#${createHash("sha256").update(normalised).digest("hex").slice(0, HASH_CHARS)}`;
}

export function dedupeKeyFor(phase: string, finding: { title: string; problem: string }): string {
  return `${phase}|${finding.title}|${firstPath(finding.problem) ?? problemHash(finding.problem)}`;
}
