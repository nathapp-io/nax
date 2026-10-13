/**
 * Refusals that protect nax's run state (`.nax/`) from git commands an agent
 * runs through Bash (#2490).
 *
 * Three rules, all evaluated PER SEGMENT of a compound command by the gated
 * and raw Bash screens alike:
 *
 * 1. `git checkout` / `git restore` of a `.nax` path (the nax#2007 gate that
 *    used to protect only a standalone command).
 * 2. `git update-index` with `--skip-worktree`, `--assume-unchanged` or their
 *    `--no-` forms on a `.nax` path. The flag hides nax's PRD from `git status`
 *    and from nax's own auto-commit, and it outlives the run.
 * 3. `git stash` / `push` / `save` / `pop` / `apply`. Policy time has no cheap
 *    way to know whether a `.nax/` path is DIRTY (it would need a git spawn in
 *    a synchronous check), so the rule is conservative: refuse whenever the
 *    working directory holds a `.nax/` directory, unless the command carries a
 *    pathspec that excludes `.nax` (`-- . ':!.nax'`). `list` and `show` are
 *    read-only and stay allowed.
 *
 * The gate is a `.nax` path SEGMENT, never a substring.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  crudeCommandSegments,
  NAX_OWNED_RUN_STATE_EXPLANATION,
  naxOwnedRunStateExplanation,
  withoutTimeoutPrefix,
} from "./denial-redirect.ts";

const INDEX_HIDING_FLAGS: ReadonlySet<string> = new Set([
  "--skip-worktree",
  "--no-skip-worktree",
  "--assume-unchanged",
  "--no-assume-unchanged",
]);

/** Stash subcommands that capture or replay the working tree. `list`/`show` are not here. */
const STASH_TREE_SUBCOMMANDS: ReadonlySet<string> = new Set(["push", "save", "pop", "apply"]);

/** `:!.nax`, `:^.nax`, `:(exclude).nax`, optionally behind `**\/`. */
const NAX_EXCLUDE_PATHSPEC = /^:(?:[!^]|\(exclude[^)]*\))(?:\*\*\/)?\.nax(?:\/.*)?$/;

const UPDATE_INDEX_REFUSAL =
  `${NAX_OWNED_RUN_STATE_EXPLANATION} ` +
  "Marking it with `git update-index --skip-worktree` or `--assume-unchanged` hides it from git and from nax's own commits, " +
  "and the flag outlives the run. To see whether something pre-existed, use `git diff HEAD -- <file>` or `git show HEAD:<file>`.";

const STASH_REFUSAL =
  "`git stash` is refused while the repository holds nax's run state under `.nax/`: the stash would capture " +
  "nax's uncommitted state and a later pop would replay stale copies over what nax has written since. " +
  "To check whether something pre-existed, use `git diff HEAD -- <file>` or `git show HEAD:<file>`. " +
  "A stash whose pathspec excludes it (`git stash push -- . ':!.nax'`) is allowed.";

function isNaxPath(word: string): boolean {
  return word.split("/").includes(".nax");
}

function updateIndexRefusal(rest: readonly string[], hasNaxDir: boolean): string | undefined {
  if (!rest.some((word) => INDEX_HIDING_FLAGS.has(word))) return undefined;
  if (rest.some((word) => !word.startsWith("-") && isNaxPath(word))) return UPDATE_INDEX_REFUSAL;
  // Paths read from stdin cannot be inspected here.
  if (hasNaxDir && (rest.includes("--stdin") || rest.includes("--index-info"))) return UPDATE_INDEX_REFUSAL;
  return undefined;
}

function stashRefusal(rest: readonly string[], hasNaxDir: boolean): string | undefined {
  if (!hasNaxDir) return undefined;
  const first = rest[0];
  if (first !== undefined && !first.startsWith("-") && !STASH_TREE_SUBCOMMANDS.has(first)) return undefined;
  if (rest.some((word) => NAX_EXCLUDE_PATHSPEC.test(word))) return undefined;
  return STASH_REFUSAL;
}

/**
 * The refusal for one command segment (its words, `git` first), or undefined.
 * `hasNaxDir` is whether the segment's working directory holds a `.nax/`.
 */
export function naxStateRefusal(segment: readonly string[], hasNaxDir: boolean): string | undefined {
  const revert = naxOwnedRunStateExplanation(segment);
  if (revert !== undefined) return revert;
  const av = withoutTimeoutPrefix(segment);
  if (av[0] !== "git") return undefined;
  const verb = av[1];
  if (verb === "update-index") return updateIndexRefusal(av.slice(2), hasNaxDir);
  if (verb === "stash") return stashRefusal(av.slice(2), hasNaxDir);
  return undefined;
}

/** True when any live working-directory frame holds a `.nax/` directory. */
export function anyFrameHasNaxDir(frames: readonly string[]): boolean {
  return frames.some((frame) => existsSync(join(frame, ".nax")));
}

/**
 * `naxStateRefusal` over a command the lexer could not read (raw mode only),
 * using the crude splitter. Quotes are stripped from each word so a quoted
 * pathspec such as `':!.nax'` still reads as an exclusion.
 */
export function naxStateRefusalInText(command: string, hasNaxDir: boolean): string | undefined {
  for (const segment of crudeCommandSegments(command)) {
    const refusal = naxStateRefusal(
      segment.map((word) => word.replace(/^['"]|['"]$/g, "")),
      hasNaxDir,
    );
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}
