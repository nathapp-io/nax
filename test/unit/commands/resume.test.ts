/**
 * registerResumeCommand + runResume — Resume CLI command (US-004)
 *
 * AC-1: registerResumeCommand is exported and adds a `resume` subcommand on a
 *       fresh commander `Command` instance.
 * AC-2: runResume for a feature whose `checkpoint.jsonl` is absent prints
 *       "No checkpoint found — running from scratch" to stdout and resolves
 *       to exit code 0.
 * AC-3: runResume for a feature WITH a checkpoint prints a resume summary
 *       line that names the feature and the count of stories with a
 *       checkpoint before the run output.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  _resumeCmdDeps,
  type ResumeCommandDeps,
  registerResumeCommand as registerResumeCommandFromCmd,
  runResume,
} from "@/commands";

function writeCheckpoint(featureDir: string, records: Array<{ storyId: string; phase: string }>): void {
  const cpPath = join(featureDir, "checkpoint.jsonl");
  const lines = records.map((r, i) =>
    JSON.stringify({
      storyId: r.storyId,
      phase: r.phase,
      headSha: `sha-${i}`,
      dirtyDigest: `dig-${i}`,
      runId: "run-1",
      ts: 1700000000000 + i,
    }),
  );
  writeFileSync(cpPath, `${lines.join("\n")}\n`);
}

function makeBaseDeps(
  featureDir: string,
  stdoutWrites: string[],
  stderrWrites: string[],
  overrides: Partial<ResumeCommandDeps> = {},
): ResumeCommandDeps {
  return {
    checkpointExists: mock(async (dir: string) => existsSync(join(dir, "checkpoint.jsonl"))),
    loadCheckpoints: mock(async (dir: string) => {
      // Default: read via real reader. Tests that want a specific map inject via overrides.
      const { loadCheckpoints } = await import("@/execution");
      return loadCheckpoints(dir);
    }),
    runInvocation: mock(async () => 0),
    stdout: (s: string) => stdoutWrites.push(s),
    stderr: (s: string) => stderrWrites.push(s),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-1: registerResumeCommand is exported and registers a "resume" subcommand
// ---------------------------------------------------------------------------

describe("registerResumeCommand — AC1: commander wiring", () => {
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
  });

  test("AC1: registerResumeCommand is an exported function from @/commands/resume", () => {
    expect(typeof registerResumeCommandFromCmd).toBe("function");
  });

  test("AC1: registerResumeCommand registers a subcommand named 'resume' on a fresh commander Command", () => {
    const program = new Command();
    registerResumeCommandFromCmd(program);

    const sub = program.commands.find((c) => c.name() === "resume");
    expect(sub).toBeDefined();
  });

  // SEC-28: `nax resume -f ../../x` must not escape the .nax directory — the
  // action validates the feature name against validateFeatureName (same
  // guard as src/commands/common.ts:112).
  test("SEC-28: rejects a feature name that fails validateFeatureName", async () => {
    const origExit = process.exit;
    const origWrite = process.stderr.write;
    let exitCode: number | undefined;
    const stderrChunks: string[] = [];
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw new Error("__process_exit__");
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const program = new Command();
      registerResumeCommandFromCmd(program);
      // Provide an explicit .nax dir under the temp dir so findProjectDir succeeds.
      const tempDir = makeTempDir("nax-resume-sec28-");
      try {
        const { mkdirSync, writeFileSync } = await import("node:fs");
        mkdirSync(join(tempDir, ".nax"), { recursive: true });
        writeFileSync(join(tempDir, ".nax", "config.json"), "{}");
        process.chdir(tempDir);
        await program.parseAsync(["node", "nax", "resume", "-f", "../../evil"]);
      } finally {
        cleanupTempDir(tempDir);
      }
    } catch (e) {
      // Expected — process.exit throws to short-circuit the action.
      if (!(e instanceof Error) || e.message !== "__process_exit__") throw e;
    } finally {
      process.exit = origExit;
      process.stderr.write = origWrite;
    }
    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toMatch(/feature/i);
    expect(stderrChunks.join("")).toMatch(/single path segment|cannot contain path traversal/);
  });
});

// ---------------------------------------------------------------------------
// AC-2: No checkpoint → "No checkpoint found — running from scratch" + exit 0
// ---------------------------------------------------------------------------

describe("runResume — AC2: no-checkpoint path", () => {
  let featureDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-no-cp-");
    stdoutWrites = [];
    stderrWrites = [];
  });

  afterEach(() => {
    cleanupTempDir(featureDir);
  });

  test("AC2: missing checkpoint.jsonl prints 'No checkpoint found — running from scratch' and resolves to exit 0", async () => {
    const deps = makeBaseDeps(featureDir, stdoutWrites, stderrWrites, {
      checkpointExists: mock(async () => false),
      loadCheckpoints: mock(async () => new Map()),
      runInvocation: mock(async () => 0),
    });

    const exit = await runResume("feat-x", { featureDir }, deps);

    expect(exit).toBe(0);
    expect(stdoutWrites.join("")).toContain("No checkpoint found");
    expect(stdoutWrites.join("")).toContain("running from scratch");
    // The underlying run() should still be invoked (resume falls through to nax run).
    expect((deps.runInvocation as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-3: With checkpoint → resume summary line names feature + story count
// ---------------------------------------------------------------------------

describe("runResume — AC3: resume summary with checkpoint", () => {
  let featureDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-with-cp-");
    stdoutWrites = [];
    stderrWrites = [];
  });

  afterEach(() => {
    cleanupTempDir(featureDir);
  });

  test("AC3: existing checkpoint prints summary naming feature and story count, then runs", async () => {
    // Write a real checkpoint so the default loadCheckpoints reads it.
    writeCheckpoint(featureDir, [
      { storyId: "US-001", phase: "test-writer" },
      { storyId: "US-001", phase: "implementer" },
      { storyId: "US-002", phase: "test-writer" },
    ]);

    const deps = makeBaseDeps(featureDir, stdoutWrites, stderrWrites);

    const exit = await runResume("feat-x", { featureDir }, deps);

    expect(exit).toBe(0);
    const out = stdoutWrites.join("");
    // Summary line names the feature and the count of stories with a checkpoint (2 here).
    expect(out).toContain("feat-x");
    expect(out).toContain("2");
    // The summary must appear BEFORE the run output — assert by checking the
    // first non-empty stdout write is the summary line, not the underlying run output.
    const firstWrite = stdoutWrites.find((w) => w.trim().length > 0);
    expect(firstWrite).toBeDefined();
    expect(firstWrite!).toContain("Resume:");
    // The underlying run was invoked exactly once.
    expect((deps.runInvocation as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Default deps smoke test — _resumeCmdDeps wires checkpointExists/loadCheckpoints
// against the real filesystem via @/execution/checkpoint/reader.
// ---------------------------------------------------------------------------

describe("_resumeCmdDeps — default checkpointExists wiring", () => {
  let featureDir: string;

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-deps-default-");
  });

  afterEach(() => {
    cleanupTempDir(featureDir);
  });

  test("default checkpointExists returns false when checkpoint.jsonl is absent", async () => {
    const exists = await _resumeCmdDeps.checkpointExists(featureDir);
    expect(exists).toBe(false);
  });

  test("default checkpointExists returns true when checkpoint.jsonl exists", async () => {
    writeCheckpoint(featureDir, [{ storyId: "US-001", phase: "test-writer" }]);
    const exists = await _resumeCmdDeps.checkpointExists(featureDir);
    expect(exists).toBe(true);
  });

  test("default loadCheckpoints returns the parsed map for a real checkpoint.jsonl", async () => {
    writeCheckpoint(featureDir, [
      { storyId: "US-001", phase: "test-writer" },
      { storyId: "US-001", phase: "implementer" },
    ]);
    const map = await _resumeCmdDeps.loadCheckpoints(featureDir);
    expect(map).toBeInstanceOf(Map);
    // Two phase records for the same story collapse into a single StoryCheckpoint.
    expect(map.size).toBe(1);
    expect(map.get("US-001")?.greenPhases).toEqual(["test-writer", "implementer"]);
  });
});
