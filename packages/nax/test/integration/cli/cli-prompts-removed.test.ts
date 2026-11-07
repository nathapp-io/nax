/**
 * `nax prompts` is a removal message (US-001).
 *
 * Workflow mode does not read prompt templates, so `nax prompts` — which
 * assembled prompt files, scaffolded overridable templates (`--init`) and
 * dumped a role's default prompt (`--export`) — has nothing left to do. The
 * command stays declared with its former option list so a user gets the
 * removal message instead of commander's unknown-command error, but it must
 * read no config, no PRD and no trust state: the message is printed before any
 * initialization, with either the full option set or none at all.
 *
 * Driven through the real binary because both failure modes it replaces are
 * process-level: commander's own handling of the options (bare `prompts`,
 * `--init` writing templates) and "Not in a nax project directory" (a config
 * read). The empty temporary cwd makes either regression observable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { stripAnsi } from "@/test-runners/detector";

/** Absolute bin path, resolved before the spawn so cwd can be an empty temp dir. */
const NAX_BIN = resolve(join(import.meta.dir, "../../../bin/nax.ts"));

const REMOVAL_MESSAGE = "nax prompts was removed: workflow mode does not read prompt templates";

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Both pipes are drained concurrently with the wait for exit. Reading one of
 * them after `proc.exited` would let a full pipe buffer block the child, and
 * leaving the read unawaited would let the assertion run before it settles.
 */
async function spawnNax(cwd: string, args: string[], env?: Record<string, string>): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", NAX_BIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function spawnPrompts(cwd: string, args: string[], env?: Record<string, string>): Promise<SpawnResult> {
  return spawnNax(cwd, ["prompts", ...args], env);
}

/** The former option list, verbatim: the stub has to swallow all of it. */
const FULL_OPTION_SET = [
  "-f",
  "demo",
  "--init",
  "--force",
  "--export",
  "implementer",
  "--story",
  "US-001",
  "--out",
  "out.md",
  "-d",
  ".",
];

describe("nax prompts (removed) — full option set", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-removed-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-1: exits 1", async () => {
    const { exitCode } = await spawnPrompts(tempDir, FULL_OPTION_SET);
    expect(exitCode).toBe(1);
  }, 20000);

  test("AC-2: prints the removal message to stderr", async () => {
    const { stderr } = await spawnPrompts(tempDir, FULL_OPTION_SET);
    expect(stderr).toContain(REMOVAL_MESSAGE);
  }, 20000);

  test("AC-3: writes nothing — neither templates nor --export output", async () => {
    await spawnPrompts(tempDir, FULL_OPTION_SET);
    expect(readdirSync(tempDir)).toEqual([]);
  }, 20000);
});

describe("nax prompts (removed) — no options", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-removed-bare-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-4: exits 1", async () => {
    const { exitCode } = await spawnPrompts(tempDir, []);
    expect(exitCode).toBe(1);
  }, 20000);

  test("AC-5: prints the removal message to stderr", async () => {
    const { stderr } = await spawnPrompts(tempDir, []);
    expect(stderr).toContain(REMOVAL_MESSAGE);
  }, 20000);

  test("prints no 'required option' or '--feature is required' error", async () => {
    const { stderr } = await spawnPrompts(tempDir, []);
    expect(stderr).not.toContain("required option");
    expect(stderr).not.toContain("--feature is required");
  }, 20000);
});

describe("nax prompts (removed) — help", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-prompts-removed-help-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-6: exits 0", async () => {
    const { exitCode } = await spawnPrompts(tempDir, ["--help"]);
    expect(exitCode).toBe(0);
  }, 20000);

  test("AC-7: keeps the command declared with its removal description", async () => {
    const { stdout } = await spawnPrompts(tempDir, ["--help"]);
    // Commander wraps the description column, so compare on folded whitespace.
    expect(stdout.replace(/\s+/g, " ")).toContain("Removed: workflow mode does not read prompt templates");
  }, 20000);
});

describe("nax prompts (removed) — reads no config, PRD or trust state", () => {
  let projectDir: string;
  let globalDir: string;

  beforeEach(() => {
    projectDir = realpathSync(makeTempDir("nax-prompts-removed-project-"));
    globalDir = realpathSync(makeTempDir("nax-prompts-removed-global-"));
    // Every input the removed command used to read is present and malformed:
    // a single read of any of them surfaces as a parse error on stderr.
    mkdirSync(join(projectDir, ".nax", "features", "demo"), { recursive: true });
    writeFileSync(join(projectDir, ".nax", "config.json"), "{ not json");
    writeFileSync(join(projectDir, ".nax", "features", "demo", "prd.json"), "{ not json");
    writeFileSync(join(globalDir, "trust.json"), "{ not json");
  });

  afterEach(() => {
    cleanupTempDir(projectDir);
    cleanupTempDir(globalDir);
  });

  test("AC-8: the removal message is the whole diagnostic", async () => {
    const { exitCode, stderr } = await spawnPrompts(projectDir, ["-f", "demo", "-d", "."], {
      NAX_GLOBAL_CONFIG_DIR: globalDir,
    });

    expect(exitCode).toBe(1);
    expect(stripAnsi(stderr).trim()).toBe(REMOVAL_MESSAGE);
  }, 20000);
});
