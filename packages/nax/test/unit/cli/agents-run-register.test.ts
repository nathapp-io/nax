/**
 * US-009: the run itself, its output, its signals and the registration of `nax agents run`.
 *
 * Every case enters the command either directly (`agentsRunCommand` with stubbed deps) or through
 * a Commander program whose `agents` command — the parent that owns `-d, --dir` — was passed to
 * `registerAgentsRunCommand`, and asserts what reaches `runAgentTask` and what is written. The
 * expected text is always the one `agentsRunOutput` produces, so these cases pin that the command
 * delegates the decision instead of re-deriving it. AC-16 spawns `bin/nax.ts` for `--help` only:
 * that proves the production registration without opening a session, as `test/unit/cli/chat.test.ts`
 * AC-18 does for `nax chat`.
 */
import { describe, expect, type Mock, mock, test } from "bun:test";
import {
  assertDefined,
  firstCall,
  makeAgentCatalog,
  makeAgentResource,
  makeNaxConfig,
  waitForCondition,
} from "@test/helpers";
import { Command } from "commander";
import {
  agentsRunCommand as barrelAgentsRunCommand,
  registerAgentsRunCommand as barrelRegisterAgentsRunCommand,
} from "@/cli";
import {
  _agentsRunCommandDeps,
  type AgentsRunOptions,
  agentsRunCommand,
  registerAgentsRunCommand,
} from "@/cli/agents-run";
import type { AgentsRunResult, AgentsRunTaskInput } from "@/cli/agents-run-exec";
import { agentsRunOutput } from "@/cli/agents-run-output";

const WORK_DIR = "/work/project";
const REPO_ROOT = "/repo";

const AGENT = makeAgentResource({ name: "spec-reviewer" });
const CONFIG = makeNaxConfig();

/** The input the stubbed composition returns; the command only hands it on. */
const TASK_INPUT: AgentsRunTaskInput = {
  agent: AGENT,
  task: "review it",
  model: "openai/gpt-bal",
  toolProviders: [],
  loopHandlers: [],
  cwd: WORK_DIR,
  repoRoot: REPO_ROOT,
  config: CONFIG,
};

/** A signal on the composed input, which the command must replace with its own. */
const COMPOSED_SIGNAL = new AbortController().signal;
const COMPOSED_INPUT: AgentsRunTaskInput = { ...TASK_INPUT, signal: COMPOSED_SIGNAL };

const COMPLETED: AgentsRunResult = {
  agent: AGENT.qualifiedName,
  model: "openai/gpt-bal",
  status: "completed",
  output: "VERDICT: ready",
  deniedAsks: [],
};
const TIMED_OUT: AgentsRunResult = { ...COMPLETED, status: "timeout", output: "too slow" };
const CANCELLED: AgentsRunResult = { ...COMPLETED, status: "cancelled", output: "stopped" };
const FAILED_WITH_DENIAL: AgentsRunResult = {
  ...COMPLETED,
  status: "failed",
  output: "boom",
  deniedAsks: [{ kind: "approval", tool: "Bash", summary: "rm -rf build" }],
};

type SignalName = Parameters<typeof _agentsRunCommandDeps.onSignal>[0];
type CatalogRequest = Parameters<typeof _agentsRunCommandDeps.loadResourceCatalog>[0];
type TaskRequest = Parameters<typeof _agentsRunCommandDeps.resolveAgentsRunTask>[0];
type ComposeRequest = Parameters<typeof _agentsRunCommandDeps.buildAgentsRunTaskInput>[0];

interface HarnessOptions {
  /** Make `runAgentTask` reject with this instead of resolving to a result. */
  readonly rejectWith?: unknown;
  /** Hold every write the command makes until `releaseWrites()`. */
  readonly holdWrites?: boolean;
}

/**
 * A command whose every seam is a recording stub. The run itself is held until `resolveRun`, so
 * a case can act while the run is in flight — the signal handlers are only registered until then.
 */
function makeHarness(options: HarnessOptions = {}) {
  const catalog = makeAgentCatalog([AGENT]);
  const run = Promise.withResolvers<AgentsRunResult>();
  const writes = Promise.withResolvers<void>();
  const handlers = new Map<SignalName, () => Promise<void>>();
  const removers: Mock<() => void>[] = [];
  let received: AgentsRunTaskInput | undefined;
  const deps = {
    ..._agentsRunCommandDeps,
    ensureTrusted: mock(async (_cwd: string): Promise<void> => {}),
    loadConfig: mock(async (_startDir?: string, _cliOverrides?: Record<string, unknown>) => CONFIG),
    findProjectDir: mock((_dir: string): string | null => null),
    loadResourceCatalog: mock(async (_request: CatalogRequest) => catalog),
    resolveAgentsRunTask: mock(async (_request: TaskRequest): Promise<string> => TASK_INPUT.task),
    buildAgentsRunTaskInput: mock((_request: ComposeRequest): AgentsRunTaskInput => COMPOSED_INPUT),
    runAgentTask: mock(async (input: AgentsRunTaskInput): Promise<AgentsRunResult> => {
      received = input;
      if (options.rejectWith !== undefined) throw options.rejectWith;
      return await run.promise;
    }),
    env: {},
    writeOut: mock(async (_text: string): Promise<void> => {
      if (options.holdWrites === true) await writes.promise;
    }),
    writeErr: mock(async (_text: string): Promise<void> => {
      if (options.holdWrites === true) await writes.promise;
    }),
    setExitCode: mock((_code: number): void => {}),
    onSignal: mock((signal: SignalName, handler: () => Promise<void>): (() => void) => {
      handlers.set(signal, handler);
      const remove = mock((): void => {});
      removers.push(remove);
      return remove;
    }),
    exit: mock((): void => {}),
  };
  return {
    deps,
    /** The input the command handed `runAgentTask`. */
    received: (): AgentsRunTaskInput | undefined => received,
    /** The handler the command registered for `signal`. */
    handler: (signal: SignalName): (() => Promise<void>) | undefined => handlers.get(signal),
    /** Every unsubscribe `onSignal` returned, in registration order. */
    removers,
    /** Let the held run settle. */
    resolveRun: (result: AgentsRunResult): void => run.resolve(result),
    /** Let every held write resolve. */
    releaseWrites: (): void => writes.resolve(),
  };
}

type Harness = ReturnType<typeof makeHarness>;

function options(overrides: Partial<AgentsRunOptions> = {}): AgentsRunOptions {
  return { dir: WORK_DIR, task: "review it", ...overrides };
}

/**
 * The exact text `agentsRunOutput` decided for a result, narrowed to a string: every case that
 * asserts a write compares against this, so the command is pinned to delegating the decision
 * rather than re-deriving it.
 */
function outputText(text: string | undefined): string {
  assertDefined(text, "agentsRunOutput text");
  return text;
}

/** Wait until the command has handed its input to `runAgentTask`. */
async function waitForRun(harness: Harness): Promise<void> {
  await waitForCondition(() => harness.received() !== undefined);
}

describe("agentsRunCommand: the run and its output", () => {
  test("AC-1: runAgentTask receives the composed input with its signal replaced", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    await agentsRunCommand("spec-reviewer", options(), harness.deps);

    const received = harness.received();
    expect(harness.deps.runAgentTask).toHaveBeenCalledTimes(1);
    expect(received?.signal).toBeInstanceOf(AbortSignal);
    expect(received?.signal).not.toBe(COMPOSED_SIGNAL);
    expect(received).toEqual({ ...COMPOSED_INPUT, signal: received?.signal });
  });

  test("AC-2: a rejected run writes its message and exits 2", async () => {
    const harness = makeHarness({ rejectWith: new Error("cannot build options") });
    await agentsRunCommand("spec-reviewer", options(), harness.deps);

    expect(harness.deps.writeErr.mock.calls).toEqual([["cannot build options\n"]]);
    expect(harness.deps.writeOut).not.toHaveBeenCalled();
    expect(harness.deps.setExitCode).toHaveBeenCalledWith(2);
  });

  test("AC-3: a completed plain result writes the output module's stdout and exits 0", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    await agentsRunCommand("spec-reviewer", options(), harness.deps);

    expect(harness.deps.writeOut).toHaveBeenCalledTimes(1);
    expect(firstCall(harness.deps.writeOut)[0]).toBe(outputText(agentsRunOutput(COMPLETED, false).stdout));
    expect(harness.deps.writeErr).not.toHaveBeenCalled();
    expect(harness.deps.setExitCode).toHaveBeenCalledWith(0);
  });

  test("AC-4: a json timeout writes one JSON object and exits 1", async () => {
    const harness = makeHarness();
    harness.resolveRun(TIMED_OUT);
    await agentsRunCommand("spec-reviewer", options({ json: true }), harness.deps);

    expect(harness.deps.writeOut).toHaveBeenCalledTimes(1);
    expect(firstCall(harness.deps.writeOut)[0]).toBe(outputText(agentsRunOutput(TIMED_OUT, true).stdout));
    expect(harness.deps.setExitCode).toHaveBeenCalledWith(1);
  });

  test("AC-5: a failed plain result with a denied ask writes the output module's stderr and exits 1", async () => {
    const harness = makeHarness();
    harness.resolveRun(FAILED_WITH_DENIAL);
    await agentsRunCommand("spec-reviewer", options(), harness.deps);

    expect(harness.deps.writeErr).toHaveBeenCalledTimes(1);
    expect(firstCall(harness.deps.writeErr)[0]).toBe(outputText(agentsRunOutput(FAILED_WITH_DENIAL, false).stderr));
    expect(harness.deps.writeOut).not.toHaveBeenCalled();
    expect(harness.deps.setExitCode).toHaveBeenCalledWith(1);
  });
});

describe("agentsRunCommand: the signals", () => {
  test("AC-6: SIGINT aborts the signal the run was given", async () => {
    const harness = makeHarness();
    const command = agentsRunCommand("spec-reviewer", options(), harness.deps);
    await waitForRun(harness);

    const signal = harness.received()?.signal;
    expect(signal?.aborted).toBe(false);
    await harness.handler("SIGINT")?.();
    expect(signal?.aborted).toBe(true);

    harness.resolveRun(CANCELLED);
    await command;
  });

  test("AC-7: SIGTERM aborts that same signal", async () => {
    const harness = makeHarness();
    const command = agentsRunCommand("spec-reviewer", options(), harness.deps);
    await waitForRun(harness);

    const signal = harness.received()?.signal;
    expect(signal?.aborted).toBe(false);
    await harness.handler("SIGTERM")?.();
    expect(signal?.aborted).toBe(true);

    harness.resolveRun(CANCELLED);
    await command;
  });

  test("AC-8: every unsubscribe is called once the run settles", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    await agentsRunCommand("spec-reviewer", options(), harness.deps);

    expect(harness.removers).toHaveLength(2);
    for (const remove of harness.removers) expect(remove).toHaveBeenCalledTimes(1);
  });

  test("AC-8: every unsubscribe is called once a rejected run settles", async () => {
    const harness = makeHarness({ rejectWith: new Error("cannot build options") });
    await agentsRunCommand("spec-reviewer", options(), harness.deps);

    expect(harness.removers).toHaveLength(2);
    for (const remove of harness.removers) expect(remove).toHaveBeenCalledTimes(1);
  });
});

const DEFAULT_DIR = "/agents/default";

/**
 * A program whose `agents` command — the parent that owns `-d, --dir` — is the one the run
 * subcommand is registered on, exactly as `bin/nax.ts` does it. The parent keeps its own action,
 * which counts as the listing a bare `nax agents` still performs.
 */
function makeProgram(harness: Harness) {
  let listings = 0;
  const program = new Command();
  const agents = program
    .command("agents")
    .description("List available coding agents with status and capabilities")
    .option("-d, --dir <path>", "Project directory", DEFAULT_DIR);
  agents.action(async (): Promise<void> => {
    listings += 1;
  });
  registerAgentsRunCommand(agents, harness.deps);
  return { program, listings: (): number => listings };
}

describe("registerAgentsRunCommand", () => {
  test("AC-9: agents run <agent> --task runs that task once", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    const { program } = makeProgram(harness);

    await program.parseAsync(["agents", "run", "spec-reviewer", "--task", "review it"], { from: "user" });

    expect(harness.deps.runAgentTask).toHaveBeenCalledTimes(1);
    expect(harness.deps.resolveAgentsRunTask.mock.calls[0]?.[0].task).toBe("review it");
  });

  test("AC-10: a -d after the subcommand name reaches ensureTrusted", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    const { program } = makeProgram(harness);

    await program.parseAsync(["agents", "run", "spec-reviewer", "--task", "t", "-d", "/d"], { from: "user" });

    expect(harness.deps.ensureTrusted).toHaveBeenCalledWith("/d");
  });

  test("AC-11: with no -d the parent's default directory is checked", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    const { program } = makeProgram(harness);

    await program.parseAsync(["agents", "run", "spec-reviewer", "--task", "t"], { from: "user" });

    expect(harness.deps.ensureTrusted).toHaveBeenCalledWith(DEFAULT_DIR);
  });

  test("AC-12: a bare agents still lists and never runs an agent", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    const fixture = makeProgram(harness);

    await fixture.program.parseAsync(["agents"], { from: "user" });

    expect(fixture.listings()).toBe(1);
    expect(harness.deps.runAgentTask).not.toHaveBeenCalled();
  });

  test("AC-13: --json, --timeout, --model and --profile reach the command", async () => {
    const harness = makeHarness();
    harness.resolveRun(COMPLETED);
    const { program } = makeProgram(harness);

    await program.parseAsync(
      ["agents", "run", "spec-reviewer", "--task", "t", "--json", "--timeout", "9", "--model", "m", "--profile", "p"],
      { from: "user" },
    );

    expect(harness.deps.buildAgentsRunTaskInput.mock.calls[0]?.[0]).toMatchObject({
      timeoutSeconds: 9,
      modelOverride: "m",
    });
    expect(harness.deps.loadConfig.mock.calls[0]).toEqual([undefined, { profile: ["p"] }]);
    // `--json` reached the command: the one write is the JSON object, not the plain text.
    expect(firstCall(harness.deps.writeOut)[0]).toBe(outputText(agentsRunOutput(COMPLETED, true).stdout));
  });

  test("AC-14: exit waits for the stdout write to resolve", async () => {
    const harness = makeHarness({ holdWrites: true });
    harness.resolveRun(COMPLETED);
    const { program } = makeProgram(harness);

    const parsed = program.parseAsync(["agents", "run", "spec-reviewer", "--task", "t"], { from: "user" });
    await waitForCondition(() => harness.deps.writeOut.mock.calls.length === 1);
    expect(harness.deps.exit).not.toHaveBeenCalled();

    harness.releaseWrites();
    await parsed;
    expect(harness.deps.exit).toHaveBeenCalledTimes(1);
  });

  test("AC-14: exit waits for the stderr write to resolve", async () => {
    const harness = makeHarness({ holdWrites: true });
    harness.resolveRun(FAILED_WITH_DENIAL);
    const { program } = makeProgram(harness);

    const parsed = program.parseAsync(["agents", "run", "spec-reviewer", "--task", "t"], { from: "user" });
    await waitForCondition(() => harness.deps.writeErr.mock.calls.length === 1);
    expect(harness.deps.exit).not.toHaveBeenCalled();

    harness.releaseWrites();
    await parsed;
    expect(harness.deps.exit).toHaveBeenCalledTimes(1);
  });
});

describe("the src/cli barrel", () => {
  test("AC-15: agentsRunCommand and registerAgentsRunCommand are exported as functions", () => {
    expect(typeof barrelAgentsRunCommand).toBe("function");
    expect(typeof barrelRegisterAgentsRunCommand).toBe("function");
    expect(barrelAgentsRunCommand).toBe(agentsRunCommand);
    expect(barrelRegisterAgentsRunCommand).toBe(registerAgentsRunCommand);
  });
});

describe("bin registration", () => {
  test("AC-16: bin registers agents run help", async () => {
    const proc = Bun.spawn(["bun", "bin/nax.ts", "agents", "run", "--help"], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout).toContain("--task-file <path>");
  }, 30_000);
});
