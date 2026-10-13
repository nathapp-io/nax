/**
 * Ways a git verb is hidden from the Bash guard for nax's run state (#2493):
 * an alias defined with `git config`, an interpreter's code string, and a verb
 * or command head built by shell expansion. Pure text helpers; the guard
 * decides, from whether a `.nax/` exists, whether a hit is a refusal.
 */
import { commandHeadIndex, gitExecutableIndex, locateGit } from "./git-flags/locate.ts";

/**
 * The verbs the guard protects `.nax/` from. A verb inside a file name or path (`reset.test.ts`,
 * `src/reset`) is not a mention.
 */
const GUARDED_VERB = /(?<![\w./-])(?:stash|update-index|checkout|restore|reset|clean|switch)(?![\w./-])/;

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

/** An alias value is dangerous when it names a guarded verb; `reset` only when it discards (`reset HEAD --` unstages). */
function aliasValueDangerous(value: string): boolean {
  const withoutReset = value.replace(/(?<![\w./-])reset(?![\w./-])/g, " ");
  if (mentionsGuardedVerb(withoutReset)) return true;
  return /(?<![\w./-])reset(?![\w./-])/.test(value) && /(?:^|\s)--(?:ha|ke|me)/.test(value);
}

/** Config keys whose value git EXECUTES (or reads more config from): an agent can run any verb through them. */
const EXEC_CONFIG_KEY =
  /^(?:include\.path|includeif\..+|core\.(?:fsmonitor|hookspath|pager|editor|sshcommand|askpass)|diff\.external|sequence\.editor|.+\.textconv|.+\.process|filter\..+\.(?:clean|smudge|process)|credential\.helper|gpg\.program|sendemail\.smtpserver)$/;

export function isExecConfigKey(key: string): boolean {
  return EXEC_CONFIG_KEY.test(key.toLowerCase());
}

export const EXEC_CONFIG_REFUSAL =
  "Setting a git config key whose value git executes (core.fsmonitor, core.hooksPath, core.pager, core.editor, " +
  "core.sshCommand, diff.external, sequence.editor, include.path, *.textconv, filter.*.clean/smudge, ...) is refused " +
  "while the repository holds nax's run state under `.nax/`: it can run any git verb where it cannot be inspected.";

/** `git config [flags] KEY VALUE` / `--add` / `set` of an executing key; a read or `--unset` (key only) is fine. */
function configWritesExecKey(args: readonly string[]): boolean {
  const operands = args.filter((word) => !word.startsWith("-") && word !== "set");
  const at = operands.findIndex(isExecConfigKey);
  return at !== -1 && at < operands.length - 1 && !args.some((a) => /^--(?:unset|get)/.test(a));
}

/** `git config [scope flags] alias.<name> <value>` (also `--add`, `--replace-all`, `set`) with a dangerous VALUE, or an executing key. */
export function configAliasRefusal(args: readonly string[]): string | undefined {
  if (configWritesExecKey(args)) return EXEC_CONFIG_REFUSAL;
  const at = args.findIndex((word) => /^alias\./i.test(word));
  if (at === -1) return undefined;
  return aliasValueDangerous(args.slice(at + 1).join(" ")) ? CONFIG_ALIAS_REFUSAL : undefined;
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
    // Without a git token (or an alias definition) in the segment the verb is not git's: `$RUNNER test reset.ts`.
    if (!words.some((w) => w === "git" || w === "\\git" || w.endsWith("/git") || w.includes("alias."))) return false;
    const head = words[commandHeadIndex(words)];
    if (head !== undefined && EXPANSION.test(head)) return true;
    return gitExecutableIndex(words) !== undefined && EXPANSION.test(locateGit(words)?.subcommand ?? "");
  });
}

const INTERPRETER = /^(?:python[\d.]*|node(?:js)?|perl|ruby|bun|deno|php|lua[\d.]*|osascript|pwsh|powershell)$/;
const CODE_FLAG = /^-[A-Za-z]*[ceEpr]$|^--eval$|^eval$|^-(?:Command|command)$/;

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
