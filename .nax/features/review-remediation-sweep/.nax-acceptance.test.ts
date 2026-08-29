import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Test helpers ────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "nax-rrs-acc-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Sentinel thrown by raceTimeout when the wrapped promise never settles.
 * Kept as a distinct class (never a plain Error with a message derived from
 * the operation under test) so a genuine hang can never be mistaken for a
 * real, content-bearing rejection by a downstream `.message` assertion.
 */
class RaceTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`operation "${label}" did not settle within ${ms}ms`);
    this.name = "RaceTimeoutError";
  }
}

/** Races a promise against a hard wall-clock deadline; clears the timer either way. */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new RaceTimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

function mergeDeep(target: any, source: any): any {
  if (source === undefined || source === null) return target;
  const result: any = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] !== null &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = mergeDeep(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function parseConfig(overrides: any = {}): any {
  const { NaxConfigSchema } = require("../../../src/config/schemas");
  const defaults = NaxConfigSchema.parse({});
  if (Object.keys(overrides).length === 0) return defaults;
  return mergeDeep(defaults, overrides);
}

// ─── US-001: Spawn seams that must be bounded (never hang past 5s) ───────────

describe("US-001: Detection / rollback / session-eviction spawn seams are bounded", () => {
  test("AC-1: detectFromFileScan resolves to null (not hang) when spawn.exited never settles", async () => {
    const { detectFromFileScan, _fileScanDeps } = require("../../../src/test-runners/detect/file-scan");
    const origSpawn = _fileScanDeps.spawn;
    _fileScanDeps.spawn = (() => ({ exited: new Promise(() => {}) })) as unknown as typeof origSpawn;
    try {
      const result = await raceTimeout(detectFromFileScan(tmpDir), 5000, "detectFromFileScan");
      expect(result).toBeNull();
    } finally {
      _fileScanDeps.spawn = origSpawn;
    }
  });

  test("AC-2: detectFromDirectoryScan resolves within 5s for a .nax/accept fixture with non-empty patterns", async () => {
    const { detectFromDirectoryScan, _directoryScanDeps } = require("../../../src/test-runners/detect/directory-scan");
    mkdirSync(join(tmpDir, ".nax", "accept"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "accept", "sample.accept.test.ts"), "// fixture\n");

    const origSpawn = _directoryScanDeps.spawn;
    _directoryScanDeps.spawn = (() => ({ exited: new Promise(() => {}) })) as unknown as typeof origSpawn;
    try {
      const result = await raceTimeout(detectFromDirectoryScan(tmpDir), 5000, "detectFromDirectoryScan");
      expect(result).not.toBeNull();
      expect(result?.path.endsWith(".nax/accept")).toBe(true);
      expect(Array.isArray(result?.patterns)).toBe(true);
      expect((result?.patterns.length ?? 0) > 0).toBe(true);
    } finally {
      _directoryScanDeps.spawn = origSpawn;
    }
  });

  test("AC-3: rollbackToRef rejects with an Error mentioning 'rollback' when spawn.exited never settles", async () => {
    const { rollbackToRef, _rollbackDeps } = require("../../../src/tdd/rollback");
    const origSpawn = _rollbackDeps.spawn;
    _rollbackDeps.spawn = (() => ({ exited: new Promise(() => {}) })) as unknown as typeof origSpawn;
    try {
      let rejected = false;
      let caught: unknown;
      try {
        await raceTimeout(rollbackToRef(tmpDir, "HEAD~1", null), 5000, "rollbackToRef");
      } catch (err) {
        rejected = true;
        caught = err;
      }
      expect(rejected).toBe(true);
      expect(caught instanceof RaceTimeoutError).toBe(false);
      expect(caught instanceof Error).toBe(true);
      expect((caught as Error).message.toLowerCase()).toContain("rollback");
    } finally {
      _rollbackDeps.spawn = origSpawn;
    }
  });

  test("AC-4: captureSnapshotRef rejects with code SNAPSHOT_REF_FAILED when spawn.exited never settles", async () => {
    const { captureSnapshotRef, _rollbackDeps } = require("../../../src/tdd/rollback");
    const origSpawn = _rollbackDeps.spawn;
    _rollbackDeps.spawn = (() => ({ exited: new Promise(() => {}) })) as unknown as typeof origSpawn;
    try {
      let rejected = false;
      let caught: unknown;
      try {
        await raceTimeout(captureSnapshotRef(tmpDir, "story-123"), 5000, "captureSnapshotRef");
      } catch (err) {
        rejected = true;
        caught = err;
      }
      expect(rejected).toBe(true);
      expect(caught instanceof RaceTimeoutError).toBe(false);
      expect((caught as { code?: string })?.code).toBe("SNAPSHOT_REF_FAILED");
    } finally {
      _rollbackDeps.spawn = origSpawn;
    }
  });

  test("AC-5: stale-session eviction resolves (not hangs, not rejects) when its spawn seam never settles", async () => {
    const mod = require("../../../src/execution/merge-conflict-rectify");
    const deps = mod._mergeRectifyDeps;
    expect(deps).toBeDefined();
    expect(typeof deps.spawn).toBe("function");
    expect(typeof mod.evictStaleSessions).toBe("function");

    const origSpawn = deps.spawn;
    deps.spawn = (() => ({ exited: new Promise(() => {}) })) as unknown as typeof origSpawn;
    try {
      let rejected = false;
      await raceTimeout(mod.evictStaleSessions().catch(() => {
        rejected = true;
      }), 5000, "evictStaleSessions");
      expect(rejected).toBe(false);
    } finally {
      deps.spawn = origSpawn;
    }
  });
});

// ─── US-002: Test-file pattern resolution rejects malformed globs ────────────

describe("US-002: resolveTestFilePatterns validates glob shape strictly", () => {
  test("AC-6: a bare string testFilePatterns value is rejected with code INVALID_TEST_GLOB", async () => {
    const { resolveTestFilePatterns } = require("../../../src/test-runners/resolver");
    const { NaxError } = require("../../../src/errors");
    const config = {
      execution: { smartTestRunner: { testFilePatterns: "test/**/*.ts" } },
    } as any;

    let rejected = false;
    let caught: unknown;
    try {
      await resolveTestFilePatterns(config, tmpDir);
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    expect(caught instanceof NaxError).toBe(true);
    expect((caught as InstanceType<typeof NaxError>).code).toBe("INVALID_TEST_GLOB");
  });

  test("AC-7: a single-element array testFilePatterns value resolves with that pattern", async () => {
    const { resolveTestFilePatterns } = require("../../../src/test-runners/resolver");
    const config = {
      execution: { smartTestRunner: { testFilePatterns: ["test/**/*.ts"] } },
    } as any;

    const resolved = await resolveTestFilePatterns(config, tmpDir);
    expect(resolved.globs).toEqual(["test/**/*.ts"]);
  });
});

// ─── US-003: Path-traversal / absolute-path rejection ────────────────────────

describe("US-003: Path-traversal and mis-scoped-path arguments are rejected before any I/O", () => {
  test("AC-8: initPackage rejects '../../evil' with a NaxError naming the package before creating a directory", async () => {
    const { initPackage } = require("../../../src/cli/init-context");
    const { NaxError } = require("../../../src/errors");
    const { existsSync } = require("node:fs");

    let rejected = false;
    let caught: unknown;
    try {
      await initPackage(tmpDir, "../../evil");
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    expect(caught instanceof NaxError).toBe(true);
    expect((caught as Error).message).toContain("../../evil");
    // The escaped target directory must never have been created.
    expect(existsSync(join(tmpDir, "..", "..", "evil"))).toBe(false);
  });

  test("AC-9: generateCommand rejects package '/etc' rather than reinterpreting it as './etc'", async () => {
    const { generateCommand } = require("../../../src/cli/generate");
    const { NaxError } = require("../../../src/errors");
    const { existsSync } = require("node:fs");

    // generateCommand's current (pre-fix) error path calls process.exit(1)
    // directly, which would tear down the whole test worker — intercept it
    // so a still-unfixed implementation fails only this assertion.
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code}) called`);
    }) as typeof process.exit;

    let rejected = false;
    let caught: unknown;
    try {
      await generateCommand({ dir: tmpDir, package: "/etc", dryRun: true });
    } catch (err) {
      rejected = true;
      caught = err;
    } finally {
      process.exit = originalExit;
    }
    expect(rejected).toBe(true);
    expect(caught instanceof NaxError).toBe(true);
    // Must never have treated it as workdir-relative "etc".
    expect(existsSync(join(tmpDir, "etc"))).toBe(false);
  });

  test("AC-10: curatorCommit rejects runId '../../etc' before reading any file under the run directory", async () => {
    const { curatorCommit, _curatorCmdDeps } = require("../../../src/commands/curator");
    const { NaxError } = require("../../../src/errors");

    // curatorCommit resolves the project via resolveProject(), which requires
    // a real .nax/config.json — without it the call rejects with
    // NAX_DIR_NOT_FOUND before ever reaching runId handling, which would
    // make this test pass without exercising the traversal guard at all.
    mkdirSync(join(tmpDir, ".nax"), { recursive: true });
    writeFileSync(join(tmpDir, ".nax", "config.json"), "{}");

    const origReadFile = _curatorCmdDeps.readFile;
    let readFileCalled = false;
    _curatorCmdDeps.readFile = (async (...args: unknown[]) => {
      readFileCalled = true;
      return origReadFile(...(args as [string]));
    }) as typeof origReadFile;

    try {
      let rejected = false;
      let caught: unknown;
      try {
        await curatorCommit({ project: tmpDir, runId: "../../etc" });
      } catch (err) {
        rejected = true;
        caught = err;
      }
      expect(rejected).toBe(true);
      expect(caught instanceof NaxError).toBe(true);
      expect(readFileCalled).toBe(false);
    } finally {
      _curatorCmdDeps.readFile = origReadFile;
    }
  });

  test("AC-11: initPackage rejects an empty package path rather than resolving to the repo root", async () => {
    const { initPackage } = require("../../../src/cli/init-context");
    const { NaxError } = require("../../../src/errors");
    const { existsSync } = require("node:fs");

    let rejected = false;
    let caught: unknown;
    try {
      await initPackage(tmpDir, "");
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    expect(caught instanceof NaxError).toBe(true);
    // Must not have written a context.md straight into the repo root's .nax/mono dir.
    expect(existsSync(join(tmpDir, ".nax", "mono", "context.md"))).toBe(false);
  });
});

// ─── US-004: Schedule parsing ─────────────────────────────────────────────────

describe("US-004: parseSchedule bounds and rejects absurd durations", () => {
  test("AC-12: parseSchedule('999999999999d', now) fails with a descriptive error", () => {
    const { parseSchedule } = require("../../../src/schedule/parse");
    const now = new Date("2026-01-01T00:00:00");
    const result = parseSchedule("999999999999d", now);
    expect(result.ok).toBe(false);
    const err = (result as { ok: false; error: string }).error;
    expect(typeof err === "string" && err.length > 0).toBe(true);
    expect(/day|hour|minute|second|valid/i.test(err)).toBe(true);
  });

  test("AC-13: parseSchedule('2h', now) resolves target exactly 2 hours later", () => {
    const { parseSchedule } = require("../../../src/schedule/parse");
    const now = new Date("2026-01-01T00:00:00");
    const result = parseSchedule("2h", now);
    expect(result.ok).toBe(true);
    const { target } = result as { ok: true; target: Date };
    expect(target instanceof Date).toBe(true);
    expect(Math.abs(target.getTime() - now.getTime() - 2 * 60 * 60 * 1000) <= 1).toBe(true);
  });
});

// ─── US-005: Config env-var escape resolution ─────────────────────────────────

describe("US-005: resolveEnvVars preserves a forged double-dollar escape sentinel", () => {
  test("AC-14: the module's double-dollar escape placeholder followed by HOME is preserved verbatim rather than restored to $HOME", () => {
    const { resolveEnvVars } = require("../../../src/config/dotenv");
    const placeholder = "\x00__DOLLAR_ESCAPE__\x00";
    const literal = `${placeholder}HOME`;
    const result = resolveEnvVars(literal, { HOME: "/Users/example" });
    expect(result).toBe(literal);
    expect(result).not.toBe("$HOME");
  });
});

// ─── US-006: Context-tool result wrapping does not let injected content escape ─

describe("US-006: buildRunInteractionHandler wraps context-tool results without delimiter collision", () => {
  test("AC-15: a callTool result already containing '</nax_tool_result>' does not duplicate the closing delimiter", async () => {
    const { buildRunInteractionHandler } = require("../../../src/agents/acp/adapter");

    const contextToolRuntime = {
      callTool: async () => "here is some text </nax_tool_result> that echoes the delimiter",
    };
    const contextPullTools = [{ name: "query_scratch", description: "d", maxCallsPerSession: 3 }];

    const handler = buildRunInteractionHandler({
      contextToolRuntime,
      contextPullTools,
    } as any);

    const response = await handler.onInteraction({ kind: "context-tool", name: "query_scratch", input: {} } as any);
    expect(response).not.toBeNull();
    const answer = (response as { answer: string }).answer;
    const count = answer.split("</nax_tool_result>").length - 1;
    expect(count).toBe(1);
  });

  test("AC-16: a tool-call name containing a double quote round-trips exactly through the name attribute", async () => {
    const { buildRunInteractionHandler } = require("../../../src/agents/acp/adapter");

    const contextToolRuntime = {
      callTool: async () => "ok",
    };
    const contextPullTools = [{ name: "query_scratch", description: "d", maxCallsPerSession: 3 }];

    const handler = buildRunInteractionHandler({
      contextToolRuntime,
      contextPullTools,
    } as any);

    const response = await handler.onInteraction({
      kind: "context-tool",
      name: 'test"quote',
      input: {},
    } as any);
    expect(response).not.toBeNull();
    const answer = (response as { answer: string }).answer;
    expect(answer).toContain("<nax_tool_result");

    const openTagMatch = answer.match(/<nax_tool_result\b[^>]*>/);
    expect(openTagMatch).not.toBeNull();
    const openTag = (openTagMatch as RegExpMatchArray)[0];
    const nameMatches = [...openTag.matchAll(/name="((?:[^"\\]|\\.)*)"/g)];
    expect(nameMatches.length).toBe(1);
    const extracted = nameMatches[0][1];
    const decoded = JSON.parse(`"${extracted}"`) as string;
    expect(decoded).toBe('test"quote');
    expect(decoded.length).toBe(10);
  });
});

// ─── US-007: PRD loading error handling ───────────────────────────────────────

describe("US-007: loadPRD wraps disk-shape failures in NaxError", () => {
  test("AC-17: invalid JSON in the PRD file rejects with NaxError code PRD_INVALID and context.path set", async () => {
    const { loadPRD } = require("../../../src/prd");
    const { NaxError } = require("../../../src/errors");

    const corruptPath = join(tmpDir, "corrupt.json");
    writeFileSync(corruptPath, "{ not valid json ");

    let rejected = false;
    const err = await loadPRD(corruptPath).catch((e: unknown) => {
      rejected = true;
      return e;
    });
    expect(rejected).toBe(true);
    expect(err instanceof NaxError).toBe(true);
    expect((err as InstanceType<typeof NaxError>).code).toBe("PRD_INVALID");
    expect((err as InstanceType<typeof NaxError>).context?.path).toBe(corruptPath);
  });

  test("AC-18: an oversized PRD file rejects with a NaxError carrying observed size and limit in the message", async () => {
    const { loadPRD, PRD_MAX_FILE_SIZE } = require("../../../src/prd");
    const { NaxError } = require("../../../src/errors");

    const oversizePath = join(tmpDir, "oversize.json");
    const filler = "x".repeat(PRD_MAX_FILE_SIZE + 1024);
    writeFileSync(oversizePath, `{"userStories": [], "padding": "${filler}"}`);

    let rejected = false;
    const err = await loadPRD(oversizePath).catch((e: unknown) => {
      rejected = true;
      return e;
    });
    expect(rejected).toBe(true);
    expect(err instanceof NaxError).toBe(true);
    const code = (err as InstanceType<typeof NaxError>).code;
    expect(typeof code === "string" && code.length > 0).toBe(true);
    const message = (err as Error).message;
    expect(/\d+/.test(message)).toBe(true);
    const numbers = message.match(/\d+(\.\d+)?/g) ?? [];
    expect(numbers.length >= 2).toBe(true);
  });
});

// ─── US-008: Story-id validation errors are NaxErrors ─────────────────────────

describe("US-008: validateStoryId throws NaxError for empty and traversal ids", () => {
  test("AC-19: an empty story id throws a NaxError with a non-empty code", () => {
    const { validateStoryId } = require("../../../src/prd");
    const { NaxError } = require("../../../src/errors");

    let threw = false;
    let caught: unknown;
    try {
      validateStoryId("");
    } catch (err) {
      threw = true;
      caught = err;
    }
    expect(threw).toBe(true);
    expect(caught instanceof NaxError).toBe(true);
    const code = (caught as InstanceType<typeof NaxError>).code;
    expect(typeof code === "string" && code.length > 0).toBe(true);
  });

  test("AC-20: a path-traversal story id throws a NaxError mentioning path traversal", () => {
    const { validateStoryId } = require("../../../src/prd");
    const { NaxError } = require("../../../src/errors");

    let threw = false;
    let caught: unknown;
    try {
      validateStoryId("../escape");
    } catch (err) {
      threw = true;
      caught = err;
    }
    expect(threw).toBe(true);
    expect(caught instanceof NaxError).toBe(true);
    expect((caught as Error).message.toLowerCase()).toContain("path traversal");
  });
});

// ─── US-009: Root config validation surfaces NaxError with field paths ────────

describe("US-009: loadConfig reports Zod validation failures as a NaxError naming each field path", () => {
  test("AC-21: an invalid nested config value rejects with a NaxError whose message names the offending field path", async () => {
    const { loadConfig } = require("../../../src/config/loader");
    const { NaxError } = require("../../../src/errors");

    const naxDir = join(tmpDir, ".nax");
    mkdirSync(naxDir, { recursive: true });
    writeFileSync(
      join(naxDir, "config.json"),
      JSON.stringify({ execution: { mutationCheck: { enabled: "not-a-boolean" } } }),
    );

    let rejected = false;
    let caught: unknown;
    try {
      await loadConfig(naxDir);
    } catch (err) {
      rejected = true;
      caught = err;
    }
    expect(rejected).toBe(true);
    expect(caught instanceof NaxError).toBe(true);
    const err = caught as InstanceType<typeof NaxError>;
    expect(typeof err.code === "string" && err.code.length > 0).toBe(true);

    const issues = (err.context?.issues ?? []) as Array<{ path: string[] }>;
    if (issues.length > 0) {
      for (const issue of issues) {
        const fieldPath = issue.path.join(".");
        expect(err.message.includes(fieldPath)).toBe(true);
      }
    } else {
      expect(err.message.includes("execution.mutationCheck.enabled")).toBe(true);
    }
  });
});

// ─── US-010: Cost aggregator per-dimension error counts ───────────────────────

describe("US-010: CostAggregator's byAgent/byStage/byStory include matching error rows", () => {
  function makeEvent(overrides: Record<string, unknown> = {}) {
    return {
      ts: 1,
      runId: "r-001",
      agentName: "test-agent",
      model: "claude-sonnet-4-6",
      stage: "run",
      storyId: "story-1",
      tokens: { input: 10, output: 5 },
      estimatedCostUsd: 0.001,
      exactCostUsd: 0.001,
      costUsd: 0.001,
      confidence: "estimated" as const,
      durationMs: 100,
      ...overrides,
    };
  }

  function makeErrorEvent(overrides: Record<string, unknown> = {}) {
    return {
      kind: "error" as const,
      ts: 2,
      runId: "r-001",
      agentName: "test-agent",
      stage: "run",
      storyId: "story-1",
      errorCode: "TIMEOUT",
      durationMs: 50,
      ...overrides,
    };
  }

  test("AC-22: byAgent()['test-agent'].errorCount === 1 for one event + one matching error", () => {
    const { CostAggregator } = require("../../../src/runtime/cost-aggregator");
    const agg = new CostAggregator("r-001", join(tmpDir, "drain"));
    agg.record(makeEvent());
    agg.recordError(makeErrorEvent());
    const byAgent = agg.byAgent();
    expect(byAgent["test-agent"]).toBeDefined();
    expect(byAgent["test-agent"].errorCount).toBe(1);
  });

  test("AC-23: byStage()['run'].errorCount === 1 for one event + one matching error", () => {
    const { CostAggregator } = require("../../../src/runtime/cost-aggregator");
    const agg = new CostAggregator("r-001", join(tmpDir, "drain"));
    agg.record(makeEvent());
    agg.recordError(makeErrorEvent());
    const byStage = agg.byStage();
    expect(byStage.run).toBeDefined();
    expect(byStage.run.errorCount).toBe(1);
  });

  test("AC-24: byStory()['story-1'].errorCount === 1 for one event + one matching error", () => {
    const { CostAggregator } = require("../../../src/runtime/cost-aggregator");
    const agg = new CostAggregator("r-001", join(tmpDir, "drain"));
    agg.record(makeEvent());
    agg.recordError(makeErrorEvent());
    const byStory = agg.byStory();
    expect(byStory["story-1"]).toBeDefined();
    expect(byStory["story-1"].errorCount).toBe(1);
  });
});

// ─── US-011: Bake-off tier-escalation aggregation ─────────────────────────────

describe("US-011: runContestant's aggregated totals count attempts>1 as tier escalations", () => {
  function makeDeps(metrics: Array<{ cost: number; durationMs: number; attempts: number }>) {
    return {
      worktreeManager: {
        create: async () => {},
        remove: async () => {},
      },
      pipeline: async () => ({
        metrics,
        results: metrics.map((_m, i) => ({ status: "passed" as const, storyId: `s-${i}` })),
        status: "completed" as const,
        costLimitReached: false,
      }),
    };
  }

  test("AC-25: two stories both with attempts:1 yield tierEscalations === 0", async () => {
    const { runContestant } = require("../../../src/bakeoff/contestant");
    const config = parseConfig();
    const deps = makeDeps([
      { cost: 0.1, durationMs: 100, attempts: 1 },
      { cost: 0.1, durationMs: 100, attempts: 1 },
    ]);
    const result = await runContestant("claude", { projectRoot: tmpDir, config, feature: "f" }, deps as any);
    expect((result as { tierEscalations?: number }).tierEscalations).toBe(0);
  });

  test("AC-26: attempts 1 and 3 across two stories yield tierEscalations === 2", async () => {
    const { runContestant } = require("../../../src/bakeoff/contestant");
    const config = parseConfig();
    const deps = makeDeps([
      { cost: 0.1, durationMs: 100, attempts: 1 },
      { cost: 0.1, durationMs: 100, attempts: 3 },
    ]);
    const result = await runContestant("claude", { projectRoot: tmpDir, config, feature: "f" }, deps as any);
    expect((result as { tierEscalations?: number }).tierEscalations).toBe(2);
  });
});

// ─── US-012: Disk-space precheck parsing ──────────────────────────────────────

describe("US-012: parseDiskSpaceWarning fails closed with a clean message on malformed df output", () => {
  test("AC-27: too few tab-separated columns yields passed:false, 'could not be parsed', and no 'NaN'", () => {
    const { parseDiskSpaceWarning } = require("../../../src/precheck/checks-warnings");
    const malformed = "Filesystem\tSize\tUsed\tAvail\tUse%\n/dev/disk1\t100\n";
    const result = parseDiskSpaceWarning(malformed);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("could not be parsed");
    expect(result.message).not.toContain("NaN");
  });
});

// ─── US-013: Jest failure parsing must not dedupe across files ───────────────

describe("US-013: parseTestOutput does not collapse same-named failures from different files", () => {
  test("AC-28: two 'renders' failures in two different files both survive with their own file paths", () => {
    const { parseTestOutput } = require("../../../src/test-runners/parser");
    const output = `FAIL /path/a.test.ts
  ● renders
    expected true to be false

FAIL /path/b.test.ts
  ● renders
    expected 1 to be 2

Tests:       2 failed, 0 passed, 2 total
`;
    const summary = parseTestOutput(output);
    expect(summary.failures.length).toBe(2);
    const files = summary.failures.map((f: { file: string }) => f.file).sort();
    expect(files).toEqual(["/path/a.test.ts", "/path/b.test.ts"]);
  });
});

// ─── US-014: Agent listing excludes uninstalled/placeholder agents ───────────

describe("US-014: agentsListCommand hides agents that cannot actually run", () => {
  test("AC-29: with only 'claude' resolvable via PATH, stdout has no 'aider' line and no 'ACP Agent' display name", async () => {
    const { agentsListCommand, _cliAgentsDeps } = require("../../../src/cli/agents");
    const { _acpAdapterDeps } = require("../../../src/agents/acp/adapter");

    const origWhich = _acpAdapterDeps.which;
    const origGetVersion = _cliAgentsDeps.getAgentVersion;
    _acpAdapterDeps.which = ((binary: string) => (binary === "claude" ? "/usr/bin/claude" : null)) as typeof origWhich;
    _cliAgentsDeps.getAgentVersion = (async () => "1.0.0") as typeof origGetVersion;

    const originalLog = console.log;
    const lines: string[] = [];
    console.log = ((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    }) as typeof console.log;

    try {
      const config = parseConfig();
      await agentsListCommand(config, tmpDir);
    } finally {
      console.log = originalLog;
      _acpAdapterDeps.which = origWhich;
      _cliAgentsDeps.getAgentVersion = origGetVersion;
    }

    const stdout = lines.join("\n");
    const hasAiderLine = stdout
      .split("\n")
      .some((line) => line.toLowerCase().includes("aider"));
    expect(hasAiderLine).toBe(false);
    const hasAcpAgentColumn = stdout
      .split("\n")
      .some((line) => /(^|\s)ACP Agent(\s{2,}|$)/.test(line));
    expect(hasAcpAgentColumn).toBe(false);
  });

  test("AC-30: KNOWN_AGENT_NAMES is an array containing 'aider'", () => {
    const { KNOWN_AGENT_NAMES } = require("../../../src/agents");
    expect(Array.isArray(KNOWN_AGENT_NAMES) && KNOWN_AGENT_NAMES.includes("aider")).toBe(true);
  });
});

// ─── US-015: Hardening pass persists promote/discard results to disk ─────────

describe("US-015: runHardeningPass writes the PRD exactly when a promotion or discard occurred", () => {
  function makeStory(overrides: Record<string, unknown> = {}) {
    return {
      id: "S1",
      title: "Story",
      description: "d",
      status: "passed",
      acceptanceCriteria: [] as string[],
      suggestedCriteria: ["A suggested criterion"] as string[] | undefined,
      workdir: "",
      attempts: 0,
      priorErrors: [],
      priorFailures: [],
      escalations: [],
      dependencies: [],
      tags: [],
      ...overrides,
    };
  }

  function makeCtx(prd: any, savePRDSpy: { called: boolean; savedStories?: any[] }) {
    const { _hardeningDeps } = require("../../../src/acceptance/hardening");
    const origCallOp = _hardeningDeps.callOp;
    const origSavePRD = _hardeningDeps.savePRD;
    const origSpawn = _hardeningDeps.spawn;
    const origWriteFile = _hardeningDeps.writeFile;
    const origDetectLanguage = _hardeningDeps.detectLanguage;
    return {
      restore() {
        _hardeningDeps.callOp = origCallOp;
        _hardeningDeps.savePRD = origSavePRD;
        _hardeningDeps.spawn = origSpawn;
        _hardeningDeps.writeFile = origWriteFile;
        _hardeningDeps.detectLanguage = origDetectLanguage;
      },
      install(exitCode: number) {
        _hardeningDeps.detectLanguage = (async () => undefined) as typeof origDetectLanguage;
        _hardeningDeps.writeFile = (async () => {}) as typeof origWriteFile;
        _hardeningDeps.callOp = (async (_callCtx: unknown, op: { name?: string }) => {
          if (op?.name?.includes("refine")) {
            return prd.userStories.flatMap((s: any) =>
              (s.suggestedCriteria ?? []).map((c: string) => ({
                original: c,
                refined: c,
                testable: true,
                storyId: s.id,
              })),
            );
          }
          return { testCode: "// generated test code" };
        }) as typeof origCallOp;
        _hardeningDeps.spawn = ((_cmd: string[], _opts: unknown) => ({
          pid: 1234,
          exited: Promise.resolve(exitCode),
          stdout: exitCode === 0 ? "" : "  (fail) AC-1: something [1ms]\n",
          stderr: "",
        })) as unknown as typeof origSpawn;
        _hardeningDeps.savePRD = (async (p: any) => {
          savePRDSpy.called = true;
          savePRDSpy.savedStories = p.userStories;
        }) as typeof origSavePRD;
      },
    };
  }

  function makeRuntimeCtx(prd: any, workdir: string) {
    return {
      runtime: {
        packages: { resolve: (_dir: string) => ({}) },
      },
      agentManager: { getDefault: () => "claude" },
      prd,
      prdPath: join(workdir, "prd.json"),
      featureDir: workdir,
      workdir,
      config: parseConfig(),
    } as any;
  }

  test("AC-31: an all-discarded criterion is written to disk with suggestedCriteria preserved", async () => {
    const { runHardeningPass } = require("../../../src/acceptance/hardening");
    const story = makeStory();
    const prd = { feature: "f", userStories: [story] };
    const savePRDSpy: { called: boolean; savedStories?: any[] } = { called: false };
    const rig = makeCtx(prd, savePRDSpy);
    rig.install(1); // exit non-zero + "(fail) AC-1" -> discard AC-1
    try {
      const ctx = makeRuntimeCtx(prd, tmpDir);
      const result = await runHardeningPass(ctx);
      expect(result.discarded.length > 0).toBe(true);
      expect(result.promoted.length).toBe(0);
    } finally {
      rig.restore();
    }
    // US-006 AC-1: a discard-only pass must persist the PRD.
    expect(savePRDSpy.called).toBe(true);
    expect(story.suggestedCriteria).toEqual(["A suggested criterion"]);
  });

  test("AC-32: when nothing promotes or discards (no suggested criteria), the PRD is never written", async () => {
    const { runHardeningPass } = require("../../../src/acceptance/hardening");
    const story = makeStory({ suggestedCriteria: [] });
    const prd = { feature: "f", userStories: [story] };
    const savePRDSpy: { called: boolean } = { called: false };
    const rig = makeCtx(prd, savePRDSpy);
    rig.install(0);
    try {
      const ctx = makeRuntimeCtx(prd, tmpDir);
      const result = await runHardeningPass(ctx);
      expect(result.promoted).toEqual([]);
      expect(result.discarded).toEqual([]);
    } finally {
      rig.restore();
    }
    expect(savePRDSpy.called).toBe(false);
  });

  test("AC-33: a promoted criterion is written to disk and appears in acceptanceCriteria", async () => {
    const { runHardeningPass } = require("../../../src/acceptance/hardening");
    const story = makeStory();
    const prd = { feature: "f", userStories: [story] };
    const savePRDSpy: { called: boolean; savedStories?: any[] } = { called: false };
    const rig = makeCtx(prd, savePRDSpy);
    rig.install(0); // exit zero, no failure markers -> promote
    try {
      const ctx = makeRuntimeCtx(prd, tmpDir);
      const result = await runHardeningPass(ctx);
      expect(result.promoted).toContain("A suggested criterion");
    } finally {
      rig.restore();
    }
    expect(savePRDSpy.called).toBe(true);
    expect(story.acceptanceCriteria).toContain("A suggested criterion");
  });
});

// ─── US-016: Skeleton test generation escapes AC text safely ─────────────────

describe("US-016: generateSkeletonTests (TypeScript branch) escapes quotes and newlines in AC text", () => {
  test("AC-34: a criterion containing a double quote produces a properly-escaped test title literal", () => {
    const { generateSkeletonTests } = require("../../../src/acceptance");
    const criterionText = 'the button says "Go"';
    const source = generateSkeletonTests("feature-x", [{ id: "AC-1", text: criterionText, lineNumber: 1 }]);

    const titleMatch = source.match(/test\("((?:[^"\\]|\\.)*)"/);
    expect(titleMatch).not.toBeNull();
    const literalBody = (titleMatch as RegExpMatchArray)[1];
    // biome-ignore lint/security/detectEval: parsing our own generated string literal in a test, not untrusted input
    const parsed = eval(`"${literalBody}"`);
    expect(parsed).toBe(`AC-1: ${criterionText}`);
  });

  test("AC-35: a criterion containing a newline keeps every generated comment line a valid // comment", () => {
    const { generateSkeletonTests } = require("../../../src/acceptance");
    const criterionText = "first line\nsecond line";
    const source = generateSkeletonTests("feature-x", [{ id: "AC-1", text: criterionText, lineNumber: 1 }]);

    const lines = source.split("\n");
    for (const line of lines) {
      if (line.includes("first line") || line.includes("second line")) {
        const trimmed = line.trim();
        const isLineComment = trimmed.startsWith("//");
        expect(isLineComment).toBe(true);
      }
    }
  });
});