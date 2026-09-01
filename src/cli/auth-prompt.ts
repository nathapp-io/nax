/**
 * Terminal prompts for credential entry.
 *
 * A sibling of confirm.ts rather than an extension of it. That file's
 * terminal-state handling was got wrong once — Ctrl+D fell through to the
 * "any other key" branch and confirmed the action — and its shape is worth
 * copying rather than disturbing.
 *
 * Nothing typed here is ever echoed, and the terminal is restored on every
 * exit path: submit, cancel, stream end, and stream error.
 */

import chalk from "chalk";

/** Ctrl+C. */
const ETX = "\u0003";
/** Ctrl+D. Conventionally cancel, never submit. */
const EOT = "\u0004";
const CR = "\r";
const LF = "\n";
const BACKSPACE = "\u007F";
const ARROW_UP = "\u001b[A";
const ARROW_DOWN = "\u001b[B";

/** The slice of process.stdin these prompts drive. Injected so tests can stand one up. */
export interface PromptStdin {
  isTTY?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: string): unknown;
  on(event: string, listener: (chunk: string) => void): unknown;
  once(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelledError";
  }
}

export const _authPromptDeps: {
  stdin: PromptStdin;
  write: (text: string) => boolean;
} = {
  stdin: process.stdin as unknown as PromptStdin,
  write: (text: string) => process.stdout.write(text),
};

/**
 * `onEmptySubmit` turns Enter-on-an-empty-buffer into an action rather than a
 * submission. An empty answer is meaningless for the prompts that use it (a
 * pasted auth code), so the keystroke is free — and spending it here keeps the
 * whole login on a single stdin reader. A second concurrent reader would fight
 * this one over raw mode.
 */
function read(message: string, echo: boolean, onEmptySubmit?: () => void): Promise<string> {
  const { stdin } = _authPromptDeps;
  if (stdin.isTTY !== true) return Promise.reject(new PromptCancelledError());
  _authPromptDeps.write(`${chalk.cyan("?")} ${message} `);

  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
      _authPromptDeps.write("\n");
    };

    const onEnd = (): void => {
      cleanup();
      reject(new PromptCancelledError());
    };

    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === ETX || char === EOT) {
          cleanup();
          reject(new PromptCancelledError());
          return;
        }
        if (char === CR || char === LF) {
          if (buffer.length === 0 && onEmptySubmit !== undefined) {
            onEmptySubmit();
            continue;
          }
          cleanup();
          resolve(buffer);
          return;
        }
        if (char === BACKSPACE) {
          buffer = buffer.slice(0, -1);
          if (echo) _authPromptDeps.write("\b \b");
          continue;
        }
        buffer += char;
        if (echo) _authPromptDeps.write(char);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onEnd);
  });
}

/** Reads a secret. Nothing is echoed, not even a masking character. */
export function promptForSecret(message: string): Promise<string> {
  return read(message, false);
}

/** Reads a visible line, for non-secret answers such as a pasted auth code. */
export function promptForLine(message: string, onEmptySubmit?: () => void): Promise<string> {
  return read(message, true, onEmptySubmit);
}

export interface SelectChoice {
  readonly id: string;
  readonly label: string;
}

/**
 * Reads a choice with the arrow keys, returning the chosen option's id.
 *
 * Rendered by rewriting the option block in place, so the list does not scroll
 * away on every keypress. Enter commits the highlighted row; there is no way
 * to submit a value that is not one of the options, which is the point — a
 * mistyped method reaches nax-ai as "no login method is available" and sends
 * the user chasing a config problem that does not exist.
 */
export function promptForSelect(message: string, choices: readonly SelectChoice[]): Promise<string> {
  const { stdin } = _authPromptDeps;
  if (stdin.isTTY !== true) return Promise.reject(new PromptCancelledError());
  // Never silently pick for the user: an empty list is a caller bug, and
  // resolving it would bill against a credential path nobody chose.
  if (choices.length === 0) return Promise.reject(new PromptCancelledError());

  _authPromptDeps.write(`${chalk.cyan("?")} ${message}\n`);

  return new Promise<string>((resolve, reject) => {
    let index = 0;
    let settled = false;
    let drawn = false;

    const render = (): void => {
      // Step back over the block drawn last time, then overwrite it. Skipped
      // on the first pass, when there is nothing above the cursor yet.
      if (drawn) _authPromptDeps.write(`\u001b[${choices.length}A`);
      drawn = true;
      for (const [i, choice] of choices.entries()) {
        const active = i === index;
        const marker = active ? chalk.cyan(">") : " ";
        const label = active ? chalk.cyan(choice.label) : choice.label;
        _authPromptDeps.write(`\r\u001b[2K${marker} ${label}\n`);
      }
    };

    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onEnd);
      stdin.setRawMode(false);
      stdin.pause();
    };

    const onEnd = (): void => {
      cleanup();
      reject(new PromptCancelledError());
    };

    const onData = (chunk: string): void => {
      // Matched on the whole chunk, not per character: an arrow key arrives as
      // a three-byte escape sequence that per-character reads would split.
      if (chunk.includes(ETX) || chunk.includes(EOT)) {
        cleanup();
        reject(new PromptCancelledError());
        return;
      }
      if (chunk.includes(ARROW_UP)) {
        index = (index - 1 + choices.length) % choices.length;
        render();
        return;
      }
      if (chunk.includes(ARROW_DOWN)) {
        index = (index + 1) % choices.length;
        render();
        return;
      }
      if (chunk.includes(CR) || chunk.includes(LF)) {
        const chosen = choices[index];
        cleanup();
        // biome-ignore lint/style/noNonNullAssertion: index is held in range by the modulo above.
        resolve(chosen!.id);
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onEnd);
    render();
  });
}
