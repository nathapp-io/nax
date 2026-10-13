/**
 * Refusals that protect nax's run state (`.nax/`) from git commands an agent
 * runs through Bash (#2490).
 *
 * Three rules, evaluated PER SEGMENT of a compound command by the gated and
 * raw Bash screens alike:
 *
 * 1. `git checkout` / `git restore` of a `.nax` path (the nax#2007 gate that
 *    used to protect only a standalone command).
 * 2. `git update-index` with `--skip-worktree`, `--assume-unchanged` or their
 *    `--no-` forms (git accepts any unambiguous abbreviation, so the whole
 *    `--skip*` / `--assume*` / `--no-skip*` / `--no-assume*` families are
 *    refused) on a `.nax` path, or with no path operand at all (paths arrive
 *    on stdin or from `xargs`, which cannot be inspected).
 * 3. `git stash` in any form other than the read-only/bookkeeping allowlist
 *    (`list`, `show`, `create`, `store`, `drop`, `clear`) when a `.nax/`
 *    directory exists at a live working directory, between it and the root,
 *    or at the root. Policy time has no cheap way to know whether a `.nax/`
 *    path is DIRTY, so the rule is conservative. A stash is allowed when its
 *    pathspec excludes the whole of `.nax` (`-- . ':!.nax'`), or when it is a
 *    `push` whose every pathspec lies outside `.nax`.
 *
 * Operands are resolved against every live working directory and judged by
 * the `.nax` path SEGMENT of the root-relative result, never a substring, so
 * `cd .nax && git update-index --skip-worktree prd.json` and `foo/../.nax`
 * are caught while `src/nax-helpers.ts` is not.
 *
 * KNOWN, NOT FIXED: a whole-tree `git checkout .` / `git restore .` also
 * reverts `.nax` (pre-existing gap: it names no `.nax` operand). And stash is
 * refused in ANY repository that has a `.nax/`, by design, even when that
 * directory is clean.
 */
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { crudeCommandSegments, NAX_OWNED_RUN_STATE_EXPLANATION } from "./denial-redirect.ts";
import { commandHeadIndex, locateGit } from "./git-flags/locate.ts";

/** Where a segment runs: every live working-directory frame, and the permitted root. */
export interface NaxGuardContext {
  readonly frames: readonly string[];
  readonly root: string;
}

const REVERT_VERBS: ReadonlySet<string> = new Set(["checkout", "restore"]);

/** Stash subcommands that neither capture nor replay the working tree. */
const STASH_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "show", "create", "store", "drop", "clear"]);

/** `--skip-worktree`, `--assume-unchanged`, their `--no-` forms, and abbreviations of them. */
const INDEX_HIDING_FLAG = /^--(?:no-)?(?:skip|assume)/;

/** `:!.nax`, `:^.nax`, `:(exclude).nax`, with an optional trailing `/` or `/**`; nothing narrower. */
const NAX_EXCLUDE_PATHSPEC = /^:(?:[!^]|\(exclude[^)]*\))\.nax(?:\/(?:\*\*)?)?$/;

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh"]);

const UPDATE_INDEX_REFUSAL =
  `${NAX_OWNED_RUN_STATE_EXPLANATION} ` +
  "Marking it with `git update-index --skip-worktree` or `--assume-unchanged` hides it from git and from nax's own commits, " +
  "and the flag outlives the run. To see whether something pre-existed, use `git diff HEAD -- <file>` or `git show HEAD:<file>`.";

const STASH_REFUSAL =
  "`git stash` is refused while the repository holds nax's run state under `.nax/`: the stash would capture " +
  "nax's uncommitted state and a later pop would replay stale copies over what nax has written since. " +
  "To check whether something pre-existed, use `git diff HEAD -- <file>` or `git show HEAD:<file>`. " +
  "A stash whose pathspec excludes it (`git stash push -- . ':!.nax'`) is allowed.";

/** True when `.nax` is a path segment of `path` (root-relative when inside the root, else as written). */
function hasNaxSegment(path: string): boolean {
  return path.split(/[\\/]/).includes(".nax");
}

/** True when `operand`, resolved from any frame, lands on or under a `.nax` directory. */
function operandTouchesNax(operand: string, ctx: NaxGuardContext): boolean {
  if (hasNaxSegment(operand)) return true;
  return ctx.frames.some((frame) => {
    const rel = relative(ctx.root, resolve(frame, operand));
    return !rel.startsWith("..") && hasNaxSegment(rel);
  });
}

/** True when a `.nax/` exists at a frame, between a frame and the root, or at the root. */
function hasNaxDirNear(ctx: NaxGuardContext): boolean {
  const candidates = new Set<string>([ctx.root]);
  for (const frame of ctx.frames) {
    let dir = frame;
    candidates.add(dir);
    while (dir !== ctx.root && dir.startsWith(`${ctx.root}${sep}`)) {
      dir = resolve(dir, "..");
      candidates.add(dir);
    }
  }
  return [...candidates].some((dir) => existsSync(join(dir, ".nax")));
}

function revertRefusal(operands: readonly string[], ctx: NaxGuardContext): string | undefined {
  return operands.some((word) => word !== "--" && operandTouchesNax(word, ctx))
    ? NAX_OWNED_RUN_STATE_EXPLANATION
    : undefined;
}

function updateIndexRefusal(args: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (!args.some((word) => INDEX_HIDING_FLAG.test(word))) return undefined;
  const operands = args.filter((word) => !word.startsWith("-"));
  if (operands.length === 0) return hasNaxDirNear(ctx) ? UPDATE_INDEX_REFUSAL : undefined;
  return operands.some((word) => operandTouchesNax(word, ctx)) ? UPDATE_INDEX_REFUSAL : undefined;
}

/** A directory pathspec is also unsafe when it has a `.nax/` directly inside it. */
function pathspecIsOutsideNax(spec: string, ctx: NaxGuardContext): boolean {
  if (spec.startsWith(":") || operandTouchesNax(spec, ctx)) return false;
  return ctx.frames.every((frame) => {
    const resolved = resolve(frame, spec);
    const rel = relative(ctx.root, resolved);
    return rel !== "" && !existsSync(join(resolved, ".nax"));
  });
}

function stashRefusal(args: readonly string[], ctx: NaxGuardContext): string | undefined {
  const first = args[0];
  if (first !== undefined && STASH_SAFE_SUBCOMMANDS.has(first)) return undefined;
  if (!hasNaxDirNear(ctx)) return undefined;
  if (args.some((word) => NAX_EXCLUDE_PATHSPEC.test(word))) return undefined;
  const isPush = first === undefined || first.startsWith("-") || first === "push" || first === "save";
  const separator = args.indexOf("--");
  if (isPush && separator !== -1) {
    const specs = args.slice(separator + 1);
    if (specs.length > 0 && specs.every((spec) => pathspecIsOutsideNax(spec, ctx))) return undefined;
  }
  return STASH_REFUSAL;
}

/** The string a `bash -c <string>` style segment runs, or undefined. */
function shellCommandString(words: readonly string[]): string | undefined {
  const head = commandHeadIndex(words);
  const shell = words[head]?.split("/").pop();
  if (shell === undefined || !SHELLS.has(shell)) return undefined;
  const flag = words.findIndex((word, index) => index > head && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
  if (flag === -1 || flag + 1 >= words.length) return undefined;
  return words
    .slice(flag + 1)
    .join(" ")
    .replace(/^\s*['"]|['"]\s*$/g, "");
}

/**
 * The refusal for one command segment (its words, `git` possibly behind
 * wrappers and global options), or undefined.
 */
export function naxStateRefusal(segment: readonly string[], ctx: NaxGuardContext): string | undefined {
  const inner = shellCommandString(segment);
  if (inner !== undefined) return naxStateRefusalInText(inner, ctx);
  const git = locateGit(segment);
  if (git === undefined) return undefined;
  if (REVERT_VERBS.has(git.subcommand)) return revertRefusal(git.args, ctx);
  if (git.subcommand === "update-index") return updateIndexRefusal(git.args, ctx);
  if (git.subcommand === "stash") return stashRefusal(git.args, ctx);
  return undefined;
}

/** A word that is only shell punctuation around a command: a redirect, or a group opener/closer. */
function crudeWord(word: string): string {
  return word.replace(/^[({]+/, "").replace(/[)}]+$/, "");
}

/**
 * `naxStateRefusal` over command TEXT, using the crude splitter. Used for a
 * command the lexer could not read (raw mode only) and for the string behind
 * `bash -c`. Redirect words (`2>&1`, `>out`) and group punctuation are
 * dropped, and quotes are stripped, so `git stash 2>&1` and `(git stash)` read
 * like `git stash`.
 */
export function naxStateRefusalInText(command: string, ctx: NaxGuardContext): string | undefined {
  for (const segment of crudeCommandSegments(command)) {
    const words = segment
      .filter((word) => !/^\d*[<>&]/.test(word))
      .map((word) => crudeWord(word).replace(/^['"]|['"]$/g, ""))
      .filter((word) => word.length > 0);
    const refusal = naxStateRefusal(words, ctx);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}
