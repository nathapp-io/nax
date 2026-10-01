/**
 * US-001 — `nax run -m/--max-iterations` validation at the CLI process boundary.
 *
 * AC-10/AC-11 are stated in terms of the process exit code and stderr of
 * `bun bin/nax.ts run`, so this test spawns the real entry point in an empty
 * temp dir (same approach as test/unit/commands/unlock.test.ts). The flag is
 * rejected before any project/config work, so no project needs to be
 * initialised and no agent is ever started.
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

describe("nax run -m/--max-iterations (US-001)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-run-max-iterations-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("AC-10: -m 0 exits 1 with the positive-integer message on stderr", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["-m", "0"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-iterations must be a positive integer");
  }, 20000);

  test("AC-11: -m 5 passes flag validation and exits 1 at the uninitialised-project check", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["-m", "5"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("nax not initialized. Run: nax init");
    expect(stderr).not.toContain("--max-iterations must be a positive integer");
  }, 20000);
});
