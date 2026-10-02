/**
 * The default runtime: node:child_process adapted to AgentSpawnResult, normalised
 * to Bun.spawn's measured behaviour (the spawn cases in @nathapp/nax-test-kit).
 *
 * Known difference, kept on purpose: with `env` omitted the child inherits the
 * live process.env, where Bun passes the environment the process started with.
 */
import { spawn as spawnChild } from "node:child_process";
import { statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { Readable } from "node:stream";
import type { AgentRuntime, AgentSpawnOptions, AgentSpawnResult, AgentSpawnStdin } from "./types";
import { which } from "./which";

type SpawnErrorCode = "ENOENT" | "ENOTDIR" | "EACCES";
const ERRNO: Record<SpawnErrorCode, number> = { ENOENT: -2, ENOTDIR: -20, EACCES: -13 };

function spawnError(code: SpawnErrorCode, message: string, path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code, errno: ERRNO[code], syscall: "posix_spawn", path });
}

/** Bun fails a spawn synchronously; child_process reports it later, so check first. */
function precheck(cmd: readonly string[], opts: AgentSpawnOptions): string {
  const bin = cmd[0];
  if (bin === undefined || bin === "") throw new TypeError("spawn: empty argv");
  if (opts.cwd !== undefined) {
    let isDirectory: boolean;
    try {
      isDirectory = statSync(opts.cwd).isDirectory();
    } catch {
      throw spawnError("ENOENT", `ENOENT: no such file or directory, posix_spawn '${bin}'`, bin);
    }
    if (!isDirectory) throw spawnError("ENOTDIR", `ENOTDIR: not a directory, posix_spawn '${bin}'`, bin);
  }
  if (bin.includes("/")) {
    try {
      statSync(bin);
    } catch {
      throw spawnError("ENOENT", `ENOENT: no such file or directory, posix_spawn '${bin}'`, bin);
    }
    if (which(bin) === null) throw spawnError("EACCES", `EACCES: permission denied, posix_spawn '${bin}'`, bin);
    return bin;
  }
  if (which(bin, opts.env?.PATH ?? process.env.PATH) === null) {
    throw Object.assign(new Error(`Executable not found in $PATH: "${bin}"`), { code: "ENOENT", errno: -2, path: bin });
  }
  return bin;
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** 128 + n for a signal exit, as Bun reports it. */
function exitStatus(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  return 128 + (signal !== null ? (osConstants.signals[signal] ?? 0) : 0);
}

function toWeb(stream: Readable | null): ReadableStream<Uint8Array> {
  return stream === null ? emptyStream() : (Readable.toWeb(stream) as ReadableStream<Uint8Array>);
}

export function nodeSpawn(cmd: readonly string[], opts: AgentSpawnOptions): AgentSpawnResult {
  const bin = precheck(cmd, opts);
  const child = spawnChild(bin, cmd.slice(1), {
    cwd: opts.cwd,
    env: opts.env !== undefined ? definedEnv(opts.env) : process.env,
    stdio: [opts.stdin ?? "ignore", "pipe", opts.stderr],
    detached: opts.detached === true,
  });
  // A broken pipe on stdin is swallowed, as Bun does; an unhandled 'error' event would crash the process.
  child.stdin?.on("error", () => {});
  // 'exit', not 'close': a grandchild still holding a pipe must not delay it (Bun resolves at exit).
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(exitStatus(code, signal)));
  });
  const stdin: AgentSpawnStdin | undefined =
    opts.stdin === "pipe" && child.stdin !== null
      ? {
          write: (data) => {
            if (child.stdin !== null && !child.stdin.destroyed) child.stdin.write(data);
            return typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
          },
          end: () => {
            child.stdin?.end();
          },
          flush: () => {},
        }
      : undefined;
  return {
    stdout: toWeb(child.stdout),
    stderr: opts.stderr === "pipe" ? toWeb(child.stderr) : emptyStream(),
    exited,
    pid: child.pid ?? -1,
    stdin,
    get exitCode() {
      return child.exitCode;
    },
    get signalCode() {
      return child.signalCode;
    },
    kill: (signal) => {
      child.kill(signal);
    },
  };
}

export const nodeRuntime: AgentRuntime = { spawn: nodeSpawn };
