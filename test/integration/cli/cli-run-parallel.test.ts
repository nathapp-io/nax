/**
 * US-002 — `nax run --parallel` validation at the CLI process boundary.
 *
 * AC-11/AC-12 are stated in terms of the process exit code and stderr of
 * `bun bin/nax.ts run`, so this test spawns the real entry point in an empty
 * temp dir (same approach as cli-run-max-iterations.test.ts / US-001). The flag
 * is rejected before the TUI mount and any project/config work, so no project
 * needs to be initialised and no agent is ever started.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawnRun(dir: string, args: string[]): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "bin/nax.ts", "run", "-f", "demo", "-d", dir, "--headless", ...args], {
    cwd: process.cwd(),
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

describe("nax run --parallel (US-002)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-run-parallel-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-11: --parallel 0 exits 1 with the positive-integer message on stderr", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--parallel", "0"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--parallel must be a positive integer (omit it to run sequentially)");
  }, 20000);

  test("AC-12: --parallel 4 passes flag validation and exits 1 at the uninitialised-project check", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--parallel", "4"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("nax not initialized. Run: nax init");
    expect(stderr).not.toContain("--parallel must be a positive integer");
  }, 20000);
});
