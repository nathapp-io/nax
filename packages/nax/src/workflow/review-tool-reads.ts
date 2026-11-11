/**
 * Which changed files a review session's tool calls actually showed the model (US-005).
 *
 * A reviewer's `inspectedFiles` list is self-reported. A `Read` of the whole file, or a `git diff`
 * whose result reached the model uncut, is the same evidence — observed instead of claimed — and it
 * is what stops "listed the files, read three of them, approved" from passing as a review.
 *
 * `toolReadPaths` is pure: no I/O, no config, no ordering surprises — it turns a list of
 * already-recorded calls into repo-relative paths. `readSessionToolCalls` is the loader that
 * supplies that list (US-006), reading the same directory and ledger session name the dispatch
 * writes, so a caller never re-spells either.
 *
 * Only `Read`, `Git` and `Bash` are read, and only when the whole result reached the model. A call
 * whose result was truncated above `TOOL_READ_CREDIT_MAX_BYTES` credits nothing, because the model
 * saw a prefix of it; a `Read` with `offset` or `limit` credits nothing for the same reason. ACP
 * agents that use their own tools leave no `ToolCallRecord` here at all, so they simply earn no
 * credit.
 */
import { isAbsolute, join } from "node:path";
import type { ToolCallRecord } from "@nathapp/nax-agent";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { getSafeLogger, type Logger } from "@/logger";
import { normalizeReviewPath } from "@/operations";

/**
 * The largest result that still counts as a whole file shown to the model: nax-agent's
 * `MODEL_MAX_BYTES`, the ceiling its model-facing truncation policy applies. A larger result was
 * cut before delivery, so the call credits no file.
 */
export const TOOL_READ_CREDIT_MAX_BYTES = 40_000;

/** A whole-file `Read`. A ranged read showed a slice, not the file. */
function readPaths(input: Record<string, unknown>): string[] {
  if (input.offset !== undefined || input.limit !== undefined) return [];
  const path = input.path;
  return typeof path === "string" ? [path] : [];
}

/**
 * The paths a `git diff` showed. `nameOnly` (and `nameStatus`) list the files without their
 * content, so the model saw names only and no file is credited.
 */
function gitPaths(input: Record<string, unknown>): string[] {
  if (input.subcommand !== "diff" || input.nameOnly === true) return [];
  const paths = input.paths;
  if (!Array.isArray(paths)) return [];
  return paths.filter((path): path is string => typeof path === "string");
}

/** Characters that make a word a glob, a variable or a bracket expression — never a path. */
const NON_PATH_CHARS = ["$", "*", "?", "["] as const;

/** `git diff` flags that list files without their content. */
const CONTENTLESS_DIFF_FLAGS = ["--name-only", "--name-status", "--stat"] as const;

/** A word with its wrapping quotes removed, or `undefined` when its quotes never close. */
function unquote(word: string): string | undefined {
  const quote = word.charAt(0);
  if (quote !== "'" && quote !== '"') return word;
  const end = word.indexOf(quote, 1);
  return end === -1 ? undefined : word.slice(1, end);
}

/** One segment's words, quotes removed; a word whose quotes never close is dropped. */
function words(segment: string): string[] {
  const out: string[] = [];
  for (const raw of segment.trim().split(/\s+/)) {
    if (raw === "") continue;
    const word = unquote(raw);
    if (word !== undefined) out.push(word);
  }
  return out;
}

/** A `cd` target as a directory prefix: no leading `./`, no trailing `/`. */
function cleanDir(dir: string): string {
  return (dir.startsWith("./") ? dir.slice(2) : dir).replace(/\/+$/, "");
}

/** A path word placed under the directory the shell is in, unless it is already absolute. */
function joinDir(dir: string, path: string): string {
  const bare = path.startsWith("./") ? path.slice(2) : path;
  return dir === "" || isAbsolute(bare) ? bare : `${dir}/${bare}`;
}

/** `git diff` or `rtk git diff` — the two spellings whose output is a diff body. */
function isDiffCommand(parts: readonly string[]): boolean {
  if (parts[0] === "git") return parts[1] === "diff";
  return parts[0] === "rtk" && parts[1] === "git" && parts[2] === "diff";
}

/** `--name-only` / `--name-status` / `--stat` show no content, so the call credits nothing. */
function hasContentlessFlag(parts: readonly string[]): boolean {
  return parts.some((part) => CONTENTLESS_DIFF_FLAGS.some((flag) => part === flag || part.startsWith(`${flag}=`)));
}

/** The words after a standalone `--` that can name a file, joined to the current directory. */
function diffPaths(parts: readonly string[], dir: string): string[] {
  const dash = parts.indexOf("--");
  if (dash === -1 || hasContentlessFlag(parts)) return [];
  return parts
    .slice(dash + 1)
    .filter((part) => !part.startsWith("-") && !NON_PATH_CHARS.some((char) => part.includes(char)))
    .map((path) => joinDir(dir, path));
}

/**
 * The paths a shell command's `git diff` segments showed. Segments are split on `;`, `&&` and
 * newlines and cut at their first `|`, so a pipe to `head` narrows the printed output without
 * changing which file the diff itself rendered. A `cd` segment carries into the later segments.
 */
function bashPaths(input: Record<string, unknown>): string[] {
  const command = input.command;
  if (typeof command !== "string") return [];
  const out: string[] = [];
  let dir = "";
  for (const raw of command.split(/;|&&|\n/)) {
    const parts = words(raw.split("|")[0]);
    const target = parts[1] ?? "";
    if (parts[0] === "cd" && target !== "" && !target.includes("$")) {
      dir = cleanDir(target);
      continue;
    }
    if (isDiffCommand(parts)) out.push(...diffPaths(parts, dir));
  }
  return out;
}

/**
 * The paths a tool call credits, before normalisation.
 *
 * Three gates, because none of them is sufficient alone:
 * - `truncated === false` — nothing cut this result: neither the tool's own shaping (a whole-file
 *   `Read` caps itself at the model-facing ceilings and states the cut, so this is the only field
 *   that can tell a cut Read from a whole one) nor the model-facing policy, which also cuts by line
 *   length and line count, so a body reduced from 2 000 short lines to 1 000 stays well under the
 *   byte ceiling. It is the only POSITIVE evidence of completeness. An absent value means unknown —
 *   a row written before the field existed, or one an ACP session produced, where nax never shaped
 *   the result at all — and unknown credits nothing, because the whole point of this module is to
 *   trust evidence rather than a plausible-looking size.
 * - `truncated === true` is therefore refused by the same test, explicitly.
 * - `resultBytes > TOOL_READ_CREDIT_MAX_BYTES` is the belt for a transport that
 *   shapes results itself and states completeness anyway.
 */
function creditedPaths(call: ToolCallRecord): string[] {
  if (call.outcome !== "ok" || call.truncated !== false) return [];
  if (call.resultBytes > TOOL_READ_CREDIT_MAX_BYTES) return [];
  if (call.tool === "Read") return readPaths(call.input);
  if (call.tool === "Git") return gitPaths(call.input);
  if (call.tool === "Bash") return bashPaths(call.input);
  return [];
}

/**
 * The repo-relative paths these calls showed in full, deduplicated, in first-appearance order.
 * Entries that cannot name a file in this repository are dropped, exactly as `unreadFiles` drops
 * them from a reviewer's own list.
 */
export function toolReadPaths(calls: readonly ToolCallRecord[], repoRoot: string): string[] {
  const credited = new Set<string>();
  for (const call of calls) {
    for (const raw of creditedPaths(call)) {
      const path = normalizeReviewPath(raw, repoRoot);
      if (path !== undefined) credited.add(path);
    }
  }
  return [...credited];
}

/**
 * Injectable file and logger seams — the `_deps` pattern. `glob` takes the directory explicitly
 * so no scan can fall back to `process.cwd()`.
 */
export const _reviewToolReadsDeps: {
  glob: (pattern: string, cwd: string) => Promise<string[]>;
  readText: (path: string) => Promise<string>;
  logger: () => Logger | null;
} = {
  glob: async (pattern, cwd) => Array.fromAsync(new Bun.Glob(pattern).scan({ cwd, absolute: false, onlyFiles: true })),
  readText: (path) => Bun.file(path).text(),
  logger: getSafeLogger,
};

/** A matching audit file, with the millisecond stamp its name carries. */
interface SessionFile {
  readonly name: string;
  readonly stamp: number;
}

/** The scope one load covers: this run's ledger session, from `sinceMs` on. */
export interface SessionToolCallQuery {
  readonly auditDir: string;
  readonly runId: string;
  readonly ledgerSessionName: string;
  readonly sinceMs: number;
}

/**
 * The stamp in `<runId>-<digits>-<ledgerSessionName>.json`, or `undefined` when the name belongs
 * to another run or another session. Both ends are matched EXACTLY and only the digits between
 * them are parsed: the ledger session name is a human label that itself contains hyphens
 * (`<feature>-wf-branch-review`), so splitting the name on `-` would cross-match.
 */
function fileStamp(name: string, runId: string, ledgerSessionName: string): number | undefined {
  const prefix = `${runId}-`;
  const suffix = `-${ledgerSessionName}.json`;
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined;
  const digits = name.slice(prefix.length, name.length - suffix.length);
  return /^\d+$/.test(digits) ? Number(digits) : undefined;
}

/**
 * The errno code a failure carries, when it carries one: a filesystem error's `ENOENT` is what
 * tells an absent directory apart from an unreadable one.
 */
function errnoCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}

/** This session's files in `auditDir`, lowest stamp first; a directory that is not there is empty. */
async function sessionFiles(input: SessionToolCallQuery): Promise<SessionFile[]> {
  let names: string[];
  try {
    names = await _reviewToolReadsDeps.glob("*.json", input.auditDir);
  } catch (err) {
    // A run that has written no ledger yet is the expected case: nothing was recorded, and an
    // empty answer is correct. Any OTHER scan failure (permissions, I/O) means the tree may hold
    // calls that could not be read, and silence would make that indistinguishable from "this
    // session read nothing" — so it is warned about, by name.
    if (errnoCode(err) !== "ENOENT") {
      _reviewToolReadsDeps.logger()?.warn("workflow", "Tool-audit directory could not be read — no calls loaded", {
        auditDir: input.auditDir,
        error: errorMessage(err),
      });
    }
    return [];
  }
  return names
    .map((name) => ({ name, stamp: fileStamp(name, input.runId, input.ledgerSessionName) }))
    .filter((file): file is SessionFile => file.stamp !== undefined && file.stamp >= input.sinceMs)
    .sort((a, b) => a.stamp - b.stamp || a.name.localeCompare(b.name));
}

/** The `calls` array of a parsed audit body, or `undefined` when the body holds none. */
function callsOf(body: unknown): ToolCallRecord[] | undefined {
  if (typeof body !== "object" || body === null || !("calls" in body)) return undefined;
  return Array.isArray(body.calls) ? body.calls : undefined;
}

/**
 * One audit file's `calls`. A file that does not parse, or holds no `calls` array, is skipped with
 * a warn: one damaged ledger must never hide the sessions that did write theirs.
 */
async function callsInFile(input: { auditDir: string; name: string }): Promise<ToolCallRecord[] | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(await _reviewToolReadsDeps.readText(join(input.auditDir, input.name)));
  } catch (err) {
    _reviewToolReadsDeps.logger()?.warn("workflow", "Tool-audit file skipped — it could not be read or parsed", {
      file: input.name,
      error: errorMessage(err),
    });
    return undefined;
  }
  const calls = callsOf(body);
  if (calls === undefined) {
    _reviewToolReadsDeps.logger()?.warn("workflow", "Tool-audit file skipped — it holds no calls array", {
      file: input.name,
    });
  }
  return calls;
}

/**
 * Every tool call this run's review session recorded from `sinceMs` on, files in stamp order and
 * each file's calls in the order they were made.
 *
 * `auditDir` and `ledgerSessionName` are the caller's own (`toolAuditDir` and
 * `buildLedgerSessionName`) rather than re-derived here: they are the same two values the dispatch
 * wrote under, and a second derivation is how a reader ends up scanning a directory the writer
 * never used. Best-effort throughout — a missing directory or an unreadable file yields the calls
 * that could be read, never a throw.
 */
export async function readSessionToolCalls(input: SessionToolCallQuery): Promise<ToolCallRecord[]> {
  const files = await sessionFiles(input);
  const bodies = await Promise.all(files.map((file) => callsInFile({ auditDir: input.auditDir, name: file.name })));
  return bodies.flatMap((calls) => calls ?? []);
}
