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
import { NaxError } from "../errors";
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

export const _launcherDeps = { runArgv, newCommandId: (): string => randomUUID() };

export interface CommandLauncherOptions {
  readonly state: SandboxState;
  readonly backend?: SandboxBackend;
  readonly policyFor?: (root: string) => Promise<SandboxPolicy>;
  /** Runs after every wrapped command, before control returns to nax (e.g. a git tripwire, #2198). */
  readonly afterWrapped?: () => Promise<void>;
}

function logicalArgv(req: LaunchRequest): readonly string[] {
  return req.spec.kind === "shell" ? [req.spec.shell, "-c", req.spec.command] : req.spec.argv;
}

async function runUnwrapped(req: LaunchRequest, sandbox: SandboxRecord): Promise<LaunchResult> {
  const argv = logicalArgv(req);
  const result = await _launcherDeps.runArgv({
    argv,
    cwd: req.cwd,
    timeoutMs: req.timeoutMs,
    stripEnvVars: [...req.stripEnvVars],
    ...(req.env !== undefined ? { env: req.env } : {}),
    ...(req.signal !== undefined ? { signal: req.signal } : {}),
  });
  return { ...result, executed: argv, sandbox };
}

async function runWrapped(req: LaunchRequest, backend: SandboxBackend, policy: SandboxPolicy): Promise<LaunchResult> {
  const command = req.spec.kind === "shell" ? req.spec.command : quoteArgvForShell(req.spec.argv);
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
    const extra = [...(denied ? [denialHintLine(policy.writeRoots)] : []), ...(violations !== "" ? [violations] : [])];
    return {
      ...result,
      stderr: extra.length > 0 ? `${result.stderr}\n${extra.join("\n")}` : result.stderr,
      executed: logicalArgv(req),
      sandbox: { backend: backend.name, wrapped: true, ...(denied ? { denialHint: true as const } : {}) },
    };
  } finally {
    backend.commandFinished();
  }
}

export function createCommandLauncher(opts: CommandLauncherOptions): CommandLauncher {
  const { state } = opts;
  return {
    state,
    async run(req) {
      if (state.kind === "disabled") return runUnwrapped(req, { backend: "none", wrapped: false });
      if (state.kind === "unavailable") {
        return runUnwrapped(req, { backend: state.backend, wrapped: false, reason: state.reason });
      }
      if (opts.backend === undefined || opts.policyFor === undefined) {
        throw new NaxError("[sandbox] an available launcher needs a backend and a policy", "SANDBOX_NOT_CONFIGURED", {
          stage: "sandbox",
        });
      }
      try {
        return await runWrapped(req, opts.backend, await opts.policyFor(req.root));
      } finally {
        await opts.afterWrapped?.();
      }
    },
  };
}
