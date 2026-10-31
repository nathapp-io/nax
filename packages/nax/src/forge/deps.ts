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

import { gitSpawnEnv, hardenedGitArgv, killProcessGroup } from "@nathapp/nax-agent/internal";
import { injectedForgeIdentity } from "./identity";
import type { ForgeDeps } from "./types";

/** Default wall-clock cap for any one subprocess (BUG-8). */
export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000;

/**
 * The variables each forge CLI reads a token from. `gh` reads `GH_TOKEN` and,
 * for a GitHub Enterprise Server host, `GH_ENTERPRISE_TOKEN`; `glab` reads
 * `GITLAB_TOKEN` for whatever host it resolves.
 */
const FORGE_TOKEN_ENV = {
  gh: ["GH_TOKEN", "GH_ENTERPRISE_TOKEN"],
  glab: ["GITLAB_TOKEN"],
} as const satisfies Record<string, readonly string[]>;

/** `gh` or a path ending in `/gh`: the program, as opposed to a wrapper in front of it. */
function isForgeProgram(token: string | undefined, program: string): boolean {
  return token === program || (token?.endsWith(`/${program}`) ?? false);
}

function forgeProgram(cmd: readonly string[]): "gh" | "glab" | undefined {
  const program = cmd[0];
  if (isForgeProgram(program, "gh")) return "gh";
  if (isForgeProgram(program, "glab")) return "glab";
  return undefined;
}

/**
 * The token environment for a `gh` / `glab` spawn — `undefined` for every other
 * program (including `git`, whose credentials are `botGit`'s business) and when
 * nothing was injected, so an uninjected run behaves exactly as before. The
 * token goes in the environment, never in `cmd`, so it cannot reach a log line
 * or another process's argv.
 */
function tokenEnv(cmd: readonly string[]): Record<string, string> | undefined {
  const identity = injectedForgeIdentity();
  const program = forgeProgram(cmd);
  if (identity === undefined || program === undefined) return undefined;
  return Object.fromEntries(FORGE_TOKEN_ENV[program].map((name) => [name, identity.token]));
}

/**
 * Injectable seam mirroring the `_autoPrDeps` pattern. Production callers read
 * through these references; tests mutate fields on the exported object to
 * inject fakes without `mock.module()`. `killProcessGroup` is the established
 * process-tree cleanup primitive (`src/utils/process-kill.ts`) — the direct
 * `proc.kill()` only reaches the spawned shell, leaving grandchildren (a
 * package manager postinstall, a `sleep` after a `trap 'exit 0' TERM`) holding
 * stdout open and stalling the pipe drain.
 */
export const _forgeDeps = { killProcessGroup };

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
  // hardenedGitArgv only changes a git status / diff argv (#2210).
  const proc = Bun.spawn(cmd[0] === "git" ? hardenedGitArgv(cmd) : cmd, {
    cwd: opts.cwd,
    // Hardened for every command, not only argv[0] === "git": gh / glab run
    // git underneath, and the GIT_CONFIG_* entries are inert to anything else.
    // tokenEnv adds the injected forge token for gh / glab only.
    env: gitSpawnEnv(tokenEnv(cmd)),
    stdout: "pipe",
    stderr: "pipe",
    // ORPHAN-1: setsid() makes this pid the process-group leader, so the
    // killProcessGroup call below reaches grandchildren rather than only the
    // direct child. Without it, a trap-handled `exit 0` on TERM leaves `sleep`
    // holding the stdout pipe and the drain blocks until it dies naturally.
    detached: true,
  });
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SUBPROCESS_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    // killProcessGroup(-pid) is the only thing that reaches grandchildren; a
    // bare `proc.kill()` would orphan anything the direct child spawned.
    // SIGTERM (not SIGKILL): the 124 substitution below distinguishes a
    // timed-out child that exited cleanly from a real success, and only
    // SIGTERM lets a process trap-handle it. SIGKILL would land on 137
    // (128 + 9) and the substitution branch would never fire.
    _forgeDeps.killProcessGroup(proc.pid, "SIGTERM");
  }, timeoutMs);
  try {
    // .catch(() => "") guards against broken-pipe errors after SIGKILL so the
    // timeout path always returns a result instead of rejecting.
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
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

export const defaultForgeDeps: ForgeDeps = {
  run: defaultRun,
  readText: defaultReadText,
  // The identity captured at CLI start (US-002), read through the module so a
  // capture that happens after this object is built is still seen.
  identity: injectedForgeIdentity,
};
