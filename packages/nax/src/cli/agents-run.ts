/**
 * US-008: the checks and errors of `nax agents run`.
 * US-009: the run itself, its output, its signals and the `run` subcommand's registration.
 *
 * One ordered gate. The command validates the `--timeout` text, proves the project is trusted,
 * loads the config, loads the catalog and finds the agent, then delegates the task and the model,
 * stopping at the first failure. Trust comes second so an untrusted project never has its config
 * or catalog read, and every failure before a run result exists is one stderr line and exit 2.
 *
 * `--dir` is the *parent* `agents` command's option, read through `optsWithGlobals`; it is made
 * absolute here, before the trust root, the cwd and a relative `--task-file` are derived from it.
 * The task, the model and the run input are the other stories' modules — this file only orders
 * them. Once the run has a result, what to print and which code to exit with are
 * `agentsRunOutput`'s decision, written here unchanged and awaited so no output is cut short.
 */
import { dirname, resolve } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import type { Command, CommanderError } from "commander";
import { findProjectDir, loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { type AgentResource, loadResourceCatalog, type ResourceCatalog } from "@/resources";
import { ensureProjectTrusted, normalizeTrustPath, resolveTrustRoot } from "@/trust";
import { buildAgentsRunTaskInput } from "./agents-run-compose";
import { type AgentsRunResult, runAgentTask } from "./agents-run-exec";
import { agentsRunOutput } from "./agents-run-output";
import { resolveAgentsRunTask } from "./agents-run-task";

/** SIGINT and SIGTERM end the run as `cancelled`; US-009 registers them. */
type AgentsRunSignal = "SIGINT" | "SIGTERM";

/** A stream this command writes to, calling back once it has accepted the text — or failed to. */
export interface TextSink {
  write(text: string, callback: (error?: Error | null) => void): unknown;
}

const USAGE_ERROR_CODE = "AGENTS_RUN_USAGE";
const EXIT_USAGE_OR_CONFIG = 2;
const TIMEOUT_TEXT_PATTERN = /^[1-9][0-9]*$/;
const TIMEOUT_USAGE_MESSAGE = "--timeout must be a positive whole number of seconds";
const UNTRUSTED_CODE = "PROJECT_UNTRUSTED";

/**
 * Write `text` exactly as given to `stream`, resolving once it has accepted the text and
 * rejecting with the sink's own error when the write failed — a callback that carries an error
 * means the text was not delivered, so reporting it as acceptance would hide a lost message.
 */
export function writeText(stream: TextSink, text: string): Promise<void> {
  return new Promise<void>((accepted, failed) => {
    stream.write(text, (error) => {
      if (error) failed(error);
      else accepted();
    });
  });
}

export const _agentsRunCommandDeps = {
  // Non-interactive by design: nobody is attached to a headless run, so an untrusted project is
  // refused with the command that would trust it rather than waiting on a prompt.
  ensureTrusted: async (cwd: string): Promise<void> => {
    await ensureProjectTrusted(await normalizeTrustPath(resolveTrustRoot(cwd)), { interactive: false });
  },
  loadConfig,
  findProjectDir,
  loadResourceCatalog,
  resolveAgentsRunTask,
  buildAgentsRunTaskInput,
  runAgentTask,
  env: process.env,
  writeOut: (text: string): Promise<void> => writeText(process.stdout, text),
  writeErr: (text: string): Promise<void> => writeText(process.stderr, text),
  setExitCode: (code: number): void => {
    process.exitCode = code;
  },
  onSignal: (signal: AgentsRunSignal, handler: () => Promise<void>): (() => void) => {
    process.on(signal, handler);
    return () => {
      process.off(signal, handler);
    };
  },
  /** Leave with the code `setExitCode` recorded (`process.exit()` reads `process.exitCode`). */
  exit: (): void => {
    process.exit();
  },
};

export type AgentsRunCommandDeps = typeof _agentsRunCommandDeps;

export interface AgentsRunOptions {
  /** The parent `agents` command's `-d, --dir`, via `optsWithGlobals`. */
  readonly dir: string;
  readonly task?: string;
  readonly taskFile?: string;
  /** Raw repeated `--profile` values; `loadConfig` splits the comma lists itself. */
  readonly profile?: readonly string[];
  readonly model?: string;
  readonly json?: boolean;
  /** The raw `--timeout` text, validated here. */
  readonly timeout?: string;
}

/** What the checks settle before anything is composed: the absolute directory and the limit. */
interface RunContext {
  readonly cwd: string;
  readonly timeoutSeconds?: number;
  /** Aborted by SIGINT or SIGTERM; the run's own signal is replaced with it. */
  readonly signal: AbortSignal;
}

/**
 * `--timeout` is a positive whole number of seconds, judged on its text: `1e2` and `1.5` are
 * numbers but not whole-second text, and `45abc` is neither.
 */
function timeoutSecondsOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (!TIMEOUT_TEXT_PATTERN.test(text)) {
    throw new NaxError(TIMEOUT_USAGE_MESSAGE, USAGE_ERROR_CODE, { stage: "agents-run", timeout: text });
  }
  return Number(text);
}

/** The layered config, with `--profile` overrides only when at least one was given. */
async function runConfig(
  naxDir: string | null,
  profile: readonly string[] | undefined,
  deps: AgentsRunCommandDeps,
): Promise<NaxConfig> {
  if (profile === undefined || profile.length === 0) return await deps.loadConfig(naxDir ?? undefined);
  return await deps.loadConfig(naxDir ?? undefined, { profile });
}

/** The agent the catalog holds under this name — short, or qualified with its package. */
function findAgentOrThrow(name: string, catalog: ResourceCatalog): AgentResource {
  const agent = catalog.findAgent(name);
  if (agent === undefined) {
    throw new NaxError(`agent ${name} not found; see nax agents`, USAGE_ERROR_CODE, {
      stage: "agents-run",
      agent: name,
    });
  }
  return agent;
}

/**
 * Everything after the trust gate, in the order the design fixes: the config, the catalog and the
 * agent, the task, then the model. Each delegation's error propagates unchanged — it is already
 * the message the command reports.
 */
async function composeAndRun(
  agent: string,
  options: AgentsRunOptions,
  context: RunContext,
  deps: AgentsRunCommandDeps,
): Promise<AgentsRunResult> {
  const naxDir = deps.findProjectDir(context.cwd);
  const config = await runConfig(naxDir, options.profile, deps);
  const repoRoot = naxDir === null ? context.cwd : dirname(naxDir);
  const catalog = await deps.loadResourceCatalog({ repoRoot, config, env: deps.env, naxPluginPackages: [] });
  const resource = findAgentOrThrow(agent, catalog);
  const task = await deps.resolveAgentsRunTask({
    task: options.task,
    taskFile: options.taskFile,
    cwd: context.cwd,
    catalog,
  });
  const input = deps.buildAgentsRunTaskInput({
    agent: resource,
    task,
    catalog,
    config,
    cwd: context.cwd,
    repoRoot,
    modelOverride: options.model,
    timeoutSeconds: context.timeoutSeconds,
  });
  // The command owns the signal: it is the one SIGINT and SIGTERM abort, so it replaces whatever
  // the composed input carried.
  return await deps.runAgentTask({ ...input, signal: context.signal });
}

/**
 * Report a failure the way the design's table says. An untrusted project names its root and the
 * command that would trust it; every other error is its own one-line message. Both exit 2.
 *
 * The code is recorded before anything is written: it is what a caller gates on, and the stream
 * that would report a failed write is the one that just failed. For the same reason a rejected
 * write is caught here rather than propagated — there is nowhere left to report it to, and
 * rethrowing would replace the real usage error the caller is being told about.
 */
async function reportFailure(error: unknown, cwd: string, deps: AgentsRunCommandDeps): Promise<void> {
  deps.setExitCode(EXIT_USAGE_OR_CONFIG);
  try {
    if (error instanceof NaxError && error.code === UNTRUSTED_CODE) {
      const root = typeof error.context?.root === "string" ? error.context.root : cwd;
      const hint = typeof error.context?.hint === "string" ? error.context.hint : `run: nax trust add ${root}`;
      await deps.writeErr(`Project not trusted: ${root}\n`);
      await deps.writeErr(`${hint}\n`);
    } else {
      await deps.writeErr(`${errorMessage(error)}\n`);
    }
  } catch {
    // The sink that would report the failed write is the sink that failed; the exit code above
    // is the only channel left, and it is already recorded.
  }
}

/** What the command owns for the length of one run: the signal the run is given, and its handlers. */
interface SignalGuard {
  readonly signal: AbortSignal;
  /** Remove every handler registered. The second call changes nothing. */
  release(): void;
}

/** Both are the caller cancelling the run, and both abort the same controller. */
const AGENTS_RUN_SIGNALS = ["SIGINT", "SIGTERM"] as const satisfies readonly AgentsRunSignal[];

/**
 * Register both signals for the length of one run. Either aborts the same controller, so the run's
 * nested session sees one cancellation whichever arrived, and a second signal aborts an already
 * aborted controller, which changes nothing. The handlers stay registered until the run settles:
 * a signal that stops a turn before it begins still has to reach the session.
 */
function guardSignals(deps: AgentsRunCommandDeps): SignalGuard {
  const controller = new AbortController();
  const removers = AGENTS_RUN_SIGNALS.map((signal) =>
    deps.onSignal(signal, (): Promise<void> => {
      controller.abort();
      return Promise.resolve();
    }),
  );
  let released = false;
  return {
    signal: controller.signal,
    release(): void {
      if (released) return;
      released = true;
      for (const remove of removers) remove();
    },
  };
}

/**
 * Write what `agentsRunOutput` decided, unchanged, and record the exit code it chose.
 *
 * Both writes are awaited before the exit code is recorded, so the caller leaves only once the
 * streams have accepted the text. A write that fails is not caught here: the sink that would
 * report it is the sink that failed, and a result already exists, so it is not the usage/config
 * failure `reportFailure` describes — it propagates to the CLI entry point instead.
 */
async function reportResult(result: AgentsRunResult, json: boolean, deps: AgentsRunCommandDeps): Promise<void> {
  const output = agentsRunOutput(result, json);
  if (output.stdout !== undefined) await deps.writeOut(output.stdout);
  if (output.stderr !== undefined) await deps.writeErr(output.stderr);
  deps.setExitCode(output.exitCode);
}

/**
 * Run one agent on one task, checking in the order the design fixes and stopping at the first
 * failure: the `--timeout` text, trust, the config, the catalog and the agent, the task, then the
 * model. Trust is second, so an untrusted project never has its config or catalog read.
 *
 * A failure before a result exists is one stderr line and exit 2. Once there is a result, the
 * output module decides what to write and which code to exit with, and every signal handler is
 * removed on settlement — including a rejected run.
 */
export async function agentsRunCommand(
  agent: string,
  options: AgentsRunOptions,
  deps: AgentsRunCommandDeps = _agentsRunCommandDeps,
): Promise<void> {
  const cwd = resolve(options.dir);
  const guard = guardSignals(deps);
  let result: AgentsRunResult;
  try {
    const timeoutSeconds = timeoutSecondsOf(options.timeout);
    await deps.ensureTrusted(cwd);
    result = await composeAndRun(agent, options, { cwd, timeoutSeconds, signal: guard.signal }, deps);
  } catch (error) {
    await reportFailure(error, cwd, deps);
    return;
  } finally {
    guard.release();
  }
  await reportResult(result, options.json === true, deps);
}

/** What Commander parses for `run`: its own flags only, since `--dir` belongs to the parent. */
interface AgentsRunCliOptions {
  readonly task?: string;
  readonly taskFile?: string;
  /** Raw repeated `--profile` values, in the order they were given. */
  readonly profile?: string[];
  readonly model?: string;
  readonly json?: boolean;
  /** The raw `--timeout` text; the command validates it. */
  readonly timeout?: string;
}

/**
 * Leave the way a parser failure should. Commander raises these before the action runs — a
 * missing `<agent>`, an unknown option, an option whose value is absent — and by default exits 1,
 * which would report the same run with two different codes depending on which side noticed. A
 * parser failure is a usage error like any other, so it exits 2; a help request (the only
 * `_exit` with a zero code here) keeps its 0.
 *
 * `deps.exit()` does not return in production (`process.exit`). The rethrow is what keeps
 * Commander's own `process.exit(exitCode)` fall-through unreachable — and a stubbed `exit` in a
 * test from terminating the runner.
 */
function exitForParserError(error: CommanderError, deps: AgentsRunCommandDeps): never {
  deps.setExitCode(error.exitCode === 0 ? 0 : EXIT_USAGE_OR_CONFIG);
  deps.exit();
  throw error;
}

/** Each `--profile` occurrence appends; `loadConfig` splits the comma lists inside a value. */
function collectProfile(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

/**
 * The directory the run works in: the parent `agents` command's `-d, --dir`, which Commander gives
 * to the parent even when it follows the subcommand name, so `run` declares no `-d` of its own.
 * The fallback is the same CLI bootstrap default the parent declares, for a registration that
 * leaves the option out.
 */
function parentDir(command: Command): string {
  const dir = (command.optsWithGlobals() as { dir?: unknown }).dir;
  return typeof dir === "string" ? dir : process.cwd();
}

/**
 * Add `run` to the `agents` command. The parent keeps its `-d, --dir` and its listing action, so a
 * bare `nax agents` still lists and `nax agents run <agent>` runs one task.
 *
 * The ordered checks stay in `agentsRunCommand`: registration declares options and forwards them,
 * so nothing here can pre-empt the order the design fixes (the `--timeout` text, then trust, then
 * the config, the catalog and the agent). What registration does own is the exit code of a parser
 * failure, which {@link exitForParserError} maps to 2.
 */
export function registerAgentsRunCommand(agents: Command, deps: AgentsRunCommandDeps = _agentsRunCommandDeps): Command {
  return agents
    .command("run <agent>")
    .description("Run one agent on one task, unattended, and print its result")
    .option("--task <text>", "The task to give the agent")
    .option("--task-file <path>", "Read the task from a UTF-8 file (a relative path resolves against --dir)")
    .option("--profile <name>", "Profile(s) to overlay (repeatable)", collectProfile, [])
    .option("--model <id>", "Provider/model id, in place of the agent file's model")
    .option("--json", "Emit one machine-readable JSON object", false)
    .option("--timeout <seconds>", "Abort the run after this many seconds")
    .exitOverride((error: CommanderError): never => exitForParserError(error, deps))
    .action(async (agent: string, options: AgentsRunCliOptions, command: Command): Promise<void> => {
      await agentsRunCommand(agent, { ...options, dir: parentDir(command) }, deps);
      deps.exit();
    });
}
