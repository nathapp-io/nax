// Synchronous policy checks cannot use the asynchronous runtime spawn slot (#2539).
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { gitSpawnEnv } from "#src/internal/git-env";
import { GIT_TIMEOUT_MS } from "#src/internal/git-exec";
import type { NaxGuardContext } from "./nax-dirs.ts";
import { isFullNaxExclusion, operandTouchesNax } from "./nax-revert.ts";

export const _naxStateGuardDeps = {
  /** stdout on success, undefined on a spawn error, timeout or non-zero exit. */
  git(cwd: string, args: readonly string[]): string | undefined {
    const out = spawnSync("git", [...args], {
      cwd,
      env: gitSpawnEnv(),
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
    });
    return out.status === 0 && out.error === undefined ? out.stdout : undefined;
  },
};

/** Parse only [--index] [-q|--quiet] [<numeric stash ref>], before doing any I/O. */
function restoreRequest(args: readonly string[]): { ref: string; index: boolean } | undefined {
  const index = args[0] === "--index";
  let i = index ? 1 : 0;
  if (args[i] === "-q" || args[i] === "--quiet") i += 1;
  if (i === args.length) return { ref: "stash@{0}", index };
  const ref = args[i];
  return i + 1 === args.length && ref !== undefined && /^(?:stash@\{\d+\}|\d+)$/.test(ref) ? { ref, index } : undefined;
}

/** Git -z output is unquoted; a .nax segment at ANY depth protects the whole operation. */
function listingIsClean(cwd: string, args: readonly string[]): boolean {
  const listing = _naxStateGuardDeps.git(cwd, args);
  return listing !== undefined && !listing.split("\0").some((path) => path.split("/").includes(".nax"));
}

/** The listing of the stash's WORKING-TREE snapshot: what a plain `pop` / `apply` writes back. */
function worktreeListingIsClean(cwd: string, ref: string): boolean {
  return listingIsClean(cwd, ["stash", "show", "-z", "--name-only", "--no-renames", "--include-untracked", ref]);
}

/**
 * The stash's INDEX snapshot (B1): a stash commit has one parent for the base and
 * one for the index, and `--index` writes that second parent back into the index.
 * It is NOT the tree `stash show` lists — a `.nax` change that was staged and then
 * reverted in the working tree appears in the index parent alone, so a listing-only
 * check would let `pop --index` replay stale nax state over what nax has written
 * since. Any failure to read it refuses.
 */
function indexSnapshotIsClean(cwd: string, ref: string): boolean {
  // A bare `N` resolves inside `git stash` only, so the diff — a plain revision —
  // needs the `stash@{N}` spelling git itself resolves the number to.
  const rev = ref.includes("@{") ? ref : `stash@{${ref}}`;
  return listingIsClean(cwd, ["diff", "-z", "--name-only", "--no-renames", `${rev}^1`, `${rev}^2`]);
}

/** Every frame must list the stash successfully and clean, index snapshot included for `--index`. */
function restoreIsExempt(args: readonly string[], ctx: NaxGuardContext): boolean {
  const request = restoreRequest(args);
  if (request === undefined) return false;
  return ctx.frames.every(
    (frame) =>
      worktreeListingIsClean(frame, request.ref) && (!request.index || indexSnapshotIsClean(frame, request.ref)),
  );
}

/** Literal existing files or directories only; never symlinks, magic or globs. */
export function pathIsClean(spec: string, ctx: NaxGuardContext): boolean {
  if (spec.startsWith(":") || /[*?[]/.test(spec) || operandTouchesNax(spec, ctx)) return false;
  return ctx.frames.every((frame) => {
    try {
      const path = resolve(frame, spec);
      const stat = lstatSync(path);
      if (stat.isFile()) return true;
      if (!stat.isDirectory() || path === ctx.root) return false;
      return listingIsClean(frame, ["ls-files", "-z", "--cached", "--others", "--", spec]);
    } catch {
      return false;
    }
  });
}

/** Stash mutations that can be proved not to capture or replay nax state. */
export function stashIsExempt(args: readonly string[], ctx: NaxGuardContext): boolean {
  if (args[0] === "pop" || args[0] === "apply") return restoreIsExempt(args.slice(1), ctx);
  if (args[0] !== "push") return false;
  const separator = args.indexOf("--");
  const options = args.slice(1, separator === -1 ? args.length : separator);
  if (options.some((word) => word === "--pathspec-from-file" || word.startsWith("--pathspec-from-file="))) {
    return false;
  }
  const specs: string[] = [];
  for (let i = 0; i < options.length; i += 1) {
    const word = options[i] as string;
    if (word === "-m" || word === "--message") i += 1;
    else if (!word.startsWith("-")) specs.push(word);
  }
  if (separator !== -1) specs.push(...args.slice(separator + 1));
  if (specs.some((spec) => isFullNaxExclusion(spec, ctx))) return true;
  return specs.length > 0 && specs.every((spec) => pathIsClean(spec, ctx));
}
