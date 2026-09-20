/**
 * Curator post-run auto-prune — US-004 (Size-gate automatic rollup retention)
 *
 * AC8-AC11 exercise the post-run action's auto-prune wiring end-to-end:
 *   AC8  — outputDir set + over-threshold → pruneRollup invoked once.
 *   AC9  — outputDir set + under-threshold → pruneRollup NOT invoked.
 *   AC10 — outputDir set + pruneRollup rejects → PostRunActionResult.success
 *          remains `true` (the curator is an observer; failures log + carry on).
 *   AC11 — outputDir set + an over-threshold rollup evicts runs → the evicted
 *          run directories still carry their `observations.jsonl` and
 *          `curator-proposals.md` (artifact deletion is manual-gc-only).
 *
 * The size gate and post-run wiring are NOT yet implemented in this story's
 * baseline — these tests fail at assertions until the implementer adds the
 * auto-prune call after `appendToRollup` and catches its rejections.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { withTempDir } from "@test/helpers";
import type { PostRunContext } from "@/plugins";
import type { Observation } from "@/plugins/builtin/curator";
import { curatorPlugin } from "@/plugins/builtin/curator";
import { _curatorPruneDeps, type PruneResult } from "@/plugins/builtin/curator/rollup-prune";

/**
 * Build a curator post-run context with `outputDir` set and a captured-log
 * logger. Returns both the context (typed loosely — `PostRunContext.config`
 * is `unknown` by design) and the warn-call log.
 */
function makePostRunContext(opts: {
  outputDir: string;
  globalDir: string;
  curatorRollupPath: string;
  runId: string;
  projectKey: string;
}): { ctx: PostRunContext; warnCalls: Array<{ message: string; data?: Record<string, unknown> }> } {
  const warnCalls: Array<{ message: string; data?: Record<string, unknown> }> = [];
  const ctx: PostRunContext = {
    runId: opts.runId,
    feature: "feat-test",
    workdir: path.join(opts.outputDir, "work"),
    prdPath: path.join(opts.outputDir, "work", ".nax", "features", "feat-test", "prd.json"),
    branch: "main",
    totalDurationMs: 1000,
    totalCost: 10,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string, data?: Record<string, unknown>) => {
        warnCalls.push({ message, data });
      },
      error: () => {},
    },
    outputDir: opts.outputDir,
    globalDir: opts.globalDir,
    projectKey: opts.projectKey,
    curatorRollupPath: opts.curatorRollupPath,
  };
  return { ctx, warnCalls };
}

/** Trivial review-finding observation. The message field accepts arbitrary strings,
 * which lets us pad the row with arbitrary bytes to drive the rollup past the
 * size threshold for AC8/AC10/AC11. */
function makeObs(runId: string, projectKey: string, padding = ""): Observation {
  return {
    schemaVersion: 3,
    projectKey,
    runId,
    featureId: "feat-test",
    storyId: "US-001",
    stage: "review",
    ts: new Date(2026, 0, 1, 0, 0, 0).toISOString(),
    kind: "review-finding",
    payload: { ruleId: "rule-x", severity: "info", file: "src/a.ts", line: 1, message: padding },
  };
}

/**
 * Pre-populate the rollup with `nRuns` distinct runIds. Each run also gets a
 * directory under `outputDir/runs/<runId>/` containing both
 * `observations.jsonl` and `curator-proposals.md` so AC11 has real artifacts
 * to assert on. Returns the rollup byte size.
 */
async function seedRunsAndRollup(opts: {
  outputDir: string;
  globalDir: string;
  rollupPath: string;
  projectKey: string;
  nRuns: number;
  padding?: string;
}): Promise<number> {
  await mkdir(opts.globalDir, { recursive: true });
  await mkdir(path.dirname(opts.rollupPath), { recursive: true });
  const padding = opts.padding ?? "x".repeat(2048);
  const lines: string[] = [];
  for (let i = 0; i < opts.nRuns; i += 1) {
    const runId = `run-${String(i).padStart(4, "0")}`;
    const obs = makeObs(runId, opts.projectKey, padding);
    lines.push(JSON.stringify(obs));

    const runDir = path.join(opts.outputDir, "runs", runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(path.join(runDir, "observations.jsonl"), `${JSON.stringify(obs)}\n`);
    await writeFile(path.join(runDir, "curator-proposals.md"), `# Proposals for ${runId}\n`);
  }
  await writeFile(opts.rollupPath, `${lines.join("\n")}\n`);
  return Bun.file(opts.rollupPath).size;
}

describe("curator post-run action — size-gated auto-prune (US-004)", () => {
  let origPrune: typeof _curatorPruneDeps.pruneRollup;
  let pruneCallLog: Array<{
    rollupPath: string;
    projectKey: string;
    keepRunIds: ReadonlySet<string>;
    dropUnattributed?: boolean;
  }>;

  beforeEach(() => {
    pruneCallLog = [];
    origPrune = _curatorPruneDeps.pruneRollup;
    _curatorPruneDeps.pruneRollup = (async (input: {
      rollupPath: string;
      projectKey: string;
      keepRunIds: ReadonlySet<string>;
      dropUnattributed?: boolean;
    }) => {
      pruneCallLog.push({ ...input });
      const ok: PruneResult = { kept: 0, dropped: 0, keptOtherProjects: 0, keptUnattributed: 0 };
      return ok;
    }) as typeof _curatorPruneDeps.pruneRollup;
  });

  afterEach(() => {
    _curatorPruneDeps.pruneRollup = origPrune;
  });

  test("AC8: outputDir set + over-threshold rollup → pruneRollup invoked once", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns: 3 });
      // Force the gate open by setting the threshold a single byte under size.
      // The implementer resolves retention from context.config.curator.retention.
      const { ctx } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size - 1, keepRuns: 2 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      expect(action).toBeDefined();
      await action?.execute(ctx);

      expect(pruneCallLog).toHaveLength(1);
      expect(pruneCallLog[0]?.rollupPath).toBe(rollupPath);
      expect(pruneCallLog[0]?.projectKey).toBe(projectKey);
    });
  });

  test("AC9: outputDir set + under-threshold rollup → pruneRollup is NOT invoked", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns: 3 });

      const { ctx } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      // Threshold comfortably above the rollup size — the gate stays closed.
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size + 4096, keepRuns: 2 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      await action?.execute(ctx);

      expect(pruneCallLog).toHaveLength(0);
    });
  });

  test("AC10: outputDir set + pruneRollup rejects → success remains true AND a pruning-related logger.warn fires", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns: 3 });

      // Force pruneRollup to reject. The post-run action must catch and
      // continue, returning success:true (the curator is an observer) AND
      // emit a logger.warn carrying the failure context.
      _curatorPruneDeps.pruneRollup = (async () => {
        throw new Error("disk full");
      }) as typeof _curatorPruneDeps.pruneRollup;

      const { ctx, warnCalls } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size - 1, keepRuns: 2 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      const result = await action?.execute(ctx);

      expect(result?.success).toBe(true);
      // The failure must surface as a logger.warn entry mentioning "prune".
      // This is the AC10 guarantee that the curator is an observer: the run
      // exits cleanly but the warning is captured in the post-run log so an
      // operator can investigate. Without the wiring, no prune-related warn
      // ever fires and this assertion fails.
      const pruneWarn = warnCalls.find((call) => /prune/i.test(call.message));
      expect(pruneWarn).toBeDefined();
    });
  });

  test("AC11: outputDir set + over-threshold prune evicts runs → evicted run dirs preserve observations.jsonl and curator-proposals.md", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const projectKey = "test-project";
      const nRuns = 3;
      const size = await seedRunsAndRollup({ outputDir, globalDir, rollupPath, projectKey, nRuns });

      // Force the gate open AND drive a real eviction. The mock returns a
      // result that drops everything but the kept runIds, mirroring the
      // real pruneRollup contract.
      _curatorPruneDeps.pruneRollup = (async (input: {
        rollupPath: string;
        projectKey: string;
        keepRunIds: ReadonlySet<string>;
      }) => {
        const allRunIds: string[] = [];
        for (let i = 0; i < nRuns; i += 1) allRunIds.push(`run-${String(i).padStart(4, "0")}`);
        // Mark the un-kept runs as evicted.
        const evicted = allRunIds.filter((id) => !input.keepRunIds.has(id));
        const dropped = evicted.length;
        // Strip evicted rows from the rollup so the eviction is observable
        // without depending on the real pruneRollup.
        const remaining = allRunIds.filter((id) => input.keepRunIds.has(id));
        const lines = remaining.map((runId) => JSON.stringify(makeObs(runId, projectKey)));
        await writeFile(input.rollupPath, `${lines.join("\n")}\n`);
        return {
          kept: remaining.length,
          dropped,
          keptOtherProjects: 0,
          keptUnattributed: 0,
        } satisfies PruneResult;
      }) as typeof _curatorPruneDeps.pruneRollup;

      const { ctx } = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId: "current-run",
        projectKey,
      });
      ctx.config = {
        curator: { retention: { pruneThresholdBytes: size - 1, keepRuns: 1 } },
      };

      const action = curatorPlugin.extensions.postRunAction;
      await action?.execute(ctx);

      // Eviction happened: only one runId remains in the rollup.
      const after = await Bun.file(rollupPath).text();
      const survivingRunIds = after
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line).runId);
      expect(survivingRunIds.length).toBe(1);

      // The evicted run dirs still carry both artifacts — automatic prune
      // must NOT delete per-run curator artifacts; that is `nax curator gc`'s
      // job and is out of scope for US-004.
      const allRunIds: string[] = [];
      for (let i = 0; i < nRuns; i += 1) allRunIds.push(`run-${String(i).padStart(4, "0")}`);
      const evicted = allRunIds.filter((id) => !survivingRunIds.includes(id));
      expect(evicted.length).toBeGreaterThan(0);

      for (const runId of evicted) {
        const runDir = path.join(outputDir, "runs", runId);
        expect(await Bun.file(path.join(runDir, "observations.jsonl")).exists()).toBe(true);
        expect(await Bun.file(path.join(runDir, "curator-proposals.md")).exists()).toBe(true);
      }
    });
  });
});
