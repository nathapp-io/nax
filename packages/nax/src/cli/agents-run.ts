/**
 * US-008: the checks and errors of `nax agents run`.
 *
 * One ordered gate. The command validates the `--timeout` text, proves the project is trusted,
 * loads the config, loads the catalog and finds the agent, then delegates the task and the model,
 * stopping at the first failure. Trust comes second so an untrusted project never has its config
 * or catalog read, and every failure before a run result exists is one stderr line and exit 2.
 *
 * `--dir` is the *parent* `agents` command's option, read through `optsWithGlobals`; it is made
 * absolute here, before the trust root, the cwd and a relative `--task-file` are derived from it.
 * The task, the model and the run input are the other stories' modules — this file only orders
 * them. Registration, the result output and the signal lifecycle are US-009's.
 */
import { dirname, resolve } from "node:path";
import { errorMessage } from "@nathapp/nax-agent/internal";
import { findProjectDir, loadConfig, type NaxConfig } from "@/config";
import { NaxError } from "@/errors";
import { type AgentResource, loadResourceCatalog, type ResourceCatalog } from "@/resources";
import { ensureProjectTrusted, normalizeTrustPath, resolveTrustRoot } from "@/trust";
import { buildAgentsRunTaskInput } from "./agents-run-compose";
import { runAgentTask } from "./agents-run-exec";
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
): Promise<void> {
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
  // US-009 writes the result and awaits it before its explicit exit; the run itself is this call.
  await deps.runAgentTask(input);
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

/**
 * Run one agent on one task, checking in the order the design fixes and stopping at the first
 * failure: the `--timeout` text, trust, the config, the catalog and the agent, the task, then the
 * model. Trust is second, so an untrusted project never has its config or catalog read.
 */
export async function agentsRunCommand(
  agent: string,
  options: AgentsRunOptions,
  deps: AgentsRunCommandDeps = _agentsRunCommandDeps,
): Promise<void> {
  const cwd = resolve(options.dir);
  try {
    const timeoutSeconds = timeoutSecondsOf(options.timeout);
    await deps.ensureTrusted(cwd);
    await composeAndRun(agent, options, { cwd, timeoutSeconds }, deps);
  } catch (error) {
    await reportFailure(error, cwd, deps);
  }
}
