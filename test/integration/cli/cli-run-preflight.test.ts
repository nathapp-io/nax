/**
 * A4 characterisation — `nax run` pre-flight gate order and messages at the
 * process boundary.
 *
 * The `run` action in bin/nax.ts is the highest-complexity CLI action in the
 * repo and is being drained (docs/plans/STATUS-complexity-drain.md §4 A4).
 * Before the extraction, this pins the observable behaviour of the gates that
 * exit before any project/config work: feature name, directory, --parallel,
 * --max-iterations/--plan ordering, bake-off preflight, --plan/--from
 * validation and --schedule parsing. Each gate is asserted in terms of exit
 * code + stderr, so a refactor that scrambles the gate ORDER (a later gate
 * firing before an earlier one) fails here even though every individual
 * message still exists.
 *
 * Same approach as cli-run-max-iterations.test.ts (US-001): the real entry
 * point is spawned in an empty temp dir; no project is initialised and no
 * agent is ever started because every gate here exits before the
 * uninitialised-project check.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
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

describe("nax run pre-flight gates (A4 characterisation)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir("nax-run-preflight-");
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  test("BUG-35: path-traversal feature name exits 1 with the feature-name message", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["-f", "../evil"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid feature name");
    expect(stderr).toContain("Feature name must be a single path segment");
  }, 20000);

  test("nonexistent -d exits 1 with the directory message", async () => {
    const { exitCode, stderr } = await spawnRun(join(tempDir, "nope"), []);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid directory");
    expect(stderr).toContain("Directory does not exist");
  }, 20000);

  test("--parallel 0 exits 1 with the parallel message", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--parallel", "0"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--parallel must be a positive integer (omit it to run sequentially)");
  }, 20000);

  test("gate order: -m 0 fails before --plan/--from validation", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["-m", "0", "--plan"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-iterations must be a positive integer");
    expect(stderr).not.toContain("--plan requires --from");
  }, 20000);

  test("gate order: --parallel 0 fails before --schedule parsing", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--parallel", "0", "--schedule", "never"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--parallel must be a positive integer");
    expect(stderr).not.toContain("Invalid --schedule");
  }, 20000);

  test("--compare with --agent exits 1 with the exclusivity message", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--compare", "claude", "--agent", "codex"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--compare and --agent are mutually exclusive");
  }, 20000);

  test("--compare with no resolvable contestant exits 1 with the contestants message", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--compare", ","]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--compare requires at least one contestant agent");
  }, 20000);

  test("--plan without --from exits 1 with the pairing message", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--plan"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Error: --plan requires --from <spec-path>");
  }, 20000);

  test("--from pointing at a missing file exits 1 with the file-not-found message", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--plan", "--from", "./no-such-a4-characterisation.spec.md"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Error: File not found:");
    expect(stderr).toContain("(required with --plan)");
  }, 20000);

  test("--schedule that parses to nothing exits 1 with the schedule message", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--schedule", "never"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid --schedule: Unrecognized schedule "never"');
  }, 20000);

  test("defaults pass every gate and exit 1 at the uninitialised-project check", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, []);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("nax not initialized. Run: nax init");
    expect(stderr).not.toContain("Invalid feature name");
    expect(stderr).not.toContain("Invalid directory");
  }, 20000);
});
