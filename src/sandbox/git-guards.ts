/**
 * The I/O half of the sandbox's git guards (#2198): the git-read files that
 * redirect where git finds its config and hooks, as they exist on disk now.
 *
 * A sandboxed command that repoints one of these at an agent-authored
 * directory (its own `config` with core.hooksPath / core.fsmonitor) makes
 * nax's next UNSANDBOXED git run agent code. The redirecting files are:
 * `<common>/commondir`, and for every linked worktree `worktrees/<id>/`
 * `{gitdir, commondir, config.worktree}` plus the worktree's `.git` pointer.
 *
 * Only files that EXIST are denied here: srt on Linux stubs an absent deny
 * with an empty file (host-side too, while the command runs), and git dies
 * reading an empty `commondir` / `gitdir` -- inside the sandbox and in any
 * concurrent nax git. An absent `<common>/commondir` is therefore guarded by
 * a tripwire instead (strayCommonDirTripwire). `config.worktree` is the
 * exception: an empty one is valid config, so it is always denied.
 */
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { SANDBOX_GLOB_CHARS } from "../config/schemas-sandbox";
import { getSafeLogger } from "../logger";
import { errorMessage } from "../utils/errors";
import { realOrRaw } from "../utils/realpath";
import type { GitLayout } from "./policy-inputs";

const WORKTREES_DIR = "worktrees";
const COMMONDIR_FILE = "commondir";
const GITDIR_FILE = "gitdir";
export const WORKTREE_CONFIG_FILE = "config.worktree";
const DOT_GIT = ".git";

export const _gitGuardDeps = {
  readdir,
  exists: async (p: string): Promise<boolean> => {
    try {
      await lstat(p);
      return true;
    } catch {
      return false;
    }
  },
  readText: (p: string): Promise<string> => Bun.file(p).text(),
  remove: (p: string): Promise<void> => rm(p, { recursive: true, force: true }),
};

/** The directory holding the shared config/hooks: the git dir itself for a main checkout. */
export function commonDirOf(git: GitLayout): string | undefined {
  if (git.kind === "none") return undefined;
  return git.kind === "worktree" ? git.commonDir : git.gitDir;
}

/** A glob-named path would make every policy build throw (F1), so it is skipped, not emitted. */
function isLiteral(p: string): boolean {
  return !SANDBOX_GLOB_CHARS.test(realOrRaw(p));
}

/**
 * The `<wt>/.git` pointer a `gitdir` file names -- only a literal `.git` path.
 *
 * git >= 2.48 with `worktree.useRelativePaths` (or `worktree add
 * --relative-paths`) writes it relative to the admin dir `<common>/worktrees/<id>`
 * -- computed from that dir's realpath, and read back by joining onto it -- so a
 * relative target resolves against the admin dir's realpath. Resolving against
 * the unresolved spelling would walk `..` lexically and miss a symlinked
 * common dir.
 */
async function pointerOf(gitdirFile: string): Promise<string[]> {
  try {
    const raw = (await _gitGuardDeps.readText(gitdirFile)).trim();
    if (raw === "") return [];
    const target = isAbsolute(raw) ? raw : resolve(realOrRaw(dirname(gitdirFile)), raw);
    return basename(target) === DOT_GIT && isLiteral(target) ? [target] : [];
  } catch {
    return [];
  }
}

async function existing(paths: readonly string[]): Promise<string[]> {
  const present = await Promise.all(paths.map((p) => _gitGuardDeps.exists(p)));
  return paths.filter((_, i) => present[i]);
}

async function worktreeEntryFiles(adminDir: string): Promise<string[]> {
  const gitdirFile = join(adminDir, GITDIR_FILE);
  const pointers = await existing([gitdirFile, join(adminDir, COMMONDIR_FILE), ...(await pointerOf(gitdirFile))]);
  return [...pointers, join(adminDir, WORKTREE_CONFIG_FILE)];
}

/**
 * Every redirecting git file for the repo that `git` describes, for every
 * worktree registered when the policy is built (literal paths: srt on Linux
 * drops glob denies).
 */
export async function listGitGuardFiles(git: GitLayout): Promise<string[]> {
  const common = commonDirOf(git);
  if (common === undefined) return [];
  const worktrees = join(common, WORKTREES_DIR);
  let names: string[] = [];
  try {
    const entries = await _gitGuardDeps.readdir(worktrees, { withFileTypes: true });
    names = entries.filter((e) => e.isDirectory() && isLiteral(join(worktrees, e.name))).map((e) => e.name);
  } catch {
    // no linked worktrees
  }
  const perWorktree = await Promise.all(names.map((name) => worktreeEntryFiles(join(worktrees, name))));
  // Filtered again as a whole: an agent-made symlink can resolve a literal name to a glob path.
  return [...(await existing([join(common, COMMONDIR_FILE)])), ...perWorktree.flat()].filter(isLiteral);
}

/**
 * `<common>/commondir` never legitimately exists (git reads it only from a
 * linked worktree's own git dir), and an absent one cannot be denied on Linux
 * (see the header). So when it is absent at session start, one created by a
 * sandboxed command is removed after that command, before nax's next git.
 * Returns undefined when there is nothing to guard (no repo, or the file
 * already exists -- listGitGuardFiles then denies it outright).
 */
export async function strayCommonDirTripwire(
  git: GitLayout,
  storyId?: string,
): Promise<(() => Promise<void>) | undefined> {
  const common = commonDirOf(git);
  if (common === undefined) return undefined;
  const target = join(common, COMMONDIR_FILE);
  if (await _gitGuardDeps.exists(target)) return undefined;
  return async () => {
    if (!(await _gitGuardDeps.exists(target))) return;
    const logger = getSafeLogger();
    try {
      await _gitGuardDeps.remove(target);
      logger?.error("sandbox", "A sandboxed command created a git commondir redirect; removed it", {
        storyId,
        path: target,
      });
    } catch (err) {
      logger?.error("sandbox", "A sandboxed command created a git commondir redirect that could not be removed", {
        storyId,
        path: target,
        error: errorMessage(err),
      });
    }
  };
}
