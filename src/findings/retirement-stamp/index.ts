/**
 * Stamp shape and queries for the `meta.recurrence` field that US-001 writes
 * onto a `Finding` once `classifyRecurrence` has placed it in a terminal bucket
 * (`retired` / `demoted`). Two consumers read this shape today and MUST agree
 * on the exact guard:
 *
 *   - `src/prompts/builders/prior-iterations-builder.ts` uses it to move a
 *     finding out of the verdict-required list and into the acknowledgement
 *     section of the carry-forward prompt.
 *   - `src/execution/non-blocking-fix.ts` uses it to drop the finding from
 *     the actionability filter that seeds a paid fix pass.
 *
 * Centralising the predicate here means a future change to the stamp shape
 * (a renamed field, a different disposition value, a wrapper type) only has
 * to be made once. Each prior hand-rolled copy could drift and silently
 * de-synchronise the prompt from the fix lane.
 *
 * Pure / repo-scoped — no I/O, no config. Lives at its own nested barrel
 * (`@/findings/retirement-stamp`) so consumers that already sit inside the
 * `src/findings/index.ts → cycle.ts → operations/index.ts` cycle can import
 * the predicate without joining that cycle (see project-conventions nested
 * barrel rule).
 */

import type { Finding } from "../types";

/**
 * Disposition string the stamp may carry. Mirrors the union that
 * `classifyRecurrence` (`src/review/recurrence-demotion.ts`) writes; kept
 * inline here to avoid a value import through `@/review/recurrence-demotion`
 * from `src/prompts/...` (cycles), and to avoid re-importing the wider
 * `@/findings` barrel from `src/execution/...` (cycles).
 */
export type RecurrenceDisposition = "blocking" | "advisory" | "demoted" | "retired";

/**
 * The shape US-001 stamps onto `meta.recurrence`. Field names mirror
 * `stampRecurrence` in `src/review/recurrence-demotion.ts` exactly.
 */
export interface RecurrenceStamp {
  disposition: RecurrenceDisposition;
  rounds: number;
  wasBlocking?: boolean;
}

/**
 * Is this finding stamped with the terminal-advisory `retired` disposition?
 *
 * The guard tolerates the wide `Record<string, unknown>` shape that
 * `Finding.meta` is typed as. A drifted shape (e.g. a future version where
 * `recurrence` is a bare string rather than an object) returns false here
 * and the two consumers converge on a no-op, which is the safe direction —
 * the prompt will still render the finding, and the fix lane will still
 * dispatch; both are wrong only on the over-active side, never on the
 * missed-retirement side.
 */
export function isRecurrenceRetired(f: Finding): boolean {
  const rec = f.meta?.recurrence;
  return typeof rec === "object" && rec !== null && (rec as { disposition?: unknown }).disposition === "retired";
}

/**
 * Read the `disposition` of the stamp if one is present. Returns `undefined`
 * when the stamp is missing or malformed. Used by tests to assert the
 * shape the prompt / fix-lane branches key on.
 */
export function readRecurrenceDisposition(f: Finding): RecurrenceDisposition | undefined {
  const rec = f.meta?.recurrence;
  if (typeof rec !== "object" || rec === null) return undefined;
  const disp = (rec as { disposition?: unknown }).disposition;
  if (disp === "blocking" || disp === "advisory" || disp === "demoted" || disp === "retired") {
    return disp;
  }
  return undefined;
}

/**
 * Identity for "is THIS finding the same defect a retired stamp was written
 * for?" Mirrors `fingerprintFor` in `src/review/recurrence-demotion.ts`
 * intentionally:
 *
 *   - `meta.acIndex` (1-based, validated) when present — the AC-anchored
 *     identity US-001 uses for every blocking finding, and the path the
 *     retirement decision actually takes.
 *   - Otherwise, the prose fingerprint over (file, category, message).
 *     The line number is deliberately excluded because `fingerprintFor`
 *     excludes it too (the line shifts as the code under review changes;
 *     including it would split one defect across rounds and let the
 *     earlier-round copy escape the suppression).
 *   - Path normalization (`./` / `../` / backslashes) is mirrored because
 *     `fingerprintFor` normalises them — without that mirror, a reviewer
 *     citing the same file with different prefix depth would mint a
 *     different key and the cross-round suppression would miss.
 *
 * Why this lives here and not in `src/review/recurrence-demotion.ts`:
 * that file's `fingerprintFor` is parameterised by the LLM-finding
 * interface (`issue` not `message`, no `meta`), and importing the value
 * from `src/review/...` into `src/prompts/...` (or `src/execution/...`)
 * pulls the barrel into the existing import cycle through
 * `src/operations/...`. The translation is mechanical and short enough
 * to keep a fork-free second copy here, anchored by this docblock as
 * the SSOT for the key shape.
 */
export function retirementIdentity(f: Finding): string {
  const acIndex = typeof f.meta?.acIndex === "number" ? f.meta.acIndex : undefined;
  const file = normalizeFile(f.file);
  if (typeof acIndex === "number" && Number.isInteger(acIndex) && acIndex >= 1) {
    return `${file}|ac${acIndex}`;
  }
  // Prose fingerprint: category + leading-clause prefix. The prefix length
  // mirrors FP_ISSUE_PREFIX in recurrence-demotion.ts; if that constant
  // moves, this one must move with it.
  const prefix = normalizeMessagePrefix(f.message);
  return `${file}|${f.category ?? ""}|${prefix}`;
}

/** Mirror of `normalizeFingerprintPath` in recurrence-demotion.ts. */
function normalizeFile(file: string | undefined): string {
  return (file ?? "").replace(/\\/g, "/").replace(/^(?:\.{1,2}\/)+/, "");
}

/**
 * Mirror of `normalizeIssueText` in recurrence-demotion.ts, then sliced to
 * the fingerprint's prose-prefix length. A backtick / whitespace /
 * casefolding normaliser plus a leading-clause clamp — the leading-clause
 * pattern (48 chars in recurrence-demotion.ts) is what makes the key
 * robust against tail rephrasing by the reviewer.
 */
function normalizeMessagePrefix(text: string | undefined): string {
  const norm = (text ?? "").replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  return norm.slice(0, 48);
}
