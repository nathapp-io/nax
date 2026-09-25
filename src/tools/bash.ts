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
 * one nobody tests. The launcher (P4) changes HOW the command runs -- inside
 * an OS sandbox when enabled -- never WHETHER.
 */
import type { BashApprovalMode } from "../config/bash-approval";
import { type CommandLauncher, rawBashRefusalReason, sandboxSentence, unsandboxedSentence } from "../sandbox";
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
  /**
   * Whether a human can answer an escalated command (ADR-030, amended for P4).
   * Read only under `escalate`; absent or false keeps `gated`'s wording, since
   * a run with no interaction channel denies every ask as `unavailable`.
   */
  readonly humanApproval?: boolean;
  /**
   * P4: how the command runs. Absent = today's direct spawn through
   * `_bashToolDeps.runArgv` (unit tests). Production always passes one --
   * disabled, available or unavailable -- and its state also shapes the
   * description, so the agent always knows whether it is sandboxed.
   */
  readonly launcher?: CommandLauncher;
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
 * US-001: a background process holding a pipe keeps the shell from exiting
 * cleanly, so the runtime SIGKILLs the whole process group after a short
 * drain grace. Every description variant states this so the model knows its
 * `&`ed processes will not outlive the call.
 */
const BACKGROUND_PROCESSES_KILLED_SENTENCE =
  "background processes still holding the command's output are killed when the command exits. ";

/**
 * `gated`'s description, also used verbatim for `escalate` when no human is
 * reachable -- see the `escalate` branch of `bashToolDescription`.
 */
function gatedDescription(shell: string, patterns: readonly string[] | undefined): string {
  return (
    `Run one shell command string under ${shell}. ${PREFER_STRUCTURED_TOOLS_SENTENCE}` +
    `${describeGrants(patterns)}; anything else is refused. ` +
    "Each segment of a `&&`/`||`/`;`/`|` chain is checked separately, and command substitution ($(...), backticks), " +
    "process substitution, here-documents and `2>&1` are refused outright because they cannot be analysed. " +
    "Paths and redirect targets must stay inside the repository root. " +
    BACKGROUND_PROCESSES_KILLED_SENTENCE
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * `escalate`'s description when a human is reachable (ADR-030, amended
 * 2026-09-23 and again for US-001). It states checkBashCommand's ACTUAL order:
 * the deny matcher and the payload checks run BEFORE the two escalatable sites
 * (a lexer refusal and a grant miss), so an out-of-bounds command never
 * reaches the human; on a refused command those checks cover the lexable prefix
 * -- the part before the unreadable construct -- and an approved command runs
 * as written. Pinned against the policy in
 * coding-tool-bash-escalate-truth.test.ts.
 */
function escalateDescription(shell: string, patterns: readonly string[] | undefined): string {
  return (
    `Run one shell command string under ${shell}. ${PREFER_STRUCTURED_TOOLS_SENTENCE}` +
    `${capitalize(describeGrants(patterns))}. Every command, granted or not, is checked first: paths ` +
    "and redirect targets must stay inside the repository root, and `.git/` access, denied flags, unexpanded " +
    "`$VAR`, glob or brace characters, `~`, a bare `cd`, and a command matching a deny rule are " +
    "refused without asking. For a command using a construct that cannot be analysed (e.g. command or process " +
    "substitution, backticks, here-documents, subshells, `2>&1`, `#` comments, an option-shaped `cd`), these " +
    "checks cover the part before that construct. A command outside the granted forms, or one using a construct " +
    "that cannot be analysed, is not refused: it is sent to a human for approval (unless an identical command " +
    "was already approved and remembered) and, if they allow it, runs exactly as written; it is refused if they " +
    "deny it or do not answer in time, so prefer the granted forms. Each segment of a `&&`/`||`/`;`/`|` chain is " +
    "checked separately. " +
    BACKGROUND_PROCESSES_KILLED_SENTENCE
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
const RAW_UNCONTAINED =
  "The command runs from the repository root, but paths are NOT contained to it: a command may read or write anywhere the nax process " +
  "itself can reach, inside the repository or outside it. ";

function rawDescription(shell: string, containment: string = RAW_UNCONTAINED): string {
  return (
    `Run one shell command string under ${shell}. ${PREFER_STRUCTURED_TOOLS_SENTENCE}` +
    "This stage runs under raw mode (ADR-030): pipes, redirects, command substitution ($(...), backticks), " +
    "process substitution, here-documents and subshells all work here -- nothing is refused for being unparseable, " +
    "and Bash allow/deny/ask rules configured for this stage are NOT consulted. " +
    containment +
    "The only refusal is a command the lexer CAN parse that names or redirects into one of the exact file " +
    "paths nax owns -- .nax/config.json, .nax/mono/*/config.json, " +
    ".nax/features/**/prd.json, or the root queue-control files -- change those through nax rather than by " + // nax-feature-dir-allow: prose naming the raw-mode protected-path screen, not a path construction
    "writing them directly. That screen is advisory, not a boundary: it matches exact file paths only, so a " +
    "command using command substitution, a directory target (cp x .nax/), a glob, a nested shell (sh -c '...'), " +
    "tar -C or dd of=, or a symlink alias all skip it; use the sandbox for a boundary. " +
    BACKGROUND_PROCESSES_KILLED_SENTENCE
  );
}

function rawUnavailableDescription(shell: string, reason: string): string {
  return (
    `Run one shell command string under ${shell} -- but on this machine ${rawBashRefusalReason(reason)} ` +
    "Under raw mode every call is refused; use the structured tools (Read, Glob, Grep, Git, RunCommand) instead. " +
    BACKGROUND_PROCESSES_KILLED_SENTENCE
  );
}

function bashToolDescription(shell: string, opts: BashToolOptions): string {
  const state = opts.launcher?.state ?? { kind: "disabled" as const };
  if (opts.bashApproval === "raw") {
    if (state.kind === "available")
      return rawDescription(shell, `The command runs from the repository root ${sandboxSentence(state.network)} `);
    if (state.kind === "unavailable") return rawUnavailableDescription(shell, state.reason);
    return rawDescription(shell);
  }
  // `escalate` describes escalation ONLY when a human is reachable (ADR-030,
  // amended for P4). Reachability is a separate config axis -- is an
  // interaction channel configured? -- resolved at the execution stage and
  // passed in as data. Without one every ask resolves `unavailable` and
  // denies, so the wording stays byte-identical to `gated`'s: promising a
  // human there would be the D13a fail-open shape stated in prose.
  const policyDescription =
    opts.bashApproval === "escalate" && opts.humanApproval === true
      ? escalateDescription(shell, opts.patterns)
      : gatedDescription(shell, opts.patterns);
  if (state.kind === "available") {
    return `${policyDescription} Commands that pass run ${sandboxSentence(state.network)}`;
  }
  if (state.kind === "unavailable") return `${policyDescription} ${unsandboxedSentence(state.reason)}`;
  return policyDescription;
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
        const launched =
          opts.launcher !== undefined
            ? await opts.launcher.run({
                spec: { kind: "shell", shell, command },
                root: ctx.root,
                cwd: ctx.root,
                timeoutMs,
                stripEnvVars: opts.stripEnvVars ?? [],
                ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
              })
            : {
                ...(await _bashToolDeps.runArgv({
                  argv,
                  cwd: ctx.root,
                  timeoutMs,
                  stripEnvVars: [...(opts.stripEnvVars ?? [])],
                  ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
                })),
                executed: argv,
                sandbox: undefined,
              };
        // US-001: an aborted call's body opens with the cancellation line and
        // surfaces whatever partial output the readers captured before the
        // process group was SIGKILLed (AC14). An orphansKilled call appends
        // the "[nax] background processes ..." final line so the model can
        // tell that a `&`ed process held the pipe and was reaped (AC15). Both
        // are independent of the regular `timed out` / `exit N` framing.
        let body: string;
        if (launched.aborted === true) {
          body = `Cancelled: the turn ended while this command was running.\nexit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}`;
        } else if (launched.orphansKilled === true) {
          body = `exit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}\n[nax] background processes still holding the output were killed`;
        } else if (launched.timedOut) {
          body = `timed out after ${timeoutMs}ms`;
        } else {
          body = `exit ${launched.exitCode}\n${launched.stdout}\n${launched.stderr}`;
        }
        // The tool's own bound is the I/O ceiling, not the model-facing cap:
        // `maxBytes` shapes what the model is told and belongs to the session's
        // truncation policy (which also spills what it cuts), while this one
        // only keeps a runaway command from being buffered without limit. The
        // full size still rides out on `resultBytesPreTruncation`.
        return {
          content: cutToByteCap(body, ctx.readCeiling ?? READ_CEILING),
          isError: launched.timedOut || launched.exitCode !== 0 || launched.aborted === true,
          // The ledger records what actually ran, not what was requested.
          // `exitCode` is recorded only when nax did not kill the process
          // group: under `timedOut` or `aborted` the code is nax's own kill
          // (128+signal) or the -1 never-spawned sentinel, not the command's.
          // `orphansKilled` still records it -- the shell exited by itself and
          // only background processes holding the pipe were reaped afterward.
          audit: {
            executed: launched.executed,
            ...(launched.sandbox !== undefined ? { sandbox: launched.sandbox } : {}),
            ...(!launched.timedOut && launched.aborted !== true ? { exitCode: launched.exitCode } : {}),
          },
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
