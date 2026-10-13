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

/** Find `git` in the executable position after supported wrappers. */
export function gitExecutableIndex(words: readonly string[]): number | undefined {
  const i = commandHeadIndex(words);
  return words[i] === "git" ? i : undefined;
}

/** Long global options whose value is the NEXT word (`--git-dir X`); `--key=value` forms are skipped as one word. */
const GIT_SEPARATE_VALUE_LONG: ReadonlySet<string> = new Set([
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
]);

/** Global options whose value redirects git to another directory. */
const GIT_DIR_OPTIONS: ReadonlySet<string> = new Set(["-C", "--git-dir", "--work-tree"]);

export interface LocatedGit {
  readonly subcommand: string;
  readonly args: readonly string[];
  /** Values of `-C`, `--work-tree` and `--git-dir` (both `--key value` and `--key=value`), in order. */
  readonly dirs: readonly string[];
}

/** Expand `-c alias.NAME=VALUE` when `subcommand` is such an alias; otherwise return it unchanged. */
function expandAlias(
  subcommand: string,
  args: readonly string[],
  aliases: ReadonlyMap<string, string>,
): { readonly subcommand: string; readonly args: readonly string[] } {
  const value = aliases.get(subcommand);
  if (value === undefined) return { subcommand, args };
  const words = value
    .replace(/^!/, "")
    .split(/\s+/)
    .filter((word) => word.length > 0);
  if (words[0] === "git") words.shift();
  const [head, ...rest] = words;
  return head === undefined ? { subcommand, args } : { subcommand: head, args: [...rest, ...args] };
}

/**
 * Locate executable `git` in `words` and advance past its global options.
 * Returns the subcommand (alias-expanded), its arguments, and the directories
 * the global options point git at, or `undefined` when `git` isn't there or has
 * no subcommand. Handles `sudo git`, `env VAR=x git`, `git --no-pager checkout`,
 * and an UNKNOWN `-x` / `--xxx` global (skipped as one word, so a new git
 * option cannot hide the subcommand).
 */
export function locateGit(words: readonly string[]): LocatedGit | undefined {
  const gitIdx = gitExecutableIndex(words);
  if (gitIdx === undefined) return undefined;
  const dirs: string[] = [];
  const aliases = new Map<string, string>();
  let i = gitIdx + 1;
  while (i < words.length && (words[i] as string).startsWith("-") && words[i] !== "--") {
    i = consumeGlobal(words, i, dirs, aliases);
  }
  const subcommand = words[i];
  if (subcommand === undefined) return undefined;
  return { ...expandAlias(subcommand, words.slice(i + 1), aliases), dirs };
}

/** Consume one global option at `i`, recording directory values and `-c alias.*` definitions; returns the next index. */
function consumeGlobal(words: readonly string[], i: number, dirs: string[], aliases: Map<string, string>): number {
  const w = words[i] as string;
  if (w === "-c") {
    const alias = /^alias\.([^=]+)=(.*)$/s.exec(words[i + 1] ?? "");
    if (alias !== null) aliases.set(alias[1] as string, alias[2] as string);
    return i + 2;
  }
  const eq = w.indexOf("=");
  const key = eq === -1 ? w : w.slice(0, eq);
  if (!GIT_DIR_OPTIONS.has(key) && !GIT_SEPARATE_VALUE_LONG.has(key)) return i + 1;
  const value = eq === -1 ? words[i + 1] : w.slice(eq + 1);
  if (GIT_DIR_OPTIONS.has(key) && value !== undefined) dirs.push(value);
  return eq === -1 ? i + 2 : i + 1;
}
