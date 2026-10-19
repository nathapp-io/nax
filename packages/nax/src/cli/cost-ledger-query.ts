/**
 * Cost ledger query core — the read side of `nax cost` (Part D, US-004).
 *
 * The ledger is the JSONL file `CostAggregator.drain()` writes at
 * `<outputDir>/cost/<runId>.jsonl` (one `CostEvent` or `CostErrorEvent` per
 * line). This module discovers those files and aggregates them into a report —
 * a pure read: no LLM call, no writes, no budget checks. The command that
 * renders it lives in `src/cli/cost.ts`.
 */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { NaxError } from "@/errors";

/** Group keys a report may be broken down by, in the order `nax cost --by` accepts them. */
export type CostGroupKey = "model" | "stage" | "role" | "project" | "feature" | "run" | "story";

export interface CostQuery {
  /** Inclusive lower bound on row `ts` (epoch ms); undefined = unbounded. */
  readonly sinceMs?: number;
  /** Exclusive upper bound on row `ts` (epoch ms); undefined = unbounded. */
  readonly untilMs?: number;
  /** Keep only rows whose projectKey is one of these; undefined = all. */
  readonly projects?: readonly string[];
  /** Keep rows whose featureName equals it. */
  readonly feature?: string;
  /** Keep rows whose runId equals it. */
  readonly runId?: string;
  /** Group keys, in order; empty = total only. */
  readonly groupBy: readonly CostGroupKey[];
}

export interface CostTotals {
  /** Rows counted. */
  readonly calls: number;
  /** Of those rows, the ones with `kind: "error"` (a failed dispatch). */
  readonly errorCalls: number;
  /** Distinct `runId` values across the counted rows. */
  readonly runs: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** `exactUsd + estimatedUsd`. */
  readonly costUsd: number;
  /**
   * Sum of `costUsd` over exact rows — `confidence === "exact"`, plus
   * `kind: "error"` rows (which carry no confidence) with a finite
   * `exactCostUsd`. Even for those, the dollars summed are `costUsd`.
   */
  readonly exactUsd: number;
  /** Sum of `costUsd` over every other row. */
  readonly estimatedUsd: number;
}

export interface CostGroupRow extends CostTotals {
  /** One entry per groupBy key, in groupBy order; "(none)" when the row lacks the field. */
  readonly key: Readonly<Record<string, string>>;
}

export interface CostLedgerReport {
  readonly schemaVersion: 1;
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
  /** Sorted by `costUsd` descending. Empty when `groupBy` is empty. */
  readonly groups: readonly CostGroupRow[];
  readonly total: CostTotals;
  /** Lines that were neither blank nor a parseable, countable row. */
  readonly skippedRows: number;
  readonly filesScanned: number;
}

/** Project output dir → ledger dir. Kept here so discovery and the writer cannot drift. */
const COST_DIR = "cost";
const LEDGER_SUFFIX = ".jsonl";
const MISSING_CODE = "ENOENT";
/** A path component of the read target is not a directory — for a child scan, "nothing here". */
const NOT_A_DIRECTORY_CODE = "ENOTDIR";

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null ? Reflect.get(err, "code") : undefined;
}

/** `ENOENT` — the path (or a component of it) is not there. */
function isMissing(err: unknown): boolean {
  return errorCode(err) === MISSING_CODE;
}

/**
 * The two codes that mean "this child is not a directory we can scan": `ENOENT`
 * (gone, or a dangling symlink) and `ENOTDIR` (a file where a directory was
 * expected). Every other error is a real read failure and propagates.
 */
function isAbsentOrNotDir(err: unknown): boolean {
  const code = errorCode(err);
  return code === MISSING_CODE || code === NOT_A_DIRECTORY_CODE;
}

/** The one thing discovery reads off a directory entry; `name` is never a `Buffer` here. */
interface DirEntry {
  readonly name: string;
  readonly isDir: boolean;
}

/**
 * Read a directory, or `[]` when it does not exist. A *missing* directory is
 * the documented "nothing to report" case; every other read error — `ENOTDIR`
 * included, where the path exists but is a file — propagates, so an unreadable
 * ledger tree cannot masquerade as an empty one.
 */
async function readEntries(dir: string): Promise<DirEntry[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.map((entry) => ({ name: String(entry.name), isDir: entry.isDirectory() }));
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

/** `stat`-based (so a symlinked child counts) "is this a directory" that treats absence as false. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (err) {
    if (isAbsentOrNotDir(err)) return false;
    throw err;
  }
}

/** Deterministic code-unit order — `Array.prototype.sort()`'s default, made explicit for the lint gate. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Every `<root>/cost/*.jsonl` under each root (a project output dir), sorted.
 *
 * Missing `cost/` dirs contribute nothing; any other directory-read error
 * propagates. A directory whose name merely ends in `.jsonl` is not a ledger.
 */
export async function listCostLedgerFiles(roots: readonly string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const root of roots) {
    const dir = join(root, COST_DIR);
    for (const entry of await readEntries(dir)) {
      if (entry.isDir || !entry.name.endsWith(LEDGER_SUFFIX)) continue;
      found.add(join(dir, entry.name));
    }
  }
  return [...found].sort(compareStrings);
}

/**
 * Every `<globalDir>/<child>` that is a directory (stat-based, so symlinked
 * children count) and contains a `cost/` dir; sorted. A missing `globalDir` is
 * empty; any other directory-read error propagates.
 */
export async function listProjectOutputDirs(globalDir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readEntries(globalDir)) {
    const child = join(globalDir, entry.name);
    if (!(await isDirectory(child))) continue;
    if (!(await isDirectory(join(child, COST_DIR)))) continue;
    found.push(child);
  }
  return found.sort(compareStrings);
}

// ─── aggregation ─────────────────────────────────────────────────────────────

export interface CostLedgerQueryDeps {
  readLedgerFile: (path: string) => Promise<string>;
}

/** Injectable I/O — the module's only external call is reading a ledger file. */
export const _costLedgerQueryDeps: CostLedgerQueryDeps = {
  readLedgerFile: (path: string) => Bun.file(path).text(),
};

/** Row field each group key reads; `project` is the exception (see `groupValues`). */
const GROUP_FIELDS: Readonly<Record<CostGroupKey, string>> = {
  model: "model",
  stage: "stage",
  role: "sessionRole",
  project: "projectKey",
  feature: "featureName",
  run: "runId",
  story: "storyId",
};

/** The accepted `nax cost --by` keys, in declaration order. */
export const COST_GROUP_KEYS: readonly CostGroupKey[] = [
  "model",
  "stage",
  "role",
  "project",
  "feature",
  "run",
  "story",
];

/** Stand-in for a row that carries no value for a group key. */
const NO_VALUE = "(none)";

interface Accumulator {
  calls: number;
  errorCalls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  exactUsd: number;
  estimatedUsd: number;
  readonly runIds: Set<string>;
}

interface Bucket {
  readonly key: Readonly<Record<string, string>>;
  readonly acc: Accumulator;
}

function newAccumulator(): Accumulator {
  return {
    calls: 0,
    errorCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    exactUsd: 0,
    estimatedUsd: 0,
    runIds: new Set<string>(),
  };
}

/** `costUsd` is reported as the sum of its two halves, so the identity holds bit for bit. */
function toTotals(acc: Accumulator): CostTotals {
  return {
    calls: acc.calls,
    errorCalls: acc.errorCalls,
    runs: acc.runIds.size,
    input: acc.input,
    output: acc.output,
    cacheRead: acc.cacheRead,
    cacheWrite: acc.cacheWrite,
    costUsd: acc.exactUsd + acc.estimatedUsd,
    exactUsd: acc.exactUsd,
    estimatedUsd: acc.estimatedUsd,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A finite number, or null for anything else (missing, null, NaN, Infinity, a string). */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringField(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];
  return typeof value === "string" ? value : null;
}

/**
 * Rule 2: a line that is valid JSON, is an object, and carries a finite `ts`
 * (and, when present, a finite `costUsd`). Everything else is a skipped row —
 * a read that succeeded but did not yield a countable event.
 */
function parseRow(line: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Unparseable line: counted in skippedRows, never thrown (rule 2).
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (finiteNumber(parsed.ts) === null) return null;
  if (parsed.costUsd !== undefined && finiteNumber(parsed.costUsd) === null) return null;
  return parsed;
}

/** Rule 3: the row's own `projectKey`, else the basename of its project output dir. */
function projectOf(row: Record<string, unknown>, file: string): string {
  return stringField(row, "projectKey") ?? basename(dirname(dirname(file)));
}

/** Rule 4: the window (`[sinceMs, untilMs)`) plus the project/feature/run filters. */
function isKept(row: Record<string, unknown>, project: string, query: CostQuery): boolean {
  const ts = finiteNumber(row.ts);
  if (ts === null) return false;
  if (query.sinceMs !== undefined && ts < query.sinceMs) return false;
  if (query.untilMs !== undefined && ts >= query.untilMs) return false;
  if (query.projects !== undefined && !query.projects.includes(project)) return false;
  if (query.feature !== undefined && stringField(row, "featureName") !== query.feature) return false;
  if (query.runId !== undefined && stringField(row, "runId") !== query.runId) return false;
  return true;
}

/** Rule 6: `confidence === "exact"`, or a confidence-less error row with a finite `exactCostUsd`. */
function isExactRow(row: Record<string, unknown>): boolean {
  if (row.confidence === "exact") return true;
  return row.kind === "error" && finiteNumber(row.exactCostUsd) !== null;
}

/** Rules 5-7: one counted row into `acc` — calls, tokens, dollars and the distinct runId. */
function accumulateRow(acc: Accumulator, row: Record<string, unknown>): void {
  const tokens = isRecord(row.tokens) ? row.tokens : {};
  const costUsd = finiteNumber(row.costUsd) ?? 0;

  acc.calls += 1;
  if (row.kind === "error") acc.errorCalls += 1;
  acc.input += finiteNumber(tokens.input) ?? 0;
  acc.output += finiteNumber(tokens.output) ?? 0;
  acc.cacheRead += finiteNumber(tokens.cacheRead) ?? 0;
  acc.cacheWrite += finiteNumber(tokens.cacheWrite) ?? 0;
  if (isExactRow(row)) acc.exactUsd += costUsd;
  else acc.estimatedUsd += costUsd;

  const runId = stringField(row, "runId");
  if (runId !== null) acc.runIds.add(runId);
}

/** One value per group key, in groupBy order; the resolved project stands in for `projectKey`. */
function groupValues(row: Record<string, unknown>, groupBy: readonly CostGroupKey[], project: string): string[] {
  return groupBy.map((key) => {
    if (key === "project") return project;
    return stringField(row, GROUP_FIELDS[key]) ?? NO_VALUE;
  });
}

function bucketFor(
  buckets: Map<string, Bucket>,
  groupBy: readonly CostGroupKey[],
  values: readonly string[],
): Accumulator {
  const id = JSON.stringify(values);
  const existing = buckets.get(id);
  if (existing !== undefined) return existing.acc;
  const acc = newAccumulator();
  buckets.set(id, { key: Object.fromEntries(groupBy.map((key, i) => [key, values[i]])), acc });
  return acc;
}

/**
 * Aggregate every countable row in `files` into a `CostLedgerReport`.
 *
 * A line that cannot be parsed or lacks a finite `ts` is counted in
 * `skippedRows`; a row outside the window or failing a filter is dropped
 * silently. A *file* that cannot be read propagates — a vanished or unreadable
 * ledger must fail the query rather than under-report spend as zero.
 */
export async function queryCostLedger(files: readonly string[], query: CostQuery): Promise<CostLedgerReport> {
  const total = newAccumulator();
  const buckets = new Map<string, Bucket>();
  let skippedRows = 0;

  for (const file of files) {
    const text = await _costLedgerQueryDeps.readLedgerFile(file);
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue; // rule 1 — blank lines are not rows at all
      const row = parseRow(line);
      if (row === null) {
        skippedRows += 1;
        continue;
      }
      const project = projectOf(row, file);
      if (!isKept(row, project, query)) continue;
      accumulateRow(total, row);
      if (query.groupBy.length === 0) continue;
      accumulateRow(bucketFor(buckets, query.groupBy, groupValues(row, query.groupBy, project)), row);
    }
  }

  const groups: CostGroupRow[] = [...buckets.values()]
    .map(({ key, acc }) => ({ ...toTotals(acc), key }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    schemaVersion: 1,
    sinceMs: query.sinceMs ?? null,
    untilMs: query.untilMs ?? null,
    groups,
    total: toTotals(total),
    skippedRows,
    filesScanned: files.length,
  };
}

// ─── window resolution ───────────────────────────────────────────────────────

/** `YYYY-MM-DD` — the only date spelling the CLI accepts (both `--since` and `--until`). */
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

interface CalendarDay {
  readonly year: number;
  /** 1-12, unlike `Date`'s 0-11, so the value read back matches what the user typed. */
  readonly month: number;
  readonly day: number;
}

function costUsageError(message: string): NaxError {
  return new NaxError(`[cost] ${message}`, "COST_USAGE", { stage: "cost" });
}

/** Day 0 of the following month is the last day of this one; UTC so the host zone cannot shift it. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * A `YYYY-MM-DD` string as a calendar day. Rejects a wrong shape and a day that
 * does not exist (`2026-13-40`, `2026-02-30`) — checked arithmetically rather
 * than by a `Date` round-trip, which would also reject a local midnight that a
 * DST transition skipped.
 */
function parseDay(value: string, flag: string): CalendarDay {
  const match = DAY_PATTERN.exec(value);
  if (match === null) throw costUsageError(`${flag} must be YYYY-MM-DD, got "${value}"`);
  const [, year, month, day] = match;
  const parsed: CalendarDay = { year: Number(year), month: Number(month), day: Number(day) };
  if (parsed.month < 1 || parsed.month > 12 || parsed.day < 1 || parsed.day > daysInMonth(parsed.year, parsed.month)) {
    throw costUsageError(`${flag} is not a real calendar date: "${value}"`);
  }
  return parsed;
}

/** Epoch ms of 00:00 on a calendar day (plus a whole-day offset), in local time or UTC. */
function dayStartMs(day: CalendarDay, utc: boolean, dayOffset = 0): number {
  const { year, month, day: date } = day;
  return utc ? Date.UTC(year, month - 1, date + dayOffset) : new Date(year, month - 1, date + dayOffset).getTime();
}

/** The calendar day `nowMs` falls on, in the zone the window is being built for. */
function dayOf(nowMs: number, utc: boolean): CalendarDay {
  const now = new Date(nowMs);
  if (utc) return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1, day: now.getUTCDate() };
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * Turn the CLI window flags into epoch-ms bounds: `today` → 00:00 of the current
 * day, `since D` → 00:00 of D, `until D` → 00:00 of the day *after* D (so
 * `--until` names an inclusive day, matching how a user reads it).
 *
 * Pure — no clock read, no I/O: `nowMs` is the caller's `Date.now()`.
 */
export function resolveCostWindow(opts: {
  today?: boolean;
  since?: string;
  until?: string;
  utc?: boolean;
  nowMs: number;
}): { sinceMs?: number; untilMs?: number } {
  const utc = opts.utc === true;
  if (opts.today === true && (opts.since !== undefined || opts.until !== undefined)) {
    throw costUsageError("--today cannot be combined with --since or --until");
  }

  const window: { sinceMs?: number; untilMs?: number } = {};
  if (opts.today === true) window.sinceMs = dayStartMs(dayOf(opts.nowMs, utc), utc);
  if (opts.since !== undefined) window.sinceMs = dayStartMs(parseDay(opts.since, "--since"), utc);
  if (opts.until !== undefined) window.untilMs = dayStartMs(parseDay(opts.until, "--until"), utc, 1);
  return window;
}
