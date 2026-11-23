/**
 * Unit tests for the completion command registration (US-004).
 *
 * Every test builds its own commander program and passes an injected
 * `CompletionCliDeps`, so no test touches the real process' stdout, stderr or
 * exit path — the only seams that are real are the ones the ACs describe
 * (`bin/nax.ts` at the process boundary, which lives in
 * `test/integration/cli/cli-completion.test.ts`).
 *
 * The AC id is the test-name prefix.
 */

import { describe, expect, test } from "bun:test";
import { Command } from "commander";
import {
  type CompletionCliDeps,
  type CompletionSources,
  completionScript,
  registerCompletionCommand,
} from "@/cli/completion";

// ─── Harness ──────────────────────────────────────────────────────────────────

/** What the injected deps recorded, in call order. */
interface Recorded {
  readonly stdout: string[];
  readonly stderr: string[];
  readonly exits: number[];
  /** Commands the program's default (chat) action ran for. */
  readonly routed: string[];
}

/** The sources AC-1..AC-7 share: features alpha and beta, no profiles. */
const DEFAULT_SOURCES: CompletionSources = {
  cwd: () => "/work",
  home: () => "/home/tester",
  features: async () => ["alpha", "beta"],
  profiles: async () => [],
};

/** A deps object recording every call, so a test can assert the exact sequence. */
function makeRecordedDeps(sources: CompletionSources = DEFAULT_SOURCES): {
  deps: CompletionCliDeps;
  recorded: Recorded;
} {
  const recorded: Recorded = { stdout: [], stderr: [], exits: [], routed: [] };
  return {
    recorded,
    deps: {
      write: (text) => recorded.stdout.push(text),
      writeErr: (text) => recorded.stderr.push(text),
      exit: (code) => {
        recorded.exits.push(code);
      },
      sources,
    },
  };
}

/**
 * A program shaped like nax's: `run` with `-d, --dir <path>`, `-f, --feature
 * <name>` and `--from <spec-path>` (no action, so a mis-dispatch shows up as a
 * routing record rather than as a run), a default `chat` command, then the
 * completion commands.
 */
function makeProgram(deps: CompletionCliDeps, recorded: Recorded): Command {
  const program = new Command();
  program.name("nax").description("test program").version("0.0.0").exitOverride();
  program
    .command("run")
    .option("-d, --dir <path>", "Project directory")
    .requiredOption("-f, --feature <name>")
    .option("--from <spec-path>");
  program
    .command("chat", { isDefault: true })
    .description("Default command")
    .action(() => {
      recorded.routed.push("chat");
    });
  registerCompletionCommand(program, deps);
  return program;
}

/** Parse `args` through a fresh program, returning what the deps recorded. */
async function runCompletion(args: readonly string[], sources: CompletionSources = DEFAULT_SOURCES): Promise<Recorded> {
  const { deps, recorded } = makeRecordedDeps(sources);
  await makeProgram(deps, recorded).parseAsync([...args], { from: "user" });
  return recorded;
}

/** The rendered help text of the registered `completion` command. */
function completionHelp(): string {
  const { deps, recorded } = makeRecordedDeps();
  const program = makeProgram(deps, recorded);
  const chunks: string[] = [];
  program.configureOutput({ writeOut: (text: string) => chunks.push(text) });
  const command = program.commands.find((candidate) => candidate.name() === "completion");
  if (command === undefined) throw new Error('no "completion" command was registered');
  command.outputHelp();
  return chunks.join("");
}

// ─── AC-1, AC-2, AC-3 ─────────────────────────────────────────────────────────

describe("registerCompletionCommand — __complete (US-004)", () => {
  test("AC-1 writes the feature candidates in one call, newline-terminated", async () => {
    const recorded = await runCompletion(["__complete", "--", "run", "-f", ""]);

    expect(recorded.stdout).toEqual(["alpha\nbeta\n"]);
    expect(recorded.stderr).toEqual([]);
    expect(recorded.exits).toEqual([]);
  });

  test("AC-2 a rejecting source produces no output at all", async () => {
    const recorded = await runCompletion(["__complete", "--", "run", "-f", ""], {
      ...DEFAULT_SOURCES,
      features: async () => {
        throw new Error("features directory vanished");
      },
    });

    expect(recorded.stdout).toEqual([]);
    expect(recorded.stderr).toEqual([]);
    expect(recorded.exits.filter((code) => code !== 0)).toEqual([]);
  });

  test("AC-3 an option with no value source writes nothing", async () => {
    const recorded = await runCompletion(["__complete", "--", "run", "--from", ""]);

    expect(recorded.stdout).toEqual([]);
    expect(recorded.stderr).toEqual([]);
  });

  test("an empty candidate list writes nothing at all", async () => {
    const recorded = await runCompletion(["__complete", "--", "run", "-f", "zzz"]);

    expect(recorded.stdout).toEqual([]);
    expect(recorded.exits).toEqual([]);
  });

  test("words after -- reach the engine intact, including the empty current word", async () => {
    const seen: string[][] = [];
    const { deps, recorded } = makeRecordedDeps({
      ...DEFAULT_SOURCES,
      features: async (startDir) => {
        seen.push([startDir]);
        return ["alpha", "beta"];
      },
    });
    // `-d` names the start directory, so the value proves the words were not
    // truncated at the `--` separator.
    await makeProgram(deps, recorded).parseAsync(["__complete", "--", "run", "-d", "/projects/somewhere", "-f", ""], {
      from: "user",
    });

    expect(seen).toEqual([["/projects/somewhere"]]);
  });
});

// ─── AC-4, AC-5 ───────────────────────────────────────────────────────────────

describe("registerCompletionCommand — completion <shell> (US-004)", () => {
  test("AC-4 zsh writes the zsh script in one call", async () => {
    const recorded = await runCompletion(["completion", "zsh"]);

    expect(recorded.stdout).toEqual([completionScript("zsh")]);
    expect(recorded.stderr).toEqual([]);
    expect(recorded.exits).toEqual([]);
  });

  test("AC-5 an unsupported shell reports every supported shell and exits 1", async () => {
    const recorded = await runCompletion(["completion", "fish"]);

    expect(recorded.stderr).toEqual(['unsupported shell "fish" (supported: bash, zsh)']);
    expect(recorded.exits).toEqual([1]);
    expect(recorded.stdout).toEqual([]);
  });

  test("bash is supported too", async () => {
    const recorded = await runCompletion(["completion", "bash"]);

    expect(recorded.stdout).toEqual([completionScript("bash")]);
    expect(recorded.exits).toEqual([]);
  });
});

// ─── AC-6, AC-7 ───────────────────────────────────────────────────────────────

describe("registerCompletionCommand — install help (US-004)", () => {
  test("AC-6 the help names ~/.zshrc and evals nax completion zsh", () => {
    const line = completionHelp()
      .split("\n")
      .find((candidate) => candidate.includes("~/.zshrc"));

    expect(line).toBeDefined();
    expect(line).toContain('eval "$(nax completion zsh)"');
  });

  test("AC-7 the help names ~/.bashrc and evals nax completion bash", () => {
    const line = completionHelp()
      .split("\n")
      .find((candidate) => candidate.includes("~/.bashrc"));

    expect(line).toBeDefined();
    expect(line).toContain('eval "$(nax completion bash)"');
  });
});

// ─── Protocol: explicit commands never fall through to the default command ────

describe("registerCompletionCommand — dispatch (US-004)", () => {
  test("__complete and completion act on their own commands, not on the default chat command", async () => {
    const complete = await runCompletion(["__complete", "--", "run", "-f", ""]);
    const script = await runCompletion(["completion", "zsh"]);

    expect(complete.routed).toEqual([]);
    expect(script.routed).toEqual([]);
  });
});
