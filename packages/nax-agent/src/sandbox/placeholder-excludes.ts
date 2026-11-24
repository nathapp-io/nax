/**
 * US-007 — hide the Linux sandbox's shell-startup placeholders from git.
 *
 * bwrap mounts a placeholder at every mandatory deny name srt resolves that is
 * ABSENT on disk: `.bashrc`, `.profile`, `.zshrc`, ... under the directory srt
 * started in. Those files exist only while a sandboxed command runs, but a
 * background command can keep them there long enough for an agent's own
 * `git status` to see them as untracked, and an agent that "cleans up" what git
 * reported removes a live sandbox's deny.
 *
 * The answer is additive and root-anchored: `/.bashrc` matches only a TOP-LEVEL
 * `.bashrc`, so a repository that keeps its dotfiles under a subdirectory is
 * untouched, and a repository that COMMITS `.bashrc` keeps tracking it, because
 * git never applies an exclude to a tracked file. `.gitconfig`, `.gitmodules`,
 * `.mcp.json`, `.vscode`, `.idea` and `.claude` are deliberately absent for that
 * same reason: repositories commit them, and hiding one would hide a change the
 * user is about to commit.
 *
 * Nothing is ever removed: `.git/info/exclude` belongs to the user, so an entry
 * nax added stays after nax is done with the repository. The update is
 * line-exact, locked, and staged through a temporary file renamed into place —
 * the same additive shape `nax/src/worktree/manager.ts` uses for its own
 * generated files, plus the atomic replace its in-place write lacks.
 */
import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, sep } from "node:path";
import { errorMessage } from "#src/infra/errors";
import { getSafeLogger, NaxError } from "#src/infra/index";
import { gitWithTimeout } from "#src/internal/git-exec";
import { withPathFileLock } from "#src/internal/path-file-lock";
import { realOrRaw } from "#src/internal/realpath";
import { _placeholderDeps } from "./placeholder-deps.ts";
import { resolveGitLayout } from "./policy-inputs.ts";

/**
 * The shell-startup names bwrap creates a placeholder at, each root-anchored: a
 * leading `/` makes git match the top level of the work tree only, so a
 * `.profile` deeper in the repository is never hidden.
 */
export const PLACEHOLDER_EXCLUDE_ENTRIES: readonly string[] = [
  "/.bashrc",
  "/.bash_profile",
  "/.profile",
  "/.zshrc",
  "/.zprofile",
  "/.ripgreprc",
];

/** The one section header nax writes. Existing lines are never rewritten or reordered. */
const EXCLUDE_HEADER = "# nax: Linux sandbox mount points";

/** Bound on the one `rev-parse` this step runs, as `resolveGitLayout` bounds its own. */
const TOPLEVEL_TIMEOUT_MS = 10_000;

/** How long to wait for another nax process's update of the same exclude file. */
const EXCLUDE_LOCK_TIMEOUT_MS = 5_000;

/** Bound on following a chain of exclude links, as the kernel bounds its own. */
const MAX_LINK_HOPS = 40;

/** The filesystem root: never a repository nax should write an exclude for. */
const FILESYSTEM_ROOT = "/";

/** The errno code an fs error carries, or `undefined` for anything else. */
function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** `<info>/exclude`: git reads the file under the git dir, which for a worktree is the common dir's. */
function excludePath(infoRoot: string): string {
  return join(infoRoot, "info", "exclude");
}

/** The real components of a path: the empty and `.` ones a leading `/` or a link text produce, dropped. */
function segmentsOf(path: string): string[] {
  return path.split(sep).filter((segment) => segment !== "" && segment !== ".");
}

/**
 * True when `cwd` is the repository root itself. A root-anchored pattern only
 * matches at the top level, so running this from a subdirectory would write
 * entries that hide nothing; `rev-parse` is asked rather than comparing `cwd`
 * with a `.git` probe because only git knows where the work tree starts.
 */
async function isRepositoryRoot(cwd: string): Promise<boolean> {
  const { stdout, exitCode } = await gitWithTimeout(["rev-parse", "--show-toplevel"], cwd, TOPLEVEL_TIMEOUT_MS);
  const topLevel = stdout.trim();
  return exitCode === 0 && topLevel !== "" && realOrRaw(topLevel) === realOrRaw(cwd);
}

/**
 * The exclude file to update for `cwd`, or `undefined` when this directory must
 * not gain one.
 */
async function targetExclude(cwd: string): Promise<string | undefined> {
  const root = realOrRaw(cwd);
  // `$HOME` and `/` are where srt's mandatory names point when nax runs from
  // them: an exclude there hides the user's own dotfiles from an unrelated
  // repository, and neither is a project nax was asked to work in.
  if (root === FILESYSTEM_ROOT || root === realOrRaw(_placeholderDeps.homedir())) return undefined;
  const layout = await resolveGitLayout(cwd);
  if (layout.kind === "none") return undefined;
  if (!(await isRepositoryRoot(cwd))) return undefined;
  // A linked worktree's per-worktree git dir holds no `info/exclude` git reads.
  return excludePath(layout.kind === "worktree" ? layout.commonDir : layout.gitDir);
}

/**
 * `existing` plus a section holding the entries it does not already list.
 *
 * Matching is line-exact on the trimmed line, so `/.profile` and `/profile` are
 * different entries and a user's `/build/.profile` never suppresses `/.profile`.
 * A file whose content does not end with a newline keeps its last line as
 * written and gains the newline the appended section needs.
 */
function withPlaceholderEntries(existing: string): string {
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = PLACEHOLDER_EXCLUDE_ENTRIES.filter((entry) => !present.has(entry));
  if (missing.length === 0) return existing;
  const body = existing === "" || existing.endsWith("\n") ? existing : `${existing}\n`;
  // The header is not repeated: an entry a user deleted is appended under the
  // header already there, rather than under a second copy of it.
  const header = present.has(EXCLUDE_HEADER) ? "" : `${EXCLUDE_HEADER}\n`;
  return `${body}${header}${missing.join("\n")}\n`;
}

/**
 * The file's current bytes and permission bits, `undefined` when it does not
 * exist yet. A read that fails for any other reason throws: there is nothing
 * safe to append to, and writing anyway would replace the user's lines with
 * nax's.
 *
 * `statSync`, so a link is read through and reports its target's bytes and mode.
 * A dangling link lands in the `ENOENT` branch together with a truly absent
 * file; {@link excludeDestination} is what keeps the two apart.
 */
function readExclude(path: string): { readonly text: string; readonly mode: number } | undefined {
  try {
    const stats = statSync(path);
    return { text: readFileSync(path, "utf8"), mode: stats.mode & 0o777 };
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * The file to write: `path` itself, or, when `path` is a symlink, the file it
 * points at, resolved the way the kernel resolves it.
 *
 * A DANGLING link is followed too (B3). It reads as an absent exclude, so a
 * write that replaced that name with a regular file would delete the user's link
 * and leave the file git actually reads untouched; nax appends THROUGH the link
 * instead, creating its target beside it.
 *
 * The walk goes component by component and follows every link it crosses (B4),
 * so a link's target is applied in the directory the link ACTUALLY lives in. With
 * `.git/info` a symlink to `/shared/info`, the relative target `../settings` of
 * `.git/info/exclude` names `/shared/settings` — the file git reads through the
 * link. Lexically normalising the text instead collapses `info/..` to `.git`
 * first and names `.git/settings`, a file git never reads and one nax would then
 * overwrite.
 */
function excludeDestination(path: string): string {
  const root = parse(path).root;
  const pending = segmentsOf(path.slice(root.length));
  let base = root;
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.shift() as string;
    if (segment === "..") {
      // Applied to the resolved `base`, never to the raw text: after a link, `..`
      // is the parent of where that link landed.
      base = dirname(base);
      continue;
    }
    const next = join(base, segment);
    let target: string;
    try {
      if (!lstatSync(next).isSymbolicLink()) {
        base = next;
        continue;
      }
      target = readlinkSync(next);
    } catch (error) {
      // Nothing at this name yet: this is where the bytes belong, and the link
      // that names it stays intact. The rest of the path is created with it.
      if (errorCode(error) === "ENOENT") return join(next, ...pending);
      throw error;
    }
    hops += 1;
    if (hops > MAX_LINK_HOPS) {
      // A chain this long is a loop: refuse rather than guess where git reads.
      throw new NaxError("[sandbox] git exclude symlink chain is too long", "SANDBOX_EXCLUDE_SYMLINK_LOOP", {
        stage: "sandbox",
        file: path,
      });
    }
    const targetRoot = parse(target).root;
    if (targetRoot !== "") base = targetRoot;
    pending.unshift(...segmentsOf(target.slice(targetRoot.length)));
  }
  return base;
}

/** Delete `path`, ignoring any failure: a renamed temp file is already gone. */
function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A successful rename already removed the temporary name.
  }
}

/**
 * Replace `path`'s bytes without ever truncating it first: stage the new
 * contents in a uniquely named file beside it, then rename that over it.
 *
 * `open`/`write` in place would empty the destination before the new bytes
 * arrive, so a write that fails partway (a full filesystem, a quota, a killed
 * process) would leave the user's exclude file empty or half-written. A rename
 * is atomic within one directory: readers see either the old file or the new
 * one, and a failure before it leaves the old bytes untouched. The temporary
 * name is unique per call and created with `wx`, never a predictable name that
 * another process could have left behind as a symlink.
 */
function replaceAtomically(path: string, content: string, mode: number | undefined): void {
  const temp = `${dirname(path)}/.${basename(path)}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { flag: "wx", mode });
    renameSync(temp, path);
  } finally {
    removeQuietly(temp);
  }
}

async function addExcludes(cwd: string): Promise<void> {
  const path = await targetExclude(cwd);
  if (path === undefined) return;
  const infoDir = dirname(path);
  mkdirSync(infoDir, { recursive: true });
  // Serialized, so two nax processes starting at once cannot interleave
  // read-read-write-write and drop one process's entries.
  await withPathFileLock(
    path,
    async () => {
      const current = readExclude(path);
      const existing = current?.text ?? "";
      const next = withPlaceholderEntries(existing);
      // Nothing missing: leave the inode, the bytes and the mtime alone.
      if (next === existing) return;
      // A linked exclude is written through: the replace must land in the file
      // git reads, not on a new regular file where the user's link used to be.
      replaceAtomically(excludeDestination(path), next, current?.mode);
    },
    { timeoutMs: EXCLUDE_LOCK_TIMEOUT_MS },
  );
}

/**
 * Append the root-anchored shell-startup names to this repository's exclude
 * file, so a placeholder srt is holding stays on disk without being reported as
 * an untracked file.
 *
 * Never throws: a command whose placeholders stay visible still runs, and the
 * worst case is one untracked `.bashrc` in an agent's next `git status`. One
 * warn names the failure and nothing else changes.
 */
export async function ensurePlaceholderExcludes(cwd: string): Promise<void> {
  try {
    await addExcludes(cwd);
  } catch (error) {
    getSafeLogger()?.warn("sandbox", "could not update git excludes", { cwd, error: errorMessage(error) });
  }
}
