/**
 * runReplay + registerReplayCommand — Replay CLI command (US-004)
 *
 * AC-3:  runReplay("run-x", {}) invokes discoverRun("run-x").
 * AC-4:  With a known timeline, runReplay(query, {}) invokes renderReport
 *        with the reconstructed timeline.
 * AC-5:  runReplay(query, { json: true }) invokes toReplayJson, writes the
 *        serialized form, and does NOT invoke renderReport.
 * AC-6:  registerReplayCommand is exported from @/commands/replay
 *        (also re-exported via @/replay barrel per spec wording).
 * AC-7:  registerReplayCommand adds a `replay` subcommand that accepts an
 *        optional positional run-id and exposes a --json option.
 * AC-8:  discoverRun throwing NaxError{RUN_NOT_FOUND} → exit code 1, error
 *        message containing "missing" written to error writer.
 * AC-9:  JSONL containing malformed lines is skipped, report is rendered from
 *        remaining spine, exit code 0.
 * AC-10: Crashed run with no metrics → report header contains CRASHED,
 *        exit code 0.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertDefined, cleanupTempDir, makeTempDir } from "@test/helpers";
import { Command } from "commander";
import {
  _replayCmdDeps,
  type ReplayCommandDeps,
  registerReplayCommand as registerReplayCommandFromCmd,
  runReplay,
} from "@/commands";
import { NaxError } from "@/errors";
import type { NaxStatusFile } from "@/execution/status-file";
import type { LogEntry } from "@/logger/types";
import type { RunMetrics } from "@/metrics";
import type { MetaJson } from "@/pipeline/subscribers/registry";
import type { RunTimeline } from "@/replay";
import { registerReplayCommand } from "@/replay";

function writeRunDir(
  runsDir: string,
  entryName: string,
  metaOverrides: Partial<MetaJson> & { runId: string; feature?: string; project?: string },
  jsonl: string,
  statusJson?: string,
): void {
  const entryDir = join(runsDir, entryName);
  mkdirSync(entryDir, { recursive: true });
  const jsonlPath = join(entryDir, `${metaOverrides.runId}.jsonl`);
  writeFileSync(jsonlPath, jsonl);
  const statusPath = join(entryDir, "status.json");
  if (statusJson) {
    writeFileSync(statusPath, statusJson);
  }
  const meta: MetaJson = {
    runId: metaOverrides.runId,
    project: metaOverrides.project ?? "demo",
    feature: metaOverrides.feature ?? "feat-x",
    workdir: "/tmp/demo",
    statusPath: existsSync(statusPath) ? statusPath : "/tmp/missing-status.json",
    eventsDir: entryDir,
    registeredAt: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(join(entryDir, "meta.json"), JSON.stringify(meta, null, 2));
}

function buildTimeline(): RunTimeline {
  return {
    runId: "run-known",
    feature: "feat-known",
    status: "failed",
    inferred: true,
    stories: [
      {
        storyId: "US-001",
        status: "failed",
        phases: [{ name: "implementer", status: "fail" }],
        escalations: [],
        rootCausePhaseIndex: 0,
      },
    ],
  };
}

function buildDiscovered(
  runsDir: string,
  runId: string,
  feature: string,
): {
  meta: MetaJson;
  jsonlPath: string;
} {
  const entryName = `demo-${feature}-${runId}`;
  return {
    meta: {
      runId,
      project: "demo",
      feature,
      workdir: "/tmp",
      statusPath: join(runsDir, entryName, "status.json"),
      eventsDir: join(runsDir, entryName),
      registeredAt: "2026-01-01T00:00:00.000Z",
    },
    jsonlPath: join(runsDir, entryName, `${runId}.jsonl`),
  };
}

function makeBaseDeps(
  runsDir: string,
  stdoutWrites: string[],
  stderrWrites: string[],
  overrides: Partial<ReplayCommandDeps> = {},
): ReplayCommandDeps {
  return {
    discoverRun: mock(async (query?: string) => buildDiscovered(runsDir, query ?? "run-known", "feat-known")),
    readJsonl: mock(async () => []),
    readMetrics: mock(async () => undefined),
    readStatus: mock(async () => undefined),
    reconstructTimeline: mock(() => buildTimeline()) as ReplayCommandDeps["reconstructTimeline"],
    renderReport: mock(() => "REPORT") as ReplayCommandDeps["renderReport"],
    toReplayJson: mock(() => buildTimeline()) as ReplayCommandDeps["toReplayJson"],
    stdout: (s: string) => stdoutWrites.push(s),
    stderr: (s: string) => stderrWrites.push(s),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// AC-3: discoverRun invoked with the supplied query
// ---------------------------------------------------------------------------

describe("runReplay — AC3: discoverRun invocation", () => {
  let runsDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let deps: ReplayCommandDeps;

  beforeEach(() => {
    runsDir = makeTempDir("nax-replay-cmd-test-");
    stdoutWrites = [];
    stderrWrites = [];
    deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites);
  });

  afterEach(() => {
    cleanupTempDir(runsDir);
  });

  test("AC3: discoverRun is invoked once with 'run-x' when runReplay('run-x', {}) is called", async () => {
    await runReplay("run-x", {}, deps);

    expect((deps.discoverRun as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((deps.discoverRun as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("run-x");
  });
});

// ---------------------------------------------------------------------------
// AC-4: renderReport is invoked with the reconstructed timeline
// ---------------------------------------------------------------------------

describe("runReplay — AC4: renderReport with reconstructed timeline", () => {
  let runsDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let deps: ReplayCommandDeps;

  beforeEach(() => {
    runsDir = makeTempDir("nax-replay-cmd-test-");
    stdoutWrites = [];
    stderrWrites = [];
    deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites);
  });

  afterEach(() => {
    cleanupTempDir(runsDir);
  });

  test("AC4: renderReport is invoked once with a timeline whose runId matches the discovered run", async () => {
    await runReplay("run-known", {}, deps);

    expect((deps.renderReport as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    const arg = (deps.renderReport as ReturnType<typeof mock>).mock.calls[0]?.[0] as RunTimeline;
    expect(arg.runId).toBe("run-known");
  });
});

// ---------------------------------------------------------------------------
// AC-5: json mode invokes toReplayJson, not renderReport
// ---------------------------------------------------------------------------

describe("runReplay — AC5: json mode serializes via toReplayJson", () => {
  let runsDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let deps: ReplayCommandDeps;

  beforeEach(() => {
    runsDir = makeTempDir("nax-replay-cmd-test-");
    stdoutWrites = [];
    stderrWrites = [];
    deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites);
  });

  afterEach(() => {
    cleanupTempDir(runsDir);
  });

  test("AC5: { json: true } writes toReplayJson output and does NOT call renderReport", async () => {
    const exit = await runReplay("run-known", { json: true }, deps);

    expect((deps.toReplayJson as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((deps.renderReport as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    // The orchestrator must pass the actual reconstructed timeline (built by
    // reconstructTimeline above) to toReplayJson — verify by checking the
    // captured argument equals the timeline the reconstructor returned.
    const jsonArg = (deps.toReplayJson as ReturnType<typeof mock>).mock.calls[0]?.[0] as RunTimeline;
    expect(jsonArg.runId).toBe("run-known");
    expect(jsonArg.feature).toBe("feat-known");
    expect(stdoutWrites.join("")).toContain("run-known");
    expect(stdoutWrites.join("")).toContain("feat-known");
    expect(exit).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC-6: registerReplayCommand is exported
// ---------------------------------------------------------------------------

describe("registerReplayCommand — AC6: exports", () => {
  test("AC6: registerReplayCommand is an exported function from @/commands/replay", () => {
    expect(typeof registerReplayCommandFromCmd).toBe("function");
  });

  test("AC6: registerReplayCommand is re-exported from @/replay barrel", () => {
    expect(typeof registerReplayCommand).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// AC-7: commander shape — subcommand name, positional run-id, --json flag
// ---------------------------------------------------------------------------

describe("registerReplayCommand — AC7: commander wiring", () => {
  test("AC7: registers a subcommand named 'replay' on a fresh commander Command", () => {
    const program = new Command();
    registerReplayCommandFromCmd(program);

    const sub = program.commands.find((c) => c.name() === "replay");
    expect(sub).toBeDefined();
  });

  test("AC7: the registered subcommand declares an optional positional run-id and --json option", () => {
    const program = new Command();
    registerReplayCommandFromCmd(program);

    const sub = program.commands.find((c) => c.name() === "replay");
    expect(sub).toBeDefined();
    assertDefined(sub, "replay subcommand");
    const help = sub.helpInformation();
    expect(help).toContain("[run-id]");
    expect(help).toContain("--json");
  });
});

// ---------------------------------------------------------------------------
// AC-8: NaxError{RUN_NOT_FOUND} → exit 1, message to error writer
// ---------------------------------------------------------------------------

describe("runReplay — AC8: not-found error path", () => {
  let runsDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    runsDir = makeTempDir("nax-replay-cmd-test-");
    stdoutWrites = [];
    stderrWrites = [];
  });

  afterEach(() => {
    cleanupTempDir(runsDir);
  });

  test("AC8: discovers-not-found NaxError resolves to exit code 1 and writes 'missing' to error writer", async () => {
    const deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites, {
      discoverRun: mock(async () => {
        throw new NaxError("Run not found in registry: missing", "RUN_NOT_FOUND", { query: "missing" });
      }),
    });

    const exit = await runReplay("missing", {}, deps);

    expect(exit).toBe(1);
    expect(stderrWrites.join("\n")).toContain("missing");
  });
});

// ---------------------------------------------------------------------------
// AC-9: malformed JSONL lines are skipped, report is still rendered, exit 0
// ---------------------------------------------------------------------------

describe("runReplay — AC9: malformed-line tolerance", () => {
  let runsDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    runsDir = makeTempDir("nax-replay-cmd-test-");
    stdoutWrites = [];
    stderrWrites = [];
  });

  afterEach(() => {
    cleanupTempDir(runsDir);
  });

  test("AC9: JSONL with malformed lines still renders a report and resolves to exit 0", async () => {
    const validEntry: LogEntry = {
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      stage: "story-orchestrator",
      storyId: "US-001",
      message: "Phase passed: test-writer",
    };
    const malformed = "{not valid json";
    const jsonl = `${JSON.stringify(validEntry)}\n${malformed}\n${JSON.stringify({
      ...validEntry,
      message: "Phase failed: implementer",
      stage: "story-orchestrator",
      storyId: "US-002",
    })}\n`;

    writeRunDir(runsDir, "demo-feat-mix-run-mix", { runId: "run-mix", feature: "feat-mix" }, jsonl);

    const deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites, {
      discoverRun: mock(async (query?: string) => buildDiscovered(runsDir, query ?? "run-mix", "feat-mix")),
      readJsonl: mock(async (path: string) => {
        const content = await Bun.file(path).text();
        const lines = content.split("\n");
        const entries: LogEntry[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            entries.push(JSON.parse(trimmed) as LogEntry);
          } catch {
            // skip malformed
          }
        }
        return entries;
      }),
    });

    const exit = await runReplay("run-mix", {}, deps);

    expect(exit).toBe(0);
    // The default renderReport mock returns "REPORT" — verify it was called
    // (proof the report path was taken, not the JSON path) and that stdout
    // received the rendered output.
    expect((deps.renderReport as ReturnType<typeof mock>).mock.calls).toHaveLength(1);
    expect((deps.toReplayJson as ReturnType<typeof mock>).mock.calls).toHaveLength(0);
    expect(stdoutWrites.join("")).toContain("REPORT");
  });
});

// ---------------------------------------------------------------------------
// AC-10: crashed run + no metrics → report header contains CRASHED, exit 0
// ---------------------------------------------------------------------------

describe("runReplay — AC10: crashed-run end-to-end", () => {
  let runsDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];

  beforeEach(() => {
    runsDir = makeTempDir("nax-replay-cmd-test-");
    stdoutWrites = [];
    stderrWrites = [];
  });

  afterEach(() => {
    cleanupTempDir(runsDir);
  });

  test("AC10: injected registry with a crash-signal status.json and no metrics writes CRASHED and resolves to exit 0", async () => {
    const crashStatus: NaxStatusFile = {
      version: 1,
      run: {
        id: "run-crash-x",
        feature: "feat-x",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "crashed",
        dryRun: false,
        pid: 1234,
        crashedAt: "2026-01-01T00:00:05.000Z",
        crashSignal: "SIGKILL",
      },
      progress: { total: 1, passed: 0, failed: 0, paused: 0, blocked: 0, pending: 1 },
      cost: { spent: 0, limit: null },
      current: null,
      iterations: 0,
      updatedAt: "2026-01-01T00:00:05.000Z",
      durationMs: 5000,
    };

    const entry: LogEntry = {
      timestamp: "2026-01-01T00:00:01.000Z",
      level: "info",
      stage: "story-orchestrator",
      storyId: "US-001",
      message: "Phase passed: test-writer",
    };
    const jsonl = `${JSON.stringify(entry)}\n`;

    writeRunDir(
      runsDir,
      "demo-feat-x-run-crash-x",
      { runId: "run-crash-x", feature: "feat-x" },
      jsonl,
      JSON.stringify(crashStatus, null, 2),
    );

    const deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites, {
      discoverRun: mock(async (query?: string) => buildDiscovered(runsDir, query ?? "run-crash-x", "feat-x")),
      readJsonl: mock(async (path: string) => {
        const content = await Bun.file(path).text();
        const lines = content.split("\n");
        const entries: LogEntry[] = [];
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            entries.push(JSON.parse(trimmed) as LogEntry);
          } catch {
            // skip
          }
        }
        return entries;
      }),
      readStatus: mock<typeof _replayCmdDeps.readStatus>(async () => ({
        version: 1,
        run: crashStatus.run,
        progress: crashStatus.progress,
        cost: crashStatus.cost,
        current: null,
        iterations: 0,
        updatedAt: crashStatus.updatedAt,
        durationMs: crashStatus.durationMs,
      })),
      reconstructTimeline: mock(() => ({
        runId: "run-crash-x",
        feature: "feat-x",
        status: "crashed",
        inferred: true,
        stories: [],
      })) as ReplayCommandDeps["reconstructTimeline"],
      renderReport: mock(
        () => "=== nax replay ===\nRun: run-crash-x\nFeature: feat-x\nStatus: CRASHED",
      ) as ReplayCommandDeps["renderReport"],
    });

    const exit = await runReplay("run-crash-x", {}, deps);

    expect(exit).toBe(0);
    // The orchestrator must pass the crashed timeline (built by
    // reconstructTimeline above) to renderReport — verify by checking the
    // captured argument has status === "crashed". If the orchestrator
    // reconstructed with the wrong status, renderReport would receive a
    // non-crashed timeline and the test would still pass on the mock's
    // hardcoded 'CRASHED' string alone, so we assert both paths.
    const reportArg = (deps.renderReport as ReturnType<typeof mock>).mock.calls[0]?.[0] as RunTimeline;
    expect(reportArg.status).toBe("crashed");
    expect(reportArg.runId).toBe("run-crash-x");
    expect(stdoutWrites.join("")).toContain("CRASHED");
  });
});

// ---------------------------------------------------------------------------
// Metrics-retention follow-up: missing metrics is surfaced, not silent.
// ---------------------------------------------------------------------------

describe("runReplay — missing metrics is surfaced on stderr, not silent", () => {
  let runsDir: string;
  let stdoutWrites: string[];
  let stderrWrites: string[];
  let deps: ReplayCommandDeps;

  beforeEach(() => {
    runsDir = makeTempDir("nax-replay-cmd-test-");
    stdoutWrites = [];
    stderrWrites = [];
    deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites);
  });

  afterEach(() => {
    cleanupTempDir(runsDir);
  });

  test("readMetrics resolving undefined writes an explanatory note to stderr naming the run", async () => {
    const exit = await runReplay("run-known", {}, deps);

    expect(exit).toBe(0);
    const stderr = stderrWrites.join("");
    expect(stderr).toContain("run-known");
    expect(stderr).toContain("no run metrics found");
  });

  test("readMetrics resolving a value writes no stderr note", async () => {
    const runMetrics: RunMetrics = {
      runId: "run-known",
      feature: "feat-known",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:10:00.000Z",
      totalCost: 0,
      totalStories: 0,
      storiesCompleted: 0,
      totalDurationMs: 600_000,
      stories: [],
      storiesFailed: 0,
    };
    deps = makeBaseDeps(runsDir, stdoutWrites, stderrWrites, {
      readMetrics: mock(async () => runMetrics),
    });

    const exit = await runReplay("run-known", {}, deps);

    expect(exit).toBe(0);
    expect(stderrWrites.join("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// _replayCmdDeps.readMetrics (readMetricsFromProject): derives outputDir from
// eventsDir instead of recomputing it, so a project with a custom
// config.outputDir still finds its metrics.json.
// ---------------------------------------------------------------------------

describe("_replayCmdDeps.readMetrics — outputDir derived from eventsDir", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = makeTempDir("nax-replay-metrics-test-");
  });

  afterEach(() => {
    cleanupTempDir(outputDir);
  });

  test("finds metrics.json under a non-default outputDir via eventsDir, not a recomputed default", async () => {
    const runMetrics = {
      runId: "run-custom-outputdir",
      feature: "feat-x",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:10:00.000Z",
      totalDurationMs: 600_000,
      stories: [],
      storiesFailed: 0,
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "metrics.json"), JSON.stringify([runMetrics], null, 2));

    // eventsDir = join(outputDir, "features", feature, "runs") per the
    // registry-writer contract (src/pipeline/subscribers/registry.ts).
    const eventsDir = join(outputDir, "features", "feat-x", "runs");

    const found = await _replayCmdDeps.readMetrics({ runId: "run-custom-outputdir", eventsDir });

    expect(found?.runId).toBe("run-custom-outputdir");
  });
});

// ---------------------------------------------------------------------------
// _replayCmdDeps.readJsonl (readJsonlLenient) — real implementation
// ---------------------------------------------------------------------------

describe("_replayCmdDeps.readJsonl — real implementation", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-readjsonl-");
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("returns an empty array when the file does not exist", async () => {
    const result = await _replayCmdDeps.readJsonl(join(dir, "missing.jsonl"));
    expect(result).toEqual([]);
  });

  test("skips blank and malformed lines, keeping only valid JSON entries", async () => {
    const entry: LogEntry = {
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      stage: "story-orchestrator",
      storyId: "US-001",
      message: "ok",
    };
    const path = join(dir, "log.jsonl");
    writeFileSync(path, `\n${JSON.stringify(entry)}\n{not valid json\n  \n`);

    const result = await _replayCmdDeps.readJsonl(path);
    expect(result).toEqual([entry]);
  });
});

// ---------------------------------------------------------------------------
// _replayCmdDeps.readStatus (readJsonOrUndefined) — real implementation
// ---------------------------------------------------------------------------

describe("_replayCmdDeps.readStatus — real implementation", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir("nax-replay-readstatus-");
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  test("returns undefined when the file does not exist", async () => {
    expect(await _replayCmdDeps.readStatus(join(dir, "missing.json"))).toBeUndefined();
  });

  test("returns undefined when the file contains malformed JSON", async () => {
    const path = join(dir, "status.json");
    writeFileSync(path, "{ not valid json");
    expect(await _replayCmdDeps.readStatus(path)).toBeUndefined();
  });

  test("returns the parsed object when the file contains valid JSON", async () => {
    const status: NaxStatusFile = {
      version: 1,
      run: {
        id: "run-x",
        feature: "feat-x",
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        dryRun: false,
        pid: 1,
      },
      progress: { total: 1, passed: 1, failed: 0, paused: 0, blocked: 0, pending: 0 },
      cost: { spent: 0, limit: null },
      current: null,
      iterations: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 1000,
    };
    const path = join(dir, "status.json");
    writeFileSync(path, JSON.stringify(status));
    expect(await _replayCmdDeps.readStatus(path)).toEqual(status);
  });
});

// ---------------------------------------------------------------------------
// registerReplayCommand — the .action() callback itself, not just its shape
// ---------------------------------------------------------------------------

describe("registerReplayCommand — action callback wiring", () => {
  let origDeps: ReplayCommandDeps;
  let origExit: typeof process.exit;
  let stdoutSpy: ReturnType<typeof spyOn>;
  let exitCalls: Array<number | string | null | undefined>;

  // process.exit must be a real `never`-returning function — bun:test's
  // spyOn/mockImplementation cannot satisfy that signature with a function
  // that merely returns `undefined`, and casting the mock to fit is a banned
  // escape hatch (test-ratchets.md). Throwing is the only way to make the
  // type genuinely `never`; every call is
  // recorded first so assertions can inspect it even though the throw
  // unwinds through registerReplayCommand's own catch (which itself calls
  // process.exit again) and finally out of program.parseAsync() as a
  // rejection the tests swallow.
  function mockProcessExit(): void {
    process.exit = ((code?: number | string | null): never => {
      exitCalls.push(code);
      throw new Error(`process.exit(${String(code)})`);
    }) as typeof process.exit;
  }

  beforeEach(() => {
    origDeps = { ..._replayCmdDeps };
    origExit = process.exit;
    exitCalls = [];
    stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true);
    mockProcessExit();
  });

  afterEach(() => {
    Object.assign(_replayCmdDeps, origDeps);
    process.exit = origExit;
    stdoutSpy.mockRestore();
  });

  test("a successful replay writes the report to stdout and does not call process.exit", async () => {
    Object.assign(_replayCmdDeps, {
      discoverRun: mock(async () => ({
        meta: {
          runId: "run-ok",
          project: "demo",
          feature: "feat-ok",
          workdir: "/tmp",
          statusPath: "/tmp/missing-status.json",
          eventsDir: "/tmp/events",
          registeredAt: "2026-01-01T00:00:00.000Z",
        },
        jsonlPath: "/tmp/missing.jsonl",
      })),
      readJsonl: mock(async () => []),
      readMetrics: mock(async () => undefined),
      readStatus: mock(async () => undefined),
      reconstructTimeline: mock(() => buildTimeline()),
      renderReport: mock(() => "OK REPORT"),
    });

    const program = new Command();
    registerReplayCommandFromCmd(program);
    await program.parseAsync(["node", "nax", "replay", "run-ok"]);

    expect(stdoutSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("OK REPORT"))).toBe(true);
    expect(exitCalls).toEqual([]);
  });

  test("a RUN_NOT_FOUND discovery failure calls process.exit(1)", async () => {
    Object.assign(_replayCmdDeps, {
      discoverRun: mock(async () => {
        throw new NaxError("Run not found in registry: nope", "RUN_NOT_FOUND", { query: "nope" });
      }),
    });

    const program = new Command();
    registerReplayCommandFromCmd(program);
    // The mock throws to satisfy process.exit's `never` return type, which
    // unwinds into registerReplayCommand's own catch block (a second,
    // uncaught process.exit(1)) and out of parseAsync as a rejection — not
    // the point of this test, so it is swallowed.
    await program.parseAsync(["node", "nax", "replay", "nope"]).catch(() => {});

    expect(exitCalls[0]).toBe(1);
  });

  test("an unexpected thrown error is caught, written to stderr, and calls process.exit(1)", async () => {
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    Object.assign(_replayCmdDeps, {
      discoverRun: mock(async () => {
        throw new Error("boom");
      }),
    });

    try {
      const program = new Command();
      registerReplayCommandFromCmd(program);
      await program.parseAsync(["node", "nax", "replay", "whatever"]).catch(() => {});

      expect(stderrSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes("boom"))).toBe(true);
      expect(exitCalls[0]).toBe(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
