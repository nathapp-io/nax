/**
 * The mention picker's file list: one `git ls-files` listing of the repository, held in a
 * short-lived index so reopening the picker does not shell out again.
 *
 * The list is the picker's whole vocabulary — one row per tracked or untracked-but-not-ignored
 * path, plus one row per folder those paths sit in — so a path git would not offer (ignored
 * build output, say) never appears as a completion. Any failure to get that list is a
 * non-answer rather than an empty repository: `git: false` lets the screen say so instead of
 * showing an empty picker.
 */
import { GIT_TIMEOUT_MS, gitWithTimeout } from "@nathapp/nax-agent/internal";
import {
  MENTION_FILE_INDEX_MAX_AGE_MS,
  type MentionFileIndex,
  type MentionFileList,
  type MentionFileRow,
} from "./types";

/** Exit code reported for a git call that timed out, so a killed process is never "no changes". */
const GIT_TIMED_OUT_EXIT = -1;
const LS_FILES_ARGS: readonly string[] = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
/** The answer a failed listing gives: nothing to offer, and the screen's own line says why. */
const NO_LIST: MentionFileList = { git: false, rows: [] };
const NUL = "\0";
const PATH_SEPARATOR = "/";
const FOLDER_SUFFIX = "/";

export const _mentionFilesDeps = {
  async git(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
    const result = await gitWithTimeout(args, cwd, GIT_TIMEOUT_MS);
    // gitWithTimeout reports a timeout as exit 1 plus an additive `timedOut`; a killed git
    // answered nothing, so it must not look like a repository git is happy with.
    return { stdout: result.stdout, exitCode: result.timedOut === true ? GIT_TIMED_OUT_EXIT : result.exitCode };
  },
  now(): number {
    return Date.now();
  },
};

/**
 * Every path and folder the picker may offer, from git's own view of the repository.
 *
 * A non-zero exit, a spawn error and a timeout all mean the same thing to the caller: there
 * is no list to filter, so `git` is false and `rows` is empty.
 */
export async function listMentionFiles(cwd: string): Promise<MentionFileList> {
  const listed = await listPaths(cwd);
  return listed === undefined ? NO_LIST : { git: true, rows: buildRows(listed) };
}

/** The paths git listed, or `undefined` when git could not answer. */
async function listPaths(cwd: string): Promise<readonly string[] | undefined> {
  try {
    const { stdout, exitCode } = await _mentionFilesDeps.git([...LS_FILES_ARGS], cwd);
    if (exitCode !== 0) return undefined;
    return stdout.split(NUL).filter((path) => path !== "");
  } catch {
    // Not a repository, git missing, or a killed process: the picker shows its no-list line.
    return undefined;
  }
}

/** One row per listed path and per distinct ancestor folder, sorted by path in code-unit order. */
function buildRows(paths: readonly string[]): readonly MentionFileRow[] {
  const rows = new Map<string, boolean>();
  for (const path of paths) {
    rows.set(path, false);
    for (const folder of ancestorFolders(path)) rows.set(folder, true);
  }
  return [...rows].map(([path, folder]) => ({ path, folder })).sort((a, b) => comparePaths(a.path, b.path));
}

/** Every folder a path sits in, each with its trailing slash: "a/b/c.ts" -> ["a/", "a/b/"]. */
function ancestorFolders(path: string): readonly string[] {
  const segments = path.split(PATH_SEPARATOR);
  const folders: string[] = [];
  let prefix = "";
  for (const segment of segments.slice(0, -1)) {
    if (segment !== "") {
      prefix = `${prefix}${segment}${FOLDER_SUFFIX}`;
      folders.push(prefix);
    }
  }
  return folders;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A cached file list for one working directory: reused for `MENTION_FILE_INDEX_MAX_AGE_MS`,
 * then re-listed, and shared by concurrent callers so a burst of keystrokes that each open
 * the picker still costs one `git ls-files`.
 */
export function createMentionFileIndex(cwd: string): MentionFileIndex {
  let cached: { readonly list: MentionFileList; readonly at: number } | undefined;
  let inFlight: Promise<MentionFileList> | undefined;
  return {
    get(): Promise<MentionFileList> {
      if (inFlight !== undefined) return inFlight;
      if (cached !== undefined && _mentionFilesDeps.now() - cached.at < MENTION_FILE_INDEX_MAX_AGE_MS) {
        return Promise.resolve(cached.list);
      }
      const pending = listMentionFiles(cwd).then(
        (list) => {
          cached = { list, at: _mentionFilesDeps.now() };
          inFlight = undefined;
          return list;
        },
        (err: unknown) => {
          inFlight = undefined;
          throw err;
        },
      );
      inFlight = pending;
      return pending;
    },
  };
}
