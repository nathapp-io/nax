/**
 * A4 characterisation — `nax run` pre-flight gate order and messages at the
 * process boundary.
 *
 * The `run` action in bin/nax.ts is the highest-complexity CLI action in the
 * repo and is being drained (docs/plans/STATUS-complexity-drain.md §4 A4).
 * Before the extraction, this pins the observable behaviour of the gates that
 * exit before any project/config work: feature name, directory, -m,
 * --parallel, bake-off preflight (exclusivity, contestants, --max-cost and the
 * worst-case confirmation), --schedule parsing and --plan/--from validation.
 * Each gate is asserted in terms of exit code + stderr, and every ADJACENT pair
 * of gates has a "gate order:" case that trips both and asserts only the
 * earlier fires, so a refactor that swaps two gates fails here even though
 * every individual message still exists. The plan phase and the schedule wait
 * run after these gates and are not order-pinned here.
 *
 * Same approach as cli-run-max-iterations.test.ts (US-001): the real entry
 * point is spawned in an empty temp dir; no project is initialised and no
 * agent is ever started because every gate here exits before the
 * uninitialised-project check.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function spawnRun(dir: string, args: string[], env?: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "bin/nax.ts", "run", "-f", "demo", "-d", dir, "--headless", ...args], {
    cwd: process.cwd(),
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

  test("gate order: feature name fails before directory validation", async () => {
    const { exitCode, stderr } = await spawnRun(join(tempDir, "nope"), ["-f", "../evil"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid feature name");
    expect(stderr).not.toContain("Invalid directory");
  }, 20000);

  test("gate order: directory fails before -m validation", async () => {
    const { exitCode, stderr } = await spawnRun(join(tempDir, "nope"), ["-m", "0"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid directory");
    expect(stderr).not.toContain("--max-iterations must be a positive integer");
  }, 20000);

  test("gate order: -m 0 fails before --parallel validation", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["-m", "0", "--parallel", "0"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--max-iterations must be a positive integer");
    expect(stderr).not.toContain("--parallel must be a positive integer");
  }, 20000);

  test("gate order: --parallel 0 fails before the bake-off --compare/--agent check", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, [
      "--parallel",
      "0",
      "--compare",
      "claude",
      "--agent",
      "codex",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--parallel must be a positive integer");
    expect(stderr).not.toContain("mutually exclusive");
  }, 20000);

  test("gate order: --compare/--agent exclusivity fails before contestant parsing", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--compare", ",", "--agent", "codex"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--compare and --agent are mutually exclusive");
    expect(stderr).not.toContain("--compare requires at least one contestant agent");
  }, 20000);

  test("gate order: empty contestant list fails before --schedule parsing", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--compare", ",", "--schedule", "never"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("--compare requires at least one contestant agent");
    expect(stderr).not.toContain("Invalid --schedule");
  }, 20000);

  test("gate order: contestant validation fails before --max-cost and --schedule", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, [
      "--compare",
      "no-such-a4-profile",
      "--max-cost",
      "-1",
      "--schedule",
      "never",
    ]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Bake-off pre-flight failed:");
    expect(stderr).toContain("no-such-a4-profile: unknown-profile");
    expect(stderr).not.toContain("--max-cost must be a positive number");
    expect(stderr).not.toContain("Invalid --schedule");
  }, 20000);

  describe("with a resolvable contestant", () => {
    // A project profile resolving to the claude ACP entry, plus a fake
    // `claude` binary on PATH, so contestant validation passes and the
    // --max-cost gate and the worst-case confirmation are reached.
    function validContestantEnv(): Record<string, string> {
      mkdirSync(join(tempDir, ".nax", "profiles"), { recursive: true });
      writeFileSync(join(tempDir, ".nax", "profiles", "a4-contestant.json"), '{"agent":{"default":"claude"}}');
      const binDir = join(tempDir, "bin");
      mkdirSync(binDir, { recursive: true });
      const fakeBinary = join(binDir, "claude");
      writeFileSync(fakeBinary, "#!/bin/sh\nexit 0\n");
      chmodSync(fakeBinary, 0o755);
      return { PATH: `${binDir}:${process.env.PATH ?? ""}` };
    }

    test("gate order: invalid --max-cost fails before --schedule parsing", async () => {
      const env = validContestantEnv();
      const { exitCode, stderr } = await spawnRun(
        tempDir,
        ["--compare", "a4-contestant", "--max-cost", "-1", "--schedule", "never"],
        env,
      );

      expect(exitCode).toBe(1);
      expect(stderr).toContain("--max-cost must be a positive number");
      expect(stderr).not.toContain("Bake-off pre-flight failed");
      expect(stderr).not.toContain("Invalid --schedule");
    }, 20000);

    test("gate order: the worst-case cost confirmation runs before --schedule parsing", async () => {
      // Non-TTY stdin auto-confirms, so the action continues into the
      // --schedule gate: both outputs present proves the order.
      const env = validContestantEnv();
      const { exitCode, stdout, stderr } = await spawnRun(
        tempDir,
        ["--compare", "a4-contestant", "--max-cost", "2", "--schedule", "never"],
        env,
      );

      expect(exitCode).toBe(1);
      expect(stdout).toContain("Bake-off worst-case exposure: 1 contestants × $2 = $2");
      expect(stderr).toContain('Invalid --schedule: Unrecognized schedule "never"');
    }, 20000);
  });

  test("gate order: --schedule parsing fails before --plan/--from validation", async () => {
    const { exitCode, stderr } = await spawnRun(tempDir, ["--schedule", "never", "--plan"]);

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Invalid --schedule");
    expect(stderr).not.toContain("--plan requires --from");
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
