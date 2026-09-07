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
 * verb-prefix grant cannot see), then `classifyExec`/`normalizeExec`
 * (install-shaped hardening and workspace scoping), then `runArgv`.
 */
import { relative } from "node:path";
import { runArgv } from "../utils/argv-exec";
import { deniedFlag, validateArgv } from "./exec-guard";
import { recordExecTouchedPaths, snapshotExecTouchedPaths } from "./exec-touched-paths";
import { classifyExec, normalizeExec, normalizeManagerBinary } from "./package-managers";
import type { ExecTarget } from "./package-managers-types";
import type { ToolResult, ToolRunContext } from "./registry";
import type { RunCommandToolOptions } from "./run-command";

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
  const classification = classifyExec(argv);
  const touchedBefore =
    opts.exec.touchedPaths !== undefined && classification === "install"
      ? await snapshotExecTouchedPaths(normalizeManagerBinary(binary), normalized.cwd)
      : undefined;

  try {
    const result = await runArgv({
      argv: normalized.argv,
      cwd: normalized.cwd,
      timeoutMs: EXEC_TIMEOUT_MS,
      stripEnvVars: [...(opts.stripEnvVars ?? [])],
      // Yarn 2+ carries its no-scripts mechanism here rather than in argv.
      ...(normalized.env !== undefined ? { env: normalized.env } : {}),
    });
    const body = result.timedOut
      ? `timed out after ${EXEC_TIMEOUT_MS}ms`
      : `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`;

    // Task 10: the containment carve-out's write side. Recorded only for a
    // REAL success (not timed out, exit 0) of an argv `classifyExec` already
    // recognized as install-shaped -- never for a generic call, and never
    // from anything the model supplied itself (the filenames come from
    // `recordExecTouchedPaths`'s own table, keyed by the manager binary this
    // module already validated and normalized above). `normalized.cwd` is
    // the cwd nax itself computed, not one the model could redirect (see
    // `package-managers.ts`'s directory-redirect screens).
    if (opts.exec.touchedPaths !== undefined && !result.timedOut && result.exitCode === 0) {
      if (classification === "install" && touchedBefore !== undefined) {
        // Deliberately `binary` (from the ORIGINAL argv), not
        // `normalized.argv[0]`: manager identity is invariant under
        // normalization (normalizeExec only ever appends a scoping/
        // no-scripts flag or rewrites arguments after argv[0]; it never
        // changes the binary itself), so the two would name the same
        // manager here -- but every other read in this function uses
        // `normalized` for the values normalization actually changes
        // (cwd, env). Using the pre-normalization binary keeps that
        // distinction visible instead of reaching into `normalized.argv`
        // for a value it never touches.
        await recordExecTouchedPaths(opts.exec.touchedPaths, touchedBefore);
      }
    }

    return {
      content: body.slice(0, ctx.maxBytes),
      isError: result.timedOut || result.exitCode !== 0,
      // Task 7 reads this to write `executed` and `target` onto the ledger
      // row. Returning it here, rather than re-deriving it in the runtime,
      // keeps the recorded argv the one that actually ran.
      audit: { executed: normalized.argv, target },
    };
  } catch (err) {
    // A spawn-time failure (e.g. an unresolvable cwd) throws rather than
    // resolving with a non-zero exit; surfaced as a normal tool error so it
    // is indistinguishable, to the caller, from any other refusal above.
    const message = err instanceof Error ? err.message : String(err);
    return { content: message, isError: true };
  }
}
