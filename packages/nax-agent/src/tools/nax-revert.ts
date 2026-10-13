/**
 * Reverts of nax's run state (`.nax/`) through git, for the Bash guard
 * (#2490, #2493).
 *
 * Three ways a revert reaches `.nax/`:
 * 1. an operand that names a `.nax` path (`git checkout -- .nax/x`);
 * 2. a WHOLE-TREE pathspec (`git checkout .`, `git restore --source=HEAD~1 .`,
 *    `:/`, `*`, the root directory itself, a pathspec made only of exclusions),
 *    unless a full `.nax` exclusion follows `--`;
 * 3. `git reset --hard`, which has no pathspec form at all.
 *
 * For `git checkout` an operand is a PATH only after `--`, when it exists on
 * disk relative to a frame, or when it resolves into `.nax` from the root; so
 * `git checkout feature/.nax` (a branch whose name has a `.nax` segment) is
 * not a revert. `git restore` has no branch operand, so all its operands are paths.
 */
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { NAX_OWNED_RUN_STATE_EXPLANATION } from "./denial-redirect.ts";
import { findNaxDirs, type NaxGuardContext } from "./nax-dirs.ts";

/** The pathspec that covers EVERY `.nax` directory, named in advice texts. */
export const COVERING_EXCLUSION = "':(exclude,glob)**/.nax'";

/** `:!X`, `:^X`, `:(exclude)X`. */
export const EXCLUDE_PATHSPEC = /^:(?:[!^]|\([^)]*exclude[^)]*\))(.*)$/;

/** True when `.nax` is a path segment of `path`. */
export function hasNaxSegment(path: string): boolean {
  return path.split(/[\\/]/).includes(".nax");
}

/** True when `operand`, resolved from any frame, lands on or under a `.nax` directory. */
export function operandTouchesNax(operand: string, ctx: NaxGuardContext): boolean {
  if (hasNaxSegment(operand)) return true;
  return ctx.frames.some((frame) => {
    const rel = relative(ctx.root, resolve(frame, operand));
    return !rel.startsWith("..") && hasNaxSegment(rel);
  });
}

// The glob forms `:(exclude,glob)<any depth>/.nax` and the same with a trailing `/**` cover a `.nax` at any depth.
const GLOB_EXCLUSION = /^:\((?:exclude,glob|glob,exclude)\)\*\*\/\.nax(?:\/\*\*)?$/;

/**
 * An exclusion that covers EVERY `.nax` the guard knows of. The glob form always does. The literal forms
 * (`:!.nax`, `:^.nax/`, `:(exclude).nax` plus a trailing glob) name only `<root>/.nax` (resolved from EVERY frame), so they
 * count only while that is the single `.nax` there is.
 */
export function isFullNaxExclusion(spec: string, ctx: NaxGuardContext): boolean {
  if (GLOB_EXCLUSION.test(spec)) return true;
  const target = EXCLUDE_PATHSPEC.exec(spec)?.[1];
  if (target === undefined) return false;
  const rootNax = join(ctx.root, ".nax");
  if (findNaxDirs(ctx).some((dir) => dir !== rootNax)) return false;
  const path = target.replace(/\/(?:\*\*)?$/, "");
  return ctx.frames.every((frame) => resolve(frame, path) === rootNax);
}

/** Options whose value occupies the next word, per verb. */
const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  checkout: new Set(["-b", "-B", "--orphan", "--pathspec-from-file"]),
  restore: new Set(["-s", "--source", "--pathspec-from-file"]),
  clean: new Set(["-e", "--exclude"]),
};

interface Operands {
  /** Non-option words before `--`. */
  readonly before: readonly string[];
  /** Words after `--`. */
  readonly after: readonly string[];
  readonly hasSeparator: boolean;
  readonly flags: readonly string[];
}

function splitOperands(verb: string, args: readonly string[]): Operands {
  const valueFlags = VALUE_FLAGS[verb] ?? new Set<string>();
  const before: string[] = [];
  const after: string[] = [];
  const flags: string[] = [];
  let hasSeparator = false;
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] as string;
    if (hasSeparator) after.push(word);
    else if (word === "--") hasSeparator = true;
    else if (word.startsWith("-") && word !== "-") {
      flags.push(word);
      if (valueFlags.has(word)) i += 1;
    } else before.push(word);
  }
  return { before, after, hasSeparator, flags };
}

/** A checkout operand that is a path although no `--` marks it: it exists on disk, or lands in `.nax` from the root. */
function isUnmarkedCheckoutPath(word: string, ctx: NaxGuardContext): boolean {
  return ctx.frames.some((frame) => {
    const target = resolve(frame, word);
    if (existsSync(target)) return true;
    return relative(ctx.root, target).split(/[\\/]/)[0] === ".nax";
  });
}

function pathOperands(verb: string, ops: Operands, ctx: NaxGuardContext): readonly string[] {
  if (verb === "restore") return [...ops.before, ...ops.after];
  return [...ops.after, ...ops.before.filter((word) => isUnmarkedCheckoutPath(word, ctx))];
}

/** True when `spec` selects a directory that holds one of the `.nax` directories (or all of them, from the top). */
function coversNax(spec: string, ctx: NaxGuardContext, nax: readonly string[]): boolean {
  if (EXCLUDE_PATHSPEC.test(spec)) return false;
  const magic = /^:(?:\(([^)]*)\)|\/)?(.*)$/s.exec(spec);
  const top = magic !== null && (spec.startsWith(":/") || /(?:^|,)top(?:,|$)/.test(magic[1] ?? ""));
  const body = (magic === null ? spec : (magic[2] as string)).replace(/(?:^|\/)\*{1,2}$/, "");
  const bases = top ? [ctx.root] : ctx.frames;
  return bases.some((base) => {
    const dir = resolve(base, body === "" ? "." : body);
    return nax.some((candidate) => candidate === dir || candidate.startsWith(`${dir}${sep}`));
  });
}

/** `--staged` and every unambiguous abbreviation git accepts (`--st`), or a short cluster of only `S`. */
const STAGED_FLAG = /^(?:--st|-S+$)/;
/** Flags that change nothing about WHAT is restored. */
const NEUTRAL_RESTORE_FLAG = /^(?:-q|--quiet|--progress|--no-progress)$/;

/**
 * `restore --staged` touches only the index. Fails closed: every flag must be `--staged` (or an
 * abbreviation) or a neutral one, so `--wor` / `-SW` / `--source=...` / an unknown flag all count as
 * touching the worktree.
 */
function touchesIndexOnly(flags: readonly string[]): boolean {
  return (
    flags.some((f) => STAGED_FLAG.test(f)) && flags.every((f) => STAGED_FLAG.test(f) || NEUTRAL_RESTORE_FLAG.test(f))
  );
}

const treeRefusal = (verb: string): string =>
  `${NAX_OWNED_RUN_STATE_EXPLANATION} A whole-tree \`git ${verb}\` reverts it too. ` +
  `Exclude it: \`git ${verb} -- . ${COVERING_EXCLUSION}\`.`;

const RESET_REFUSAL =
  `${NAX_OWNED_RUN_STATE_EXPLANATION} \`git reset --hard\` (and \`--keep\` / \`--merge\`) resets the whole tree, ` +
  "`.nax/` included, and has no pathspec form. " +
  `To discard changes outside it use \`git checkout -- . ${COVERING_EXCLUSION}\`; to unstage use plain \`git reset\`.`;

const DISCARD_REFUSAL =
  `${NAX_OWNED_RUN_STATE_EXPLANATION} This command discards or deletes working-tree changes across the whole tree, ` +
  `\`.nax/\` included. Name the files, or exclude it: \`-- . ${COVERING_EXCLUSION}\` (not available for forced checkouts and switches).`;

function wholeTreeRefusal(verb: string, ops: Operands, ctx: NaxGuardContext): string | undefined {
  const nax = findNaxDirs(ctx);
  if (nax.length === 0 || (verb === "restore" && touchesIndexOnly(ops.flags))) return undefined;
  if (ops.hasSeparator && ops.after.some((spec) => isFullNaxExclusion(spec, ctx))) return undefined;
  const specs = ops.hasSeparator ? ops.after : ops.before;
  const exclusionOnly = specs.length > 0 && specs.every((spec) => EXCLUDE_PATHSPEC.test(spec));
  return exclusionOnly || specs.some((spec) => coversNax(spec, ctx, nax)) ? treeRefusal(verb) : undefined;
}

/** `-f` (alone or in a cluster) or `--force` and its abbreviations. */
const isForceFlag = (word: string): boolean => /^--fo/.test(word) || (/^-[A-Za-z]+$/.test(word) && word.includes("f"));

/** A forced checkout throws local changes away whatever it names. */
function forcedCheckoutRefusal(verb: string, ops: Operands, ctx: NaxGuardContext): string | undefined {
  if (verb !== "checkout" || !ops.flags.some(isForceFlag) || findNaxDirs(ctx).length === 0) return undefined;
  return ops.hasSeparator && ops.after.some((spec) => isFullNaxExclusion(spec, ctx)) ? undefined : DISCARD_REFUSAL;
}

/** The refusal for `git checkout` / `git restore` with these arguments, or undefined. */
export function revertRefusal(verb: string, args: readonly string[], ctx: NaxGuardContext): string | undefined {
  const ops = splitOperands(verb, args);
  // An exclusion NAMES `.nax` to keep it out; it is not an operand that touches it.
  const names = pathOperands(verb, ops, ctx).some(
    (word) => !EXCLUDE_PATHSPEC.test(word) && operandTouchesNax(word, ctx),
  );
  if (names) return NAX_OWNED_RUN_STATE_EXPLANATION;
  return wholeTreeRefusal(verb, ops, ctx) ?? forcedCheckoutRefusal(verb, ops, ctx);
}

/** `git reset --hard` / `--keep` / `--merge` (any abbreviation git accepts) while a `.nax/` exists. */
export function resetRefusal(args: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (!args.some((word) => /^--(?:ha(?:rd?)?|ke|me)/.test(word))) return undefined;
  return findNaxDirs(ctx).length > 0 ? RESET_REFUSAL : undefined;
}

const hasFlag = (flags: readonly string[], long: RegExp, short: string): boolean =>
  flags.some((f) => long.test(f) || (/^-[A-Za-z]+$/.test(f) && f.includes(short)));

/** `switch -f`, `clean`, `checkout-index -a -f`, `read-tree -u --reset`: other ways to wipe the tree. */
export function discardRefusal(verb: string, args: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (findNaxDirs(ctx).length === 0) return undefined;
  const ops = splitOperands(verb, args);
  const covered = ops.hasSeparator && ops.after.some((spec) => isFullNaxExclusion(spec, ctx));
  const f = ops.flags;
  if (verb === "switch") {
    return f.some(isForceFlag) || f.some((w) => /^--di/.test(w)) ? DISCARD_REFUSAL : undefined;
  }
  if (verb === "clean") return covered ? undefined : DISCARD_REFUSAL;
  if (verb === "checkout-index") {
    return hasFlag(f, /^--al/, "a") && hasFlag(f, /^--fo/, "f") ? DISCARD_REFUSAL : undefined;
  }
  if (verb === "read-tree") {
    const reset = f.some((w) => /^--res/.test(w));
    return reset && hasFlag(f, /^--upd/, "u") ? DISCARD_REFUSAL : undefined;
  }
  return undefined;
}
