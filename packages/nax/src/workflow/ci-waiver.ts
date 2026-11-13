/**
 * The durable CI waiver record (spec ci-starved-checks US-005).
 *
 * A starved check never ran, so nothing in the run's own tests can clear it: the only honest way
 * to mark the PR ready is a human's waiver, and that waiver has to be readable afterwards. The
 * record mirrors the coverage record (`src/bot/coverage-record.ts`) — a heading carrying a declared
 * count, one code-span line per check — and adds a `Reason:` line. Its parts must agree: a body
 * whose heading count, check lines and reason line do not line up reads as no record at all, so a
 * truncated or hand-edited comment is never reported as a waiver nobody wrote.
 *
 * This module is the wire format only. Reading the PR's comments, posting the record and gating
 * readiness live in the callers (US-006/US-007/US-008).
 */
import { NaxError } from "@/errors";
import { ownComments, type PrComment, stripNaxBotMarkers, withNaxBotMarker } from "@/forge";
import { neutralise } from "./pr-body-safe";

export const CI_WAIVER_KEY = "w-ci-waiver";
/** Longest reason accepted; a longer one is a pasted log, not a reason. */
export const CI_WAIVER_REASON_MAX = 300;

export interface CiWaiver {
  readonly headSha: string;
  readonly checks: readonly string[];
  readonly reason: string;
}

const HEADING = /^CI waiver at ([0-9A-Fa-f]{40}): (\d+) check\(s\) never got a runner$/;
const CHECK_LINE = /^- `(.*)`$/;
const REASON_PREFIX = "Reason: ";
const UNNAMED_CHECK = "(unnamed check)";
/** A line break would end the record line early, and a marker comment would be read as the comment's own. */
const REASON_LINE_BREAK = /[\r\n]/;
const REASON_MARKER = "<!--";

/**
 * The trimmed reason a waiver is allowed to carry. Anything a reviewer could not read back as one
 * line of prose is refused here, before a caller posts a comment or readies the PR.
 */
export function parseWaiverReason(raw: string): string {
  const reason = raw.trim();
  if (reason === "") throw invalidReason("the reason is empty", { raw });
  if (REASON_LINE_BREAK.test(reason)) throw invalidReason("the reason spans more than one line", { raw });
  if (reason.includes(REASON_MARKER)) throw invalidReason("the reason holds a comment marker", { raw });
  if (reason.length > CI_WAIVER_REASON_MAX) {
    throw invalidReason(`the reason is longer than ${CI_WAIVER_REASON_MAX} characters`, { raw, length: reason.length });
  }
  return reason;
}

function invalidReason(why: string, context: { raw: string; length?: number }): NaxError {
  return new NaxError(`[workflow] Invalid CI waiver reason: ${why}`, "CI_WAIVER_REASON_INVALID", {
    stage: "workflow",
    ...context,
  });
}

function heading(headSha: string, count: number): string {
  return `CI waiver at ${headSha}: ${count} check(s) never got a runner`;
}

/**
 * One check line. The name sits in a code span so GitHub neither links nor mentions anything in it,
 * which is also why a backtick inside the name cannot be escaped within one: it is written as `'`
 * and does not round-trip. An empty name still has to occupy its line, or the count would disagree.
 */
function checkLine(name: string): string {
  const written = name === "" ? UNNAMED_CHECK : name.replaceAll("`", "'");
  return `- \`${written}\``;
}

/** The marked comment body: the heading, one line per check, then the neutralised reason. */
export function renderCiWaiver(waiver: CiWaiver): string {
  const lines = [
    heading(waiver.headSha, waiver.checks.length),
    ...waiver.checks.map(checkLine),
    `${REASON_PREFIX}${neutralise(waiver.reason)}`,
  ];
  return withNaxBotMarker(lines.join("\n"), CI_WAIVER_KEY);
}

/** The check lines under the heading; anything else ends the list. */
function checkLines(lines: readonly string[]): { checks: string[]; rest: readonly string[] } {
  const checks: string[] = [];
  let index = 0;
  for (; index < lines.length; index++) {
    const match = CHECK_LINE.exec(lines[index] ?? "");
    if (match?.[1] === undefined) break;
    checks.push(match[1]);
  }
  return { checks, rest: lines.slice(index) };
}

/**
 * Read a raw or forge-marked body back. The heading, its declared count, the check lines under it
 * and a single trailing `Reason: ` line must all agree; the reason is returned exactly as written
 * (already neutralised by the renderer), never revalidated as raw input.
 */
export function parseCiWaiver(body: string): CiWaiver | null {
  const lines = stripNaxBotMarkers(body).split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start === -1) return null;
  const [, headSha, declared] = HEADING.exec(lines[start] ?? "") ?? [];
  if (headSha === undefined || declared === undefined) return null;
  const { checks, rest } = checkLines(lines.slice(start + 1));
  if (checks.length !== Number(declared)) return null;
  const [reasonLine, ...tail] = rest;
  if (!reasonLine?.startsWith(REASON_PREFIX)) return null;
  if (tail.some((line) => line.trim() !== "")) return null;
  return { headSha, checks, reason: reasonLine.slice(REASON_PREFIX.length) };
}

/**
 * The newest own waiver that parses. Forge order is the order (`ownComments` keeps it), as the item
 * index reads its own newest comment: a newer waiver that does not parse — truncated, edited, or
 * half-written — is skipped rather than reported as the current one. Another account's waiver is
 * not ours to report.
 */
export function latestCiWaiver(comments: readonly PrComment[], login: string): CiWaiver | null {
  const waivers = ownComments(comments, login).filter(({ key }) => key === CI_WAIVER_KEY);
  for (const { comment } of waivers.toReversed()) {
    const waiver = parseCiWaiver(comment.body);
    if (waiver) return waiver;
  }
  return null;
}
