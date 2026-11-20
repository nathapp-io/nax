/**
 * The bot-owned record of the blocking findings a review could not anchor (B1).
 *
 * A review that narrows its range to the commits after the reviewed head cannot re-report a finding an
 * earlier review of that head raised inside the part it skips. A finding with an inline thread is carried
 * by the thread itself; one the reviewer gave no line for lives only in the earlier review's artifact,
 * which is on the machine that ran it. This comment is that record on the PR, so a review on another
 * worker — or after the artifact was cleaned up — still holds the finding.
 *
 * The record speaks for one head and only its own review writes it: its own-comment key (`w-carry:<sha>`)
 * names that head, and `headSha` repeats it in the payload, so a reader that finds no record for the head
 * it needs carries nothing from a stranger's.
 *
 * The payload is one base64 JSON block, the grammar the bot's push ledger uses, because a finding's issue
 * is arbitrary text. A block this module cannot decode is rejected whole, never partly trusted: half a
 * record would hold some findings and silently release the rest. Two budgets keep the comment small —
 * `MAX_CARRIED_ENTRIES` and `MAX_CARRIED_CHARS` — and `carriedRecordBody` reports what it had to drop, so
 * the caller can hold the reviewed head instead of losing a finding.
 */
import { type OwnComment, stripNaxBotMarkers } from "@/forge";
import type { WorkflowSeverity } from "@/operations";

/** Own-comment key prefix of one head's record: like `push-`, the key names what it speaks for. */
export const CARRIED_RECORD_PREFIX = "w-carry:";

/** The one record per reviewed head, so a later review of another head cannot overwrite it (B1). */
export function carriedRecordKey(headSha: string): string {
  return `${CARRIED_RECORD_PREFIX}${headSha}`;
}

/** One finding as the record holds it: the identity a later review matches, and what it says. */
export interface CarriedEntry {
  readonly key: string;
  readonly severity: WorkflowSeverity;
  readonly issue: string;
  readonly file?: string;
  readonly line?: number;
  readonly suggestion?: string;
}

export interface CarriedRecord {
  /** The head whose review wrote it; the record speaks for that head and no other. */
  readonly headSha: string;
  readonly findings: readonly CarriedEntry[];
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const HEADING = /^Carried blocking findings at ([0-9a-f]{40}): (\d+)$/;
const BLOCK = /^<!-- nax-bot:carried v1 (.*?) -->$/;
/** Padded, canonical base64 in whole groups — the only form `encode` writes. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SEVERITIES: readonly WorkflowSeverity[] = ["critical", "important", "minor"];
export const MAX_CARRIED_ENTRIES = 32;
export const MAX_CARRIED_CHARS = 24_000;
const MAX_ISSUE_CHARS = 1_000;
const MAX_SUGGESTION_CHARS = 500;

function encode(record: CarriedRecord): string {
  return Buffer.from(JSON.stringify(record), "utf8").toString("base64");
}

/** The heading a human reads and the parser cross-checks the payload against. */
function heading(record: CarriedRecord): string {
  return `Carried blocking findings at ${record.headSha}: ${record.findings.length}`;
}

function body(record: CarriedRecord): string {
  return `${heading(record)}\n<!-- nax-bot:carried v1 ${encode(record)} -->`;
}

/**
 * The bot's own record for one head, when the PR carries one. Keyed by the head, so a review of a later
 * head writes beside it instead of erasing the record a review on another worker may still need.
 */
export function carriedRecordComment(own: readonly OwnComment[], headSha: string): OwnComment | undefined {
  const key = carriedRecordKey(headSha);
  return own.find((candidate) => candidate.key === key && candidate.threadId === undefined);
}

function isSeverity(value: unknown): value is WorkflowSeverity {
  return SEVERITIES.some((severity) => severity === value);
}

/** A finding as the record holds it, or undefined when it is not one: no field is guessed. */
function readEntry(value: unknown): CarriedEntry | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.key !== "string" || item.key === "") return undefined;
  if (typeof item.issue !== "string" || !isSeverity(item.severity)) return undefined;
  return {
    key: item.key,
    severity: item.severity,
    issue: item.issue,
    ...(typeof item.file === "string" ? { file: item.file } : {}),
    ...(typeof item.line === "number" && Number.isFinite(item.line) ? { line: item.line } : {}),
    ...(typeof item.suggestion === "string" ? { suggestion: item.suggestion } : {}),
  };
}

/** The payload's record, or undefined when it is not one this module can hold whole. */
function readPayload(decoded: unknown): CarriedRecord | undefined {
  if (typeof decoded !== "object" || decoded === null) return undefined;
  const item = decoded as Record<string, unknown>;
  if (typeof item.headSha !== "string" || !FULL_SHA.test(item.headSha) || !Array.isArray(item.findings))
    return undefined;
  const findings: CarriedEntry[] = [];
  for (const value of item.findings) {
    const entry = readEntry(value);
    if (entry === undefined) return undefined;
    findings.push(entry);
  }
  return { headSha: item.headSha, findings };
}

/**
 * Read one body back. The heading, its declared count and the payload must all agree, and every finding
 * must be one this module can hold, so a damaged or edited body reads as no record at all. The heading is
 * found rather than assumed: a posted body also carries the bot's visible header and identity marker.
 */
export function parseCarriedRecord(text: string): CarriedRecord | null {
  const lines = stripNaxBotMarkers(text).split(/\r?\n/);
  const at = lines.findIndex((line) => HEADING.test(line));
  if (at === -1) return null;
  const declared = HEADING.exec(lines[at] ?? "");
  const payload = BLOCK.exec(lines[at + 1] ?? "");
  if (declared?.[1] === undefined || declared[2] === undefined || payload?.[1] === undefined) return null;
  // `Buffer.from` skips characters it cannot decode, so the payload must be the canonical form first.
  if (!BASE64.test(payload[1])) return null;
  const bytes = Buffer.from(payload[1], "base64");
  if (bytes.toString("base64") !== payload[1]) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  const record = readPayload(decoded);
  if (record === undefined || record.findings.length !== Number(declared[2])) return null;
  return record.headSha === declared[1] ? record : null;
}

/** One entry as the budget spends it: an issue is a finding's text, truncated only at the cap. */
function budgeted(entry: CarriedEntry): CarriedEntry {
  return {
    ...entry,
    issue: entry.issue.slice(0, MAX_ISSUE_CHARS),
    ...(entry.suggestion === undefined ? {} : { suggestion: entry.suggestion.slice(0, MAX_SUGGESTION_CHARS) }),
  };
}

/**
 * The comment body for a head, and how many findings the budgets forced out. A caller that is told to
 * drop one must not let the reviewed head advance on it: the dropped finding has no other record.
 */
export function carriedRecordBody(record: CarriedRecord): { body: string; dropped: number } {
  const kept: CarriedEntry[] = [];
  for (const entry of record.findings.slice(0, MAX_CARRIED_ENTRIES).map(budgeted)) {
    const candidate = { headSha: record.headSha, findings: [...kept, entry] };
    if (body(candidate).length > MAX_CARRIED_CHARS) break;
    kept.push(entry);
  }
  return { body: body({ headSha: record.headSha, findings: kept }), dropped: record.findings.length - kept.length };
}
