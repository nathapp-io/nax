/**
 * Post-run action wires the heuristic-window provenance into renderProposals
 * (US-003). ACs 6 and 8 are exercised end-to-end through the post-run
 * action: the rollup is pre-populated with the observations that the action
 * is supposed to read, then `curatorPlugin.execute()` is invoked and the
 * written `curator-proposals.md` is read back to assert on its header.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { makeNaxConfig, withTempDir } from "@test/helpers";
import type { CuratorPostRunContext, Observation } from "@/plugins/builtin/curator";
import { curatorPlugin } from "@/plugins/builtin/curator";
import { appendToRollup } from "@/plugins/builtin/curator/rollup";

/**
 * Minimal curator post-run context pointing at the supplied directories.
 * Artifact directories under `outputDir` are intentionally absent so
 * `collectObservations` returns [] (it is graceful about missing sources),
 * giving the test full control over what the rollup contains.
 */
function makePostRunContext(opts: {
  outputDir: string;
  globalDir: string;
  curatorRollupPath: string;
  runId: string;
  projectKey: string;
}): CuratorPostRunContext {
  return {
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
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: makeNaxConfig(),
    outputDir: opts.outputDir,
    globalDir: opts.globalDir,
    projectKey: opts.projectKey,
    curatorRollupPath: opts.curatorRollupPath,
  };
}

/** A trivial review-finding observation for a given runId, suitable for the rollup. */
function makeReviewFindingObs(runId: string): Observation {
  return {
    schemaVersion: 3,
    projectKey: "test-project",
    runId,
    featureId: "feat-test",
    storyId: "US-001",
    stage: "review",
    ts: "2026-05-04T00:00:00Z",
    kind: "review-finding",
    payload: { ruleId: "rule-x", severity: "error", file: "src/a.ts", line: 1, message: "x" },
  };
}

describe("curator post-run action — heuristic-window provenance wiring (US-003)", () => {
  test("AC6: written curator-proposals.md header states the window run count when the rollup holds >1 run", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const runId = "current-run";
      const projectKey = "test-project";

      // Pre-populate the rollup with observations from TWO prior runs. The
      // current run's window therefore spans 3 distinct runIds (the two
      // historical plus its own, appended at execute-time).
      await appendToRollup([makeReviewFindingObs("historical-run-1")], rollupPath);
      await appendToRollup([makeReviewFindingObs("historical-run-2")], rollupPath);

      const ctx = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId,
        projectKey,
      });

      const postRunAction = curatorPlugin.extensions.postRunAction;
      expect(postRunAction).toBeDefined();
      await postRunAction?.execute(ctx);

      const proposalsPath = path.join(outputDir, "runs", runId, "curator-proposals.md");
      const md = await Bun.file(proposalsPath).text();

      // The header must carry the window's run count, not the literal "1" of
      // the per-run reading. The rollup holds two historical runs plus the
      // current run → window has at least 2 runIds.
      // (We assert "at least 2" rather than "exactly 3" because HEURISTIC_WINDOW_RUNS
      // caps at 20; for this fixture the window holds everything we appended.)
      expect(md).toMatch(/[2-9]\d*\s+run/);
    });
  });

  test("AC6 (boundary): single-run rollup still writes 'one run' in the header", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const runId = "current-run";

      // One historical observation from the SAME runId we're about to execute
      // as — the window collapses to that single runId.
      await appendToRollup([makeReviewFindingObs(runId)], rollupPath);

      const ctx = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId,
        projectKey: "test-project",
      });

      const postRunAction = curatorPlugin.extensions.postRunAction;
      await postRunAction?.execute(ctx);

      const md = await Bun.file(path.join(outputDir, "runs", runId, "curator-proposals.md")).text();
      expect(md).toMatch(/1\s+run/);
    });
  });

  test("AC8: empty rollup — header states one run and a window observation count equal to the current run's own count", async () => {
    await withTempDir(async (dir) => {
      const outputDir = path.join(dir, "out");
      const globalDir = path.join(dir, "global");
      const rollupPath = path.join(globalDir, "rollup.jsonl");
      const runId = "current-run";

      // Seed outputDir with metrics.json whose stories will produce a known
      // number of observations. The test is non-tautological only when the
      // current run has a NON-ZERO observation count: with all zeros, a broken
      // implementation that always reports "0 window observations" still
      // passes — exactly the bug the AC exists to catch.
      //
      // Seven stories → seven verdict observations on the collector path. We
      // capture the value of the window observation token directly rather
      // than just checking that "7" occurs somewhere, so the test fails if
      // the implementation ever lists the window count as 0 while the run
      // count is 7 — exactly AC8's bug.
      await mkdir(outputDir, { recursive: true });
      await writeFile(
        path.join(outputDir, "metrics.json"),
        JSON.stringify([
          {
            runId,
            feature: "feat-test",
            stories: Array.from({ length: 7 }, (_, i) => ({
              storyId: `US-${String(i + 1).padStart(3, "0")}`,
              success: true,
              attempts: 1,
              cost: 0,
            })),
          },
        ]),
      );

      const ctx = makePostRunContext({
        outputDir,
        globalDir,
        curatorRollupPath: rollupPath,
        runId,
        projectKey: "test-project",
      });

      const postRunAction = curatorPlugin.extensions.postRunAction;
      await postRunAction?.execute(ctx);

      const md = await Bun.file(path.join(outputDir, "runs", runId, "curator-proposals.md")).text();
      // Empty rollup, this run has 7 observations → fallback provenance is
      // { runCount: 1, observationCount: 7 } and the run's own observation
      // count is also 7. The header must carry 7 both as the window
      // observation count and as the run observation count. A header that
      // reports "1 run(s) · 0 window observation(s) · 7 run observation(s)"
      // would NOT satisfy AC8 — the window count must equal the run's own.
      expect(md).toMatch(/1\s+run/);
      // Match the window observation count token directly — a header that
      // lists the window count as 0 but the run count as 7 would pass a
      // naive `toContain("7")` check, but does not satisfy AC8. Capturing
      // the value rather than counting occurrences is robust against
      // unrelated "7" substrings in the rendered markdown.
      const windowMatch = md.match(/(\d+)\s+window observation/);
      expect(windowMatch?.[1]).toBe("7");
      const runMatch = md.match(/(\d+)\s+run observation/);
      expect(runMatch?.[1]).toBe("7");
    });
  });
});
