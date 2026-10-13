/**
 * Locating `git` and its subcommand inside a command line.
 *
 * A leaf module with NO imports, like `./index.ts`, so both `command-safety`
 * and `tools` can use it without a cycle. Shared by the command-safety scorer
 * and the Bash guard for nax's run state (#2490), so a wrapper or global
 * option that hides `git` from one cannot hide it from the other.
 */

/** `git`'s global options that take no value — pass-through, then look for
 *  the subcommand. */
const GIT_BOOLEAN_GLOBALS: ReadonlySet<string> = new Set([
  "--no-pager",
  "--no-replace-objects",
  "--bare",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
]);

/** `git`'s global options that take a separate value (the next token). */
const GIT_VALUE_GLOBALS: ReadonlySet<string> = new Set(["-c", "-C"]);

/** `git`'s global long options that embed their value (`--key=value`). */
const GIT_KEY_VALUE_GLOBALS: ReadonlySet<string> = new Set([
  "--git-dir=",
  "--exec-path=",
  "--work-tree=",
  "--namespace=",
  "--super-prefix=",
]);

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

/** Locate executable `git` in `words` and advance past its global options. Returns the
   subcommand and the index of the first argument (or `undefined` when `git`
   isn't there or has no subcommand). Handles `sudo git`, `env VAR=x git`,
   `git --no-pager checkout`, etc. */
export function locateGit(
  words: readonly string[],
): { readonly subcommand: string; readonly args: readonly string[] } | undefined {
  const gitIdx = gitExecutableIndex(words);
  if (gitIdx === undefined) return undefined;
  let i = gitIdx + 1;
  while (i < words.length) {
    const w = words[i] as string;
    if (GIT_BOOLEAN_GLOBALS.has(w)) {
      i += 1;
      continue;
    }
    if (GIT_VALUE_GLOBALS.has(w)) {
      // The value is a separate token; skip it.
      i += 2;
      continue;
    }
    if ([...GIT_KEY_VALUE_GLOBALS].some((prefix) => w.startsWith(prefix))) {
      i += 1;
      continue;
    }
    break;
  }
  const subcommand = words[i];
  if (subcommand === undefined) return undefined;
  return { subcommand, args: words.slice(i + 1) };
}
