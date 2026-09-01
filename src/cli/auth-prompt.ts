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

function read(message: string, echo: boolean): Promise<string> {
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

/** Reads a visible line, for non-secret answers such as a method choice. */
export function promptForLine(message: string): Promise<string> {
  return read(message, true);
}
