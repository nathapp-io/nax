/**
 * Curator auto-prune size gate — US-004 (Size-gate automatic rollup retention)
 *
 * AC3-AC7 exercise the `maybePruneRollup` size gate end-to-end through the
 * public symbol. AC12 exercises `getCuratorRetention` with a context that
 * carries no curator configuration.
 *
 * The size gate reads `Bun.file(input.rollupPath).size`:
 *   - size >  retention.pruneThresholdBytes → derive keepRunIds from the first
 *     `retention.keepRuns` ids of `scanProjectRunIds`, call `pruneRollup`.
 *   - size <= retention.pruneThresholdBytes → return `{ pruned: false }` without
 *     invoking `pruneRollup`.
 *
 * `pruneRollup` rejection is caught and reported on `error` with
 * `pruned: false`. A missing rollup path resolves without rejection and
 * without invoking `pruneRollup`.
 *
 * STUBS: `maybePruneRollup` and `getCuratorRetention` are stubs that throw /
 * return `DEFAULT_RETENTION`. The implementer in the next session replaces
 * them with real logic; these tests fail (assertion failures or "not
 * implemented" throws propagated through `await`) until then.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { withTempDir } from "@test/helpers";
import type { PostRunContext } from "@/plugins";
import type { Observation } from "@/plugins/builtin/curator";
import { DEFAULT_RETENTION, getCuratorRetention, maybePruneRollup } from "@/plugins/builtin/curator";
import { _curatorPruneDeps, type PruneResult } from "@/plugins/builtin/curator/rollup-prune";

/** Minimal post-run context with a no-op logger. */
function makeContext(opts: {
  outputDir: string;
  globalDir: string;
  curatorRollupPath: string;
  projectKey: string;
}): PostRunContext {
  return {
    runId: "test-run",
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
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    outputDir: opts.outputDir,
    globalDir: opts.globalDir,
    projectKey: opts.projectKey,
    curatorRollupPath: opts.curatorRollupPath,
  };
}

/**
 * Build a JSONL rollup with `countRows` rows, each from a distinct runId in
 * `run-${i}`. Returns the number of bytes written so the test can pick a
 * threshold relative to the actual size.
 */
async function writeRollupWithNRuns(rollupPath: string, countRows: number, projectKey: string): Promise<number> {
  await mkdir(path.dirname(rollupPath), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < countRows; i += 1) {
    const obs: Observation = {
      schemaVersion: 3,
      projectKey,
      runId: `run-${String(i).padStart(4, "0")}`,
      featureId: "feat-test",
      storyId: "US-001",
      stage: "review",
      ts: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      kind: "verdict",
      payload: { status: "completed", cost: 0, tokens: 0 },
    };
    lines.push(JSON.stringify(obs));
  }
  await writeFile(rollupPath, `${lines.join("\n")}\n`);
  return Bun.file(rollupPath).size;
}

/** Capture every pruneRollup invocation so tests can assert on call counts and arg shape. */
type PruneCall = {
  rollupPath: string;
  projectKey: string;
  keepRunIds: ReadonlySet<string>;
  dropUnattributed?: boolean;
};

describe("maybePruneRollup — size gate (US-004)", () => {
  let origPrune: typeof _curatorPruneDeps.pruneRollup;
  let pruneCalls: PruneCall[];
  let pruneImpl: typeof _curatorPruneDeps.pruneRollup;

  beforeEach(() => {
    pruneCalls = [];
    origPrune = _curatorPruneDeps.pruneRollup;
    pruneImpl = (async (input: {
      rollupPath: string;
      projectKey: string;
      keepRunIds: ReadonlySet<string>;
      dropUnattributed?: boolean;
    }) => {
      pruneCalls.push({ ...input });
      const ok: PruneResult = { kept: 0, dropped: 0, keptOtherProjects: 0, keptUnattributed: 0 };
      return ok;
    }) as typeof _curatorPruneDeps.pruneRollup;
    _curatorPruneDeps.pruneRollup = pruneImpl;
  });

  afterEach(() => {
    _curatorPruneDeps.pruneRollup = origPrune;
  });

  test("AC3: over-threshold rollup → pruneRollup invoked once with keepRunIds of at most retention.keepRuns", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      // 200 runs → far more than keepRuns=50, so keepRunIds should be capped.
      await writeRollupWithNRuns(rollupPath, 200, "test-project");
      const size = Bun.file(rollupPath).size;
      expect(size).toBeGreaterThan(0);

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: size - 1, keepRuns: 50 },
      });

      expect(result.pruned).toBe(true);
      expect(pruneCalls).toHaveLength(1);
      expect(pruneCalls[0]?.rollupPath).toBe(rollupPath);
      expect(pruneCalls[0]?.projectKey).toBe("test-project");
      // The keepRunIds set's cardinality must NOT exceed the configured keepRuns.
      expect(pruneCalls[0]?.keepRunIds.size).toBeLessThanOrEqual(50);
      // And it must include some of the runIds that were in the rollup.
      expect(pruneCalls[0]?.keepRunIds.size).toBeGreaterThan(0);
    });
  });

  test("AC4: under-threshold rollup → pruneRollup is NOT invoked", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const size = await writeRollupWithNRuns(rollupPath, 5, "test-project");

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        // Threshold well above the actual size — gate stays closed.
        retention: { pruneThresholdBytes: size + 1024, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(pruneCalls).toHaveLength(0);
    });
  });

  test("AC5: size exactly equal to threshold → pruneRollup is NOT invoked (gate opens strictly above)", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const size = await writeRollupWithNRuns(rollupPath, 5, "test-project");

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        // Threshold == size — boundary. The AC says "above rather than at",
        // so an exactly-at-threshold file must not trigger a prune.
        retention: { pruneThresholdBytes: size, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(pruneCalls).toHaveLength(0);
    });
  });

  test("AC6: pruneRollup rejection → maybePruneRollup resolves with pruned:false and an error string", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const size = await writeRollupWithNRuns(rollupPath, 200, "test-project");

      // Force pruneRollup to reject — the post-run hook must catch and report,
      // not propagate.
      _curatorPruneDeps.pruneRollup = (async () => {
        throw new Error("disk full");
      }) as typeof _curatorPruneDeps.pruneRollup;

      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: size - 1, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      // An error string must surface — the post-run logs it via logger.warn.
      expect(typeof result.error).toBe("string");
      expect(result.error?.length ?? 0).toBeGreaterThan(0);
    });
  });

  test("AC7: missing rollup path → no pruneRollup call, resolves without rejecting", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "does-not-exist.jsonl");
      // Confirm the path really doesn't exist.
      expect(await Bun.file(rollupPath).exists()).toBe(false);

      // The call must not reject — Bun.file().size on a missing file is 0,
      // which puts the size well below any reasonable threshold, so the gate
      // stays closed without invoking pruneRollup.
      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: 1, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(pruneCalls).toHaveLength(0);
    });
  });
});

describe("getCuratorRetention — schema-default fallback (US-004)", () => {
  test("AC12: returns DEFAULT_RETENTION values when context carries no curator configuration", () => {
    // Use a partial PostRunContext — the resolver reads context.config.curator,
    // which is undefined here. The schema default is the only available source.
    const ctx = makeContext({
      outputDir: "/tmp/doesnt-matter",
      globalDir: "/tmp/doesnt-matter",
      curatorRollupPath: "/tmp/doesnt-matter.jsonl",
      projectKey: "test-project",
    });

    const retention = getCuratorRetention(ctx);

    expect(retention.pruneThresholdBytes).toBe(DEFAULT_RETENTION.pruneThresholdBytes);
    expect(retention.pruneThresholdBytes).toBe(67108864);
    expect(retention.keepRuns).toBe(DEFAULT_RETENTION.keepRuns);
    expect(retention.keepRuns).toBe(50);
  });

  test("AC12 boundary: returns DEFAULT_RETENTION values when context carries curator config with retention unset", () => {
    // Curator config is present but retention is missing — schema default
    // for the retention field is the only available source. The implementer
    // must handle the case where curator exists but retention doesn't.
    const ctx = makeContext({
      outputDir: "/tmp/doesnt-matter",
      globalDir: "/tmp/doesnt-matter",
      curatorRollupPath: "/tmp/doesnt-matter.jsonl",
      projectKey: "test-project",
    });
    ctx.config = { curator: { enabled: true } };

    const retention = getCuratorRetention(ctx);

    expect(retention.pruneThresholdBytes).toBe(67108864);
    expect(retention.keepRuns).toBe(50);
  });

  test("AC12 boundary: returns curator config retention when it is fully set", () => {
    const ctx = makeContext({
      outputDir: "/tmp/doesnt-matter",
      globalDir: "/tmp/doesnt-matter",
      curatorRollupPath: "/tmp/doesnt-matter.jsonl",
      projectKey: "test-project",
    });
    ctx.config = {
      curator: {
        retention: { pruneThresholdBytes: 1024, keepRuns: 7 },
      },
    };

    const retention = getCuratorRetention(ctx);

    // Custom values pass through; nothing here falls back to DEFAULT_RETENTION.
    expect(retention.pruneThresholdBytes).toBe(1024);
    expect(retention.keepRuns).toBe(7);
  });
});
