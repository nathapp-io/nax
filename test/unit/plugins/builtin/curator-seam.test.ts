/**
 * The collector→heuristics seam.
 *
 * Both sides of this seam had green tests while the integration was broken:
 * heuristics tests fed multi-feature observation arrays straight to
 * `runHeuristics`, and collector tests checked which observations came back
 * without ever running heuristics on them. Nothing asserted what the heuristics
 * actually receive in production.
 *
 * The regression: collection is run-scoped (one run = one feature), so a run's
 * own observations can only ever contain ONE featureId — while H1 thresholds on
 * DISTINCT features. H1 could never fire. Cross-feature recurrence needs
 * cross-run input, which is what the rollup is for.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectObservations, curatorPlugin, readHeuristicWindow } from "../../../../src/plugins/builtin/curator";
import type { CuratorPostRunContext } from "../../../../src/plugins/builtin/curator";
import { runHeuristics } from "../../../../src/plugins/builtin/curator/heuristics";
import type { CuratorThresholds } from "../../../../src/plugins/builtin/curator/heuristics";
import { appendToRollup } from "../../../../src/plugins/builtin/curator/rollup";

const THRESHOLDS: CuratorThresholds = {
  repeatedFinding: 3,
  emptyKeyword: 2,
  rectifyAttempts: 3,
  escalationChain: 2,
  staleChunkRuns: 2,
  unchangedOutcome: 3,
};

const DEFECT = "Test asserts a pattern exists in the source file instead of invoking the code";

function makeContext(root: string, feature: string, runId: string, runStartedAt: number): CuratorPostRunContext {
  return {
    runId,
    feature,
    workdir: join(root, "work"),
    prdPath: "",
    branch: "main",
    totalDurationMs: 1,
    totalCost: 0,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    // biome-ignore lint/suspicious/noExplicitAny: collector reads no config keys on this path
    config: {} as any,
    outputDir: join(root, "out"),
    globalDir: join(root, "global"),
    projectKey: "p",
    curatorRollupPath: join(root, "rollup.jsonl"),
    runStartedAt,
  };
}

/** One run over one feature, writing a review-audit entry the way production does. */
async function runOnce(root: string, feature: string, runId: string, file: string, when: string) {
  const dir = join(root, "out", "review-audit", feature);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${runId}.json`),
    JSON.stringify({
      timestamp: when,
      storyId: "US-001",
      featureName: feature,
      result: {
        findings: [{ rule: "test-gap:x", category: "test-gap", severity: "error", file, line: 1, message: DEFECT }],
      },
    }),
  );
  const ctx = makeContext(root, feature, runId, Date.parse(when) - 60_000);
  const observations = await collectObservations(ctx);
  await appendToRollup(observations, ctx.curatorRollupPath);
  return ctx;
}

describe("collector → heuristics seam", () => {
  test("a single run's own observations carry exactly one featureId", async () => {
    // This is the fact that made H1 unfireable on run-scoped input. Pinning it
    // so nobody 'fixes' H1 by feeding it a single run again.
    const root = await mkdtemp(join(tmpdir(), "curator-seam-single-"));
    const ctx = await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T12:05:00.000Z");
    const observations = await collectObservations(ctx);
    const features = new Set(observations.filter((o) => o.kind === "review-finding").map((o) => o.featureId));
    expect([...features]).toEqual(["feat-a"]);
    expect(runHeuristics(observations, THRESHOLDS).filter((p) => p.id === "H1")).toHaveLength(0);
  });

  test("H1 fires on the accumulated window across runs and features", async () => {
    // The scenario the whole heuristic exists for: the same defect recurring in
    // three separate features, each its own run, each touching its own file.
    const root = await mkdtemp(join(tmpdir(), "curator-seam-window-"));
    let ctx = await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z");
    ctx = await runOnce(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z");
    ctx = await runOnce(root, "feat-c", "run-3", "src/c.ts", "2026-08-01T12:00:00.000Z");

    const window = await readHeuristicWindow(ctx.curatorRollupPath, 10);
    const features = new Set(window.filter((o) => o.kind === "review-finding").map((o) => o.featureId));
    expect([...features].sort()).toEqual(["feat-a", "feat-b", "feat-c"]);

    const h1 = runHeuristics(window, THRESHOLDS).find((p) => p.id === "H1");
    expect(h1).toBeDefined();
    expect(h1?.description).toContain("3 features");
  });

  test("each run contributes its findings to the window exactly once", async () => {
    // Run-scoped collection is what makes the window trustworthy: before it, a
    // run re-ingested the whole audit directory and every earlier finding was
    // appended again under a new runId.
    const root = await mkdtemp(join(tmpdir(), "curator-seam-once-"));
    let ctx = await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z");
    ctx = await runOnce(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z");

    const window = await readHeuristicWindow(ctx.curatorRollupPath, 10);
    expect(window.filter((o) => o.kind === "review-finding")).toHaveLength(2);
  });

  test("the window keeps only the most recent runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-seam-bound-"));
    let ctx = await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z");
    ctx = await runOnce(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z");
    ctx = await runOnce(root, "feat-c", "run-3", "src/c.ts", "2026-08-01T12:00:00.000Z");

    const window = await readHeuristicWindow(ctx.curatorRollupPath, 2);
    const runs = new Set(window.map((o) => o.runId));
    expect(runs.has("run-1")).toBe(false);
    expect([...runs].sort()).toEqual(["run-2", "run-3"]);
  });

  test("a missing or empty rollup yields an empty window rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-seam-empty-"));
    expect(await readHeuristicWindow(join(root, "nope.jsonl"), 5)).toEqual([]);
    const empty = join(root, "empty.jsonl");
    await writeFile(empty, "");
    expect(await readHeuristicWindow(empty, 5)).toEqual([]);
  });

  test("malformed rollup lines are skipped, not fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-seam-malformed-"));
    const p = join(root, "rollup.jsonl");
    await writeFile(
      p,
      [
        "{not json",
        JSON.stringify({
          schemaVersion: 2,
          runId: "run-1",
          featureId: "f",
          storyId: "s",
          stage: "review",
          ts: "t",
          kind: "verdict",
          payload: {},
        }),
        "",
      ].join("\n"),
    );
    const window = await readHeuristicWindow(p, 5);
    expect(window).toHaveLength(1);
  });
});

describe("curator plugin — end to end", () => {
  /** Drive the real post-run action, as the runner does. */
  async function executeRun(root: string, feature: string, runId: string, file: string, when: string) {
    const dir = join(root, "out", "review-audit", feature);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${runId}.json`),
      JSON.stringify({
        timestamp: when,
        storyId: "US-001",
        featureName: feature,
        result: {
          findings: [{ rule: "test-gap:x", category: "test-gap", severity: "error", file, line: 1, message: DEFECT }],
        },
      }),
    );
    const ctx = {
      ...makeContext(root, feature, runId, Date.parse(when) - 60_000),
      config: {
        curator: {
          enabled: true,
          thresholds: {
            repeatedFinding: 3,
            emptyKeyword: 2,
            rectifyAttempts: 3,
            escalationChain: 2,
            staleChunkRuns: 2,
            unchangedOutcome: 3,
          },
        },
        // biome-ignore lint/suspicious/noExplicitAny: partial config is all this path reads
      } as any,
    };
    await curatorPlugin.extensions.postRunAction?.execute(ctx);
    return join(root, "out", "runs", runId, "curator-proposals.md");
  }

  test("three runs over three features produce one cross-feature proposal", async () => {
    // The regression this file exists for: everything below passed its own unit
    // tests while the assembled pipeline emitted nothing.
    const root = await mkdtemp(join(tmpdir(), "curator-plugin-e2e-"));
    await executeRun(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z");
    await executeRun(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z");
    const proposalsPath = await executeRun(root, "feat-c", "run-3", "src/c.ts", "2026-08-01T12:00:00.000Z");

    const markdown = await Bun.file(proposalsPath).text();
    expect(markdown).toContain("Recurring across 3 features");
    expect(markdown).toContain("feat-a");
    expect(markdown).toContain("feat-c");
    // Files differ per feature; they are evidence, never identity.
    expect(markdown).toContain("src/a.ts");
  });

  test("the first run of a project proposes nothing, rather than erroring", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-plugin-first-"));
    const proposalsPath = await executeRun(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z");
    const markdown = await Bun.file(proposalsPath).text();
    expect(markdown).toContain("Curator Proposals");
    expect(markdown).not.toContain("Recurring across");
  });
});
