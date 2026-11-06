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

describe("nax run --parallel (removed flags)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-run-parallel-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("rejects --parallel 2 before initialization", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--parallel", "2"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("nax run --parallel was removed: workflow mode runs stories one at a time");
    expect(stderr).not.toContain("nax not initialized");
  }, 20000);
});
