/**
 * The PR body's findings table, "Set aside" and "Stops" sections (finish A spec 7).
 *
 * Placement rule: the table is the single place a ledger finding appears, `accepted` ones included
 * (state `accepted`, ref `advisor approval`). The separate "Accepted by the advisor" list is only
 * used for results without a ledger (pre-v3), so nothing is listed twice.
 */

import type { LedgerEntry, LedgerState } from "../ledger";
import { stopReason } from "../resolve";
import type { Finding, HandoffRecord } from "../types";
import type { FinishPrContext } from "./context";
import { type BodyLimits, DEFAULT_LIMITS, escapeInline, escapeTableCell } from "./escape";

const SHORT_SHA_LEN = 7;
const SEVERITY_ORDER: Record<Finding["severity"], number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
const UNKNOWN_RANK = 99;

/** `items` cut to `max`, with a closing line naming how many were left out. */
export function capRows(items: string[], max: number = DEFAULT_LIMITS.rows): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `- _${items.length - max} more - see result.json_`];
}

const STATE_ORDER: Record<LedgerState, number> = {
  open: 0,
  rejected: 1,
  "set-aside": 2,
  unresolved: 3,
  "fixed-unreviewed": 4,
  accepted: 5,
  "fixed-reviewed": 6,
  waived: 7,
  superseded: 8,
};
const RESOLVED: ReadonlySet<LedgerState> = new Set(["fixed-reviewed", "waived", "superseded"]);
const TABLE_HEAD = "| Severity | Finding | File | State | Ref |\n|---|---|---|---|---|";

function refCell(e: LedgerEntry, cellMax: number): string {
  if (!e.ref) return "";
  const isSha = e.state === "fixed-unreviewed" || e.state === "fixed-reviewed";
  if (!isSha) return escapeTableCell(e.ref, cellMax);
  const short = escapeTableCell(e.ref.slice(0, SHORT_SHA_LEN));
  return /^[0-9a-f]+$/i.test(short) ? `\`${short}\`` : short;
}

function ledgerRow(e: LedgerEntry, cellMax: number): string {
  const loc = e.finding.file ? `${e.finding.file}${e.finding.line !== undefined ? `:${e.finding.line}` : ""}` : "";
  const cell = (text: string): string => escapeTableCell(text, cellMax);
  return `| ${cell(e.finding.severity)} | ${cell(e.finding.title)} | ${cell(loc)} | ${cell(e.state)} | ${refCell(e, cellMax)} |`;
}

function sortLedger(entries: LedgerEntry[]): LedgerEntry[] {
  return [...entries].sort(
    (a, b) =>
      (STATE_ORDER[a.state] ?? UNKNOWN_RANK) - (STATE_ORDER[b.state] ?? UNKNOWN_RANK) ||
      (SEVERITY_ORDER[a.finding.severity] ?? UNKNOWN_RANK) - (SEVERITY_ORDER[b.finding.severity] ?? UNKNOWN_RANK),
  );
}

/** Table rows, capped; the overflow note is a plain line after the last row. */
function rows(entries: LedgerEntry[], limits: BodyLimits): string {
  const shown = entries.slice(0, limits.rows).map((e) => ledgerRow(e, limits.cell));
  return entries.length > limits.rows
    ? [...shown, "", `_${entries.length - limits.rows} more - see result.json_`].join("\n")
    : shown.join("\n");
}

/** One table of the live entries, then the resolved ones folded away. Null on an empty ledger. */
export function buildFindingsTable(ledger: LedgerEntry[], limits: BodyLimits): string | null {
  if (ledger.length === 0) return null;
  const live = sortLedger(ledger.filter((e) => !RESOLVED.has(e.state)));
  const done = sortLedger(ledger.filter((e) => RESOLVED.has(e.state)));
  const table = live.length > 0 ? `${TABLE_HEAD}\n${rows(live, limits)}` : "";
  const folded =
    done.length > 0
      ? `<details><summary>${done.length} resolved</summary>\n\n${TABLE_HEAD}\n${rows(done, limits)}\n\n</details>`
      : "";
  return [table, folded].filter(Boolean).join("\n\n");
}

/** At render time (finalize) a handoff that was not committed was not re-applied, whatever its flags say. */
function handoffState(h: HandoffRecord): string {
  if (h.consumed) return "re-applied and committed";
  return h.limit === "error" ? "crashed, not re-applied" : "set aside, not re-applied";
}

function handoffTrouble(h: HandoffRecord, cellMax: number): string[] {
  const names = (paths: string[]): string => escapeInline(paths.join(", "), cellMax * 5);
  return [
    ...(h.restored ? [] : ["worktree restore failed"]),
    ...(h.untrackedFailed.length > 0 ? [`your files that could not be put back: ${names(h.untrackedFailed)}`] : []),
    ...(h.untrackedMovedAside.length > 0
      ? [`untracked files over the snapshot cap moved into the handoff: ${names(h.untrackedMovedAside)}`]
      : []),
  ];
}

function renderHandoff(h: HandoffRecord, cellMax: number): string {
  const dir = escapeInline(h.dir, cellMax);
  const where = h.patchSaved ? `\`${dir}/changes.patch\`` : "_patch not saved, work lost_";
  const trouble = handoffTrouble(h, cellMax);
  const head = `- handoff-${h.n} (${h.phase}, ${h.limit}, ${h.findingIds.length} finding(s)): ${where} — ${handoffState(h)}`;
  return trouble.length > 0 ? `${head}; ${trouble.join("; ")}` : head;
}

export const block = (heading: string, items: string[], maxRows: number = DEFAULT_LIMITS.rows): string[] =>
  items.length > 0 ? [`### ${heading}\n${capRows(items, maxRows).join("\n")}`] : [];

export type Unresolved = NonNullable<FinishPrContext["unresolved"]>;

/** What was set aside and where the finish stopped short. */
export function buildStopSections(u: Unresolved, limits: BodyLimits): string[] {
  return [
    ...block(
      "Set aside",
      u.handoffs.map((h) => renderHandoff(h, limits.cell)),
      limits.rows,
    ),
    ...block(
      "Stops",
      u.stops.map((s) => `- ${escapeInline(stopReason([s]) ?? "stopped", limits.cell)}`),
      limits.rows,
    ),
  ];
}
