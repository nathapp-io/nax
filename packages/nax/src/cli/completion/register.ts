/**
 * The two commands that make shell completion work — `nax completion <shell>`
 * and the hidden `nax __complete -- <words...>` the generated scripts call.
 *
 * Both actions take their process seams from an injected `CompletionCliDeps`, so
 * a unit test drives them without writing to the real stdout, without exiting
 * the test process, and without a file system behind the value sources.
 *
 * What the seams buy is the protocol's two promises:
 *
 * - a Tab press must never fail the shell. `__complete` writes only candidates
 *   and, when a source throws, writes nothing at all — no stderr, no non-zero
 *   exit. A user pressing Tab is not running a command; there is nothing to
 *   report to them and a broken completion must stay invisible.
 * - `completion <unsupported>` is a real, user-invoked command, so it does
 *   report: one stderr line naming every shell that would have worked, and
 *   exit 1. Nothing is written to stdout, so `eval "$(nax completion fish)"`
 *   cannot silently load an empty script.
 *
 * `bin/nax.ts` registers both once, after every other command, and never routes
 * a user's own words to a command action: the completion engine only compares
 * the words to the command tree's vocabulary.
 */

import { homedir as osHomedir } from "node:os";
import type { Command } from "commander";
import { type CompletionSources, completeWords } from "./engine";
import { type CompletionShell, completionScript, SUPPORTED_SHELLS } from "./scripts";
import { listFeatureNames, listProfileNames } from "./values";

/** The process and value-source seams `registerCompletionCommand` writes through. */
export interface CompletionCliDeps {
  /** stdout — candidates, or a shell script. */
  write: (text: string) => void;
  /** stderr — an unsupported-shell diagnostic, and nothing else. */
  writeErr: (text: string) => void;
  /** The exit code an unsupported shell ends the process with. */
  exit: (code: number) => void;
  /** Where feature and profile names come from. */
  sources: CompletionSources;
}

/** The real process and the real value sources. */
export const _completionCliDeps: CompletionCliDeps = {
  write: (text) => {
    process.stdout.write(text);
  },
  writeErr: (text) => {
    process.stderr.write(text);
  },
  exit: (code) => {
    process.exit(code);
  },
  sources: {
    cwd: () => process.cwd(),
    home: () => osHomedir(),
    features: listFeatureNames,
    profiles: listProfileNames,
  },
};

/** The hidden protocol command the generated shell scripts call. */
const COMPLETE_COMMAND_NAME = "__complete";
/** The visible command that prints a shell's script. */
const COMPLETION_COMMAND_NAME = "completion";

/** One candidate per line, each line terminated — including the last. */
const CANDIDATE_SEPARATOR = "\n";

/**
 * The install instructions `nax completion --help` shows after the option list.
 *
 * Each line carries both halves a reader needs: the file it belongs in and the
 * exact line to add, so no install step has to be inferred.
 */
const INSTALL_HELP = `
Install (add the matching line to the file named, then open a new shell):
  ~/.zshrc   eval "$(nax completion zsh)"
  ~/.bashrc  eval "$(nax completion bash)"
`;

/** True when `shell` is one `completionScript` can render. */
function isSupportedShell(shell: string): shell is CompletionShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(shell);
}

/**
 * Write the candidates for `words`, or nothing.
 *
 * A rejecting source is swallowed on purpose (Failure Handling: "a source throws
 * during `__complete`" → no stdout, no stderr, no non-zero exit). The failure is
 * not reported because there is no one to report it to: the user pressed Tab, and
 * a diagnostic in the middle of their prompt would be noise, while a non-zero
 * exit would make the shell treat the completion as broken.
 */
async function writeCandidates(program: Command, words: readonly string[], deps: CompletionCliDeps): Promise<void> {
  let candidates: string[];
  try {
    candidates = await completeWords(program, words, deps.sources);
  } catch {
    return;
  }
  if (candidates.length === 0) return;
  deps.write(`${candidates.join(CANDIDATE_SEPARATOR)}${CANDIDATE_SEPARATOR}`);
}

/** Write the script for `shell`, or its refusal. */
function writeScript(shell: string, deps: CompletionCliDeps): void {
  if (!isSupportedShell(shell)) {
    deps.writeErr(`unsupported shell "${shell}" (supported: ${SUPPORTED_SHELLS.join(", ")})`);
    deps.exit(1);
    return;
  }
  deps.write(completionScript(shell));
}

/**
 * Register `nax completion <shell>` and the hidden `nax __complete -- <words...>`.
 *
 * Registration happens before `parseAsync`, and after every other command, so the
 * command tree the engine walks is the complete one.
 *
 * @param program - the program the commands attach to; `__complete` also walks it
 * @param deps - process and value-source seams; tests pass recording stubs
 */
export function registerCompletionCommand(program: Command, deps: CompletionCliDeps = _completionCliDeps): void {
  program
    .command(`${COMPLETE_COMMAND_NAME} [words...]`, { hidden: true })
    .description("Print the completion candidates for the words typed after nax")
    .action(async (words: string[]) => {
      await writeCandidates(program, words, deps);
    });

  program
    .command(`${COMPLETION_COMMAND_NAME} <shell>`)
    .description(`Print the shell completion script for <shell> (${SUPPORTED_SHELLS.join(", ")})`)
    .addHelpText("after", INSTALL_HELP)
    .action((shell: string) => {
      writeScript(shell, deps);
    });
}
