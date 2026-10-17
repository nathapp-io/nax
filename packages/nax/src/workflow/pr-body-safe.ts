/**
 * Safe rendering of agent-sourced text in the workflow PR body (#2552).
 *
 * Gate output, assumptions, rulings and rationales come from agents and the user's worktree. Before
 * they reach a PR body they are (1) run through the shared secret redaction, so a leaked key in a
 * failing-gate excerpt is not published, and (2) stripped of GitHub's auto-linking triggers: an
 * `#123` after "fixes" would close an issue on merge and an `@name` would notify a user. Only the
 * `## Closes` section, built from the spec's own `Closes:` line, may carry live references.
 *
 * Scope: this lives in the workflow body path on purpose. `escapeInline` is shared with
 * `nax finish`'s findings sections, whose bodies are a different surface and are left as they are.
 */
import { redactSecrets } from "@/logger";
// The leaf, not the `@/finish` barrel: the barrel loads `src/finish/context.ts`, which imports
// `@/cli`, and that would close a runtime import cycle onto this module (US-003).
import { escapeInline, escapeTableCell } from "../finish/pr/escape";

const ZERO_WIDTH_SPACE = "​";

/**
 * Break `#123`, `@user` and `/issues/12` / `/pull/12` URLs so GitHub neither links, closes nor notifies.
 * Every `#<digit>` is broken, `owner/repo#45` included (GitHub links it across repos). Every `@` is broken
 * except right after a word character (`node@20`, `a@b`), the one case GitHub never mentions; `@org/team`
 * notifies a team, so a following `/` is no exemption. File paths render through `safeCode` instead.
 */
export function neutralise(text: string): string {
  return text
    .replace(/#(?=\d)/g, `#${ZERO_WIDTH_SPACE}`)
    .replace(/(?<!\w)@(?=[A-Za-z0-9_])/g, `@${ZERO_WIDTH_SPACE}`)
    .replace(/\/(issues|pull)\/(?=\d)/gi, `/$1/${ZERO_WIDTH_SPACE}`);
}

/** Redacted and neutralised multi-line markdown (the advisor section). */
export function safeBlock(text: string): string {
  return neutralise(redactSecrets(text));
}

/** Redacted, neutralised, one-line inline text, capped after escaping. */
export function safeInline(text: string, max?: number): string {
  return escapeInline(safeBlock(text), max);
}

/** Redacted, one-line text for an inline code span (a file path): GitHub neither links nor mentions there. */
export function safeCode(text: string, max?: number): string {
  return escapeInline(redactSecrets(text), max);
}

/** Redacted, neutralised, escaped table-cell text. */
export function safeCell(text: string, max?: number): string {
  return escapeTableCell(safeBlock(text), max);
}

/** Redacted only: inside a code fence GitHub neither links nor mentions, so the text stays verbatim. */
export function redactedExcerpt(text: string): string {
  return redactSecrets(text);
}
