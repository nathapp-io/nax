/**
 * Curator auto-prune size gate — US-004 (Size-gate automatic rollup retention)
 *
 * AC3-AC7 exercise the `maybePruneRollup` size gate end-to-end through the
 * public symbol. AC12 exercises `getCuratorRetention` with a context that
 * carries no curator configuration.
 *
 * The size gate reads `Bun.file(input.rollupPath).size`:
 *   - size >  retention.pruneThresholdBytes → invoke the scan-then-prune
 *     pair (under a single lock acquisition, to close the race against a
 *     concurrent `appendToRollup`).
 *   - size <= retention.pruneThresholdBytes → return `{ pruned: false }`
 *     without invoking the rollup rewrite.
 *
 * `scanAndPruneNewest` rejection is caught and reported on `error` with
 * `pruned: false`. A missing rollup path resolves without rejection and
 * without invoking the rollup rewrite.
 *
 * Dispatch wiring: `maybePruneRollup` calls
 * `_curatorPruneDeps.scanAndPruneNewest(rollupPath, projectKey, keepRuns)`.
 * The mock intercepts that single function and tracks the `(rollupPath,
 * projectKey, keepRuns)` triple — the AC's "calls pruneRollup once with
 * keepRunIds containing at most retention.keepRuns IDs" reads against this
 * dispatch: one invocation, with the configured `keepRuns` cap.
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

/**
 * Capture every `scanAndPruneNewest` invocation so tests can assert on call
 * counts and arg shape. Mirrors the dispatch contract: `(rollupPath,
 * projectKey, keepRuns)`. The `keepRuns` cap is the AC-mandated bound the
 * implementation must pass through; the real `scanAndPruneNewest` slices
 * the run-id set to that length internally.
 */
type ScanAndPruneCall = {
  rollupPath: string;
  projectKey: string;
  keepRuns: number;
};

describe("maybePruneRollup — size gate (US-004)", () => {
  let origScanAndPrune: typeof _curatorPruneDeps.scanAndPruneNewest;
  let scanAndPruneCalls: ScanAndPruneCall[];
  let scanAndPruneImpl: typeof _curatorPruneDeps.scanAndPruneNewest;

  beforeEach(() => {
    scanAndPruneCalls = [];
    origScanAndPrune = _curatorPruneDeps.scanAndPruneNewest;
    scanAndPruneImpl = (async (rollupPath: string, projectKey: string, keepRuns: number) => {
      scanAndPruneCalls.push({ rollupPath, projectKey, keepRuns });
      const ok: PruneResult = { kept: 0, dropped: 0, keptOtherProjects: 0, keptUnattributed: 0 };
      return ok;
    }) as typeof _curatorPruneDeps.scanAndPruneNewest;
    _curatorPruneDeps.scanAndPruneNewest = scanAndPruneImpl;
  });

  afterEach(() => {
    _curatorPruneDeps.scanAndPruneNewest = origScanAndPrune;
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
      expect(scanAndPruneCalls).toHaveLength(1);
      expect(scanAndPruneCalls[0]?.rollupPath).toBe(rollupPath);
      expect(scanAndPruneCalls[0]?.projectKey).toBe("test-project");
      // The AC-mandated bound: keepRuns caps the run-id set the rewrite
      // preserves. The real `scanAndPruneNewest` slices to keepRuns, so the
      // mock receives `keepRuns` as its argument and the cap travels with it.
      expect(scanAndPruneCalls[0]?.keepRuns).toBeLessThanOrEqual(50);
      // And it must be a positive cap — a zero cap would silently keep nothing.
      expect(scanAndPruneCalls[0]?.keepRuns).toBeGreaterThan(0);
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
      expect(scanAndPruneCalls).toHaveLength(0);
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
      expect(scanAndPruneCalls).toHaveLength(0);
    });
  });

  test("AC6: pruneRollup rejection → maybePruneRollup resolves with pruned:false and an error string", async () => {
    await withTempDir(async (dir) => {
      const rollupPath = path.join(dir, "rollup.jsonl");
      const size = await writeRollupWithNRuns(rollupPath, 200, "test-project");

      // Force the scan-then-prune pair to reject — the post-run hook must
      // catch and report, not propagate.
      _curatorPruneDeps.scanAndPruneNewest = (async () => {
        throw new Error("disk full");
      }) as typeof _curatorPruneDeps.scanAndPruneNewest;

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
      // stays closed without invoking the rollup rewrite.
      const result = await maybePruneRollup({
        rollupPath,
        projectKey: "test-project",
        retention: { pruneThresholdBytes: 1, keepRuns: 50 },
      });

      expect(result.pruned).toBe(false);
      expect(scanAndPruneCalls).toHaveLength(0);
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
