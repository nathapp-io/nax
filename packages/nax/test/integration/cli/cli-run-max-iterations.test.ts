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

describe("nax run -m/--max-iterations (removed flags)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-run-max-iterations-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("rejects -m 5 before initialization", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["-m", "5"]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("nax run -m/--max-iterations was removed: workflow mode bounds a run by its stories");
    expect(stderr).not.toContain("nax not initialized");
  }, 20000);
  test("AC-7: help keeps removed flags discoverable", async () => {
    const { exitCode, stdout } = await spawnRun(tempDir, ["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/-m, --max-iterations <n>\s+Removed: workflow mode sets its own limits/);
    expect(stdout).toMatch(/--parallel <n>\s+Removed: workflow mode sets its own limits/);
  }, 20000);
});
