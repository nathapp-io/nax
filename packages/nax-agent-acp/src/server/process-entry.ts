/**
 * Adapts a real process to `MainDeps` (master plan M-2): the published bin is a
 * three-line file that calls `runCli(process)`.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { type MainDeps, main } from "#src/server/main";
import type { Env } from "#src/server/options";

export interface ProcessLike {
  readonly argv: readonly string[];
  readonly env: Env;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export function mainDepsFrom(proc: ProcessLike): MainDeps {
  return {
    argv: proc.argv.slice(2),
    env: proc.env,
    homedir: homedir(),
    stdin: proc.stdin,
    stdout: proc.stdout,
    writeErr: (text) => {
      proc.stderr.write(text);
    },
    readFile: (path, encoding) => readFile(path, encoding),
    onSignal: (handler) => {
      proc.once("SIGINT", handler);
      proc.once("SIGTERM", handler);
    },
  };
}

export function runCli(proc: ProcessLike): Promise<number> {
  return main(mainDepsFrom(proc));
}
