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
import { runArgv } from "../utils/argv-exec";
import { deniedFlag, validateArgv } from "./exec-guard";
import { normalizeExec } from "./package-managers";
import type { ExecTarget } from "./package-managers-types";
import type { ToolResult, ToolRunContext } from "./registry";
import type { RunCommandToolOptions } from "./run-command";
import { cutToByteCap, READ_CEILING } from "./truncate";

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

  try {
    const launched =
      opts.exec.launcher !== undefined
        ? await opts.exec.launcher.run({
            spec: { kind: "argv", argv: normalized.argv },
            root: ctx.root,
            cwd: normalized.cwd,
            timeoutMs: EXEC_TIMEOUT_MS,
            stripEnvVars: opts.stripEnvVars ?? [],
            ...(normalized.env !== undefined ? { env: normalized.env } : {}),
            ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
          })
        : {
            ...(await runArgv({
              argv: normalized.argv,
              cwd: normalized.cwd,
              timeoutMs: EXEC_TIMEOUT_MS,
              stripEnvVars: [...(opts.stripEnvVars ?? [])],
              // Yarn 2+ carries its no-scripts mechanism here rather than in argv.
              ...(normalized.env !== undefined ? { env: normalized.env } : {}),
              ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
            })),
            sandbox: undefined,
          };
    // US-001: match Bash's framing so an aborted Exec is rendered as an
    // error with the cancellation banner (AC14 mirror) and an orphansKilled
    // Exec appends the same `[nax]` footer (AC15 mirror). Without this
    // branch an aborted call would land in the `exit N` path with
    // `exitCode === -1` and no indication that a turn cancel killed it.
    let body: string;
    if (launched.aborted === true) {
      body = `Cancelled: the turn ended while this command was running.\nexit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}`;
    } else if (launched.orphansKilled === true) {
      body = `exit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}\n[nax] background processes still holding the output were killed`;
    } else if (launched.timedOut) {
      body = `timed out after ${EXEC_TIMEOUT_MS}ms`;
    } else {
      body = `exit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}`;
    }

    return {
      content: cutToByteCap(body, ctx.readCeiling ?? READ_CEILING),
      isError: launched.timedOut || launched.exitCode !== 0 || launched.aborted === true,
      // Task 7 reads this to write `executed` and `target` onto the ledger
      // row. Returning it here, rather than re-deriving it in the runtime,
      // keeps the recorded argv the one that actually ran.
      audit: {
        executed: normalized.argv,
        target,
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
