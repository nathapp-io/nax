/**
 * Interactive yes/no confirmation prompt.
 *
 * Extracted from bin/nax.ts so the terminal-state handling below is reachable
 * from tests — the entry point is not importable without running commander.
 */

import chalk from "chalk";

/** Ctrl+C — cancel and exit with the conventional 128+SIGINT status. */
const ETX = "\u0003";
/** Ctrl+D — end of transmission. Conventionally "cancel", never "confirm". */
const EOT = "\u0004";
/** Exit status for a SIGINT-initiated cancellation. */
const SIGINT_EXIT_CODE = 130;
/** The one key that answers yes when a bare Enter means no. */
const YES_KEY = "y";
/** A question that already spells its own default, whichever way round it reads. */
const STATED_DEFAULT_RE = /\[[yYnN]\/[yYnN]\]\s*$/;

/**
 * Where the prompt's own text goes.
 *
 * `stdout` is the terminal's answer for every command that owns stdout. `stderr` is what a
 * command whose stdout is a machine-readable document needs — `nax memory compact --json` — so
 * the question and the caller's document never share a stream.
 */
export type ConfirmChannel = "stdout" | "stderr";

/** The answer a bare Enter stands for: the two shapes a nax prompt offers. */
export type ConfirmDefault = "yes" | "no";

/**
 * What a prompt is asked with: where its text goes, and what Enter means.
 *
 * `defaultAnswer` exists because the two defaults are not interchangeable. `"yes"` is the
 * proceed-or-not question a run asks a person who is already running it; `"no"` is the shape every
 * destructive question needs — `nax memory compact`, `nax memory mirrors --prune` — where the
 * question advertises `[y/N]` and a stray Enter must not authorize the change. Rendering `[Y/n]`
 * over a `[y/N]` question, as the one-answer prompt did, both contradicted the caller's text and
 * answered "yes" to every key that was not an `n`.
 */
export interface ConfirmOptions {
  /** Where the question and its closing newline go; `stdout` unless the caller says otherwise. */
  readonly channel?: ConfirmChannel;
  /** What a bare Enter, and any key that is not an explicit answer, resolves to. */
  readonly defaultAnswer?: ConfirmDefault;
}

/** The slice of `process.stdin` this prompt drives. Injected so tests can stand one up. */
export interface ConfirmStdin {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: string): unknown;
  on(event: string, listener: (chunk: string) => void): unknown;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * `exit` is annotated `=> void`, not the `never` `process.exit` infers. The
 * inferred type over-stated the seam: the point of an injectable exit is that a
 * substitute records the code and returns, which no `never`-returning stub can
 * do. Nothing depends on the unreachability — the sole call site in `onData`
 * already `return`s explicitly on the next line.
 */
export const _confirmDeps: {
  stdin: ConfirmStdin;
  write: (text: string) => boolean;
  /** The same writer for a prompt that may not touch stdout — see {@link ConfirmChannel}. */
  writeErr: (text: string) => boolean;
  exit: (code: number) => void;
} = {
  stdin: process.stdin as unknown as ConfirmStdin,
  write: (text: string) => process.stdout.write(text),
  writeErr: (text: string) => process.stderr.write(text),
  exit: (code: number) => process.exit(code),
};

/**
 * The one suffix a prompt renders after its question.
 *
 * A caller that has already spelled its default — `Apply? [y/N]` — keeps its own words; adding a
 * second bracket beside it is a prompt that appears to offer two answers, which is exactly how the
 * default-yes suffix turned two `[y/N]` questions into `[y/N] [Y/n]` ones.
 */
function suffixFor(question: string, answersYes: boolean): string {
  if (STATED_DEFAULT_RE.test(question)) return " ";
  return answersYes ? " [Y/n] " : " [y/N] ";
}

/**
 * Whether one keystroke means yes, given what a bare Enter means.
 *
 * Raw-mode `data` events can deliver more than one byte per chunk (a paste, an escape sequence, or
 * `"n" + Enter` coalesced into `"n\r"`), so only the first byte is read — BUG-7 was this check
 * operating on the whole chunk. Under the yes default any key that is not an explicit `n` proceeds;
 * under the no default only an explicit `y` does, and Enter, a stray key or a space is a no.
 */
function readsAsYes(char: string, answersYes: boolean): boolean {
  const key = char[0]?.toLowerCase();
  return answersYes ? key !== "n" : key === YES_KEY;
}

/**
 * Prompt for a yes/no confirmation on a single keypress.
 *
 * Non-TTY (tests, pipes, CI) resolves the question's own default without touching the terminal:
 * `true` under `defaultAnswer: "yes"` (the shape every pre-existing caller has), `false` under
 * `"no"`, which is the only defensible answer to a destructive question nobody was asked.
 *
 * Terminal state is restored exactly once, on every exit path — keypress,
 * stream end, or stream error. The previous version registered only a `data`
 * listener, which left two gaps:
 *
 *   - `end`/`error` had no listener at all, so a stream that closed without
 *     delivering a byte left the promise pending forever with the terminal
 *     still in raw mode.
 *   - Ctrl+D fell through to the "any other input" branch and resolved
 *     **true**. Raw mode performs no EOF processing, so the byte arrives as
 *     ordinary data; a keystroke that universally means "cancel" was
 *     confirming the action instead.
 *
 * @param options - Where the prompt's text goes and what a bare Enter means — see
 *   {@link ConfirmOptions}
 * @returns true for an affirmative key, false for a no, Ctrl+D, a closed stream, or — under
 *   `defaultAnswer: "no"` — anything that is not an explicit yes
 */
export async function promptForConfirmation(question: string, options: ConfirmOptions = {}): Promise<boolean> {
  const { channel, defaultAnswer } = options;
  const answersYes = (defaultAnswer ?? "yes") === "yes";
  const { stdin } = _confirmDeps;
  // Bound once, so a caller that restores the deps mid-prompt cannot split one prompt across
  // two streams.
  const write = channel === "stderr" ? _confirmDeps.writeErr : _confirmDeps.write;

  // In non-TTY mode (tests, pipes) the answer is the question's own default, without touching the
  // terminal: a proceed-or-not prompt proceeds, and a destructive one — the only caller that passes
  // `defaultAnswer: "no"` — refuses rather than taking an unattended yes nobody gave.
  if (!stdin.isTTY) {
    return answersYes;
  }

  return new Promise<boolean>((resolve) => {
    write(chalk.bold(`${question}${suffixFor(question, answersYes)}`));

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let settled = false;
    /** Restore the terminal and detach every listener, exactly once. */
    const finish = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onClosed);
      stdin.removeListener("error", onClosed);
      write("\n");
      resolve(answer);
    };

    const onData = (char: string): void => {
      if (char === ETX) {
        finish(false);
        _confirmDeps.exit(SIGINT_EXIT_CODE);
        return;
      }
      if (char === EOT) {
        finish(false);
        return;
      }
      finish(readsAsYes(char, answersYes));
    };

    // A stream that ends or errors before a keypress must not hang the CLI.
    const onClosed = (): void => finish(false);

    stdin.on("data", onData);
    stdin.once("end", onClosed);
    stdin.once("error", onClosed);
  });
}
