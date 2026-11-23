/**
 * US-004 seams — `nax __complete` and `nax completion` at the real process
 * boundary.
 *
 * Importing `bin/nax.ts` runs the CLI, so the only way to prove the entry point
 * wires `registerCompletionCommand` into the program a user actually runs is to
 * spawn it. These four tests are the only place US-004 spawns the full nax
 * process; every other AC uses injected deps (`test/unit/cli/completion/`).
 *
 * Each fixture is an isolated project plus an isolated global config directory
 * (NAX_GLOBAL_CONFIG_DIR), so nothing here reads the developer's real `~/.nax`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

/** A cold start of bin/nax.ts takes ~1s; under full-suite load bun's 5s default is not enough. */
const CLI_PROCESS_TIMEOUT_MS = 30_000;

interface CliResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

let projectDir: string;
let globalDir: string;
let previousGlobalDir: string | undefined;

/** A nax project: `.nax/config.json` plus the feature directories named. */
function makeProject(root: string, featureNames: readonly string[] = []): void {
  mkdirSync(join(root, ".nax"), { recursive: true });
  Bun.write(join(root, ".nax", "config.json"), "{}\n");
  for (const name of featureNames) {
    mkdirSync(join(root, ".nax", "features", name), { recursive: true });
  }
}

/** Spawn the real entry point, draining both pipes concurrently with the exit. */
async function spawnNax(args: readonly string[]): Promise<CliResult> {
  const proc = Bun.spawn(["bun", join(process.cwd(), "bin", "nax.ts"), ...args], {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NAX_GLOBAL_CONFIG_DIR: globalDir },
    signal: AbortSignal.timeout(CLI_PROCESS_TIMEOUT_MS),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** The lines of the `Commands:` block of a `--help` listing. */
function commandListLines(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((line) => line.trim() === "Commands:");
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === "");
  return end === -1 ? rest : rest.slice(0, end);
}

/** The first whitespace-delimited word of each `Commands:` line. */
function commandNames(help: string): string[] {
  return commandListLines(help)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => name !== "");
}

beforeEach(() => {
  projectDir = realpathSync(makeTempDir("nax-cli-completion-project-"));
  globalDir = realpathSync(makeTempDir("nax-cli-completion-global-"));
  previousGlobalDir = process.env.NAX_GLOBAL_CONFIG_DIR;
  process.env.NAX_GLOBAL_CONFIG_DIR = globalDir;
});

afterEach(() => {
  if (previousGlobalDir === undefined) delete process.env.NAX_GLOBAL_CONFIG_DIR;
  else process.env.NAX_GLOBAL_CONFIG_DIR = previousGlobalDir;
  cleanupTempDir(projectDir);
  cleanupTempDir(globalDir);
});

describe("nax __complete at the process boundary (US-004)", () => {
  test(
    "AC-8 completes the feature names of the project named by -d",
    async () => {
      makeProject(projectDir, ["alpha", "beta"]);

      const { exitCode, stdout, stderr } = await spawnNax(["__complete", "--", "run", "-d", projectDir, "-f", ""]);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("alpha\nbeta\n");
      expect(stderr).toBe("");
    },
    CLI_PROCESS_TIMEOUT_MS,
  );

  test(
    "AC-9 completes the profile names from the global config directory",
    async () => {
      makeProject(projectDir);
      mkdirSync(join(globalDir, "profiles"), { recursive: true });
      await Bun.write(join(globalDir, "profiles", "fast.json"), "{}\n");

      const { exitCode, stdout } = await spawnNax(["__complete", "--", "run", "-d", projectDir, "--profile", ""]);

      expect(exitCode).toBe(0);
      expect(stdout).toBe("fast\n");
    },
    CLI_PROCESS_TIMEOUT_MS,
  );
});

describe("nax --help command list (US-004)", () => {
  test(
    "AC-10 the hidden __complete command is not listed",
    async () => {
      const { stdout } = await spawnNax(["--help"]);

      expect(commandNames(stdout)).not.toContain("__complete");
    },
    CLI_PROCESS_TIMEOUT_MS,
  );

  test(
    "AC-11 the completion command is listed",
    async () => {
      const { stdout } = await spawnNax(["--help"]);

      expect(commandNames(stdout)).toContain("completion");
    },
    CLI_PROCESS_TIMEOUT_MS,
  );
});
