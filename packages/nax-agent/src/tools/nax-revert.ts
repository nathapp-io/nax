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

/** `:!X`, `:^X`, `:(exclude)X`. */
export const EXCLUDE_PATHSPEC = /^:(?:[!^]|\(exclude[^)]*\))(.*)$/;

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

/** `:!.nax`, `:^.nax/`, `:(exclude).nax/**` -- and it must resolve to `<root>/.nax` from EVERY frame. */
export function isFullNaxExclusion(spec: string, ctx: NaxGuardContext): boolean {
  const target = EXCLUDE_PATHSPEC.exec(spec)?.[1];
  if (target === undefined) return false;
  const path = target.replace(/\/(?:\*\*)?$/, "");
  return ctx.frames.every((frame) => resolve(frame, path) === join(ctx.root, ".nax"));
}

/** Options whose value occupies the next word, per verb. */
const VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  checkout: new Set(["-b", "-B", "--orphan", "--pathspec-from-file"]),
  restore: new Set(["-s", "--source", "--pathspec-from-file"]),
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

/** `restore --staged` without `--worktree` touches only the index. */
function touchesIndexOnly(flags: readonly string[]): boolean {
  const staged = flags.includes("--staged") || flags.includes("-S");
  return staged && !flags.includes("--worktree") && !flags.includes("-W");
}

const treeRefusal = (verb: string): string =>
  `${NAX_OWNED_RUN_STATE_EXPLANATION} A whole-tree \`git ${verb}\` reverts it too. ` +
  `Exclude it: \`git ${verb} -- . ':!.nax'\`.`;

const RESET_REFUSAL =
  `${NAX_OWNED_RUN_STATE_EXPLANATION} \`git reset --hard\` resets the whole tree, \`.nax/\` included, and has no pathspec form. ` +
  "To discard changes outside it use `git checkout -- . ':!.nax'`; to unstage use plain `git reset`.";

function wholeTreeRefusal(verb: string, ops: Operands, ctx: NaxGuardContext): string | undefined {
  const nax = findNaxDirs(ctx);
  if (nax.length === 0 || (verb === "restore" && touchesIndexOnly(ops.flags))) return undefined;
  if (ops.hasSeparator && ops.after.some((spec) => isFullNaxExclusion(spec, ctx))) return undefined;
  const specs = ops.hasSeparator ? ops.after : ops.before;
  const exclusionOnly = specs.length > 0 && specs.every((spec) => EXCLUDE_PATHSPEC.test(spec));
  return exclusionOnly || specs.some((spec) => coversNax(spec, ctx, nax)) ? treeRefusal(verb) : undefined;
}

/** The refusal for `git checkout` / `git restore` with these arguments, or undefined. */
export function revertRefusal(verb: string, args: readonly string[], ctx: NaxGuardContext): string | undefined {
  const ops = splitOperands(verb, args);
  const names = pathOperands(verb, ops, ctx).some((word) => operandTouchesNax(word, ctx));
  return names ? NAX_OWNED_RUN_STATE_EXPLANATION : wholeTreeRefusal(verb, ops, ctx);
}

/** `git reset --hard` (any abbreviation of the flag git accepts) while a `.nax/` exists. */
export function resetRefusal(args: readonly string[], ctx: NaxGuardContext): string | undefined {
  if (!args.some((word) => /^--ha(?:rd?)?$/.test(word))) return undefined;
  return findNaxDirs(ctx).length > 0 ? RESET_REFUSAL : undefined;
}
