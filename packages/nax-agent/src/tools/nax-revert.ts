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

/**
 * The pathspec that covers EVERY `.nax` directory AND the files inside them, named in advice texts. Real git:
 * the glob must end in `/**` (the bare `.nax` glob matches only the directory entry) and be anchored at the
 * top (a relative glob is taken from the working directory).
 */
export const COVERING_EXCLUSION = "':(top,exclude,glob)**/.nax/**'";

interface Magic {
  readonly elements: readonly string[];
  readonly body: string;
}

/** `:(a,b)body` split on commas; git does not abbreviate long magic names. */
function parseMagic(spec: string): Magic | undefined {
  const match = /^:\(([^)]*)\)(.*)$/s.exec(spec);
  return match === null ? undefined : { elements: (match[1] as string).split(","), body: match[2] as string };
}

/**
 * The path an exclusion pathspec excludes, or undefined when `spec` is not one: `:!X`, `:^X`, or a long form
 * with an element exactly `exclude` and no `attr:` element (an `attr:` spec is an attribute filter whatever
 * else it says).
 */
export function exclusionBody(spec: string): string | undefined {
  const short = /^:[!^](.*)$/s.exec(spec);
  if (short !== null) return short[1];
  const magic = parseMagic(spec);
  if (magic === undefined || !magic.elements.includes("exclude")) return undefined;
  return magic.elements.some((e) => e.startsWith("attr")) ? undefined : magic.body;
}

export const isExclusionSpec = (spec: string): boolean => exclusionBody(spec) !== undefined;

/** Exactly the covering form, magic in any order. */
export function isCoveringExclusion(spec: string): boolean {
  const magic = parseMagic(spec);
  if (magic === undefined || magic.body !== "**/.nax/**" || magic.elements.length !== 3) return false;
  return ["top", "exclude", "glob"].every((e) => magic.elements.includes(e));
}

/** `--force` -> true for `--f`, `--fo`, `--force`: any option abbreviation of `long` (`--x=v` too). */
export function isLongPrefix(word: string, long: string): boolean {
  const name = word.split("=")[0] as string;
  return name.startsWith("--") && name.length >= 3 && long.startsWith(name);
}

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

/**
 * An exclusion that covers EVERY `.nax` the guard knows of. The covering glob always does. The literal forms
 * (`:!.nax`, `:^.nax/`, `:(exclude).nax`) name only `<root>/.nax` (resolved from EVERY frame, or from the root
 * under `top`), so they count only while that is the single `.nax` there is.
 */
export function isFullNaxExclusion(spec: string, ctx: NaxGuardContext): boolean {
  if (isCoveringExclusion(spec)) return true;
  const target = exclusionBody(spec);
  if (target === undefined) return false;
  const rootNax = join(ctx.root, ".nax");
  if (findNaxDirs(ctx).some((dir) => dir !== rootNax)) return false;
  const path = target.replace(/\/(?:\*\*)?$/, "");
  const top = parseMagic(spec)?.elements.includes("top") === true;
  return (top ? [ctx.root] : ctx.frames).every((frame) => resolve(frame, path) === rootNax);
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
  if (isExclusionSpec(spec)) return false;
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
  const exclusionOnly = specs.length > 0 && specs.every(isExclusionSpec);
  return exclusionOnly || specs.some((spec) => coversNax(spec, ctx, nax)) ? treeRefusal(verb) : undefined;
}

/** `-f` (alone or in a cluster) or `--force` and its abbreviations. */
const isForceFlag = (word: string): boolean =>
  isLongPrefix(word, "--force") || (/^-[A-Za-z]+$/.test(word) && word.includes("f"));

/** A forced checkout throws local changes away whatever it names. */
function forcedCheckoutRefusal(verb: string, ops: Operands, ctx: NaxGuardContext): string | undefined {
  if (verb !== "checkout" || !ops.flags.some(isForceFlag) || findNaxDirs(ctx).length === 0) return undefined;
  return ops.hasSeparator && ops.after.some((spec) => isFullNaxExclusion(spec, ctx)) ? undefined : DISCARD_REFUSAL;
}

/** The refusal for `git checkout` / `git restore` with these arguments, or undefined. */
export function revertRefusal(verb: string, args: readonly string[], ctx: NaxGuardContext): string | undefined {
  const ops = splitOperands(verb, args);
  // An exclusion NAMES `.nax` to keep it out; it is not an operand that touches it.
  const names = pathOperands(verb, ops, ctx).some((word) => !isExclusionSpec(word) && operandTouchesNax(word, ctx));
  if (names) return NAX_OWNED_RUN_STATE_EXPLANATION;
  return wholeTreeRefusal(verb, ops, ctx) ?? forcedCheckoutRefusal(verb, ops, ctx);
}

/** `git reset --hard` / `--keep` / `--merge` (any abbreviation git accepts) while a `.nax/` exists. */
export function resetRefusal(args: readonly string[], ctx: NaxGuardContext): string | undefined {
  const dangerous = ["--hard", "--keep", "--merge"];
  if (!args.some((word) => dangerous.some((long) => isLongPrefix(word, long)))) return undefined;
  return findNaxDirs(ctx).length > 0 ? RESET_REFUSAL : undefined;
}

const hasFlag = (flags: readonly string[], long: string, short: string): boolean =>
  flags.some((f) => isLongPrefix(f, long) || (/^-[A-Za-z]+$/.test(f) && f.includes(short)));

/**
 * `git clean -n` / `--dry-run`. In a short cluster `-e` takes the rest of the cluster as its value
 * (`-fdenx` is `-f -d -e nx`, a real clean), so only an `n` before any `e` counts.
 */
const isCleanDryRun = (flags: readonly string[]): boolean =>
  flags.some(
    (f) =>
      isLongPrefix(f, "--dry-run") || (/^-[A-Za-z]+$/.test(f) && (f.slice(1).split("e")[0] as string).includes("n")),
  );

/** Operands (and `--opt=value` values) of a discard verb that name a `.nax` path. */
function namesNax(ops: Operands, ctx: NaxGuardContext): boolean {
  const values = ops.flags.filter((f) => f.includes("=")).map((f) => f.slice(f.indexOf("=") + 1));
  return [...ops.before, ...ops.after, ...values].some(
    (word) => !isExclusionSpec(word) && operandTouchesNax(word, ctx),
  );
}

/** Does this switch / clean / checkout-index / read-tree invocation wipe the tree (given no covering exclusion)? */
function wipesTree(verb: string, ops: Operands, ctx: NaxGuardContext): boolean {
  const f = ops.flags;
  if (verb === "switch") return f.some(isForceFlag) || f.some((w) => isLongPrefix(w, "--discard-changes"));
  if (verb === "clean") {
    const covered = ops.hasSeparator && ops.after.some((spec) => isFullNaxExclusion(spec, ctx));
    return !covered && !isCleanDryRun(f);
  }
  if (verb === "checkout-index") return hasFlag(f, "--all", "a") && hasFlag(f, "--force", "f");
  if (verb === "read-tree") return f.some((w) => isLongPrefix(w, "--reset")) && hasFlag(f, "--update", "u");
  return false;
}

const NAMED_PATH_VERBS: ReadonlySet<string> = new Set(["checkout-index", "read-tree", "clean"]);

/** `switch -f`, `clean`, `checkout-index -a -f`, `read-tree -u --reset`: other ways to wipe the tree. */
export function discardRefusal(verb: string, args: readonly string[], ctx: NaxGuardContext): string | undefined {
  const ops = splitOperands(verb, args);
  if (NAMED_PATH_VERBS.has(verb) && namesNax(ops, ctx)) return NAX_OWNED_RUN_STATE_EXPLANATION;
  if (findNaxDirs(ctx).length === 0) return undefined;
  return wipesTree(verb, ops, ctx) ? DISCARD_REFUSAL : undefined;
}
