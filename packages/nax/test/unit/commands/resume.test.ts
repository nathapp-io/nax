/**
 * runResume + registerResumeCommand — Resume CLI command.
 *
 * AC-1/AC-2: runResume dispatches the underlying run invocation exactly once,
 *            forwarding the feature name and the `featureDir` option verbatim.
 * AC-3/AC-4: a feature WITH a `checkpoint.jsonl` prints nothing and still runs once.
 * AC-7:      a feature WITHOUT one prints nothing either.
 *
 * `nax resume` no longer probes or summarises `checkpoint.jsonl`: the checkpoint
 * store's reader and writer are gone, so the command's only job is to hand the
 * feature to the real run invocation and inherit its exit code.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertCaughtInstanceOf, assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  _resumeCmdDeps,
  type ResumeCommandOptions,
  registerResumeCommand as registerResumeCommandFromCmd,
  runResume,
} from "@/commands";
import { NaxError } from "@/errors";
import { resetLogger } from "@/logger";

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

/** A run invocation that records its calls and resolves to `exitCode`. */
function makeRunInvocation(exitCode = 0) {
  return mock(async (_feature: string, _options: ResumeCommandOptions): Promise<number> => exitCode);
}

// ---------------------------------------------------------------------------
// AC-1/AC-2: runResume dispatches the run invocation exactly once
// ---------------------------------------------------------------------------

describe("runResume — AC-1/AC-2: dispatches the run invocation", () => {
  test("AC-1: resolves the exit code the run invocation resolves", async () => {
    const runInvocation = makeRunInvocation(0);

    const exit = await runResume("demo", { featureDir: "/tmp/feat" }, { runInvocation });

    expect(exit).toBe(0);
  });

  test("AC-2: calls runInvocation exactly once with the feature name and the featureDir option", async () => {
    const runInvocation = makeRunInvocation(0);

    await runResume("demo", { featureDir: "/tmp/feat" }, { runInvocation });

    expect(runInvocation.mock.calls).toHaveLength(1);
    expect(runInvocation.mock.calls[0]).toEqual(["demo", { featureDir: "/tmp/feat" }]);
  });

  test("propagates a non-zero invocation result unchanged", async () => {
    const runInvocation = makeRunInvocation(3);

    const exit = await runResume("demo", { featureDir: "/tmp/feat" }, { runInvocation });

    expect(exit).toBe(3);
  });

  test("omits the featureDir key entirely when the option is not provided", async () => {
    const runInvocation = makeRunInvocation(0);

    await runResume("demo", {}, { runInvocation });

    expect(runInvocation.mock.calls).toHaveLength(1);
    const forwarded = runInvocation.mock.calls[0]?.[1] ?? {};
    expect(Object.hasOwn(forwarded, "featureDir")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-3/AC-4: an existing checkpoint.jsonl prints nothing and still runs once
// ---------------------------------------------------------------------------

describe("runResume — AC-3/AC-4: an existing checkpoint prints nothing", () => {
  let featureDir: string;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-with-cp-");
    writeCheckpoint(featureDir, [
      { storyId: "US-001", phase: "test-writer" },
      { storyId: "US-001", phase: "implementer" },
      { storyId: "US-002", phase: "test-writer" },
    ]);
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    cleanupTempDir(featureDir);
  });

  test("AC-3: never writes to stdout", async () => {
    const runInvocation = makeRunInvocation(0);

    await runResume("demo", { featureDir }, { runInvocation });

    expect(stdoutSpy.mock.calls).toHaveLength(0);
  });

  test("AC-4: calls runInvocation exactly once", async () => {
    const runInvocation = makeRunInvocation(0);

    const exit = await runResume("demo", { featureDir }, { runInvocation });

    expect(exit).toBe(0);
    expect(runInvocation.mock.calls).toHaveLength(1);
    expect(runInvocation.mock.calls[0]?.[0]).toBe("demo");
  });
});

// ---------------------------------------------------------------------------
// AC-7: a missing checkpoint.jsonl prints nothing either
// ---------------------------------------------------------------------------

describe("runResume — AC-7: a missing checkpoint prints nothing", () => {
  let featureDir: string;
  let stdoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    featureDir = makeTempDir("nax-resume-no-cp-");
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    cleanupTempDir(featureDir);
  });

  test("AC-7: never writes to stdout and still runs once", async () => {
    const runInvocation = makeRunInvocation(0);

    const exit = await runResume("demo", { featureDir }, { runInvocation });

    expect(exit).toBe(0);
    expect(stdoutSpy.mock.calls).toHaveLength(0);
    expect(runInvocation.mock.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// _resumeCmdDeps — the production default is a throwing stub
// ---------------------------------------------------------------------------

describe("_resumeCmdDeps", () => {
  test("default runInvocation stub throws — the CLI layer must supply its own", async () => {
    let caught: unknown;
    try {
      await _resumeCmdDeps.runInvocation("some-feature", {});
    } catch (e) {
      caught = e;
    }
    assertCaughtInstanceOf(caught, NaxError, "_resumeCmdDeps.runInvocation");
    expect(caught.code).toBe("RESUME_INVOCATION_MISSING");
  });
});

// ---------------------------------------------------------------------------
// registerResumeCommand — commander wiring
// ---------------------------------------------------------------------------

describe("registerResumeCommand — AC1: commander wiring", () => {
  let origCwd: string;

  beforeEach(() => {
    origCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(origCwd);
    // The end-to-end case runs the real resume action, which initializes a file-backed
    // logger; a later file in the same worker would throw on its own initLogger().
    resetLogger();
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
  test("exits with 'nax not initialized' when no .nax project dir is found", async () => {
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
      // A temp dir with no .nax anywhere in its ancestry — findProjectDir returns null.
      const tempDir = makeTempDir("nax-resume-no-project-");
      try {
        await program.parseAsync(["node", "nax", "resume", "-f", "some-feature", "-d", tempDir]);
      } finally {
        cleanupTempDir(tempDir);
      }
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__process_exit__") throw e;
    } finally {
      process.exit = origExit;
      process.stderr.write = origWrite;
    }
    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("nax not initialized");
  });

  test("wires the real run() invocation end-to-end for an already-completed feature", async () => {
    const tempDir = makeTempDir("nax-resume-real-run-");
    try {
      const { mkdirSync, writeFileSync: write } = await import("node:fs");
      mkdirSync(join(tempDir, ".nax"), { recursive: true });
      write(join(tempDir, ".nax", "config.json"), "{}");

      const featureDir = join(tempDir, ".nax", "features", "done-feature");
      mkdirSync(featureDir, { recursive: true });
      const prd = {
        project: "test-project",
        feature: "done-feature",
        branchName: "feat/done-feature",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userStories: [
          {
            id: "US-001",
            title: "Already done",
            description: "Nothing left to do",
            acceptanceCriteria: ["Works"],
            tags: [],
            dependencies: [],
            status: "passed",
            passes: true,
            escalations: [],
            attempts: 0,
          },
        ],
      };
      write(join(featureDir, "prd.json"), JSON.stringify(prd, null, 2));

      const program = new Command();
      registerResumeCommandFromCmd(program);

      const origExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code?: number) => {
        exitCode = code ?? 0;
      }) as typeof process.exit;
      try {
        await program.parseAsync(["node", "nax", "resume", "-f", "done-feature", "-d", tempDir]);
      } finally {
        process.exit = origExit;
      }

      // All stories already passed — run() completes without touching an agent,
      // and resolves normally (exit code reflects the run's own success flag,
      // which the acceptance/finish gate may still flip to false).
      assertDefined(exitCode, "exitCode");
      expect([0, 1]).toContain(exitCode);
    } finally {
      cleanupTempDir(tempDir);
    }
  }, 30000);

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
