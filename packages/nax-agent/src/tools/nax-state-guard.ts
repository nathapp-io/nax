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
 * BACKSTOP. The structured rules above only fire on a segment whose git
 * invocation `locateGit` can read. `naxStateRefusalInText` therefore also runs
 * a deliberately COARSE check over the whole command string (and every
 * `bash -c` / `eval` string, recursively) for segments the structured rules
 * could not classify (`eval git stash`, `time git stash`, `nohup`, `stdbuf`,
 * an unknown wrapper): when such a segment names `git` and one of `stash`,
 * `update-index` with a hiding flag, or `checkout`/`restore` of a `.nax` path,
 * it is refused. It exists to catch wrappers and aliases nobody can enumerate,
 * so it trades precision for coverage; a segment the structured rules DID
 * classify keeps their (precise) verdict, which is why
 * `git update-index --assume-unchanged src/a.ts` stays allowed.
 *
 * KNOWN, NOT FIXED:
 * - A whole-tree `git checkout .` / `git restore .` also reverts `.nax`
 *   (pre-existing gap: it names no `.nax` operand).
 * - Stash is refused in ANY repository that has a `.nax/`, by design, even
 *   when that directory is clean.
 * - Only the root `.nax/` (and one at a working directory on the way down) is
 *   looked for; a nested-only `packages/a/.nax` is not seen by the stash rule.
 * - `git checkout feature/.nax` (a branch whose name has a `.nax` segment) is
 *   a false positive; it is kept.
 */
import { existsSync, lstatSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { NAX_OWNED_RUN_STATE_EXPLANATION } from "./denial-redirect.ts";
import { commandHeadIndex, gitExecutableIndex, locateGit } from "./git-flags/locate.ts";

/** Where a segment runs: every live working-directory frame, and the permitted root. */
export interface NaxGuardContext {
  readonly frames: readonly string[];
  readonly root: string;
}

const REVERT_VERBS: ReadonlySet<string> = new Set(["checkout", "restore"]);

/** Stash subcommands that neither capture nor replay the working tree. */
const STASH_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "show", "create", "store", "drop", "clear"]);

/** Abbreviations git really accepts: `--sk`, `--as`, `--no-sk`, `--no-as` and everything longer. */
const INDEX_HIDING_FLAG = /^--(?:no-)?(?:sk|as)/;

/** `:!X`, `:^X`, `:(exclude)X`. */
const EXCLUDE_PATHSPEC = /^:(?:[!^]|\(exclude[^)]*\))(.*)$/;

const SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "zsh", "dash", "ksh", "eval"]);

const UPDATE_INDEX_REFUSAL =
  `${NAX_OWNED_RUN_STATE_EXPLANATION} ` +
  "Marking it with `git update-index --skip-worktree` or `--assume-unchanged` hides it from git and from nax's own commits, " +
  "and the flag outlives the run. To see whether something pre-existed, use `git diff HEAD -- <file>` or `git show HEAD:<file>`.";

const STASH_REFUSAL =
  "`git stash` is refused while the repository holds nax's run state under `.nax/`: the stash would capture " +
  "nax's uncommitted state and a later pop would replay stale copies over what nax has written since. " +
  "To check whether something pre-existed, use `git diff HEAD -- <file>` or `git show HEAD:<file>`. " +
  "A `git stash push -- . ':!.nax'` (or `push` of named regular files) is allowed.";

const ALIAS_REFUSAL =
  "A git alias defined through `--config-env` cannot be inspected while the repository holds nax's run state under `.nax/`. " +
  "Run the git verb directly, or define the alias with `-c alias.NAME=VALUE`.";

/** True when `.nax` is a path segment of `path`. */
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

/** The frames plus where `-C` / `--work-tree` / `--git-dir` (chained, in order) lead from each. */
function withGitDirs(ctx: NaxGuardContext, dirs: readonly string[]): NaxGuardContext {
  if (dirs.length === 0) return ctx;
  const moved = ctx.frames.map((frame) => dirs.reduce((dir, next) => resolve(dir, next), frame));
  return { root: ctx.root, frames: [...ctx.frames, ...moved] };
}

function revertRefusal(operands: readonly string[], ctx: NaxGuardContext): string | undefined {
  return operands.some((word) => word !== "--" && operandTouchesNax(word, ctx))
    ? NAX_OWNED_RUN_STATE_EXPLANATION
    : undefined;
}

function updateIndexRefusal(args: readonly string[], ctx: NaxGuardContext, viaXargs: boolean): string | undefined {
  if (!args.some((word) => INDEX_HIDING_FLAG.test(word))) return undefined;
  const operands = args.filter((word) => !word.startsWith("-"));
  if (operands.some((word) => operandTouchesNax(word, ctx))) return UPDATE_INDEX_REFUSAL;
  // Paths that arrive on stdin, from xargs or from an expansion cannot be inspected, with or without other operands.
  const uninspectable =
    viaXargs ||
    operands.length === 0 ||
    operands.some((word) => /[$`]/.test(word)) ||
    args.includes("--stdin") ||
    args.includes("--index-info");
  return uninspectable && hasNaxDirNear(ctx) ? UPDATE_INDEX_REFUSAL : undefined;
}

/** `:!.nax`, `:^.nax/`, `:(exclude).nax/**` -- and it must resolve to `<root>/.nax` from EVERY frame. */
function isFullNaxExclusion(spec: string, ctx: NaxGuardContext): boolean {
  const target = EXCLUDE_PATHSPEC.exec(spec)?.[1];
  if (target === undefined) return false;
  const path = target.replace(/\/(?:\*\*)?$/, "");
  return ctx.frames.every((frame) => resolve(frame, path) === join(ctx.root, ".nax"));
}

/** An existing regular file (not a directory, symlink or glob) that is not under `.nax`. */
function isPlainFileOutsideNax(spec: string, ctx: NaxGuardContext): boolean {
  if (spec.startsWith(":") || /[*?[]/.test(spec) || operandTouchesNax(spec, ctx)) return false;
  return ctx.frames.every((frame) => {
    try {
      return lstatSync(resolve(frame, spec)).isFile();
    } catch {
      return false;
    }
  });
}

/** Only `push`, and only AFTER `--`, may use a pathspec exemption. */
function pushIsExempt(args: readonly string[], ctx: NaxGuardContext): boolean {
  const separator = args.indexOf("--");
  if (args[0] !== "push" || separator === -1) return false;
  const specs = args.slice(separator + 1);
  if (specs.some((spec) => isFullNaxExclusion(spec, ctx))) return true;
  return specs.length > 0 && specs.every((spec) => isPlainFileOutsideNax(spec, ctx));
}

function stashRefusal(args: readonly string[], ctx: NaxGuardContext): string | undefined {
  const first = args[0];
  if (first !== undefined && STASH_SAFE_SUBCOMMANDS.has(first)) return undefined;
  if (!hasNaxDirNear(ctx)) return undefined;
  return pushIsExempt(args, ctx) ? undefined : STASH_REFUSAL;
}

/** The string a `bash -c <string>` / `eval <string>` style segment runs, or undefined. */
function shellCommandString(words: readonly string[]): string | undefined {
  const head = commandHeadIndex(words);
  const shell = words[head]?.split("/").pop();
  if (shell === undefined || !SHELLS.has(shell)) return undefined;
  const flag = shell === "eval" ? head : words.findIndex((word, i) => i > head && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
  if (flag === -1 || flag + 1 >= words.length) return undefined;
  return words
    .slice(flag + 1)
    .join(" ")
    .replace(/^\s*['"]|['"]\s*$/g, "");
}

/**
 * The refusal for one command segment (its words, `git` possibly behind
 * wrappers and global options), or undefined. A segment whose git invocation
 * cannot be located is NOT judged here; see the BACKSTOP in the header.
 */
export function naxStateRefusal(segment: readonly string[], ctx: NaxGuardContext): string | undefined {
  const inner = shellCommandString(segment);
  if (inner !== undefined) return naxStateRefusalInText(inner, ctx);
  const git = locateGit(segment);
  if (git === undefined) return undefined;
  const where = withGitDirs(ctx, git.dirs);
  if (git.unresolvedAlias && hasNaxDirNear(where)) return ALIAS_REFUSAL;
  if (REVERT_VERBS.has(git.subcommand)) return revertRefusal(git.args, where);
  if (git.subcommand === "update-index") {
    const viaXargs = segment.slice(0, gitExecutableIndex(segment)).includes("xargs");
    return updateIndexRefusal(git.args, where, viaXargs);
  }
  if (git.subcommand === "stash") return stashRefusal(git.args, where);
  return undefined;
}

/** Split command text into segments of tokens: quotes are removed and kept atomic; `; & | ( ) { }` and newlines end a segment. */
function shellSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  let token = "";
  let quote: string | undefined;
  let inToken = false;
  const endToken = () => {
    if (inToken) (segments[segments.length - 1] as string[]).push(token);
    token = "";
    inToken = false;
  };
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      else token += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
    } else if (/\s/.test(ch) && ch !== "\n") {
      endToken();
    } else if (";&|(){}\n".includes(ch)) {
      endToken();
      segments.push([]);
    } else {
      token += ch;
      inToken = true;
    }
  }
  endToken();
  return segments.map((words) => words.filter((word) => !/^\d*[<>]/.test(word))).filter((words) => words.length > 0);
}

const HEREDOC_MARKER = /(?<!<)<<(?!<)-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w-]*))/g;

/** The heredoc terminators a command line opens, in order. */
function heredocTerminators(line: string): string[] {
  return [...line.matchAll(HEREDOC_MARKER)].map((match) => (match[1] ?? match[2] ?? match[3]) as string);
}

/**
 * Drop heredoc bodies (the lines after `<<WORD`, `<<'WORD'`, `<<"WORD"` or
 * `<<-WORD` up to the terminator line): they are data, not commands, so a
 * commit message that says "git stash" is not a stash.
 */
function withoutHeredocBodies(command: string): string {
  const kept: string[] = [];
  let pending: string[] = [];
  for (const line of command.split("\n")) {
    if (pending.length > 0) {
      if (line.trim() === pending[0]) pending = pending.slice(1);
      continue;
    }
    kept.push(line);
    pending = heredocTerminators(line);
  }
  return kept.join("\n");
}

/** `cd X` / `pushd X` widens the frames to also include X resolved from each (the union stays conservative). */
function framesAfterCd(words: readonly string[], frames: readonly string[]): readonly string[] | undefined {
  const head = words[commandHeadIndex(words)];
  if (head !== "cd" && head !== "pushd") return undefined;
  const target = words.slice(commandHeadIndex(words) + 1).find((word) => !word.startsWith("-"));
  if (target === undefined || /^[$~]/.test(target)) return frames;
  return [...frames, ...frames.map((frame) => resolve(frame, target))];
}

function aliasTarget(word: string): string | undefined {
  return /^alias\.[^=]+=(.*)$/is.exec(word)?.[1];
}

/** True when `word` is a git verb token, or an alias definition that expands to one. */
function namesVerb(word: string, verb: string): boolean {
  return word === verb || (aliasTarget(word)?.includes(verb) ?? false);
}

/**
 * The coarse check for a segment `locateGit` could not read. Requires a `git`
 * token in the same segment, so `echo stash` and a commit message that merely
 * contains the word never match.
 */
function backstopRefusal(words: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (!words.some((word) => word === "git" || word.endsWith("/git"))) return undefined;
  const mentions = (verb: string) => words.some((word) => namesVerb(word, verb));
  if (mentions("update-index") && words.some((word) => INDEX_HIDING_FLAG.test(word))) return UPDATE_INDEX_REFUSAL;
  if (mentions("stash") && !stashIsSafeWord(words)) return STASH_REFUSAL;
  if ((mentions("checkout") || mentions("restore")) && words.some((word) => operandTouchesNax(word, ctx))) {
    return NAX_OWNED_RUN_STATE_EXPLANATION;
  }
  return undefined;
}

function stashIsSafeWord(words: readonly string[]): boolean {
  const next = words[words.indexOf("stash") + 1];
  return words.includes("stash") && next !== undefined && STASH_SAFE_SUBCOMMANDS.has(next);
}

/** Recurse into every multi-word token of a segment that runs a nested shell. */
function nestedRefusal(words: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (!words.some((word) => SHELLS.has(word.split("/").pop() as string) || /^-[A-Za-z]*c[A-Za-z]*$/.test(word))) {
    return undefined;
  }
  for (const word of words) {
    if (!/\s/.test(word)) continue;
    const refusal = naxStateRefusalInText(word, ctx);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}

/**
 * `naxStateRefusal` over command TEXT: the raw command string in every Bash
 * mode, and the string behind `bash -c` / `eval`. Tracks `cd` itself, applies
 * the structured rules to each segment, and the coarse BACKSTOP (see the
 * header) to segments whose git invocation it could not read.
 */
export function naxStateRefusalInText(command: string, ctx: NaxGuardContext): string | undefined {
  let frames = ctx.frames;
  for (const words of shellSegments(withoutHeredocBodies(command))) {
    const moved = framesAfterCd(words, frames);
    if (moved !== undefined) {
      frames = moved;
      continue;
    }
    const here = { root: ctx.root, frames };
    const refusal =
      naxStateRefusal(words, here) ??
      nestedRefusal(words, here) ??
      (locateGit(words) === undefined && hasNaxDirNear(here) ? backstopRefusal(words, here) : undefined);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}
