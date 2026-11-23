/**
 * Unit tests for the completion engine (US-002).
 *
 * Every case drives `completeWords` over a fixture commander program built here,
 * never over `bin/nax.ts`: the engine is a pure function of the program tree and
 * the injected sources, so the assertions are on the exact candidate list and on
 * the source arguments the walk produced.
 */

import { describe, expect, test } from "bun:test";
import { Command, Option } from "commander";
import { type CompletionSources, completeWords } from "@/cli/completion";

// ─── Fixture program ──────────────────────────────────────────────────────────

interface FixtureProgram {
  program: Command;
}

function buildFixtureProgram(): FixtureProgram {
  const program = new Command().name("nax");

  const run = program.command("run");
  run.option("-f, --feature <name>", "Feature name");
  run.option("--profile <name>", "Profile");
  run.option("-d, --dir <path>", "Working directory");
  run.option("--from <spec-path>", "Spec path");
  run.addOption(new Option("--secret-opt <x>", "Hidden on purpose").hideHelp());

  const plan = program.command("plan");
  plan.option("--resume [id]", "Resume a session");

  const init = program.command("init");
  init.option("-f, --force", "Force overwrite");

  const features = program.command("features");
  features.command("create <name>");
  features.command("list");
  features.command("resolve [name]");

  const config = program.command("config");
  const profile = config.command("profile");
  profile.command("show <name>");
  profile.command("use <name>");

  program.command("secret", { hidden: true });

  return { program };
}

/** `chat` carries the optional-value option the brief names (`--resume [id]`). */
function buildOptionalFixtureProgram(): Command {
  const program = new Command().name("nax");
  const chat = program.command("chat");
  chat.option("--resume [id]", "Resume a session");
  chat.option("-f, --feature <name>", "Feature name");
  return program;
}

// ─── Fixture sources ──────────────────────────────────────────────────────────

const CWD = "/w";
const HOME = "/home/u";
const FEATURE_NAMES = ["alpha", "beta"];
const PROFILE_NAMES = ["cheap", "fast", "slow"];

interface RecordingSources extends CompletionSources {
  readonly featureCalls: string[];
  readonly profileCalls: string[];
}

function buildSources(): RecordingSources {
  const featureCalls: string[] = [];
  const profileCalls: string[] = [];
  return {
    cwd: () => CWD,
    home: () => HOME,
    features: async (startDir) => {
      featureCalls.push(startDir);
      return FEATURE_NAMES;
    },
    profiles: async (startDir) => {
      profileCalls.push(startDir);
      return PROFILE_NAMES;
    },
    featureCalls,
    profileCalls,
  };
}

// ─── Subcommand candidates ────────────────────────────────────────────────────

describe("completeWords — subcommands", () => {
  test("AC-1: offers the root's visible subcommands, excluding secret and the implicit help command", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, [""], buildSources())).toEqual(["config", "features", "init", "plan", "run"]);
  });

  test("AC-2: offers the subcommands of the descended command", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["features", ""], buildSources())).toEqual(["create", "list", "resolve"]);
  });

  test("AC-16: offers nothing once a walked word names no subcommand", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    expect(await completeWords(program, ["features", "bogus", ""], sources)).toEqual([]);
    expect(sources.featureCalls).toEqual([]);
  });
});

// ─── Flag candidates ─────────────────────────────────────────────────────────

describe("completeWords — flags", () => {
  test("AC-9: narrows the flags of the reached command to the typed prefix", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["run", "--fe"], buildSources())).toEqual(["--feature"]);
  });

  test("AC-10: offers every visible short and long flag, hiding --secret-opt", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["run", "-"], buildSources())).toEqual([
      "--dir",
      "--feature",
      "--from",
      "--help",
      "--profile",
      "-d",
      "-f",
      "-h",
    ]);
  });

  test("AC-22: an optional-value option does not take a flag-shaped current word", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["plan", "--resume", "-"], buildSources())).toEqual([
      "--help",
      "--resume",
      "-h",
    ]);
  });

  test("a stuck walk does not suppress flag candidates", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["features", "bogus", "-"], buildSources())).toEqual(["--help", "-h"]);
  });
});

// ─── Option values ───────────────────────────────────────────────────────────

describe("completeWords — option values", () => {
  test("AC-3: completes --feature/-f with the feature names", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    expect(await completeWords(program, ["run", "-f", ""], sources)).toEqual(["alpha", "beta"]);
    expect(sources.featureCalls).toEqual([CWD]);
  });

  test("AC-4: narrows the feature names to the typed prefix", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["run", "--feature", "be"], buildSources())).toEqual(["beta"]);
  });

  test("AC-5: a boolean flag consumes no value, so no feature source is consulted", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    expect(await completeWords(program, ["init", "-f", ""], sources)).toEqual([]);
    expect(sources.featureCalls).toEqual([]);
  });

  test("AC-6: completes --profile with the profile names", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["run", "--profile", ""], buildSources())).toEqual(["cheap", "fast", "slow"]);
  });

  test("AC-7: a trailing comma starts a new profile name, excluding the ones already listed", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["run", "--profile", "fast,"], buildSources())).toEqual([
      "fast,cheap",
      "fast,slow",
    ]);
  });

  test("AC-8: a partial name after the comma narrows the appended candidates", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["run", "--profile", "fast,s"], buildSources())).toEqual(["fast,slow"]);
  });

  test("AC-13: an option with no nax value source yields no candidates", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    expect(await completeWords(program, ["run", "--from", ""], sources)).toEqual([]);
    expect(sources.featureCalls).toEqual([]);
  });
});

// ─── Positional values ───────────────────────────────────────────────────────

describe("completeWords — positional values", () => {
  test("AC-11: `features resolve` completes feature names positionally", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["features", "resolve", ""], buildSources())).toEqual(["alpha", "beta"]);
  });

  test("AC-12: `config profile use` completes profile names positionally", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["config", "profile", "use", "f"], buildSources())).toEqual(["fast"]);
  });

  test("AC-21: a positional already typed leaves nothing to complete", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    expect(await completeWords(program, ["features", "resolve", "alpha", ""], sources)).toEqual([]);
    expect(sources.featureCalls).toEqual([]);
  });
});

// ─── The walk ────────────────────────────────────────────────────────────────

describe("completeWords — walking", () => {
  test("AC-14: an option value is consumed, never read as a subcommand", async () => {
    const { program } = buildFixtureProgram();

    expect(await completeWords(program, ["run", "--profile", "fast", "-f", ""], buildSources())).toEqual([
      "alpha",
      "beta",
    ]);
  });

  test("AC-15: a flag-shaped word after a required-value option is that option's value", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    expect(await completeWords(program, ["run", "--from", "-f", ""], sources)).toEqual([]);
    expect(sources.featureCalls).toEqual([]);
  });

  test("an optional-value option relinquishes a flag-shaped word mid-walk", async () => {
    const program = buildOptionalFixtureProgram();
    const sources = buildSources();

    // `-f` is walked as a flag, so `--feature` is pending and the current word is its value.
    expect(await completeWords(program, ["chat", "--resume", "-f", ""], sources)).toEqual(["alpha", "beta"]);
    expect(sources.featureCalls).toEqual([CWD]);
  });
});

// ─── Project directory ───────────────────────────────────────────────────────

describe("completeWords — project directory", () => {
  test("AC-17: an absolute --dir value is the start directory", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    await completeWords(program, ["run", "-d", "/tmp/x", "-f", ""], sources);

    expect(sources.featureCalls).toEqual(["/tmp/x"]);
  });

  test("AC-18: a relative --dir value is resolved against the current directory", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    await completeWords(program, ["run", "-d", "sub", "-f", ""], sources);

    expect(sources.featureCalls).toEqual([`${CWD}/sub`]);
  });

  test("AC-19: a leading ~/ in the --dir value is replaced by the home directory", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    await completeWords(program, ["run", "-d", "~/proj", "-f", ""], sources);

    expect(sources.featureCalls).toEqual([`${HOME}/proj`]);
  });

  test("AC-20: with no --dir the start directory is the current directory", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    await completeWords(program, ["run", "-f", ""], sources);

    expect(sources.featureCalls).toEqual([CWD]);
  });

  test("a bare ~ --dir value is the home directory itself", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    await completeWords(program, ["run", "--dir", "~", "-f", ""], sources);

    expect(sources.featureCalls).toEqual([HOME]);
  });

  test("the last --dir value wins", async () => {
    const { program } = buildFixtureProgram();
    const sources = buildSources();

    await completeWords(program, ["run", "-d", "/tmp/first", "--dir", "/tmp/second", "-f", ""], sources);

    expect(sources.featureCalls).toEqual(["/tmp/second"]);
  });
});
