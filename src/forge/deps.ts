/**
 * The default `ForgeDeps`: subprocess execution and file reads for every
 * function in this module.
 *
 * Lifted from `defaultRun` / `defaultReadText` in
 * `src/plugins/builtin/auto-pr/index.ts`, which was the only implementation of
 * this module's own contract. `src/finish/` needs one too and must not import
 * from `@/plugins`, so it lives with the contract instead. stdout and stderr
 * are read concurrently with `proc.exited` so non-trivial output cannot
 * deadlock, under a wall-clock cap so a wedged `gh` / `glab` / `git push`
 * cannot hang a run's completion phase.
 */

import type { ForgeDeps } from "./types";

/** Default wall-clock cap for any one subprocess (BUG-8). */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * Default subprocess runner — wraps Bun.spawn with concurrent stdout/stderr
 * reads so non-trivial output does not deadlock, under a wall-clock cap so a
 * wedged `git push` / `gh` / `glab` cannot hang the run's completion phase.
 * Lifted verbatim from `defaultRun` in `src/plugins/builtin/auto-pr/index.ts`
 * (D4.11) — that module keeps its own copy and overrides `_autoPrDeps.run` in
 * its tests; callers here inject a `ForgeDeps` directly instead of a seam.
 */
export async function defaultRun(
  cmd: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return timedOut
      ? {
          exitCode: exitCode === 0 ? 124 : exitCode,
          stdout,
          stderr: `${stderr}\n[forge] command killed after ${timeoutMs}ms timeout`,
        }
      : { exitCode, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Default UTF-8 reader — returns `null` on missing files so callers can probe
 * the candidate template paths without try/catch noise.
 */
async function defaultReadText(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

export const defaultForgeDeps: ForgeDeps = { run: defaultRun, readText: defaultReadText };
