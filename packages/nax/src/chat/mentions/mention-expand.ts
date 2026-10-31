/**
 * Resolve the `@path` tokens in a typed chat message to whole-file (or refusal) records.
 *
 * Steps 1-4 of the spec's resolution pipeline (locate, dedup, repo boundary, git-ignored)
 * plus the whole-file case of step 8. Folder listings, oversize/binary/cut handling and the
 * total cap belong to the content steps added later; `contentRecord` is the seam they extend.
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { errorMessage, GIT_TIMEOUT_MS, gitWithTimeout } from "@nathapp/nax-agent/internal";
import { formatMentionMessage } from "./mention-envelope";
import { findMentionTokens } from "./mention-tokens";
import type { ExpandedMentions, MentionRecord, MentionToken } from "./types";

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
/** Sentence punctuation an unquoted path picks up when it ends a sentence. */
const TRAILING_PUNCTUATION = /[.,;:!?)]+$/;

/**
 * Expand every resolvable `@path` in `text` into one record, in the order typed.
 *
 * Never rejects: a token that cannot be resolved stays plain text, and a token whose handling
 * fails becomes a `refused` record while the remaining tokens are still processed.
 */
export async function expandChatMentions(text: string, where: MentionWhere): Promise<ExpandedMentions> {
  const ctx: ExpandContext = { cwd: where.cwd, realRoot: await realPathOrUndefined(where.repoRoot), seen: new Set() };
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
    return await contentRecord(located);
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

/** Step 8, whole-file case: the content steps that bound or cut a body extend this function. */
async function contentRecord(located: Located): Promise<MentionRecord> {
  const text = new TextDecoder().decode(await _mentionExpandDeps.readBytes(located.realPath));
  return { path: located.path, status: "attached", note: `${lineCount(text)} lines`, body: text };
}

/** Newlines, plus a final unterminated line; an empty file has none. */
function lineCount(text: string): number {
  if (text === "") return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
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
