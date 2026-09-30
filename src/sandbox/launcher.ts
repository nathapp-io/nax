/**
 * How an agent-authored command runs (spec 5.1). Never WHETHER -- that is the
 * policy's call (single-gate rule). Handed only to Bash and RunCommand's Exec
 * branch, so a user-authored command can never be wrapped (D14).
 *
 * Two rules with teeth:
 * - F6: the backend returns argv only; runArgv receives the CALLER's env
 *   overlay and strips from process.env exactly as today.
 * - A wrap that throws is an error. The command never runs unwrapped: what
 *   stops is the command, never the sandbox.
 */
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { NaxError } from "../errors";
import { getSafeLogger } from "../logger";
import { runArgv } from "../utils/argv-exec";
import { errorMessage } from "../utils/errors";
import { quoteArgvForShell } from "./argv-quote";
import { denialHintLine, LIKELY_SANDBOX_DENIAL } from "./messages";
import type {
  CommandLauncher,
  LaunchRequest,
  LaunchResult,
  SandboxBackend,
  SandboxPolicy,
  SandboxRecord,
  SandboxState,
} from "./types";

export const DISABLED_SANDBOX_STATE: SandboxState = { kind: "disabled" };

export const _launcherDeps = {
  runArgv,
  newCommandId: (): string => randomUUID(),
  mkdir: (path: string): Promise<void> => mkdir(path, { recursive: true }).then(() => undefined),
};

export interface CommandLauncherOptions {
  readonly state: SandboxState;
  readonly backend?: SandboxBackend;
  /**
   * Build the policy for one command.
   *
   * `tmpDirInForce` is whether THIS command gets the session's own `TMPDIR`
   * override: the launcher declared a `tmpDir` and the per-run `ensureTmpDir`
   * recreated it, so `runWrapped` applied the `export TMPDIR=…` prefix. It is
   * false when the override was dropped, and srt's own forced `TMPDIR` applies
   * instead — a builder that denies that directory would then hand the session a
   * `TMPDIR` its own sandbox refuses to write (#2301, SPEC-tmp-confinement.md:132).
   * The launcher cannot know whether the session is confined; it only reports
   * the override, and the builder narrows that with what it does know.
   */
  readonly policyFor?: (root: string, tmpDirInForce: boolean) => Promise<SandboxPolicy>;
  /** Runs after every wrapped command, before control returns to nax (e.g. a git tripwire, #2198). */
  readonly afterWrapped?: () => Promise<void>;
  /**
   * US-004 — the session's temp directory. Created before every run, then handed
   * to the child as `TMPDIR`/`TMP`/`TEMP` so stray files land under the run's own
   * root instead of the shared `/tmp`.
   */
  readonly tmpDir?: string;
}

function logicalArgv(req: LaunchRequest): readonly string[] {
  return req.spec.kind === "shell" ? [req.spec.shell, "-c", req.spec.command] : req.spec.argv;
}

/** POSIX single-quoting: wrap in `'`, turning an embedded `'` into `'\''`. */
function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** `export TMPDIR=… TMP=… TEMP=…; ` — the prefix a wrapped command carries, since srt replaces the child env. */
function tmpEnvPrefix(tmpDir: string): string {
  const q = shellSingleQuote(tmpDir);
  return `export TMPDIR=${q} TMP=${q} TEMP=${q}; `;
}

/** The TMPDIR/TMP/TEMP overlay for an unwrapped run; the request's own env wins per key. */
function withTmpEnv(req: LaunchRequest, tmpDir: string | undefined): Readonly<Record<string, string>> | undefined {
  if (tmpDir === undefined) return req.env;
  return { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir, ...(req.env ?? {}) };
}

async function ensureTmpDir(tmpDir: string): Promise<boolean> {
  try {
    await _launcherDeps.mkdir(tmpDir);
    return true;
  } catch (err) {
    getSafeLogger()?.warn("sandbox", "could not create session temp dir — running without TMPDIR override", {
      tmpDir,
      error: errorMessage(err),
    });
    return false;
  }
}

/**
 * Per-launch environment: the session temp directory (recreated before every
 * run) and whether the policy still grants the shared temp roots.
 */
interface LaunchEnv {
  readonly tmpDir?: string;
  readonly sharedTmp: boolean;
}

async function runUnwrapped(req: LaunchRequest, sandbox: SandboxRecord, env: LaunchEnv): Promise<LaunchResult> {
  const argv = logicalArgv(req);
  const overlay = env.tmpDir !== undefined ? withTmpEnv(req, env.tmpDir) : req.env;
  const result = await _launcherDeps.runArgv({
    argv,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    stripEnvVars: [...req.stripEnvVars],
    ...(overlay !== undefined ? { env: overlay } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  });
  return { ...result, executed: argv, sandbox };
}

async function runWrapped(
  req: LaunchRequest,
  backend: SandboxBackend,
  policy: SandboxPolicy,
  env: LaunchEnv,
): Promise<LaunchResult> {
  const rawCommand = req.spec.kind === "shell" ? req.spec.command : quoteArgvForShell(req.spec.argv);
  // srt replaces the child environment wholesale, so a TMPDIR override cannot
  // ride an `env` overlay — it has to be part of the shell command itself.
  // Other overlay keys DO survive: the live suite proves it (`AGENT=1` reaches
  // a wrapped child — see test/integration/sandbox/sandbox-live.test.ts
  // "US-004 — the AGENT=1 overlay reaches a wrapped child"). `executed` below
  // stays the unprefixed logical argv, so the ledger records what the agent
  // wrote, not this shim.
  const command = env.tmpDir !== undefined ? `${tmpEnvPrefix(env.tmpDir)}${rawCommand}` : rawCommand;
  const shell = req.spec.kind === "shell" ? req.spec.shell : "/bin/sh";
  const commandId = _launcherDeps.newCommandId();
  let argv: readonly string[];
  try {
    argv = await backend.wrap({ command, shell, policy, cwd: req.cwd, commandId });
  } catch (err) {
    throw new NaxError(`[sandbox] could not wrap the command: ${errorMessage(err)}`, "SANDBOX_WRAP_FAILED", {
      stage: "sandbox",
      backend: backend.name,
      commandId,
      cause: err,
    });
  }
  try {
    const result = await _launcherDeps.runArgv({
      argv,
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      stripEnvVars: [...req.stripEnvVars],
      ...(req.env !== undefined ? { env: req.env } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
    const denied = result.exitCode !== 0 && LIKELY_SANDBOX_DENIAL.test(result.stderr);
    const violations = backend.annotate(commandId, result.stderr);
    const extra = [
      ...(denied ? [denialHintLine(policy.writeRoots, env.sharedTmp)] : []),
      ...(violations !== "" ? [violations] : []),
    ];
    return {
      ...result,
      stderr: extra.length > 0 ? `${result.stderr}\n${extra.join("\n")}` : result.stderr,
      executed: logicalArgv(req),
      sandbox: {
        backend: backend.name,
        wrapped: true,
        argv,
        ...(denied ? { denialHint: true as const } : {}),
      },
    };
  } finally {
    backend.commandFinished();
  }
}

export function createCommandLauncher(opts: CommandLauncherOptions): CommandLauncher {
  const { state } = opts;
  const env: LaunchEnv = {
    tmpDir: opts.tmpDir,
    // A confined session's denial hint points at $TMPDIR instead of /tmp; a
    // shared-temp session's hint must not contradict the policy it runs under.
    sharedTmp: state.kind !== "available" || state.sharedTmp !== false,
  };
  return {
    state,
    async run(req) {
      const tmpDir = env.tmpDir !== undefined && (await ensureTmpDir(env.tmpDir)) ? env.tmpDir : undefined;
      if (state.kind === "disabled") return runUnwrapped(req, { backend: "none", wrapped: false }, { ...env, tmpDir });
      if (state.kind === "unavailable") {
        return runUnwrapped(req, { backend: state.backend, wrapped: false, reason: state.reason }, { ...env, tmpDir });
      }
      if (opts.backend === undefined || opts.policyFor === undefined) {
        throw new NaxError("[sandbox] an available launcher needs a backend and a policy", "SANDBOX_NOT_CONFIGURED", {
          stage: "sandbox",
        });
      }
      try {
        // `tmpDir` is the EFFECTIVE dir for this run (undefined when the per-run
        // mkdir failed), so `env.tmpDir !== undefined && tmpDir !== undefined`
        // is exactly "runWrapped is about to apply the export TMPDIR prefix".
        const tmpDirInForce = env.tmpDir !== undefined && tmpDir !== undefined;
        return await runWrapped(req, opts.backend, await opts.policyFor(req.root, tmpDirInForce), { ...env, tmpDir });
      } finally {
        await opts.afterWrapped?.();
      }
    },
  };
}
