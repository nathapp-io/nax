/**
 * US-008: the checks and errors of `nax agents run`.
 *
 * Every test enters through `agentsRunCommand` with stubbed deps, so what is asserted is the
 * order of the checks, the arguments each delegation receives and the exact stderr line and exit
 * code of every failure. No config, catalog or session is loaded for real; the one exception is
 * AC-9, which drives the *default* trust check against an empty registry to prove it is
 * non-interactive.
 */
import { describe, expect, mock, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  cleanupTempDir,
  makeAgentCatalog,
  makeAgentResource,
  makeNaxConfig,
  makeTempDir,
  useUntrustedRegistry,
} from "@test/helpers";
import { _agentsRunCommandDeps, type AgentsRunOptions, agentsRunCommand } from "@/cli/agents-run";
import type { AgentsRunResult, AgentsRunTaskInput } from "@/cli/agents-run-exec";
import { NaxError } from "@/errors";
import { _trustGateDeps, type TrustChoice } from "@/trust";

const REPO_NAX_DIR = "/repo/.nax";
const REPO_ROOT = "/repo";
const WORK_DIR = "/work/project";
const TIMEOUT_MESSAGE = "--timeout must be a positive whole number of seconds";

const AGENT = makeAgentResource({ name: "spec-reviewer" });
const CONFIG = makeNaxConfig();

/** What the stubbed `buildAgentsRunTaskInput` returns; the command only hands it on. */
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

/** A completed run; what the command prints for it belongs to the output story, not this one. */
const RUN_RESULT: AgentsRunResult = {
  agent: AGENT.qualifiedName,
  model: "openai/gpt-bal",
  status: "completed",
  output: "done",
  deniedAsks: [],
};

type CatalogRequest = Parameters<typeof _agentsRunCommandDeps.loadResourceCatalog>[0];
type TaskRequest = Parameters<typeof _agentsRunCommandDeps.resolveAgentsRunTask>[0];
type ComposeRequest = Parameters<typeof _agentsRunCommandDeps.buildAgentsRunTaskInput>[0];

/** A command whose every seam is a recording stub. */
function makeDeps() {
  // `a` is the one-letter name AC-1 and AC-2 pass as the agent, so those two reach composition.
  const catalog = makeAgentCatalog([AGENT, makeAgentResource({ name: "a" })]);
  const deps = {
    ..._agentsRunCommandDeps,
    ensureTrusted: mock(async (_cwd: string): Promise<void> => {}),
    loadConfig: mock(async (_startDir?: string, _cliOverrides?: Record<string, unknown>) => CONFIG),
    findProjectDir: mock((_dir: string): string | null => REPO_NAX_DIR),
    loadResourceCatalog: mock(async (_request: CatalogRequest) => catalog),
    resolveAgentsRunTask: mock(async (_request: TaskRequest) => TASK_INPUT.task),
    buildAgentsRunTaskInput: mock((_request: ComposeRequest) => TASK_INPUT),
    runAgentTask: mock(async (_input: AgentsRunTaskInput) => RUN_RESULT),
    env: { NAX_AGENTS_RUN_TEST: "1" },
    writeOut: mock(async (_text: string) => {}),
    writeErr: mock(async (_text: string) => {}),
    setExitCode: mock((_code: number) => {}),
  };
  return { deps };
}

type Deps = ReturnType<typeof makeDeps>["deps"];

function options(overrides: Partial<AgentsRunOptions> = {}): AgentsRunOptions {
  return { dir: WORK_DIR, task: "review it", ...overrides };
}

/** The one-line failure response: the message and a newline on stderr, exit 2, nothing on stdout. */
function expectUsageLine(deps: Deps, message: string): void {
  expect(deps.writeErr).toHaveBeenCalledTimes(1);
  expect(deps.writeErr).toHaveBeenCalledWith(`${message}\n`);
  expect(deps.writeOut).not.toHaveBeenCalled();
  expect(deps.setExitCode).toHaveBeenCalledWith(2);
}

/** Fail where the case says: the task helper, or the composition that resolves the model. */
function stageFailure(deps: Deps, source: "task" | "compose", message: string): void {
  const failure = new NaxError(message, "AGENTS_RUN_USAGE", { stage: "agents-run" });
  if (source === "task") {
    deps.resolveAgentsRunTask.mockRejectedValue(failure);
    return;
  }
  deps.buildAgentsRunTaskInput.mockImplementation(() => {
    throw failure;
  });
}

/** One row per (usage case, output mode) pair: its title, the options to run with, the seam, the message. */
type UsageRow = readonly [title: string, run: Partial<AgentsRunOptions>, source: "task" | "compose", message: string];

interface UsageCase {
  readonly ac: string;
  readonly name: string;
  /** The flags the case is about, so the options match the failure they stage. */
  readonly run: Partial<AgentsRunOptions>;
  readonly source: "task" | "compose";
  readonly message: string;
}

const USAGE_CASES: readonly UsageCase[] = [
  {
    ac: "AC-19",
    name: "neither --task nor --task-file",
    run: { task: undefined, taskFile: undefined },
    source: "task",
    message: "pass exactly one of --task or --task-file",
  },
  {
    ac: "AC-19",
    name: "both --task and --task-file",
    run: { task: "review it", taskFile: "task.md" },
    source: "task",
    message: "pass exactly one of --task or --task-file",
  },
  {
    ac: "AC-20",
    name: "an unreadable task file",
    run: { task: undefined, taskFile: "task.md" },
    source: "task",
    message: "cannot read task file task.md: ENOENT",
  },
  { ac: "AC-21", name: "an empty task", run: { task: "   " }, source: "task", message: "the task is empty" },
  {
    ac: "AC-22",
    name: "an unknown model",
    run: { model: "nonsense" },
    source: "compose",
    message: "unknown model nonsense; pass provider/model, acp:<agent>, or a configured alias",
  },
];

const MODES = [
  ["plain", false],
  ["json", true],
] as const;

const USAGE_ROWS: readonly UsageRow[] = MODES.flatMap(([mode, json]) =>
  USAGE_CASES.map(
    (row): UsageRow => [
      `${row.ac} (${mode} mode): ${row.name} writes its line and exits 2`,
      { ...row.run, json },
      row.source,
      row.message,
    ],
  ),
);

describe("agentsRunCommand", () => {
  describe("the working directory and the paths derived from it", () => {
    test("AC-1: the trust check runs on the absolute --dir", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("a", { dir: "sub", task: "t" }, deps);
      expect(deps.ensureTrusted).toHaveBeenCalledWith(resolve("sub"));
    });

    test("AC-2: the composed input is given that same absolute --dir as cwd", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("a", { dir: "sub", task: "t" }, deps);
      expect(deps.buildAgentsRunTaskInput.mock.calls[0]?.[0].cwd).toBe(resolve("sub"));
    });

    test.each([
      [REPO_NAX_DIR, REPO_ROOT],
      [null, WORK_DIR],
    ] as const)("AC-3: findProjectDir %p gives repoRoot %p", async (naxDir, repoRoot) => {
      const { deps } = makeDeps();
      deps.findProjectDir.mockReturnValue(naxDir);
      await agentsRunCommand("spec-reviewer", options(), deps);
      expect(deps.buildAgentsRunTaskInput.mock.calls[0]?.[0].repoRoot).toBe(repoRoot);
    });
  });

  describe("--timeout", () => {
    test.each(["0", "-3", "1.5", "abc", "45abc", "1e2"])(
      "AC-4: %p is refused before the trust check",
      async (timeout) => {
        const { deps } = makeDeps();
        await agentsRunCommand("spec-reviewer", options({ timeout }), deps);
        expectUsageLine(deps, TIMEOUT_MESSAGE);
        expect(deps.ensureTrusted).not.toHaveBeenCalled();
      },
    );

    test("AC-5: 45 reaches the composition as timeoutSeconds", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("spec-reviewer", options({ timeout: "45" }), deps);
      expect(deps.buildAgentsRunTaskInput.mock.calls[0]?.[0].timeoutSeconds).toBe(45);
    });
  });

  describe("trust", () => {
    test("AC-6: an untrusted project names its root and the command that grants trust", async () => {
      const { deps } = makeDeps();
      deps.ensureTrusted.mockRejectedValue(
        new NaxError("project not trusted", "PROJECT_UNTRUSTED", {
          stage: "trust",
          root: "/r",
          hint: "run: nax trust add /r",
        }),
      );
      await agentsRunCommand("spec-reviewer", options(), deps);
      expect(deps.writeErr.mock.calls).toEqual([["Project not trusted: /r\n"], ["run: nax trust add /r\n"]]);
      expect(deps.setExitCode).toHaveBeenCalledWith(2);
    });

    test("AC-7: an untrusted project never has its config or catalog read", async () => {
      const { deps } = makeDeps();
      deps.ensureTrusted.mockRejectedValue(
        new NaxError("project not trusted", "PROJECT_UNTRUSTED", { stage: "trust", root: "/r" }),
      );
      await agentsRunCommand("spec-reviewer", options(), deps);
      expect(deps.loadConfig).not.toHaveBeenCalled();
      expect(deps.loadResourceCatalog).not.toHaveBeenCalled();
      expect(deps.findProjectDir).not.toHaveBeenCalled();
    });

    test("AC-8: a trust store that cannot be read reports its message", async () => {
      const { deps } = makeDeps();
      deps.ensureTrusted.mockRejectedValue(
        new NaxError("trust store unreadable", "TRUST_STORE_UNREADABLE", { stage: "trust" }),
      );
      await agentsRunCommand("spec-reviewer", options(), deps);
      expectUsageLine(deps, "trust store unreadable");
    });
  });

  describe("config and catalog", () => {
    test("AC-10: --profile values reach loadConfig with the discovered .nax directory", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("spec-reviewer", options({ profile: ["a,b", "c"] }), deps);
      expect(deps.loadConfig).toHaveBeenCalledWith(REPO_NAX_DIR, { profile: ["a,b", "c"] });
    });

    test("AC-11: no --profile calls loadConfig with the directory argument only", async () => {
      const { deps } = makeDeps();
      deps.findProjectDir.mockReturnValue(null);
      await agentsRunCommand("spec-reviewer", options(), deps);
      expect(deps.loadConfig.mock.calls[0]).toHaveLength(1);
      expect(deps.loadConfig.mock.calls[0]).toEqual([undefined]);
    });

    test("AC-12: the catalog is repo-scoped and loads no nax plugins", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("spec-reviewer", options(), deps);
      expect(deps.loadResourceCatalog.mock.calls[0]?.[0]).toEqual({
        repoRoot: REPO_ROOT,
        config: CONFIG,
        env: deps.env,
        naxPluginPackages: [],
      });
    });

    test("AC-13: a config that fails to load reports its message", async () => {
      const { deps } = makeDeps();
      deps.loadConfig.mockRejectedValue(new Error("bad config"));
      await agentsRunCommand("spec-reviewer", options(), deps);
      expectUsageLine(deps, "bad config");
      expect(deps.loadResourceCatalog).not.toHaveBeenCalled();
    });

    test("AC-14: a catalog that fails to load reports its message", async () => {
      const { deps } = makeDeps();
      deps.loadResourceCatalog.mockRejectedValue(new Error("catalog broke"));
      await agentsRunCommand("spec-reviewer", options(), deps);
      expectUsageLine(deps, "catalog broke");
      expect(deps.resolveAgentsRunTask).not.toHaveBeenCalled();
    });
  });

  describe("the agent", () => {
    test("AC-15: an unknown agent names itself and stops before the task is resolved", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("ghost", options(), deps);
      expectUsageLine(deps, "agent ghost not found; see nax agents");
      expect(deps.resolveAgentsRunTask).not.toHaveBeenCalled();
    });

    test("AC-16: an unknown agent writes no JSON even with --json", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("ghost", options({ json: true }), deps);
      expect(deps.writeOut).not.toHaveBeenCalled();
    });
  });

  describe("the task and the model", () => {
    test("AC-17: a skill error stops before the run input is composed", async () => {
      const { deps } = makeDeps();
      stageFailure(deps, "task", "skill nope not found");
      await agentsRunCommand("spec-reviewer", options({ task: "/nope" }), deps);
      expectUsageLine(deps, "skill nope not found");
      expect(deps.buildAgentsRunTaskInput).not.toHaveBeenCalled();
    });

    test("AC-18: a missing balanced model reports its message and runs nothing", async () => {
      const { deps } = makeDeps();
      stageFailure(deps, "compose", "configure models.native.balanced or pass --model");
      await agentsRunCommand("spec-reviewer", options(), deps);
      expectUsageLine(deps, "configure models.native.balanced or pass --model");
      expect(deps.runAgentTask).not.toHaveBeenCalled();
    });

    test.each(USAGE_ROWS)("%s", async (_title, run, source, message) => {
      const { deps } = makeDeps();
      stageFailure(deps, source, message);
      await agentsRunCommand("spec-reviewer", options(run), deps);
      expectUsageLine(deps, message);
    });
  });

  describe("the run itself", () => {
    test("a valid call hands the composed input to runAgentTask", async () => {
      const { deps } = makeDeps();
      await agentsRunCommand("spec-reviewer", options(), deps);
      expect(deps.runAgentTask).toHaveBeenCalledTimes(1);
      expect(deps.runAgentTask).toHaveBeenCalledWith(TASK_INPUT);
      expect(deps.setExitCode).not.toHaveBeenCalled();
    });
  });
});

describe("the default deps", () => {
  // US-009's registration and signal lifecycle sit on this seam, so it is pinned here rather
  // than only exercised through a commander program.
  test("onSignal registers a handler and its remover unregisters it", async () => {
    const before = process.listenerCount("SIGINT");
    const handler = async (): Promise<void> => {};
    const remove = _agentsRunCommandDeps.onSignal("SIGINT", handler);
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    remove();
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
});

describe("the default trust check", () => {
  useUntrustedRegistry();

  test("AC-9: refuses a temp directory non-interactively and never prompts", async () => {
    const workDir = makeTempDir("nax-agents-run-work-");
    const globalDir = makeTempDir("nax-agents-run-global-");
    const savedGlobal = process.env.NAX_GLOBAL_CONFIG_DIR;
    const savedPrompt = _trustGateDeps.prompt;
    const prompt = mock(async (): Promise<TrustChoice> => "yes");
    // An empty global directory is an empty store: the preload's `/` entry would otherwise
    // cover every temp directory and the refusal under test would never happen.
    process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
    _trustGateDeps.prompt = prompt;
    try {
      const caught = await _agentsRunCommandDeps.ensureTrusted(workDir).then(
        () => null,
        (err: unknown) => err,
      );
      expect(caught).toBeInstanceOf(NaxError);
      expect(caught instanceof NaxError ? caught.code : null).toBe("PROJECT_UNTRUSTED");
      // The refusal names this directory's real path, so the default seam really did run on it.
      expect(caught instanceof NaxError ? caught.context?.root : undefined).toBe(realpathSync(workDir));
      expect(prompt).not.toHaveBeenCalled();
    } finally {
      _trustGateDeps.prompt = savedPrompt;
      if (savedGlobal === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
      else process.env.NAX_GLOBAL_CONFIG_DIR = savedGlobal;
      cleanupTempDir(workDir);
      cleanupTempDir(globalDir);
    }
  });
});
