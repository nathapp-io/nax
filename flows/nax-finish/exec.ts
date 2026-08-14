/**
 * Subprocess execution for the nax-finish flow.
 *
 * Two distinct entry points, deliberately:
 *
 * - `runArgv` — for commands *this flow* constructs (`git`, `gh`, `glab`). An
 *   argv array is spawned directly: no shell, so no quoting or injection
 *   surface for branch names and review text.
 * - `runShell` — for command *strings the user configured* (`quality.commands`,
 *   `acceptance.command`). These are run through `/bin/sh -c`, matching
 *   `src/quality/runner.ts`, which is the only way to preserve `&&`, quoting,
 *   globs and env prefixes. Splitting such a string on whitespace and spawning
 *   argv (the previous behaviour) silently mis-ran every non-trivial command.
 *
 * Both cap wall-clock time: an unbounded gate would hang `acpx flow run`, and
 * the post-run plugin awaits that subprocess.
 *
 * ## Why `node:child_process` and not `Bun.spawn`
 *
 * The rest of nax is Bun-native (see `.claude/rules/project-conventions.md`),
 * but this module is **not** loaded by nax. `acpx flow run` loads it, in acpx's
 * own process, and the published `acpx` binary is a Node program
 * (`#!/usr/bin/env node`). Under Node the `Bun` global does not exist, so
 * `Bun.spawn` threw `ReferenceError: Bun is not defined` on the flow's very
 * first git call — aborting the flow before any node completed and before the
 * result file was written. Everything under `flows/` must therefore stay on
 * Node built-ins; `Bun.*` is banned here and only here, enforced by
 * `scripts/check-flows-no-bun.ts`.
 */
import { spawn } from "node:child_process";
import type { RunResult } from "./types";

/** Fallbacks used when the plugin passes no explicit budget in the flow input. */
export const DEFAULT_ACCEPTANCE_TIMEOUT_MS = 600_000;
export const DEFAULT_GATE_TIMEOUT_MS = 900_000;
/** Short budget for the flow's own git/forge plumbing — these are never long-running. */
export const DEFAULT_ARGV_TIMEOUT_MS = 120_000;

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
}

/** Exit code reported when the wall-clock cap kills the process, matching `timeout(1)`. */
const TIMEOUT_EXIT_CODE = 124;
/** Exit code reported when the binary is missing, matching a shell's "command not found". */
const NOT_FOUND_EXIT_CODE = 127;

function spawnCapture(cmd: string[], opts: ExecOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const [file, ...args] = cmd;
    // `detached: true` puts the child in its own process group so we can
    // SIGKILL the whole tree when the timer fires — otherwise a SIGTERM on
    // `sh` only kills the shell, and any inherited pipes from a still-running
    // child (e.g. `sleep 30`) keep `close` from firing until the child exits.
    const proc = spawn(file as string, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    // setTimeout (not a sleep) because the handle must be cancellable the moment
    // the process exits — the documented exception in forbidden-patterns.md.
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (proc.pid !== undefined) {
              // Negative pid = process group. SIGKILL cannot be ignored,
              // guarantees the child tree (and inherited pipes) actually close.
              try {
                process.kill(-proc.pid, "SIGKILL");
              } catch {
                // Group already gone.
              }
            }
          }, opts.timeoutMs)
        : undefined;

    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    // A missing binary (`gh`/`glab` not installed) surfaces as an `error` event
    // under Node, where `Bun.spawn` used to throw. Resolving with 127 instead of
    // rejecting keeps it a readable gate failure the flow can route on, rather
    // than an exception that kills `acpx flow run` with no result file.
    proc.on("error", (err: Error) => {
      settle({ exitCode: NOT_FOUND_EXIT_CODE, stdout, stderr: `${stderr}${err.message}`, timedOut });
    });

    // `close` (not `exit`) so both pipes are fully drained before we read them.
    // `code` is null when the process died from a signal — including our own
    // timeout kill — so it maps to a non-zero code rather than a false green.
    proc.on("close", (code: number | null) => {
      const exitCode = code ?? (timedOut ? TIMEOUT_EXIT_CODE : 1);
      settle(
        timedOut
          ? {
              exitCode: exitCode === 0 ? TIMEOUT_EXIT_CODE : exitCode,
              stdout,
              stderr: `${stderr}\n[nax-finish] killed after ${opts.timeoutMs}ms timeout`,
              timedOut: true,
            }
          : { exitCode, stdout, stderr },
      );
    });
  });
}

/** Spawn an argv array directly — no shell. For flow-constructed commands. */
export function runArgv(cmd: string[], opts: ExecOptions): Promise<RunResult> {
  return spawnCapture(cmd, { ...opts, timeoutMs: opts.timeoutMs ?? DEFAULT_ARGV_TIMEOUT_MS });
}

/** Run a configured command string through `/bin/sh -c`, preserving shell semantics. */
export function runShell(command: string, opts: ExecOptions): Promise<RunResult> {
  return spawnCapture(["/bin/sh", "-c", command], opts);
}
