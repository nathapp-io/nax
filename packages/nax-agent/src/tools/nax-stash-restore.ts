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
function restoreRef(args: readonly string[]): string | undefined {
  let i = 0;
  if (args[i] === "--index") i += 1;
  if (args[i] === "-q" || args[i] === "--quiet") i += 1;
  if (i === args.length) return "stash@{0}";
  const ref = args[i];
  return i + 1 === args.length && ref !== undefined && /^(?:stash@\{\d+\}|\d+)$/.test(ref) ? ref : undefined;
}

/** Git -z output is unquoted; a .nax segment at ANY depth protects the whole operation. */
function listingIsClean(cwd: string, args: readonly string[]): boolean {
  const listing = _naxStateGuardDeps.git(cwd, args);
  return listing !== undefined && !listing.split("\0").some((path) => path.split("/").includes(".nax"));
}

/** Literal existing files or directories only; never symlinks, magic or globs. */
function pathIsClean(spec: string, ctx: NaxGuardContext): boolean {
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
  if (args[0] === "pop" || args[0] === "apply") {
    const ref = restoreRef(args.slice(1));
    return (
      ref !== undefined &&
      ctx.frames.every((frame) =>
        listingIsClean(frame, ["stash", "show", "-z", "--name-only", "--no-renames", "--include-untracked", ref]),
      )
    );
  }
  const separator = args.indexOf("--");
  if (args[0] !== "push" || separator === -1) return false;
  const specs = args.slice(separator + 1);
  if (specs.some((spec) => isFullNaxExclusion(spec, ctx))) return true;
  return specs.length > 0 && specs.every((spec) => pathIsClean(spec, ctx));
}
