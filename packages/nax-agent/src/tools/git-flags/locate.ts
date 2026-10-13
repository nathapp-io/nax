/**
 * Locating `git` and its subcommand inside a command line.
 *
 * A leaf module with NO imports, like `./index.ts`, so both `command-safety`
 * and `tools` can use it without a cycle. Shared by the command-safety scorer
 * and the Bash guard for nax's run state (#2490), so a wrapper or global
 * option that hides `git` from one cannot hide it from the other.
 */

/** `sudo` options whose values occupy the next shell word. */
const SUDO_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "-u",
  "-g",
  "-h",
  "-D",
  "-C",
  "-p",
  "-r",
  "-t",
  "-U",
  "--user",
  "--group",
  "--host",
  "--chdir",
  "--close-from",
  "--prompt",
  "--role",
  "--type",
  "--other-user",
]);

/** Skip a sudo/doas prefix, including options with a separate value. */
function afterPrivilegeWrapper(words: readonly string[]): number {
  if (words[0] !== "sudo" && words[0] !== "doas") return 0;
  let i = 1;
  while (words[i]?.startsWith("-")) {
    const option = words[i++];
    if (option === "--") break;
    if (option !== undefined && SUDO_VALUE_OPTIONS.has(option)) i += 1;
  }
  return i;
}

/** Skip an env prefix and its assignments and options. */
function afterEnvWrapper(words: readonly string[], start: number): number {
  if (words[start] !== "env") return start;
  let i = start + 1;
  while (i < words.length) {
    const word = words[i] as string;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "-i" || word === "--ignore-environment") {
      i += 1;
    } else if (word === "-u" || word === "--unset") {
      i += 2;
    } else break;
  }
  return i;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** `xargs` options that take a separate value. */
const XARGS_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a"]);

function afterNice(words: readonly string[], start: number): number {
  let i = start + 1;
  if (words[i] === "-n" || words[i] === "--adjustment") i += 2;
  else if (words[i]?.startsWith("-") && words[i] !== "--") i += 1;
  return i;
}

function afterTimeout(words: readonly string[], start: number): number {
  let i = start + 1;
  while (words[i]?.startsWith("-")) i += words[i] === "-k" || words[i] === "-s" ? 2 : 1;
  return i + 1;
}

function afterXargs(words: readonly string[], start: number): number {
  let i = start + 1;
  while (words[i]?.startsWith("-") && words[i] !== "--") i += XARGS_VALUE_OPTIONS.has(words[i] as string) ? 2 : 1;
  return i;
}

/**
 * Index of the word that actually names the command, after leading `VAR=x`
 * assignments and the wrappers that pass through to it (`sudo`, `env`,
 * `command`, `exec`, `nice`, `timeout`, `xargs`).
 */
export function commandHeadIndex(words: readonly string[]): number {
  let i = 0;
  for (let guard = 0; guard < words.length; guard += 1) {
    const before = i;
    while (words[i] !== undefined && ASSIGNMENT.test(words[i] as string)) i += 1;
    const word = words[i];
    if (word === "sudo" || word === "doas") i = afterPrivilegeWrapper(words.slice(i)) + i;
    else if (word === "env") i = afterEnvWrapper(words, i);
    else if (word === "command" || word === "exec") i += 1;
    else if (word === "nice") i = afterNice(words, i);
    else if (word === "timeout") i = afterTimeout(words, i);
    else if (word === "xargs") i = afterXargs(words, i);
    if (i === before) break;
  }
  return i;
}

/** `git`, or `\\git` (a leading backslash only suppresses shell aliases, so it still runs git). */
function isGitWord(word: string | undefined): boolean {
  return word === "git" || word === "\\git";
}

/** Find `git` in the executable position after supported wrappers. */
export function gitExecutableIndex(words: readonly string[]): number | undefined {
  const i = commandHeadIndex(words);
  return isGitWord(words[i]) ? i : undefined;
}

/** Long global options whose value is the NEXT word (`--git-dir X`); `--key=value` forms are skipped as one word. */
const GIT_SEPARATE_VALUE_LONG: ReadonlySet<string> = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
]);

/** Global options that take no value, or only an `=value` (`git help git`). Anything else before the subcommand is unknown. */
const GIT_KNOWN_FLAG_GLOBALS: ReadonlySet<string> = new Set([
  "-v",
  "--version",
  "-h",
  "--help",
  "--exec-path",
  "--html-path",
  "--man-path",
  "--info-path",
  "-p",
  "--paginate",
  "-P",
  "--no-pager",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--no-optional-locks",
  "--no-advice",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--list-cmds",
]);

/** Global options whose value redirects git to another directory. */
const GIT_DIR_OPTIONS: ReadonlySet<string> = new Set(["-C", "--git-dir", "--work-tree"]);

export interface LocatedGit {
  readonly subcommand: string;
  readonly args: readonly string[];
  /**
   * Values of `-C`, `--work-tree` and `--git-dir` (both `--key value` and
   * `--key=value`) and of leading `GIT_WORK_TREE=` / `GIT_DIR=` assignments, in order.
   */
  readonly dirs: readonly string[];
  /** True when an alias is defined through `--config-env=alias.*`: its value lives in the environment and cannot be read. */
  readonly unresolvedAlias: boolean;
  /** True when a global option this reader does not know sat before the subcommand: the subcommand found may be that option's value. */
  readonly uncertain: boolean;
  /** The shell text a `!` alias runs (its value without the `!`, then the call's remaining arguments), or undefined. */
  readonly shellAlias: string | undefined;
  /** Lower-cased keys set by `-c key=value` and `--config-env=key=VAR`, in order. */
  readonly configKeys: readonly string[];
  /** True when a leading assignment sets a `GIT_CONFIG*` variable (config, including aliases, injected through the environment). */
  readonly configEnv: boolean;
}

interface GlobalState {
  readonly dirs: string[];
  readonly aliases: Map<string, string>;
  readonly configKeys: string[];
  uncertain: boolean;
}

/**
 * Subcommands git runs itself: an alias of the same name is NEVER expanded (`git -c alias.stash=status
 * stash` really stashes). Every guarded verb plus the common builtins; a name missing here is expanded,
 * which can only over-refuse.
 */
const GIT_BUILTINS: ReadonlySet<string> = new Set([
  "add",
  "am",
  "apply",
  "archive",
  "bisect",
  "blame",
  "branch",
  "bundle",
  "checkout",
  "checkout-index",
  "cherry",
  "cherry-pick",
  "clean",
  "clone",
  "commit",
  "config",
  "describe",
  "diff",
  "fetch",
  "format-patch",
  "gc",
  "grep",
  "init",
  "log",
  "ls-files",
  "ls-tree",
  "merge",
  "mv",
  "notes",
  "pull",
  "push",
  "rebase",
  "reflog",
  "remote",
  "reset",
  "restore",
  "revert",
  "rm",
  "show",
  "sparse-checkout",
  "stash",
  "status",
  "submodule",
  "switch",
  "tag",
  "update-index",
  "update-ref",
  "worktree",
  "read-tree",
  "write-tree",
  "rev-parse",
  "rev-list",
  "symbolic-ref",
  "show-ref",
  "for-each-ref",
  "hash-object",
  "cat-file",
  "help",
]);

/** Skip global options from `start`; returns the index of the first word that is not one. */
function skipGlobals(words: readonly string[], start: number, state: GlobalState): number {
  let i = start;
  while (i < words.length && (words[i] as string).startsWith("-") && words[i] !== "--") {
    i = consumeGlobal(words, i, state);
  }
  return i;
}

/** Alias value words, with a leading `!` and a leading `git` removed. */
function aliasWords(value: string): string[] {
  const words = value
    .replace(/^!/, "")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (isGitWord(words[0])) words.shift();
  return words;
}

interface Resolved {
  readonly subcommand: string;
  readonly args: readonly string[];
  readonly shellAlias: string | undefined;
  readonly cycle: boolean;
}

/**
 * Expand `-c alias.NAME=VALUE` while `subcommand` names such an alias (never a builtin, see GIT_BUILTINS).
 * A name met twice is a cycle: `cycle` is set and the chain stops. The
 * expanded words are run through the global-option skip again (an alias may
 * start with `-C .` or `--no-pager`), and a `!` value is also returned as shell text.
 */
function resolveAliases(subcommand: string, args: readonly string[], state: GlobalState): Resolved {
  let current: Resolved = { subcommand, args, shellAlias: undefined, cycle: false };
  const seen = new Set<string>();
  for (;;) {
    const name = current.subcommand.toLowerCase();
    const value = GIT_BUILTINS.has(name) ? undefined : state.aliases.get(name);
    if (value === undefined) break;
    if (seen.has(name)) return { ...current, cycle: true };
    seen.add(name);
    const shellAlias = value.startsWith("!") ? `${value.slice(1)} ${current.args.join(" ")}`.trim() : undefined;
    const merged = [...aliasWords(value), ...current.args];
    const next = skipGlobals(merged, 0, state);
    const head = merged[next];
    if (head === undefined) break;
    current = {
      subcommand: head,
      args: merged.slice(next + 1),
      shellAlias: current.shellAlias ?? shellAlias,
      cycle: false,
    };
  }
  return current;
}

/** Directory and config environment set by leading assignments (also those of an `env` wrapper). */
function leadingGitEnv(words: readonly string[], gitIdx: number): { dirs: string[]; configEnv: boolean } {
  const dirs: string[] = [];
  let configEnv = false;
  for (const word of words.slice(0, gitIdx)) {
    const match = /^(GIT_WORK_TREE|GIT_DIR|GIT_CONFIG[A-Z0-9_]*)=(.*)$/.exec(word);
    if (match === null) continue;
    if (match[1]?.startsWith("GIT_CONFIG")) configEnv = true;
    else dirs.push(match[2] as string);
  }
  return { dirs, configEnv };
}

/**
 * Locate executable `git` in `words` and advance past its global options.
 * Returns the subcommand (alias-expanded), its arguments, and the directories
 * the global options point git at, or `undefined` when `git` isn't there or has
 * no subcommand. Handles `sudo git`, `env VAR=x git`, a backslash-prefixed
 * `git`, `git --no-pager checkout`, and an UNKNOWN `-x` / `--xxx` global
 * (skipped as one word and flagged `uncertain`, so a new git option cannot
 * hide the subcommand silently).
 */
export function locateGit(words: readonly string[]): LocatedGit | undefined {
  const gitIdx = gitExecutableIndex(words);
  if (gitIdx === undefined) return undefined;
  const env = leadingGitEnv(words, gitIdx);
  const state: GlobalState = { dirs: [...env.dirs], aliases: new Map(), configKeys: [], uncertain: false };
  const i = skipGlobals(words, gitIdx + 1, state);
  const unresolvedAlias = words.slice(gitIdx + 1, i).some((word, k, globals) => isConfigEnvAlias(word, globals[k + 1]));
  const subcommand = words[i];
  if (subcommand === undefined) return undefined;
  const resolved = resolveAliases(subcommand, words.slice(i + 1), state);
  return {
    subcommand: resolved.subcommand,
    args: resolved.args,
    dirs: state.dirs,
    unresolvedAlias: unresolvedAlias || resolved.cycle,
    configKeys: state.configKeys,
    uncertain: state.uncertain,
    shellAlias: resolved.shellAlias,
    configEnv: env.configEnv,
  };
}

/** `--config-env=alias.x=VAR` or `--config-env alias.x=VAR` (git config keys are case-insensitive). */
function isConfigEnvAlias(word: string, next: string | undefined): boolean {
  if (word.startsWith("--config-env=")) return /^alias\./i.test(word.slice("--config-env=".length));
  return word === "--config-env" && /^alias\./i.test(next ?? "");
}

/** Consume one global option at `i`, recording directory values and `-c alias.*` definitions; returns the next index. */
function consumeGlobal(words: readonly string[], i: number, state: GlobalState): number {
  const w = words[i] as string;
  if (w === "-c") {
    const configKey = /^([^=]+)=/.exec(words[i + 1] ?? "")?.[1];
    if (configKey !== undefined) state.configKeys.push(configKey.toLowerCase());
    const alias = /^alias\.([^=]+)=(.*)$/is.exec(words[i + 1] ?? "");
    if (alias !== null) state.aliases.set((alias[1] as string).toLowerCase(), alias[2] as string);
    return i + 2;
  }
  const eq = w.indexOf("=");
  const key = eq === -1 ? w : w.slice(0, eq);
  const separate = GIT_DIR_OPTIONS.has(key) || GIT_SEPARATE_VALUE_LONG.has(key);
  if (!separate) {
    if (!GIT_KNOWN_FLAG_GLOBALS.has(key)) state.uncertain = true;
    return i + 1;
  }
  const value = eq === -1 ? words[i + 1] : w.slice(eq + 1);
  if (key === "--config-env") {
    const envKey = /^([^=]+)=/.exec(value ?? "")?.[1];
    if (envKey !== undefined) state.configKeys.push(envKey.toLowerCase());
  }
  if (GIT_DIR_OPTIONS.has(key) && value !== undefined) state.dirs.push(value);
  return eq === -1 ? i + 2 : i + 1;
}
