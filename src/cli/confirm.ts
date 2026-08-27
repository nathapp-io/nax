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
 * inferred type over-stated the seam (same reasoning as `_hybridDeps` in
 * src/debate/runner-hybrid.ts): the point of an injectable exit is that a
 * substitute records the code and returns, which no `never`-returning stub can
 * do. Nothing depends on the unreachability — the sole call site in `onData`
 * already `return`s explicitly on the next line.
 */
export const _confirmDeps: {
  stdin: ConfirmStdin;
  write: (text: string) => boolean;
  exit: (code: number) => void;
} = {
  stdin: process.stdin as unknown as ConfirmStdin,
  write: (text: string) => process.stdout.write(text),
  exit: (code: number) => process.exit(code),
};

/**
 * Prompt for a yes/no confirmation on a single keypress.
 *
 * Non-TTY (tests, pipes, CI) resolves `true` without touching the terminal.
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
 * @param question - Confirmation question to display
 * @returns true for Y/Enter/other keys, false for N, Ctrl+D, or a closed stream
 */
export async function promptForConfirmation(question: string): Promise<boolean> {
  const { stdin } = _confirmDeps;

  // In non-TTY mode (tests, pipes), default to true
  if (!stdin.isTTY) {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    _confirmDeps.write(chalk.bold(`${question} [Y/n] `));

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
      _confirmDeps.write("\n");
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
      // BUG-7 fix: raw-mode `data` events can deliver more than one byte
      // per chunk (paste, escape sequences, or `"n" + Enter` coalesced into
      // `"n\r"`). The previous `char.toLowerCase() !== "n"` operated on
      // the entire chunk — `"n\r".toLowerCase()` is `"n\r"`, which is not
      // equal to `"n"`, so the prompt confirmed instead of cancelling.
      // Inspecting the first byte (`char[0]`) makes the no-explicit-no path
      // work for coalesced input while keeping the documented
      // "any other input confirms" default for genuine non-`n` keystrokes
      // (see docs/20260816-review-since-0.80.0-canary.3.md, BUG-7).
      // Default to yes for Y, Enter, or any other input.
      finish(char[0]?.toLowerCase() !== "n");
    };

    // A stream that ends or errors before a keypress must not hang the CLI.
    const onClosed = (): void => finish(false);

    stdin.on("data", onData);
    stdin.once("end", onClosed);
    stdin.once("error", onClosed);
  });
}
