/**
 * RunCommand's second, allowlisted call shape (`Exec`): a model-authored argv
 * rather than a declared command key.
 *
 * Split out of run-command.ts (fix round 1, Minor) so the no-shell guarantee
 * is structural rather than a comment pinned to file layout: this file must
 * never import the declared branch's shell-templated command executor
 * (the RunCommand sibling module resolves and spawns those through a real
 * shell) or its shell-argument quoting helper (there is no shell string
 * here to quote). `test/unit/tools/run-command-exec.test.ts` reads this
 * file WHOLE and asserts neither one appears anywhere in it — a whole-file
 * check that cannot be defeated by moving functions around within it,
 * unlike the prior slice-from-a-known-function-name guard.
 *
 * Order matters and is fixed: `validateArgv` (shape/metacharacters) runs
 * before `runExecBranch` is even reached — the runtime's policy check
 * already ran it against the raw argv before `run()` was called at all, see
 * `src/tools/policy.ts`. It is re-checked here too, because this function
 * must also be safe to call directly, bypassing the runtime (as this file's
 * own tests do). Then `deniedFlag` (source/destination-redirecting flags a
 * verb-prefix grant cannot see), then `normalizeExec` (install-shaped
 * hardening and workspace scoping), then `runArgv`.
 */
import { relative } from "node:path";
import { agentOutputOverlay } from "#src/internal/agent-output-env";
import type { ArgvExecResult } from "#src/internal/argv-exec";
import { runArgv } from "#src/internal/argv-exec";
import { formatExecBody } from "#src/internal/exec-framing";
import type { CommandLauncher, SandboxRecord } from "../sandbox/index.ts";
import { deniedFlag, validateArgv } from "./exec-guard.ts";
import { normalizeExec } from "./package-managers.ts";
import type { ExecTarget } from "./package-managers-types.ts";
import type { ToolResult, ToolRunContext } from "./registry.ts";
import type { RunCommandToolOptions } from "./run-command.ts";
import { cutToByteCap, READ_CEILING } from "./truncate.ts";

/**
 * Deadline for the argv branch's spawn (`runExecBranch`).
 *
 * Deliberately longer than the declared branch's own default deadline
 * (120_000ms, in the project's quality-command runner): a declared quality
 * command runs entirely on code already on disk, while an install-shaped
 * argv call here talks to a package registry over the network and may run
 * a vendor postinstall script — both routinely take longer than a
 * project's own test/lint/typecheck command.
 */
export const EXEC_TIMEOUT_MS = 300_000;

/**
 * Layer the AGENT=1 overlay onto an existing Exec env (or build a fresh env
 * with just the overlay). Returns undefined when both inputs are undefined
 * so the caller can omit the `env` key entirely and let `Bun.spawn` inherit
 * the parent's environment on its own — the same shape `withAgentOutputEnv`
 * applied via `normalizeEnvironment` in the verification runner, but here the
 * inputs are partial: the Exec env is optional and the overlay may also be
 * undefined when a marker is inherited or AGENT is stripped.
 */
function mergedExecEnv(
  execEnv: Readonly<Record<string, string>> | undefined,
  strippedVars: readonly string[],
): Record<string, string> | undefined {
  const agentOverlay = agentOutputOverlay(strippedVars);
  if (agentOverlay === undefined) return execEnv !== undefined ? { ...execEnv } : undefined;
  return { ...(execEnv ?? {}), ...agentOverlay };
}

/**
 * Spawn the normalized argv through the launcher when one is configured and
 * fall back to a direct `runArgv` call otherwise. The launcher branch carries
 * the `stripEnvVars` as a shared array (Bun.spawn reads it once), while the
 * direct branch spreads it so the deps seam sees the same shape every other
 * `_argvExecDeps.spawn` test stubs.
 */
async function launchExec(req: {
  argv: readonly string[];
  root: string;
  cwd: string;
  launcher: CommandLauncher | undefined;
  mergedEnv: Record<string, string> | undefined;
  stripEnvVars: readonly string[];
  signal: AbortSignal | undefined;
}): Promise<ArgvExecResult & { sandbox?: SandboxRecord }> {
  if (req.launcher !== undefined) {
    return await req.launcher.run({
      spec: { kind: "argv", argv: req.argv },
      root: req.root,
      cwd: req.cwd,
      timeoutMs: EXEC_TIMEOUT_MS,
      stripEnvVars: req.stripEnvVars,
      ...(req.mergedEnv !== undefined ? { env: req.mergedEnv } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    });
  }
  return {
    ...(await runArgv({
      argv: req.argv,
      cwd: req.cwd,
      timeoutMs: EXEC_TIMEOUT_MS,
      stripEnvVars: [...req.stripEnvVars],
      // Yarn 2+ carries its no-scripts mechanism here rather than in argv.
      ...(req.mergedEnv !== undefined ? { env: req.mergedEnv } : {}),
      ...(req.signal !== undefined ? { signal: req.signal } : {}),
    })),
    sandbox: undefined,
  };
}

export async function runExecBranch(
  input: Record<string, unknown>,
  ctx: ToolRunContext,
  opts: RunCommandToolOptions,
): Promise<ToolResult> {
  if (opts.exec === undefined) return { content: "argv is not available on this path", isError: true };

  const invalid = validateArgv(input.argv);
  if (invalid !== undefined) return { content: invalid, isError: true };
  const argv = input.argv as string[];
  // Real narrowing, not a cast: validateArgv above already rejected an
  // empty argv, so this destructure cannot actually miss -- kept as a
  // defensive fallback (matching package-managers.ts's own "unreachable"
  // comments) rather than a postfix `!` or an `as string`.
  const [binary] = argv;
  if (binary === undefined) return { content: "argv must not be empty", isError: true };

  const flag = deniedFlag(argv);
  if (flag !== undefined) return { content: `flag ${flag} is not permitted`, isError: true };

  const target: ExecTarget = input.target === "repoRoot" ? "repoRoot" : "package";
  const packageRelPath = relative(opts.exec.repoRoot, opts.exec.packageWorkdir);
  const normalized = normalizeExec({
    argv,
    target,
    repoRoot: opts.exec.repoRoot,
    packageWorkdir: opts.exec.packageWorkdir,
    packageRelPath,
    allowScripts: opts.exec.allowScripts,
    ...(opts.exec.packageName !== undefined ? { packageName: opts.exec.packageName } : {}),
  });
  if ("error" in normalized) return { content: normalized.error, isError: true };

  // US-004: opt the child into agent-friendly output. The Exec branch never
  // rewrites the argv (that's the model's command), and the overlay is only
  // `AGENT=1` — same rule the quality and verification runners apply. An
  // inherited marker (`CLAUDECODE`/`REPL_ID`) speaks for itself, and a
  // stripped AGENT stays stripped. The overlay is layered on top of any Exec
  // env (the Yarn no-scripts key) so the latter survives wrapping alongside.
  const mergedEnv = mergedExecEnv(normalized.env, opts.stripEnvVars ?? []);

  try {
    const launched = await launchExec({
      argv: normalized.argv,
      root: ctx.root,
      cwd: normalized.cwd,
      launcher: opts.exec.launcher,
      mergedEnv,
      stripEnvVars: opts.stripEnvVars ?? [],
      signal: ctx.signal,
    });

    // US-001: match Bash's framing so an aborted Exec is rendered as an
    // error with the cancellation banner (AC14 mirror) and an orphansKilled
    // Exec appends the same `[nax]` footer (AC15 mirror).
    const text = formatExecBody(launched, EXEC_TIMEOUT_MS);

    return {
      content: cutToByteCap(text, ctx.readCeiling ?? READ_CEILING),
      isError: launched.timedOut || launched.exitCode !== 0 || launched.aborted === true,
      // Task 7 reads this to write `executed` and `target` onto the ledger
      // row. Returning it here, rather than re-deriving it in the runtime,
      // keeps the recorded argv the one that actually ran.
      audit: {
        executed: normalized.argv,
        target,
        cwd: normalized.cwd,
        ...(launched.sandbox !== undefined ? { sandbox: launched.sandbox } : {}),
      },
    };
  } catch (err) {
    // A spawn-time failure (e.g. an unresolvable cwd) throws rather than
    // resolving with a non-zero exit; surfaced as a normal tool error so it
    // is indistinguishable, to the caller, from any other refusal above.
    const message = err instanceof Error ? err.message : String(err);
    return { content: message, isError: true };
  }
}
