/**
 * The model-authored shell tool (spec §4 US-004).
 *
 * Session-local like `RunCommand`, not a global registry entry: it needs the
 * project's shell and secret-strip list, which are per-config. Created only
 * when the operation DECLARED it (see coding-tool-support.ts) — a tool the
 * global registry held would be callable by an op that never declared it,
 * because `callTool` looks a name up before it consults advertisement.
 *
 * WHERE IT RUNS: `ctx.root`, the hop's permitted root and the same root the
 * policy resolved every path against. Never the runtime's workdir — under `-d`
 * those differ, and that difference is the #1794 defect.
 *
 * WHAT GATES IT: nothing here. The command string reached this function only
 * because `policy.check` already lexed it, matched every segment against the
 * stage's `Bash(...)` rules and containment-checked its paths and redirects
 * (src/tools/policy-bash.ts). This module must never be given a "safe enough"
 * check of its own: two gates in two places drift, and the second one is the
 * one nobody tests.
 */
import type { BashApprovalMode } from "../config/bash-approval";
import { runArgv } from "../utils/argv-exec";
import type { CodingTool } from "./registry";
import { cutToByteCap, READ_CEILING } from "./truncate";
import { BASH_TOOL_NAME } from "./types";

/**
 * Deadline for a Bash spawn — the same ceiling the Exec branch uses
 * (`EXEC_TIMEOUT_MS`, src/tools/run-command-exec.ts). A model-authored command
 * may legitimately be a build or a full test run, and a shorter default would
 * be worked around rather than respected.
 */
export const BASH_TIMEOUT_MS = 300_000;

/** Floor for a caller-requested deadline: below this, a real command cannot
 * even start, and a 0 would disable the deadline entirely. */
const MIN_BASH_TIMEOUT_MS = 1_000;

export const DEFAULT_BASH_SHELL = "/bin/sh";

export interface BashToolOptions {
  /** `quality.shell`. */
  readonly shell?: string;
  /** `quality.stripEnvVars` — secrets removed before the spawn. */
  readonly stripEnvVars?: readonly string[];
  /** The stage's granted patterns, for the DESCRIPTION only. The policy is the
   * gate; naming the granted forms here is what stops the model spending a
   * turn discovering them by denial. Ignored under `raw` (see
   * `rawDescription` below) -- there is no per-pattern grant to name. */
  readonly patterns?: readonly string[];
  /**
   * ADR-030 mode this description should reflect. Defaults to `gated`, the
   * conservative posture, matching `compileToolPolicy`'s own default so an
   * omitted mode never advertises a capability the policy would not actually
   * grant.
   */
  readonly bashApproval?: BashApprovalMode;
}

/** Injectable seam, mirroring `_argvExecDeps` / `_gitToolDeps`. */
export const _bashToolDeps = { runArgv };

function describeGrants(patterns: readonly string[] | undefined): string {
  const named = (patterns ?? []).filter((pattern) => pattern !== "*");
  if (patterns?.includes("*") === true) return "every command form is granted for this stage";
  if (named.length === 0) return "no command forms are granted for this stage";
  return `granted command forms: ${named.join(", ")}`;
}

const PREFER_STRUCTURED_TOOLS_SENTENCE =
  "PREFER the structured tools when they express the task -- Read, Glob, Grep, Git and RunCommand return " +
  "bounded, parseable output, and Bash exists for what they cannot express. ";

/**
 * `gated`'s description, also used verbatim for `escalate` -- see the
 * comment on the `escalate` branch of `bashToolDescription` for why the two
 * must not diverge.
 */
function gatedDescription(shell: string, patterns: readonly string[] | undefined): string {
  return (
    `Run one shell command string under ${shell}. ${PREFER_STRUCTURED_TOOLS_SENTENCE}` +
    `${describeGrants(patterns)}; anything else is refused. ` +
    "Each segment of a `&&`/`||`/`;`/`|` chain is checked separately, and command substitution ($(...), backticks), " +
    "process substitution, here-documents and `2>&1` are refused outright because they cannot be analysed. " +
    "Paths and redirect targets must stay inside the repository root."
  );
}

/**
 * `raw`'s description (ADR-030 / F3). Under `raw`, `checkBashCommand` is
 * never consulted at all -- `commandBranch` in policy-command-branch.ts
 * dispatches to `screenRawBashCommand` and returns before it ever reads
 * `denyBy`/`askBy` -- so every clause of `gatedDescription` above is false
 * under this mode, and advertising it would push the model toward the exact
 * workaround (reading whole files instead of piping/grepping them) this ADR
 * exists to stop paying for.
 */
function rawDescription(shell: string): string {
  return (
    `Run one shell command string under ${shell}. ${PREFER_STRUCTURED_TOOLS_SENTENCE}` +
    "This stage runs under raw mode (ADR-030): pipes, redirects, command substitution ($(...), backticks), " +
    "process substitution, here-documents and subshells all work here -- nothing is refused for being unparseable, " +
    "and Bash allow/deny/ask rules configured for this stage are NOT consulted. The command runs from the " +
    "repository root, but paths are NOT contained to it: a command may read or write anywhere the nax process " +
    "itself can reach, inside the repository or outside it. The only refusal is a command the lexer CAN parse " +
    "that names or redirects into a path nax owns -- .nax/config.json, .nax/mono/*/config.json, " +
    ".nax/features/**/prd.json, or the root queue-control files -- change those through nax rather than by " + // nax-feature-dir-allow: prose naming the raw-mode protected-path screen, not a path construction
    "writing them directly; that screen is advisory, not a boundary, and a command using substitution skips it " +
    "entirely."
  );
}

function bashToolDescription(shell: string, opts: BashToolOptions): string {
  if (opts.bashApproval === "raw") return rawDescription(shell);
  // `escalate` ships against the existing `AskResolver` seam, whose only
  // implementation denies unconditionally until an interactive approval
  // channel exists (ADR-030 "What this does not decide"). Advertising
  // "unmatched commands go to a human" would be a lie for the whole of P1,
  // whose own exit criterion is metering `denied:ask` volume against that
  // lie never having been told -- so `escalate`'s description is IDENTICAL
  // to `gated`'s, deliberately, and must stay that way until P2 ships a real
  // resolver. Do not "improve" this by describing escalation.
  return gatedDescription(shell, opts.patterns);
}

export function createBashTool(opts: BashToolOptions = {}): CodingTool {
  const shell = opts.shell ?? DEFAULT_BASH_SHELL;
  return {
    name: BASH_TOOL_NAME,
    // A non-zero exit from a command the model wrote is its own red/green loop,
    // not a fault worth an operator's attention — the same reason RunCommand
    // sets this.
    routineErrors: true,
    description: bashToolDescription(shell, opts),
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: 'The shell command to run, e.g. "bun test src/a.test.ts"' },
        timeoutMs: {
          type: "number",
          description: `Deadline in milliseconds (default and maximum ${BASH_TIMEOUT_MS}).`,
        },
        description: { type: "string", description: "One short line on what this command is for." },
      },
      required: ["command"],
    },
    // `commandField` is what routes this call to the Bash branch of the policy
    // (src/tools/policy-bash.ts). No pathFields: the paths are inside the
    // command string, where only that branch can see them.
    scope: { pathFields: [], commandField: "command" },

    async run(input, ctx) {
      const command = input.command;
      if (typeof command !== "string" || command.trim() === "") {
        return { content: '"command" must be a non-empty string', isError: true };
      }
      const requested =
        typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs) ? input.timeoutMs : BASH_TIMEOUT_MS;
      const timeoutMs = Math.min(Math.max(Math.trunc(requested), MIN_BASH_TIMEOUT_MS), BASH_TIMEOUT_MS);
      const argv = [shell, "-c", command];

      try {
        const result = await _bashToolDeps.runArgv({
          argv,
          cwd: ctx.root,
          timeoutMs,
          stripEnvVars: [...(opts.stripEnvVars ?? [])],
        });
        const body = result.timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exit ${result.exitCode}\n${result.stdout}\n${result.stderr}`;
        // The tool's own bound is the I/O ceiling, not the model-facing cap:
        // `maxBytes` shapes what the model is told and belongs to the session's
        // truncation policy (which also spills what it cuts), while this one
        // only keeps a runaway command from being buffered without limit. The
        // full size still rides out on `resultBytesPreTruncation`.
        return {
          content: cutToByteCap(body, ctx.readCeiling ?? READ_CEILING),
          isError: result.timedOut || result.exitCode !== 0,
          // The ledger records what actually ran, not what was requested.
          audit: { executed: argv },
          resultBytesPreTruncation: Buffer.byteLength(body, "utf8"),
        };
      } catch (err) {
        // A spawn-time failure (an unresolvable cwd, a missing shell) rejects
        // rather than resolving with an exit code; surfaced as an ordinary tool
        // error so it is indistinguishable from any other refusal above.
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  };
}
