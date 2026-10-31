/**
 * Resolve the `@path` tokens in a typed chat message to content (or refusal) records.
 *
 * The spec's resolution pipeline: locate, dedup, repo boundary, git-ignored (steps 1-4), then
 * a folder listing or a file body bounded by the read ceiling, the binary probe, the per-file
 * cut and the message total cap (steps 5-9). Any rejection while handling one token becomes a
 * `refused` record, so the expander itself never rejects.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { errorMessage, GIT_TIMEOUT_MS, gitWithTimeout } from "@nathapp/nax-agent/internal";
import { formatMentionMessage } from "./mention-envelope";
import { findMentionTokens } from "./mention-tokens";
import {
  type ExpandedMentions,
  MENTION_BINARY_PROBE_BYTES,
  MENTION_FILE_MAX_CHARS,
  MENTION_READ_MAX_BYTES,
  MENTION_TOTAL_MAX_CHARS,
  type MentionRecord,
  type MentionToken,
} from "./types";

/** Where a mention is being resolved: the user's cwd and the repo it must stay inside. */
export interface MentionWhere {
  readonly cwd: string;
  readonly repoRoot: string;
}

export const _mentionExpandDeps = {
  realpath(path: string): Promise<string> {
    return realpath(path);
  },
  async stat(path: string): Promise<{ isDirectory: boolean; size: number }> {
    const info = await stat(path);
    return { isDirectory: info.isDirectory(), size: info.size };
  },
  async readBytes(path: string): Promise<Uint8Array> {
    // Bun.file has no byte-range slice of an unknown length; the whole file is the read.
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  },
  async readdir(path: string): Promise<readonly { name: string; isDirectory: boolean }[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  },
  async git(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
    const result = await gitWithTimeout(args, cwd, GIT_TIMEOUT_MS);
    // gitWithTimeout omits `timedOut` on every non-timeout return; normalize its meaning.
    return { stdout: result.stdout, exitCode: result.exitCode, timedOut: result.timedOut === true };
  },
};

/** A token that resolved to something on disk: the path a record carries, and its real path. */
interface Located {
  readonly path: string;
  readonly realPath: string;
}

/** What every token in one message shares: where to look, the repo boundary, and what is already recorded. */
interface ExpandContext {
  readonly cwd: string;
  readonly realRoot: string | undefined;
  readonly seen: Set<string>;
  /** Characters of record bodies kept so far; the running total step 9 caps. */
  chars: number;
}

/** One direct entry of a listed folder, before the trailing "/" a subfolder is shown with. */
interface FolderEntry {
  readonly name: string;
  readonly folder: boolean;
}

const REFUSAL_PREFIX = "not attached: ";
const OUTSIDE_REPO = "outside the repo";
const INSIDE_GIT_DIR = "inside .git";
const GIT_TIMED_OUT = "git timed out";
const IGNORED_BY_GIT = "ignored by git";
const GIT_DIR_SEGMENT = ".git";
/**
 * The ignore check. `check-ignore` refuses pathspec magic outright ("pathspec magic not
 * supported by this command") and `--literal-pathspecs` / `GIT_LITERAL_PATHSPECS` inject
 * exactly that, so either spelling exits 128 on every path (confirmed on git 2.50.1). Its
 * pathnames are matched literally as typed, which is the behaviour this step needs.
 */
const CHECK_IGNORE_ARGS: readonly string[] = ["check-ignore", "-q", "--"];
/**
 * The folder listing. `--literal-pathspecs` keeps a folder name containing glob characters out
 * of pathspec-magic interpretation, and `-z` makes each returned path NUL-terminated so a name
 * with a newline cannot split an entry.
 */
const LS_FILES_ARGS: readonly string[] = [
  "--literal-pathspecs",
  "ls-files",
  "-z",
  "--cached",
  "--others",
  "--exclude-standard",
  "--",
];
/** The pathspec that names the cwd itself, whose entries are each listed path's first segment. */
const ROOT_PATHSPEC = ".";
const PATH_ONLY_FILE_TOO_LARGE = "path only: file too large";
const PATH_ONLY_BINARY = "path only: binary";
const PATH_ONLY_MESSAGE_TOO_LARGE = "path only: message too large";
/** A folder listing is one entry per line, and every line of a file body ends with this. */
const NEWLINE = "\n";
/** Paths git lists are always "/"-separated, whatever the platform's `sep` is. */
const PATH_SEPARATOR = "/";
const FOLDER_SUFFIX = "/";
const NUL = "\0";
/** Sentence punctuation an unquoted path picks up when it ends a sentence. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

/**
 * Expand every resolvable `@path` in `text` into one record, in the order typed.
 *
 * Never rejects: a token that cannot be resolved stays plain text, and a token whose handling
 * fails becomes a `refused` record while the remaining tokens are still processed.
 */
export async function expandChatMentions(text: string, where: MentionWhere): Promise<ExpandedMentions> {
  const ctx: ExpandContext = {
    cwd: where.cwd,
    realRoot: await realPathOrUndefined(where.repoRoot),
    seen: new Set(),
    chars: 0,
  };
  const records: MentionRecord[] = [];
  for (const token of findMentionTokens(text)) {
    const record = await expandToken(token, ctx);
    if (record !== undefined) records.push(record);
  }
  return { message: formatMentionMessage(text, records), records };
}

async function expandToken(token: MentionToken, ctx: ExpandContext): Promise<MentionRecord | undefined> {
  const located = await locate(token, ctx.cwd);
  if (located === undefined || ctx.seen.has(located.realPath)) return undefined;
  ctx.seen.add(located.realPath);
  try {
    const refusal = boundaryRefusal(located.realPath, ctx.realRoot);
    if (refusal !== undefined) return refused(located.path, refusal);
    const ignored = await ignoredRefusal(located.path, ctx.cwd);
    if (ignored !== undefined) return refused(located.path, ignored);
    return await contentRecord(located, ctx);
  } catch (err) {
    return refused(located.path, errorMessage(err));
  }
}

/** Step 1: resolve the typed path, retrying once without trailing punctuation when unquoted. */
async function locate(token: MentionToken, cwd: string): Promise<Located | undefined> {
  const direct = await realPathOrUndefined(resolve(cwd, token.path));
  if (direct !== undefined) return { path: token.path, realPath: direct };
  if (token.quoted) return undefined;
  const stripped = token.path.replace(TRAILING_PUNCTUATION, "");
  if (stripped === "" || stripped === token.path) return undefined;
  const retried = await realPathOrUndefined(resolve(cwd, stripped));
  return retried === undefined ? undefined : { path: stripped, realPath: retried };
}

/** Step 3: the real path must be the repo root or below it, and must not descend into `.git`. */
function boundaryRefusal(realPath: string, realRoot: string | undefined): string | undefined {
  if (realRoot === undefined) return OUTSIDE_REPO;
  const prefix = realRoot.endsWith(sep) ? realRoot : `${realRoot}${sep}`;
  if (realPath === realRoot) return undefined;
  if (!realPath.startsWith(prefix)) return OUTSIDE_REPO;
  const segments = realPath.slice(prefix.length).split(sep);
  return segments.some((segment) => segment.toLowerCase() === GIT_DIR_SEGMENT) ? INSIDE_GIT_DIR : undefined;
}

/** Step 4: ask git about the path as typed — never the real path, which git would not recognise. */
async function ignoredRefusal(path: string, cwd: string): Promise<string | undefined> {
  const result = await _mentionExpandDeps.git([...CHECK_IGNORE_ARGS, path], cwd);
  if (result.timedOut) return GIT_TIMED_OUT;
  if (result.exitCode === 0) return IGNORED_BY_GIT;
  return result.exitCode === 1 ? undefined : `git check-ignore failed (exit ${result.exitCode})`;
}

/** Steps 5-9: a folder listing, or a file body bounded by size, binary, cut and the total cap. */
async function contentRecord(located: Located, ctx: ExpandContext): Promise<MentionRecord> {
  const info = await _mentionExpandDeps.stat(located.realPath);
  if (info.isDirectory) return folderRecord(located, ctx);
  if (info.size > MENTION_READ_MAX_BYTES) return pathOnly(located.path, PATH_ONLY_FILE_TOO_LARGE);
  const bytes = await _mentionExpandDeps.readBytes(located.realPath);
  if (isBinary(bytes)) return pathOnly(located.path, PATH_ONLY_BINARY);
  return applyTotalCap(textRecord(located, new TextDecoder().decode(bytes)), ctx);
}

/** Step 5: the folder's direct entries, one per line, subfolders suffixed with "/". */
async function folderRecord(located: Located, ctx: ExpandContext): Promise<MentionRecord> {
  const entries = await folderEntries(located, ctx.cwd);
  const record: MentionRecord = {
    path: located.path,
    status: "folder",
    note: `${entries.length} entries`,
    body: entries.map(formatEntry).join(NEWLINE),
  };
  return applyTotalCap(record, ctx);
}

/** §Folder listing: git's view when it has one, the directory itself when git says no. */
async function folderEntries(located: Located, cwd: string): Promise<FolderEntry[]> {
  const pathspec = folderPathspec(cwd, located.path);
  const listed = await _mentionExpandDeps.git([...LS_FILES_ARGS, pathspec], cwd);
  const entries =
    listed.exitCode === 0 ? parseListedPaths(listed.stdout, pathspec) : await readdirEntries(located.realPath);
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The folder's cwd-relative path with exactly one trailing "/", or "." for the cwd itself.
 *
 * Derived from the typed path resolved against `cwd`, never from the real path: `realpath`
 * canonicalises (a symlinked cwd, macOS's `/var` -> `/private/var`), and a pathspec computed
 * across those two frames escapes the repo and makes every listing fall back to `readdir`.
 */
function folderPathspec(cwd: string, path: string): string {
  const rel = relative(cwd, resolve(cwd, path)).split(sep).join(PATH_SEPARATOR).replace(/\/+$/, "");
  return rel === "" || rel === ROOT_PATHSPEC ? ROOT_PATHSPEC : `${rel}${FOLDER_SUFFIX}`;
}

/** One entry per first path segment below the pathspec; a segment followed by more path is a folder. */
function parseListedPaths(stdout: string, pathspec: string): FolderEntry[] {
  const prefix = pathspec === ROOT_PATHSPEC ? "" : pathspec;
  const entries = new Map<string, boolean>();
  for (const path of stdout.split(NUL)) {
    if (!path.startsWith(prefix)) continue;
    const segments = path
      .slice(prefix.length)
      .split(PATH_SEPARATOR)
      .filter((segment) => segment !== "");
    const name = segments[0];
    if (name === undefined) continue;
    entries.set(name, (entries.get(name) ?? false) || segments.length > 1);
  }
  return [...entries].map(([name, folder]) => ({ name, folder }));
}

async function readdirEntries(realPath: string): Promise<FolderEntry[]> {
  const entries = await _mentionExpandDeps.readdir(realPath);
  return entries.map((entry) => ({ name: entry.name, folder: entry.isDirectory }));
}

function formatEntry(entry: FolderEntry): string {
  return entry.folder ? `${entry.name}${FOLDER_SUFFIX}` : entry.name;
}

/** Step 7: a NUL in the probed head marks the file binary. */
function isBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, MENTION_BINARY_PROBE_BYTES).includes(0);
}

/** Step 8: the whole text when it fits, else the longest whole-line prefix within the cap. */
function textRecord(located: Located, text: string): MentionRecord {
  const lines = lineCount(text);
  if (text.length <= MENTION_FILE_MAX_CHARS) {
    return { path: located.path, status: "attached", note: `${lines} lines`, body: text };
  }
  const cut = cutBody(text);
  return { path: located.path, status: "cut", note: `first ${cut.lines} of ${lines} lines`, body: cut.body };
}

/**
 * The longest prefix of whole lines (each keeping its newline) within the per-file cap. When
 * even the first line overflows it, the prefix is the first cap characters, counted as one line.
 */
function cutBody(text: string): { readonly body: string; readonly lines: number } {
  let end = 0;
  let lines = 0;
  for (
    let newline = text.indexOf(NEWLINE);
    newline !== -1 && newline + 1 <= MENTION_FILE_MAX_CHARS;
    newline = text.indexOf(NEWLINE, newline + 1)
  ) {
    end = newline + 1;
    lines += 1;
  }
  return lines === 0 ? { body: text.slice(0, MENTION_FILE_MAX_CHARS), lines: 1 } : { body: text.slice(0, end), lines };
}

/** Step 9: a body that would push the message past its cap becomes a path-only record instead. */
function applyTotalCap(record: MentionRecord, ctx: ExpandContext): MentionRecord {
  if (ctx.chars + record.body.length > MENTION_TOTAL_MAX_CHARS) {
    return pathOnly(record.path, PATH_ONLY_MESSAGE_TOO_LARGE);
  }
  ctx.chars += record.body.length;
  return record;
}

/** Newlines, plus a final unterminated line; an empty file has none. */
function lineCount(text: string): number {
  if (text === "") return 0;
  const newlines = text.split(NEWLINE).length - 1;
  return text.endsWith(NEWLINE) ? newlines : newlines + 1;
}

function pathOnly(path: string, note: string): MentionRecord {
  return { path, status: "path-only", note, body: "" };
}

function refused(path: string, reason: string): MentionRecord {
  return { path, status: "refused", note: `${REFUSAL_PREFIX}${reason}`, body: "" };
}

async function realPathOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await _mentionExpandDeps.realpath(path);
  } catch {
    // A path that does not exist is not an error here: the mention simply stays plain text.
    return undefined;
  }
}
