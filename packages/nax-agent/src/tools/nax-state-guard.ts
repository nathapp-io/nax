/**
 * Refusals that protect nax's run state (`.nax/`) from git commands an agent
 * runs through Bash (#2490, #2493).
 *
 * Rules, evaluated PER SEGMENT of a compound command by the gated and raw
 * Bash screens alike. Every one is a hard, non-escalatable denial; the ones
 * that say "while a `.nax/` exists" do nothing in a repository without one.
 *
 * 1. `git checkout` / `git restore` of a `.nax` path (the nax#2007 gate that
 *    used to protect only a standalone command), and of a WHOLE-TREE pathspec
 *    (`.`, `:/`, `*`, the root directory, exclusion-only) unless a full `.nax`
 *    exclusion follows `--`; `git reset --hard` in any form (see nax-revert.ts).
 * 2. `git update-index` with `--skip-worktree`, `--assume-unchanged` or their
 *    `--no-` forms (git accepts any unambiguous abbreviation, so the whole
 *    `--skip*` / `--assume*` / `--no-skip*` / `--no-assume*` families are
 *    refused) on a `.nax` path, or with no path operand at all (paths arrive
 *    on stdin or from `xargs`, which cannot be inspected).
 * 3. `git stash` in any form other than the read-only/bookkeeping allowlist
 *    (`list`, `show`, `create`, `store`, `drop`, `clear`) when a `.nax/`
 *    directory exists at a live working directory, between it and the root,
 *    at the root, or nested below it (depth <= 3, see nax-dirs.ts). Policy
 *    time has no cheap way to know whether a `.nax/` path is DIRTY, so the
 *    rule is conservative. A stash is allowed when its pathspec excludes the
 *    whole of `.nax` (`-- . ':!.nax'`), or when it is a `push` whose every
 *    pathspec lies outside `.nax`.
 * 4. Hiding the verb (nax-evasion.ts): `git config alias.X <value>` whose
 *    value names stash / update-index / checkout / restore / reset (so even
 *    `git config alias.co checkout` is refused while a `.nax/` exists);
 *    `GIT_CONFIG_*` set in leading assignments or `env` args next to such a
 *    verb; a command head or git subcommand built by expansion (`$G stash`,
 *    `git $X reset`) next to such a verb; `python|node|perl|ruby -c|-e` code
 *    that runs one.
 *
 * Operands are resolved against every live working directory and judged by
 * the `.nax` path SEGMENT of the root-relative result, never a substring, so
 * `cd .nax && git update-index --skip-worktree prd.json` and `foo/../.nax`
 * are caught while `src/nax-helpers.ts` is not. `-C`, `--work-tree`,
 * `--git-dir`, `GIT_WORK_TREE` and `GIT_DIR` all move the frames.
 *
 * `locateGit` reads the invocation: `\git`, wrappers, global options (an
 * unknown one is "uncertain" and sends the segment to the BACKSTOP), and
 * aliases (expanded, then the global-option skip is run again; a `!` alias is
 * guarded as shell text).
 *
 * BACKSTOP. The structured rules above only fire on a segment whose git
 * invocation `locateGit` can read. `naxStateRefusalInText` therefore also runs
 * a deliberately COARSE check over the whole command string (and every
 * `bash -c` / `eval` string, recursively) for segments the structured rules
 * could not classify (`eval git stash`, `time git stash`, `nohup`, `stdbuf`,
 * an unknown wrapper, an unknown global option): when such a segment names
 * `git` and one of `stash`, `reset --hard`, `update-index` with a hiding flag,
 * or `checkout`/`restore` of a `.nax` path or the whole tree, it is refused.
 * It exists to catch wrappers and aliases nobody can enumerate, so it trades
 * precision for coverage; a segment the structured rules DID classify keeps
 * their (precise) verdict, which is why
 * `git update-index --assume-unchanged src/a.ts` stays allowed.
 *
 * KNOWN, NOT FIXED:
 * - Stash is refused in ANY repository that has a `.nax/`, by design, even
 *   when that directory is clean.
 * - Prose that reads as a command (`echo git stash`, `python -c 'print("git
 *   stash")'`) is refused when a `.nax/` exists: the guard works on words.
 * - Under `raw` Bash approval an operand BUILT by expansion (`.na?/x`,
 *   `$D/prd.json`) is not resolved; raw mode is advisory. A verb built by
 *   expansion IS refused (rule 4), but `git $X` alone, naming no guarded
 *   verb, is not.
 * - A heredoc body fed to an interpreter (`python3 <<EOF`) is data to this
 *   reader, as is `--pathspec-from-file`, `GIT_CONFIG_GLOBAL` pointing at a
 *   file, and `export GIT_CONFIG_*` set on an earlier line.
 * - A full `:!.nax` exclusion names the root `.nax`; a whole-tree revert that
 *   excludes only that still reaches a nested package `.nax`.
 * - From inside `.nax` (`cd .nax`), every unmarked `git checkout` operand is
 *   read as a path.
 */
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { NAX_OWNED_RUN_STATE_EXPLANATION } from "./denial-redirect.ts";
import { commandHeadIndex, gitExecutableIndex, type LocatedGit, locateGit } from "./git-flags/locate.ts";
import { hasNaxDirNear, type NaxGuardContext } from "./nax-dirs.ts";
import {
  buildsVerbByExpansion,
  CONFIG_ENV_REFUSAL,
  configAliasRefusal,
  EXPANSION_REFUSAL,
  flattenCode,
  interpreterCode,
  mentionsGuardedVerb,
} from "./nax-evasion.ts";
import { isFullNaxExclusion, operandTouchesNax, resetRefusal, revertRefusal } from "./nax-revert.ts";

export type { NaxDirIndex, NaxGuardContext } from "./nax-dirs.ts";
export { createNaxDirIndex } from "./nax-dirs.ts";

/** Stash subcommands that neither capture nor replay the working tree. */
const STASH_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "show", "create", "store", "drop", "clear"]);

/** Abbreviations git really accepts: `--sk`, `--as`, `--no-sk`, `--no-as` and everything longer. */
const INDEX_HIDING_FLAG = /^--(?:no-)?(?:sk|as)/;

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

/**
 * The frames plus where `-C` / `--work-tree` / `--git-dir` / `GIT_WORK_TREE` /
 * `GIT_DIR` lead from each: every directory alone, and the whole chain in order.
 */
function withGitDirs(ctx: NaxGuardContext, dirs: readonly string[]): NaxGuardContext {
  if (dirs.length === 0) return ctx;
  const chained = ctx.frames.map((frame) => dirs.reduce((dir, next) => resolve(dir, next), frame));
  const single = ctx.frames.flatMap((frame) => dirs.map((dir) => resolve(frame, dir)));
  return { ...ctx, frames: [...ctx.frames, ...single, ...chained] };
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

/** The structured rules for one located git invocation. */
function verbRefusal(git: LocatedGit, segment: readonly string[], where: NaxGuardContext): string | undefined {
  if (git.subcommand === "checkout" || git.subcommand === "restore") {
    return revertRefusal(git.subcommand, git.args, where);
  }
  if (git.subcommand === "reset") return resetRefusal(git.args, where);
  if (git.subcommand === "stash") return stashRefusal(git.args, where);
  if (git.subcommand === "config") return hasNaxDirNear(where) ? configAliasRefusal(git.args) : undefined;
  if (git.subcommand !== "update-index") return undefined;
  const viaXargs = segment.slice(0, gitExecutableIndex(segment)).includes("xargs");
  return updateIndexRefusal(git.args, where, viaXargs);
}

/** Refusals that depend on HOW git was invoked, not on its verb: environment config, `--config-env` and `!` aliases. */
function invocationRefusal(git: LocatedGit, segment: readonly string[], where: NaxGuardContext): string | undefined {
  if (git.unresolvedAlias && hasNaxDirNear(where)) return ALIAS_REFUSAL;
  if (git.configEnv && mentionsGuardedVerb(segment.join(" ")) && hasNaxDirNear(where)) return CONFIG_ENV_REFUSAL;
  return git.shellAlias === undefined ? undefined : naxStateRefusalInText(git.shellAlias, where);
}

/**
 * The refusal for one command segment (its words, `git` possibly behind
 * wrappers and global options), or undefined. A segment whose git invocation
 * cannot be located is NOT judged here; see the BACKSTOP in the header. One
 * that CAN be located but met a global option this reader does not know is
 * judged by the structured rules and then, with a `.nax/` present, by the BACKSTOP.
 */
export function naxStateRefusal(segment: readonly string[], ctx: NaxGuardContext): string | undefined {
  const inner = shellCommandString(segment);
  if (inner !== undefined) return naxStateRefusalInText(inner, ctx);
  const code = interpreterCode(segment);
  if (code !== undefined) return naxStateRefusalInText(flattenCode(code), ctx);
  const git = locateGit(segment);
  if (git === undefined) return undefined;
  const where = withGitDirs(ctx, git.dirs);
  const refusal = invocationRefusal(git, segment, where) ?? verbRefusal(git, segment, where);
  if (refusal !== undefined || !git.uncertain || !hasNaxDirNear(where)) return refusal;
  return backstopRefusal(segment, where);
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

/** `git`, `\git` or a path ending in `/git`. */
function isGitToken(word: string): boolean {
  return word === "git" || word === "\\git" || word.endsWith("/git");
}

/** The coarse revert check: whole-tree and `.nax` operands after the first word naming `verb`. */
function backstopRevert(words: readonly string[], verb: string, ctx: NaxGuardContext): string | undefined {
  const at = words.findIndex((word) => namesVerb(word, verb));
  if (at === -1) return undefined;
  const refusal = revertRefusal(verb, words.slice(at + 1), ctx);
  if (refusal !== undefined) return refusal;
  return words.some((word) => operandTouchesNax(word, ctx)) ? NAX_OWNED_RUN_STATE_EXPLANATION : undefined;
}

/**
 * The coarse check for a segment `locateGit` could not read. Requires a `git`
 * token in the same segment, so `echo stash` and a commit message that merely
 * contains the word never match.
 */
function backstopRefusal(words: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (!words.some(isGitToken)) return undefined;
  const mentions = (verb: string) => words.some((word) => namesVerb(word, verb));
  if (mentions("update-index") && words.some((word) => INDEX_HIDING_FLAG.test(word))) return UPDATE_INDEX_REFUSAL;
  if (mentions("stash") && !stashIsSafeWord(words)) return STASH_REFUSAL;
  if (mentions("reset")) {
    const reset = resetRefusal(words, ctx);
    if (reset !== undefined) return reset;
  }
  return backstopRevert(words, "checkout", ctx) ?? backstopRevert(words, "restore", ctx);
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
  const code = withoutHeredocBodies(command);
  if (buildsVerbByExpansion(code) && hasNaxDirNear(ctx)) return EXPANSION_REFUSAL;
  for (const words of shellSegments(code)) {
    const moved = framesAfterCd(words, frames);
    if (moved !== undefined) {
      frames = moved;
      continue;
    }
    const here = { ...ctx, frames };
    const refusal =
      naxStateRefusal(words, here) ??
      nestedRefusal(words, here) ??
      (locateGit(words) === undefined && hasNaxDirNear(here) ? backstopRefusal(words, here) : undefined);
    if (refusal !== undefined) return refusal;
  }
  return undefined;
}
