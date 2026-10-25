/**
 * The two things RunCommand shows the model: its description and its input
 * schema.
 *
 * Split out of run-command.ts when US-008 added the argv branch's opt-in escape
 * argument: the tool file crossed the 600-line source limit with the schema
 * groups (declared fields, argv fields, the escape's two fields) and the
 * description variants all in one function, and `check:file-sizes` has an empty
 * baseline. The split is by concern, not by convenience — nothing here executes
 * anything, and `run-command.ts` keeps every decision about what runs.
 *
 * `_runCommandToolDeps` moved with the description it feeds, and
 * `run-command.ts` re-exports it: it is a `_*Deps` seam that reaches
 * `./internal` through that module's star export, so its API-snapshot name and
 * the `#src/tools/run-command` specifier tests use both stay valid.
 */
import type { CommandLauncher } from "../sandbox/index.ts";
import { sandboxSentence, unsandboxedSentence } from "../sandbox/index.ts";
import { describeExecAllowlist } from "./exec-allowlist-text.ts";
import type { CodingTool } from "./registry.ts";
import type { RunCommandExecOptions } from "./run-command.ts";

/**
 * US-006: the platform seam `execSandboxNote` reads to decide whether the
 * description carries the macOS ps note.
 *
 * Kept out of `src/tools/index.ts` on purpose: `src/index.ts` takes named
 * exports from that barrel, so a seam there would reach the package's public
 * `.` entry, where `_` names are forbidden. It DOES reach `./internal`, because
 * `src/internal.ts` star-exports `run-command.ts` — which is exactly where a
 * `_*Deps` seam belongs (nax-only, outside semver), and why adding it needed
 * the one-line api/ snapshot update. Tests reach it through
 * `#src/tools/run-command`.
 */
export const _runCommandToolDeps = {
  platform: (): NodeJS.Platform => process.platform,
};

function execSandboxNote(launcher: CommandLauncher | undefined): string {
  const state = launcher?.state;
  if (state?.kind === "available")
    return ` An "argv" call runs ${sandboxSentence(state.network, state.sharedTmp !== false, _runCommandToolDeps.platform())}`;
  if (state?.kind === "unavailable") return ` ${unsandboxedSentence(state.reason)}`;
  return "";
}

/**
 * US-008: the one sentence an opted-in session appends to an Exec-capable
 * description. Worded for the argv branch ("the argv", not "the command") so it
 * reads as the argv branch's own argument — the declared branch refuses the
 * flag by name, and a shared sentence would promise a capability half the tool
 * rejects.
 */
const UNSANDBOXED_ARGV_SENTENCE =
  'Set "unsandboxed": true with an "unsandboxedReason" only when the argv needs the network, a local socket or a device the sandbox blocks.';

/**
 * US-008: the description with the opt-in sentence appended, or the description
 * unchanged. A separate function for the same reason `withUnsandboxedSentence`
 * is one in bash.ts: the separator is chosen here, so the off-form stays
 * byte-identical to what shipped, and no caller has to end its own sentence
 * with a space to keep the result readable.
 */
function withUnsandboxedArgvSentence(description: string, exec: RunCommandExecOptions): string {
  if (exec.unsandboxedCommands !== true) return description;
  const separator = description.endsWith(" ") ? "" : " ";
  return `${description}${separator}${UNSANDBOXED_ARGV_SENTENCE}`;
}

function execDescription(commandDescriptions: string, exec: RunCommandExecOptions): string {
  return withUnsandboxedArgvSentence(
    `Two ways to run something. (1) Run one of this project's declared commands: ${commandDescriptions} — supply "command" and, optionally, "values" for its placeholders. (2) Run an allowlisted external command via "argv" (an array, e.g. ["bun","add","left-pad"]) — no shell, so no quoting and no shell metacharacters; ${describeExecAllowlist(exec.patterns)}. Supply exactly one of "command" or "argv".${execSandboxNote(exec.launcher)}`,
    exec,
  );
}

export function runCommandDescription(commandDescriptions: string, exec: RunCommandExecOptions | undefined): string {
  if (exec === undefined) {
    return `Run one of this project's declared commands: ${commandDescriptions}. Supply values for its placeholders; you cannot write a command of your own.`;
  }
  return execDescription(commandDescriptions, exec);
}

/** The declared branch's two fields, always present. */
function declaredInputProperties(keys: readonly string[]): Record<string, unknown> {
  return {
    command: { type: "string", enum: keys, description: "Which declared command to run" },
    values: {
      type: "object",
      description:
        'Values for the command\'s placeholders, e.g. { files: "a.test.ts" }. A path placeholder takes several paths separated by spaces, e.g. { files: "a.test.ts b.test.ts" }, or as an array of paths, e.g. { files: ["test/a.test.ts", "test/b.test.ts"] } -- one call, not one per file.',
    },
  };
}

/** The argv branch's two fields, present only when `exec` is available. */
function argvInputProperties(): Record<string, unknown> {
  return {
    argv: {
      type: "array",
      items: { type: "string" },
      description:
        'Argv for an allowlisted external command, e.g. ["bun","add","left-pad"]. No shell: each element is one literal argument. Supply exactly one of "command" or "argv".',
    },
    target: {
      type: "string",
      enum: ["repoRoot", "package"],
      description: 'Working directory for "argv": this package (default) or the repo root.',
    },
  };
}

/**
 * US-008: the escape argument's two fields, only when the session opted in.
 * Neither is `required`: the escape is per call, and a call without it runs
 * exactly as it does today.
 */
function unsandboxedArgvProperties(exec: RunCommandExecOptions): Record<string, unknown> {
  if (exec.unsandboxedCommands !== true) return {};
  return { unsandboxed: { type: "boolean" }, unsandboxedReason: { type: "string" } };
}

/**
 * The tool's input schema. Each of the three conditional groups (declared
 * fields, argv fields, the opt-in escape argument) has one owner here, so
 * `createRunCommandTool` carries no schema branch of its own.
 *
 * With exec available, neither field is unconditionally required — `run()`
 * enforces "exactly one of command or argv" at call time, which a static JSON
 * Schema `required` list cannot express as an either/or.
 */
export function runCommandInputSchema(
  keys: readonly string[],
  exec: RunCommandExecOptions | undefined,
): CodingTool["inputSchema"] {
  return {
    type: "object",
    properties: {
      ...declaredInputProperties(keys),
      ...(exec === undefined ? {} : { ...argvInputProperties(), ...unsandboxedArgvProperties(exec) }),
    },
    ...(exec === undefined ? { required: ["command"] } : {}),
  };
}
