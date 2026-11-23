/**
 * Completion engine — turns the words typed after `nax` into candidates.
 *
 * `completeWords` is a pure function over the commander program and the injected
 * value sources: it never imports `bin/nax.ts`, runs a command action, or reads
 * the process directory or home directly. The shell words arrive already split,
 * the last one being the word under the cursor, so nothing here re-parses a
 * command line.
 *
 * The candidates are the command tree's own vocabulary: visible subcommand names,
 * visible flags, and the feature/profile names the value sources return. A word
 * typed by the user is only ever compared, never executed.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Command, Option } from "commander";

/** Where the file-system-backed candidates come from. Injected, so tests need no disk. */
export interface CompletionSources {
  cwd: () => string;
  home: () => string;
  features: (startDir: string) => Promise<string[]>;
  profiles: (startDir: string) => Promise<string[]>;
}

/** Which value source a completion site reads. */
type ValueSourceKind = "features" | "profiles";

/** The command commander adds implicitly to a command that has subcommands. */
const IMPLICIT_HELP_COMMAND_NAME = "help";
/**
 * `--dir` (with whatever short flag it carries) names the directory the sources
 * read. commander keeps the dashes on `Option.long`, so the constants here do too.
 */
const DIR_OPTION_LONG = "--dir";
/** The home-directory shorthand `--dir` values are allowed to use. */
const HOME_SHORTHAND = "~";
/** The separator `--profile` accepts between chained profile names. */
const PROFILE_SEPARATOR = ",";

/** Options whose value is a navigable name, keyed by long flag. */
const OPTION_VALUE_SOURCES: ReadonlyMap<string, ValueSourceKind> = new Map([
  ["--feature", "features"],
  ["--profile", "profiles"],
]);

/** Positional arguments that name a value, keyed by the command's path from the root. */
const POSITIONAL_VALUE_SOURCES: ReadonlyMap<string, ValueSourceKind> = new Map([
  ["features resolve", "features"],
  ["config profile show", "profiles"],
  ["config profile use", "profiles"],
]);

/** Everything the walk of the words before the cursor learned. */
interface WalkState {
  /** The command the walk reached. */
  command: Command;
  /** The reached command's subcommand names, from the root down. */
  path: string[];
  /** An option still waiting for its value when the walk ended. */
  pending: Option | undefined;
  /** True once a word named nothing the walk could follow — no descent after that. */
  stuck: boolean;
  /** The value of the last `--dir` seen, unexpanded. */
  dirValue: string | undefined;
}

/** True when `option` consumes the following word. */
function takesValue(option: Option): boolean {
  return option.required || option.optional;
}

/** True when `word` spells `option`'s long or short flag. */
function spellsOption(option: Option, word: string): boolean {
  if (!takesValue(option)) return false;
  if (option.long !== undefined && word === option.long) return true;
  return option.short !== undefined && word === option.short;
}

/** The nearest value-taking option named by `word`, on `command` or an ancestor. */
function findValueOption(command: Command, word: string): Option | undefined {
  for (let cmd: Command | null = command; cmd !== null; cmd = cmd.parent) {
    const option = cmd.options.find((candidate) => spellsOption(candidate, word));
    if (option !== undefined) return option;
  }
  return undefined;
}

/** The visible subcommands of `command`, including commander's implicit help command. */
function visibleSubcommands(command: Command): Command[] {
  return command.createHelp().visibleCommands(command);
}

/** Consume one word before the cursor, updating `state` in place. */
function stepWord(state: WalkState, word: string): void {
  const pending = state.pending;
  state.pending = undefined;

  // A pending option owns the next word — unless its value is optional and the
  // word is flag-shaped, in which case the word is walked normally.
  if (pending !== undefined && !(pending.optional && word.startsWith("-"))) {
    if (pending.long === DIR_OPTION_LONG) state.dirValue = word;
    return;
  }

  if (!state.stuck) {
    const subcommand = visibleSubcommands(state.command).find((cmd) => cmd.name() === word);
    if (subcommand !== undefined) {
      state.command = subcommand;
      state.path.push(subcommand.name());
      return;
    }
  }

  const option = findValueOption(state.command, word);
  if (option !== undefined) {
    state.pending = option;
    return;
  }
  if (!word.startsWith("-")) state.stuck = true;
}

/** Walk the words before the cursor, recording the command reached and any pending option. */
function walkWords(program: Command, words: readonly string[]): WalkState {
  const state: WalkState = {
    command: program,
    path: [],
    pending: undefined,
    stuck: false,
    dirValue: undefined,
  };
  for (const word of words) stepWord(state, word);
  return state;
}

/** `~` and `~/…` become the home directory; every other form is taken literally. */
function expandHome(dirValue: string, home: () => string): string {
  if (dirValue === HOME_SHORTHAND) return home();
  if (dirValue.startsWith(`${HOME_SHORTHAND}/`)) return `${home()}${dirValue.slice(HOME_SHORTHAND.length)}`;
  return dirValue;
}

/** The directory the value sources read: the last `--dir` value, else the current directory. */
function resolveStartDir(dirValue: string | undefined, sources: CompletionSources): string {
  if (dirValue === undefined) return sources.cwd();
  const expanded = expandHome(dirValue, sources.home);
  return isAbsolute(expanded) ? expanded : resolvePath(sources.cwd(), expanded);
}

/** `resolveStartDir`, computed at most once per call. */
function memoizeStartDir(state: WalkState, sources: CompletionSources): () => string {
  let resolved: string | undefined;
  return () => {
    resolved ??= resolveStartDir(state.dirValue, sources);
    return resolved;
  };
}

/** The names `kind` offers for `startDir`. */
function readSourceNames(kind: ValueSourceKind, sources: CompletionSources, startDir: string): Promise<string[]> {
  return kind === "features" ? sources.features(startDir) : sources.profiles(startDir);
}

/** The names that start with `current`. */
function prefixMatches(names: readonly string[], current: string): string[] {
  return names.filter((name) => name.startsWith(current));
}

/**
 * Candidates for the profile name being typed inside a comma-separated list.
 *
 * The prefix keeps everything up to the last comma, so each candidate rewrites
 * the whole word; the names already listed there are never offered twice.
 */
function commaAwareNames(names: readonly string[], current: string): string[] {
  const lastSeparator = current.lastIndexOf(PROFILE_SEPARATOR);
  const prefix = current.slice(0, lastSeparator + 1);
  const partial = current.slice(lastSeparator + 1);
  const listed = new Set(prefix.split(PROFILE_SEPARATOR).filter((name) => name !== ""));
  return names.filter((name) => name.startsWith(partial) && !listed.has(name)).map((name) => `${prefix}${name}`);
}

/** The names a source offers for a value being typed there. */
async function valueCandidates(
  kind: ValueSourceKind,
  current: string,
  sources: CompletionSources,
  startDir: string,
): Promise<string[]> {
  const names = await readSourceNames(kind, sources, startDir);
  const commaAware = kind === "profiles" && current.includes(PROFILE_SEPARATOR);
  return commaAware ? commaAwareNames(names, current) : prefixMatches(names, current);
}

/** Candidates for the value of an option still pending at the cursor. */
function pendingValueCandidates(
  option: Option,
  current: string,
  sources: CompletionSources,
  startDir: () => string,
): Promise<string[]> {
  const kind = option.long === undefined ? undefined : OPTION_VALUE_SOURCES.get(option.long);
  if (kind === undefined) return Promise.resolve([]);
  return valueCandidates(kind, current, sources, startDir());
}

/** Every visible short and long flag of `command`. */
function flagCandidates(command: Command): string[] {
  const flags: string[] = [];
  for (const option of command.createHelp().visibleOptions(command)) {
    if (option.long !== undefined) flags.push(option.long);
    if (option.short !== undefined) flags.push(option.short);
  }
  return flags;
}

/** The names of `command`'s visible subcommands, minus commander's implicit help command. */
function subcommandCandidates(command: Command): string[] {
  return visibleSubcommands(command)
    .map((subcommand) => subcommand.name())
    .filter((name) => name !== IMPLICIT_HELP_COMMAND_NAME);
}

/** Candidates for a positional argument that names a value. */
function positionalCandidates(
  state: WalkState,
  current: string,
  sources: CompletionSources,
  startDir: () => string,
): Promise<string[]> {
  const kind = state.stuck ? undefined : POSITIONAL_VALUE_SOURCES.get(state.path.join(" "));
  if (kind === undefined) return Promise.resolve([]);
  return valueCandidates(kind, current, sources, startDir());
}

/** The rule ladder: option value, then flags, then subcommands, then positional values. */
async function candidatesFor(state: WalkState, current: string, sources: CompletionSources): Promise<string[]> {
  const startDir = memoizeStartDir(state, sources);
  const pending = state.pending;
  if (pending !== undefined && (pending.required || (pending.optional && !current.startsWith("-")))) {
    return pendingValueCandidates(pending, current, sources, startDir);
  }
  if (current.startsWith("-")) return prefixMatches(flagCandidates(state.command), current);
  const subcommands = subcommandCandidates(state.command);
  if (subcommands.length > 0 && !state.stuck) return prefixMatches(subcommands, current);
  return positionalCandidates(state, current, sources, startDir);
}

/**
 * The candidates for the word under the cursor.
 *
 * `words` are the shell words after `nax`, the last one being the word being
 * completed (possibly `""`). The result holds only the candidates that start
 * with that word, de-duplicated and sorted in UTF-16 code-unit order.
 */
export async function completeWords(
  program: Command,
  words: readonly string[],
  sources: CompletionSources,
): Promise<string[]> {
  const current = words[words.length - 1] ?? "";
  const state = walkWords(program, words.slice(0, -1));
  const candidates = await candidatesFor(state, current, sources);
  return [...new Set(candidates)].sort();
}
