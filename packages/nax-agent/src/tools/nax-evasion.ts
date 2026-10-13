/**
 * Ways a git verb is hidden from the Bash guard for nax's run state (#2493):
 * an alias defined with `git config`, an interpreter's code string, and a verb
 * or command head built by shell expansion. Pure text helpers; the guard
 * decides, from whether a `.nax/` exists, whether a hit is a refusal.
 */
import { commandHeadIndex, gitExecutableIndex, locateGit } from "./git-flags/locate.ts";

/** The verbs the guard protects `.nax/` from. */
const GUARDED_VERB = /(?<![\w-])(?:stash|update-index|checkout|restore|reset)(?![\w-])/;

/** True when `text` names a guarded git verb as a word (`alias.s=stash` and `` stash` `` count). */
export function mentionsGuardedVerb(text: string): boolean {
  return GUARDED_VERB.test(text);
}

export const CONFIG_ALIAS_REFUSAL =
  "Defining a git alias whose value runs stash, update-index, checkout, restore or reset is refused while the " +
  "repository holds nax's run state under `.nax/`: the alias would run that verb where it cannot be inspected. " +
  "Run the git verb directly.";

export const CONFIG_ENV_REFUSAL =
  "Git configuration injected through `GIT_CONFIG_*` cannot be inspected while the repository holds nax's run " +
  "state under `.nax/`. Run the git verb directly, without `GIT_CONFIG_*`.";

export const EXPANSION_REFUSAL =
  "A git verb or command built by shell expansion (`$VAR`, `$(...)`, backticks) cannot be inspected while the " +
  "repository holds nax's run state under `.nax/`. Write the command out literally.";

/** `git config [flags] alias.NAME VALUE` (also `--add`, `--replace-all`, `set`) with a guarded verb in VALUE. */
export function configAliasRefusal(args: readonly string[]): string | undefined {
  const at = args.findIndex((word) => /^alias\./i.test(word));
  if (at === -1) return undefined;
  return mentionsGuardedVerb(args.slice(at + 1).join(" ")) ? CONFIG_ALIAS_REFUSAL : undefined;
}

const EXPANSION = /[$`]/;

/**
 * True when some command of `command` (split coarsely on `; & |` and newlines)
 * has an expansion as its head or as its git subcommand AND mentions a guarded
 * verb: the verb is then probably what the expansion builds.
 */
export function buildsVerbByExpansion(command: string): boolean {
  return command.split(/[;&|\n]+/).some((part) => {
    if (!GUARDED_VERB.test(part)) return false;
    const words = part.trim().split(/\s+/).filter(Boolean);
    const head = words[commandHeadIndex(words)];
    if (head !== undefined && EXPANSION.test(head)) return true;
    return gitExecutableIndex(words) !== undefined && EXPANSION.test(locateGit(words)?.subcommand ?? "");
  });
}

const INTERPRETER = /^(?:python[\d.]*|node(?:js)?|perl|ruby)$/;
const CODE_FLAG = /^-[A-Za-z]*[ceEp]$|^--eval$/;

/** The code string of `python -c`, `node -e`, `perl -e`, `ruby -e` (behind wrappers), or undefined. */
export function interpreterCode(words: readonly string[]): string | undefined {
  const head = commandHeadIndex(words);
  const name = words[head]?.split("/").pop();
  if (name === undefined || !INTERPRETER.test(name)) return undefined;
  const flag = words.findIndex((word, i) => i > head && CODE_FLAG.test(word));
  return flag === -1 || flag + 1 >= words.length ? undefined : words.slice(flag + 1).join(" ");
}

/** Code reduced to shell-like words: quotes, brackets, parentheses and commas become spaces. */
export function flattenCode(code: string): string {
  return code.replace(/["'`[\](),]/g, " ");
}
