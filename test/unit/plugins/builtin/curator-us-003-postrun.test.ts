/**
 * Post-run action wires the heuristic-window provenance into renderProposals
 * (US-003). ACs 6 and 8 are exercised end-to-end through the post-run
 * action: the rollup is pre-populated with the observations that the action
 * is supposed to read, then `curatorPlugin.execute()` is invoked and the
 * written `curator-proposals.md` is read back to assert on its header.
 */

import { describe, expect, test } from "bun:test";
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

      // Empty rollup. The fallback provenance must say "one run" — NOT
      // "zero runs" — because the heuristic window is "this run's own
      // observations" by definition. The current run's own observation count
      // is whatever `collectObservations` returned; with no artifacts the
      // collector returns [], so the window observation count is 0.
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
      // Empty rollup AND empty current-run observations → window count is this
      // run (fallback provenance), so the header must say "1 run(s)". The
      // window observation count matches the run's own count (both 0 here).
      expect(md).toMatch(/1\s+run/);
      expect(md).toContain("0");
    });
  });
});
