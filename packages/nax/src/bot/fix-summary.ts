/**
 * The one public comment a bot fix publishes: its identity marker, its outcome line and the facts a
 * reader needs about the round it just ran.
 *
 * This module owns the text only. It moved out of `fix-report.ts` so that module — the step bodies that
 * post, edit and ready the PR — keeps room under the 600-line source limit for the push ledger and the
 * convergence facts, and so the wording a reader sees lives in one place with `fix-outcome-text.ts`.
 *
 * Everything here is public text: local absolute paths are shown relative to the checkout (nax#2681)
 * and untrusted text goes through `safeText` before it is joined into the body.
 */
import { homedir } from "node:os";
import { withNaxBotMarker } from "@/forge";
import { FIX_SUMMARY_KEY, readinessLines } from "./ci-waiver-ready";
import { outcomeText } from "./fix-outcome-text";
import type { BotFixState } from "./fix-steps";
import { safeText } from "./render";

const SHORT_SHA_LENGTH = 7;
const MAX_FAILURE_LENGTH = 500;

/** Truncation marker on a detail line the budget cut short. */
const ELLIPSIS = "…";

/**
 * The detail lines that fit in `available` characters, each costing its length plus its newline. B2: a
 * report can carry a long protected-file list, and the whole comment — not just the ledger block — must
 * stay under the forge's limit, or the write is refused and the push is not recorded at all. A line the
 * budget cuts short ends in an ellipsis, so a reader sees that more was reported than shown. A negative
 * budget drops the details entirely: what remains always fits.
 */
export function fitDetails(lines: readonly string[], available: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost <= available) {
      kept.push(line);
      used += cost;
      continue;
    }
    const room = available - used - 1 - ELLIPSIS.length;
    if (room > 0) kept.push(`${line.slice(0, room)}${ELLIPSIS}`);
    break;
  }
  return kept;
}

/** `prefix/x` -> `${bare}/x` and a bare `prefix` -> `bare`, only where `prefix` ends at a path boundary. */
function replacePathPrefix(text: string, prefix: string, bare: string): string {
  if (prefix.length <= 1) return text;
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Not followed by a name character: `/a/repo-old` and `/a/repo.bak` are other paths, `/a/repo.` is this one.
  return text.replace(new RegExp(`${escaped}(?![\\w-]|\\.[\\w-])(/?)`, "g"), (_m, slash: string) =>
    slash ? (bare === "." ? "" : `${bare}/`) : bare,
  );
}

function stripLocalPaths(text: string, repoRoot: string | undefined): string {
  return replacePathPrefix(replacePathPrefix(text, repoRoot ?? "", "."), homedir(), "~");
}

/** The knobs the body needs beyond its outcome and details. */
export interface FixSummaryOptions {
  /**
   * Lines that render before the outcome line. US-007: an advisor-ledger push is listed first and the
   * follow-up sentence after it, which is the one ordering the outcome line cannot express alone.
   */
  readonly lead?: readonly string[];
}

/** `repoRoot` keeps local absolute paths out of the public comment (nax#2681). */
export function renderFixSummary(
  state: BotFixState,
  details: readonly string[] = [],
  repoRoot?: string,
  options: FixSummaryOptions = {},
): string {
  const lines = [...(options.lead ?? []), outcomeText(state, repoRoot), ...details];
  if (state.reusedFix)
    lines.push(
      `Reused the saved fix ${safeText(state.reusedFix.slice(0, SHORT_SHA_LENGTH), SHORT_SHA_LENGTH)}; no new fix session.`,
    );
  if (state.repairMode !== undefined)
    lines.push(`Repair turn: ${state.repairMode}, round ${state.gateRepairRounds ?? 0}.`);
  if (state.repairSkippedForCost) lines.push("Repair turn skipped: cost limit reached.");
  if (state.fixFailure !== undefined)
    lines.push(`Fix session: ${safeText(stripLocalPaths(state.fixFailure, repoRoot), MAX_FAILURE_LENGTH)}`);
  // Why the PR is still a draft, or what released it. Untrusted text is neutralised in
  // `readinessLines`, which also rewrites exactly these lines when a waiver readies the PR (US-007).
  lines.push(...readinessLines(state));
  return withNaxBotMarker(lines.join("\n"), FIX_SUMMARY_KEY);
}
