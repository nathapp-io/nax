/**
 * `nax accept` is a removal message (US-007).
 *
 * Workflow mode does not run acceptance tests, so `nax accept` — which
 * overrode failed acceptance criteria the run never produced — has nothing
 * left to override. The command stays declared so a user gets the removal
 * message instead of commander's unknown-command error, but it must read no
 * config and no PRD: the message is printed before any initialization, with
 * either the full option set or none at all.
 *
 * Driven through the real binary because both failure modes it replaces are
 * process-level: commander's required-option validation (bare `accept`) and
 * "Not in a nax project directory" (a config read). The empty temporary cwd
 * makes either regression observable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

/** Absolute bin path, resolved before the spawn so cwd can be an empty temp dir. */
const NAX_BIN = resolve(join(import.meta.dir, "../../../bin/nax.ts"));

const REMOVAL_MESSAGE = "nax accept was removed: workflow mode does not run acceptance tests";

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
async function spawnNax(cwd: string, args: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", NAX_BIN, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function spawnAccept(cwd: string, args: string[]): Promise<SpawnResult> {
  return spawnNax(cwd, ["accept", ...args]);
}

describe("nax accept (removed) — full option set", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-accept-removed-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-1: exits 1", async () => {
    const { exitCode } = await spawnAccept(tempDir, ["-f", "demo", "--override", "AC-1", "-r", "why"]);
    expect(exitCode).toBe(1);
  }, 20000);

  test("AC-2: prints the removal message to stderr", async () => {
    const { stderr } = await spawnAccept(tempDir, ["-f", "demo", "--override", "AC-1", "-r", "why"]);
    expect(stderr).toContain(REMOVAL_MESSAGE);
  }, 20000);
});

describe("nax accept (removed) — no options", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-accept-removed-bare-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-3: exits 1", async () => {
    const { exitCode } = await spawnAccept(tempDir, []);
    expect(exitCode).toBe(1);
  }, 20000);

  test("AC-4: prints the removal message to stderr", async () => {
    const { stderr } = await spawnAccept(tempDir, []);
    expect(stderr).toContain(REMOVAL_MESSAGE);
  }, 20000);

  test("AC-5: prints no 'required option' error", async () => {
    const { stderr } = await spawnAccept(tempDir, []);
    expect(stderr).not.toContain("required option");
  }, 20000);

  test("reads no config: the empty cwd never reaches the project-directory check", async () => {
    const { stderr } = await spawnAccept(tempDir, []);
    expect(stderr).not.toContain("Not in a nax project directory");
    // The removal message is the whole diagnostic, not one line among others.
    expect(stderr.trim()).toBe(REMOVAL_MESSAGE);
  }, 20000);
});

describe("nax accept (removed) — help", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-accept-removed-help-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("keeps the command declared with its removal description", async () => {
    const { exitCode, stdout } = await spawnNax(tempDir, ["--help"]);
    expect(exitCode).toBe(0);
    // Commander wraps the description column, so compare on folded whitespace.
    expect(stdout.replace(/\s+/g, " ")).toContain(
      "accept [options] Removed: workflow mode does not run acceptance tests",
    );
  }, 20000);
});
