/**
 * What happened after a session kept hitting the same tool error (nax#2491 P8): when a step's
 * session logged three or more identical errors (same tool, same error kind, same target) the run
 * log gets ONE line saying whether it then succeeded (and how) or gave up, instead of three or four
 * bare `Edit error old_string not found` lines and no ending.
 *
 * The rows come from the tool audit (`<outputDir>/tool-audit/<feature>/<runId>-<stamp>-<session>.json`),
 * which only holds rows once a session's sink has flushed, so this reads after the step and is
 * WORKFLOW-MODE scoped: pipeline mode has no per-step hook to read them from. The row carries no error
 * text, so "same error kind" is the outcome plus, for Bash, the exit code; a reader needing the message
 * still has the per-call error lines. Fail-open: an unreadable audit is no line, never a failed step.
 *
 * ATTRIBUTION. A native session flushes its file when its hop ends, an ACP session only when the session
 * closes, so a file can hold several steps' rows. Each row therefore carries its own timestamp (`at`) and
 * counts only inside the step's [start, end] window (a row with no timestamp falls back to its file's
 * stamp), and every row is reported at most once per run (`claimed`). An ACP session whose file is not
 * written until after the step simply gets no line for that step.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toolAuditDir } from "@/config/paths";
import { logWorkflow } from "./run-log";

export const MIN_REPEATED_ERRORS = 3;
const MAX_TARGET_CHARS = 80;

/** The slice of a tool-audit row this reads. */
export interface ToolRow {
  readonly tool: string;
  readonly outcome: string;
  /** ISO time the call was recorded. */
  readonly at?: string;
  readonly input?: Record<string, unknown>;
  readonly exitCode?: number;
}

const TARGET_FIELDS = ["file_path", "path", "filePath", "command", "pattern"] as const;

const capTarget = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_TARGET_CHARS ? `${flat.slice(0, MAX_TARGET_CHARS - 3)}...` : flat;
};

/** The file, command or argv a call acted on; undefined when it names none (such calls are never grouped). */
function targetOf(row: ToolRow): string | undefined {
  for (const field of TARGET_FIELDS) {
    const value = row.input?.[field];
    if (typeof value === "string" && value !== "") return capTarget(value);
  }
  const argv = row.input?.argv;
  if (Array.isArray(argv) && argv.length > 0) return capTarget(argv.map(String).join(" "));
  return undefined;
}

function kindOf(row: ToolRow): string {
  return row.tool === "Bash" && row.exitCode !== undefined ? `exit ${row.exitCode}` : "error";
}

interface Group {
  readonly tool: string;
  readonly kind: string;
  readonly target: string;
  count: number;
  lastAt: number;
}

function groupErrors(rows: readonly ToolRow[]): Group[] {
  const groups = new Map<string, Group>();
  rows.forEach((row, at) => {
    if (row.outcome !== "error") return;
    const target = targetOf(row);
    if (target === undefined) return;
    const kind = kindOf(row);
    const key = `${row.tool}|${kind}|${target}`;
    const group = groups.get(key) ?? { tool: row.tool, kind, target, count: 0, lastAt: at };
    group.count += 1;
    group.lastAt = at;
    groups.set(key, group);
  });
  return [...groups.values()];
}

function whatNext(rows: readonly ToolRow[], group: Group): string {
  const later = rows
    .slice(group.lastAt + 1)
    .find((row) => row.outcome === "ok" && targetOf(row) !== undefined && targetOf(row) === group.target);
  if (later === undefined) return "gave up";
  return later.tool === group.tool ? "succeeded" : `succeeded via ${later.tool}`;
}

/** One line per group of >= 3 identical errors: `4 Edit errors on <file>, then succeeded via Write`. */
export function describeRepeatedToolErrors(rows: readonly ToolRow[]): string[] {
  return groupErrors(rows)
    .filter((group) => group.count >= MIN_REPEATED_ERRORS)
    .map((group) => {
      const kind = group.tool === "Bash" && group.kind !== "error" ? ` (${group.kind})` : "";
      return `${group.count} ${group.tool} errors${kind} on ${group.target}, then ${whatNext(rows, group)}`;
    });
}

export interface ToolAuditScope {
  readonly outputDir: string;
  readonly feature: string;
  readonly runId: string;
}

/** A row with the identity of its place in the audit tree, so it can be claimed once. */
export interface ToolRowEntry {
  readonly key: string;
  readonly row: ToolRow;
  /** The file's write stamp: the fallback time of a row that carries none. */
  readonly fileStamp: number;
}

/** This run's audit rows from files stamped at or after `sinceMs`, files in stamp order, rows in file order. */
export async function readToolEntriesSince(scope: ToolAuditScope, sinceMs: number): Promise<ToolRowEntry[]> {
  const dir = toolAuditDir({ outputDir: scope.outputDir, root: "" }, scope.feature);
  const prefix = `${scope.runId}-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const stamped = names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => ({ name, stamp: Number(/^(\d+)-/.exec(name.slice(prefix.length))?.[1] ?? Number.NaN) }))
    .filter(({ stamp }) => Number.isFinite(stamp) && stamp >= sinceMs)
    .sort((a, b) => a.stamp - b.stamp);
  const entries: ToolRowEntry[] = [];
  for (const { name, stamp } of stamped) {
    try {
      const body = JSON.parse(await readFile(join(dir, name), "utf8")) as { calls?: ToolRow[] };
      for (const [index, row] of (body.calls ?? []).entries()) {
        entries.push({ key: `${name}#${index}`, row, fileStamp: stamp });
      }
    } catch {
      // One unreadable ledger file must not hide the others.
    }
  }
  return entries;
}

export interface ToolErrorStep extends ToolAuditScope {
  /** The log scope (`US-004`, or `_run` for feature steps). */
  readonly storyId: string;
  readonly now?: () => number;
}

/** Row keys already reported, per run: a row is blamed on one step only. */
const claimed = new Map<string, Set<string>>();

/** Drop a run's claimed rows: the feature workflow is the last step that reads them. */
export function clearToolErrorClaims(runId: string): void {
  claimed.delete(runId);
}

/** True while the run still holds claimed rows. */
export function toolErrorClaimsHeld(runId: string): boolean {
  return claimed.has(runId);
}

/** Test seam: forget every run's claims. */
export function resetToolErrorClaims(): void {
  claimed.clear();
}

/** The rows that happened inside [startedAt, endedAt] and were not reported before. */
function ownRows(
  entries: readonly ToolRowEntry[],
  claimedKeys: Set<string>,
  startedAt: number,
  endedAt: number,
): ToolRow[] {
  const own = entries.filter(({ key, row, fileStamp }) => {
    if (claimedKeys.has(key)) return false;
    const at = row.at === undefined ? Number.NaN : Date.parse(row.at);
    return Number.isFinite(at) ? at >= startedAt && at <= endedAt : fileStamp >= startedAt;
  });
  for (const entry of own) claimedKeys.add(entry.key);
  return own.map((entry) => entry.row);
}

/** Runs a step, then logs what became of any session's repeated tool errors. Never changes the step's outcome. */
export async function withToolErrorOutcome<T>(step: ToolErrorStep, label: string, run: () => Promise<T>): Promise<T> {
  const now = step.now ?? Date.now;
  const startedAt = now();
  try {
    return await run();
  } finally {
    try {
      const entries = await readToolEntriesSince(step, startedAt);
      const claimedKeys = claimed.get(step.runId) ?? new Set<string>();
      claimed.set(step.runId, claimedKeys);
      const rows = ownRows(entries, claimedKeys, startedAt, now());
      for (const line of describeRepeatedToolErrors(rows)) logWorkflow(step.storyId, `${label}: ${line}`);
    } catch {
      // A log line must never fail a step.
    }
  }
}
