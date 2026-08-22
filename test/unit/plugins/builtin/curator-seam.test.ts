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
import { collectObservations, curatorPlugin, readHeuristicWindow } from "@/plugins/builtin/curator";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { runHeuristics } from "@/plugins/builtin/curator/heuristics";
import type { CuratorThresholds } from "@/plugins/builtin/curator/heuristics";
import { appendToRollup } from "@/plugins/builtin/curator/rollup";

const THRESHOLDS: CuratorThresholds = {
  repeatedFinding: 3,
  emptyKeyword: 2,
  rectifyAttempts: 3,
  escalationChain: 2,
  staleChunkRuns: 2,
  unchangedOutcome: 3,
};

const DEFECT = "Test asserts a pattern exists in the source file instead of invoking the code";

function makeContext(
  root: string,
  feature: string,
  runId: string,
  runStartedAt: number,
  projectKey = "p",
): CuratorPostRunContext {
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
    config: {} as any,
    outputDir: join(root, "out", projectKey),
    globalDir: join(root, "global"),
    projectKey,
    // One global rollup shared by every project — the production default (#1429).
    curatorRollupPath: join(root, "rollup.jsonl"),
    runStartedAt,
  };
}

/** One run over one feature, writing a review-audit entry the way production does. */
async function runOnce(root: string, feature: string, runId: string, file: string, when: string, projectKey = "p") {
  const dir = join(root, "out", projectKey, "review-audit", feature);
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
  const ctx = makeContext(root, feature, runId, Date.parse(when) - 60_000, projectKey);
  const observations = await collectObservations(ctx);
  await appendToRollup(observations, ctx.curatorRollupPath);
  return ctx;
}

/** The window as the plugin asks for it: scoped to the run's own project. */
async function windowFor(ctx: CuratorPostRunContext, runs: number) {
  return readHeuristicWindow(ctx.curatorRollupPath, runs, { projectKey: ctx.projectKey });
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

    const { observations: window } = await windowFor(ctx, 10);
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

    const { observations: window } = await windowFor(ctx, 10);
    expect(window.filter((o) => o.kind === "review-finding")).toHaveLength(2);
  });

  test("the window keeps only the most recent runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-seam-bound-"));
    let ctx = await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z");
    ctx = await runOnce(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z");
    ctx = await runOnce(root, "feat-c", "run-3", "src/c.ts", "2026-08-01T12:00:00.000Z");

    const { observations: window } = await windowFor(ctx, 2);
    const runs = new Set(window.map((o) => o.runId));
    expect(runs.has("run-1")).toBe(false);
    expect([...runs].sort()).toEqual(["run-2", "run-3"]);
  });

  test("a missing or empty rollup yields an empty window rather than throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-seam-empty-"));
    const opts = { projectKey: "p" };
    expect((await readHeuristicWindow(join(root, "nope.jsonl"), 5, opts)).observations).toEqual([]);
    const empty = join(root, "empty.jsonl");
    await writeFile(empty, "");
    expect((await readHeuristicWindow(empty, 5, opts)).observations).toEqual([]);
  });

  test("malformed rollup lines are skipped, not fatal", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-seam-malformed-"));
    const p = join(root, "rollup.jsonl");
    await writeFile(p, ["{not json", JSON.stringify(rollupRow("run-1", "p")), ""].join("\n"));
    const { observations } = await readHeuristicWindow(p, 5, { projectKey: "p" });
    expect(observations).toHaveLength(1);
  });
});

/** A minimal well-formed rollup row, for tests that write the rollup directly. */
function rollupRow(runId: string, projectKey: string | undefined, featureId = "f") {
  return {
    schemaVersion: 3,
    ...(projectKey !== undefined && { projectKey }),
    runId,
    featureId,
    storyId: "US-001",
    stage: "review",
    ts: "2026-08-01T10:00:00.000Z",
    kind: "verdict",
    payload: {},
  };
}

describe("the rollup is shared by every project (#1429)", () => {
  test("a project's window excludes another project's rows", async () => {
    // The production default is ONE global rollup for the whole machine, so
    // another repo's runs are interleaved with this one's in the same file.
    const root = await mkdtemp(join(tmpdir(), "curator-scope-window-"));
    await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z", "alpha");
    await runOnce(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z", "beta");
    const ctx = await runOnce(root, "feat-c", "run-3", "src/c.ts", "2026-08-01T12:00:00.000Z", "alpha");

    const { observations } = await windowFor(ctx, 20);
    expect(new Set(observations.map((o) => o.projectKey))).toEqual(new Set(["alpha"]));
    expect(new Set(observations.map((o) => o.runId))).toEqual(new Set(["run-1", "run-3"]));
  });

  test("H1 never counts a foreign project's features toward cross-feature recurrence", async () => {
    // The consequence that matters: a proposal written into alpha's run dir,
    // targeting alpha's .nax/rules/, grounded in beta's features and files.
    const root = await mkdtemp(join(tmpdir(), "curator-scope-h1-"));
    await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z", "alpha");
    await runOnce(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z", "beta");
    await runOnce(root, "feat-c", "run-3", "src/c.ts", "2026-08-01T12:00:00.000Z", "beta");
    const ctx = await runOnce(root, "feat-d", "run-4", "src/d.ts", "2026-08-01T13:00:00.000Z", "beta");

    const { observations } = await windowFor(ctx, 20);
    const h1 = runHeuristics(observations, THRESHOLDS).find((p) => p.id === "H1");
    // Three of beta's features, never alpha's — even though alpha's row sits in
    // the same file, inside the same window, carrying the same defect text.
    expect(h1?.description).toContain("3 features");
    expect(h1?.evidence).toContain("feat-b");
    expect(h1?.evidence).toContain("feat-d");
    expect(h1?.evidence).not.toContain("feat-a");
  });

  test("a run's own window still spans its own features", async () => {
    // Scoping must not over-correct into per-run isolation — that was #1428.
    const root = await mkdtemp(join(tmpdir(), "curator-scope-own-"));
    await runOnce(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z", "alpha");
    await runOnce(root, "feat-b", "run-2", "src/b.ts", "2026-08-01T11:00:00.000Z", "alpha");
    const ctx = await runOnce(root, "feat-c", "run-3", "src/c.ts", "2026-08-01T12:00:00.000Z", "alpha");

    const { observations } = await windowFor(ctx, 20);
    const h1 = runHeuristics(observations, THRESHOLDS).find((p) => p.id === "H1");
    expect(h1?.description).toContain("3 features");
  });

  test("rows written before project scoping are dropped, not attributed to the caller", async () => {
    // Pre-#1429 rows carry no projectKey and no way to recover one. Claiming
    // them would reintroduce exactly the contamination this fixes; they are
    // also the pre-#1427 rows inflated by whole-history re-ingestion.
    const root = await mkdtemp(join(tmpdir(), "curator-scope-legacy-"));
    const p = join(root, "rollup.jsonl");
    await writeFile(
      p,
      `${[rollupRow("old-1", undefined), rollupRow("new-1", "alpha")].map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    const { observations } = await readHeuristicWindow(p, 20, { projectKey: "alpha" });
    expect(observations.map((o) => o.runId)).toEqual(["new-1"]);
  });
});

describe("the window's byte ceiling must not masquerade as its run policy (#1429)", () => {
  /** A rollup whose rows are far larger than the initial tail read. */
  async function bigRollup(root: string, runs: number, padBytes: number): Promise<string> {
    const p = join(root, "rollup.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < runs; i += 1) {
      const row = rollupRow(`run-${i}`, "alpha", `feat-${i}`);
      lines.push(JSON.stringify({ ...row, payload: { pad: "x".repeat(padBytes) } }));
    }
    await writeFile(p, `${lines.join("\n")}\n`);
    return p;
  }

  test("reads further back when the initial tail holds fewer runs than requested", async () => {
    // On the real rollup an 8 MB tail held 2 runs, not the 20 configured. The
    // byte cap is a memory guard; it must not silently become the window size.
    const root = await mkdtemp(join(tmpdir(), "curator-window-expand-"));
    const p = await bigRollup(root, 10, 500);
    const { runIds, truncated } = await readHeuristicWindow(p, 10, {
      projectKey: "alpha",
      tailBytes: 600,
      maxTailBytes: 1024 * 1024,
    });
    expect(runIds).toHaveLength(10);
    expect(truncated).toBe(false);
  });

  test("reports the shortfall when the hard ceiling is reached", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-window-cap-"));
    const p = await bigRollup(root, 10, 500);
    const { runIds, truncated } = await readHeuristicWindow(p, 10, {
      projectKey: "alpha",
      tailBytes: 600,
      maxTailBytes: 1200,
    });
    expect(runIds.length).toBeLessThan(10);
    expect(truncated).toBe(true);
  });

  test("a degenerate byte bound terminates instead of spinning", async () => {
    // A zero tail reads nothing and doubles to zero — the growth loop must not
    // depend on the caller passing a sane starting size.
    const root = await mkdtemp(join(tmpdir(), "curator-window-zero-"));
    const p = await bigRollup(root, 3, 10);
    const { runIds } = await readHeuristicWindow(p, 5, { projectKey: "alpha", tailBytes: 0 });
    expect(runIds).toHaveLength(3);
  });

  test("counts rows belonging to no project, so an empty window is legible", async () => {
    // On an existing rollup pre-#1429 rows dominate: the window is empty while
    // the file is hundreds of MB. Without this count that looks like a bug.
    const root = await mkdtemp(join(tmpdir(), "curator-window-legacy-"));
    const p = join(root, "rollup.jsonl");
    const rows = [rollupRow("old-1", undefined), rollupRow("old-2", undefined), rollupRow("new-1", "alpha")];
    await writeFile(p, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const window = await readHeuristicWindow(p, 20, { projectKey: "alpha" });
    expect(window.runIds).toEqual(["new-1"]);
    expect(window.unattributedRows).toBe(2);
  });

  test("rows spanning a stream-chunk boundary survive intact", async () => {
    // The window reads its tail through the same streaming reader the prune
    // uses, so rows no longer arrive whole — a row can straddle two chunks.
    // Padding each row past any plausible chunk size forces that split; a
    // reader that lost the carry would drop or corrupt these rows silently.
    const root = await mkdtemp(join(tmpdir(), "curator-window-chunked-"));
    const p = await bigRollup(root, 6, 300_000);
    const { observations, runIds } = await readHeuristicWindow(p, 6, {
      projectKey: "alpha",
      maxTailBytes: 64 * 1024 * 1024,
    });
    expect(runIds).toHaveLength(6);
    expect(observations).toHaveLength(6);
    // Every payload is intact — a mid-chunk split would truncate one.
    for (const obs of observations) {
      expect((obs.payload as unknown as { pad: string }).pad).toHaveLength(300_000);
    }
  });

  test("a window that fits reports no truncation even when fewer runs exist than requested", async () => {
    // Exhausting the file is not truncation — there is simply no more history.
    const root = await mkdtemp(join(tmpdir(), "curator-window-short-"));
    const p = await bigRollup(root, 3, 10);
    const { runIds, truncated } = await readHeuristicWindow(p, 20, { projectKey: "alpha" });
    expect(runIds).toHaveLength(3);
    expect(truncated).toBe(false);
  });
});

describe("curator plugin — end to end", () => {
  /** Drive the real post-run action, as the runner does. */
  async function executeRun(
    root: string,
    feature: string,
    runId: string,
    file: string,
    when: string,
    projectKey = "p",
  ) {
    const dir = join(root, "out", projectKey, "review-audit", feature);
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
      ...makeContext(root, feature, runId, Date.parse(when) - 60_000, projectKey),
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
      } as any,
    };
    await curatorPlugin.extensions.postRunAction?.execute(ctx);
    return join(root, "out", projectKey, "runs", runId, "curator-proposals.md");
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

  test("a busy neighbour project cannot crowd out or contaminate this project's proposals", async () => {
    // alpha's three runs are interleaved with beta's, so an unscoped window
    // would cite beta's features as evidence for a rule written into alpha.
    const root = await mkdtemp(join(tmpdir(), "curator-plugin-neighbour-"));
    await executeRun(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z", "alpha");
    await executeRun(root, "beta-x", "run-2", "src/x.ts", "2026-08-01T10:30:00.000Z", "beta");
    await executeRun(root, "feat-b", "run-3", "src/b.ts", "2026-08-01T11:00:00.000Z", "alpha");
    await executeRun(root, "beta-y", "run-4", "src/y.ts", "2026-08-01T11:30:00.000Z", "beta");
    const proposalsPath = await executeRun(root, "feat-c", "run-5", "src/c.ts", "2026-08-01T12:00:00.000Z", "alpha");

    const markdown = await Bun.file(proposalsPath).text();
    expect(markdown).toContain("Recurring across 3 features");
    expect(markdown).not.toContain("beta-");
    expect(markdown).toContain("feat-a");
    expect(markdown).toContain("feat-c");
  });

  test("the first run of a project proposes nothing, rather than erroring", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-plugin-first-"));
    const proposalsPath = await executeRun(root, "feat-a", "run-1", "src/a.ts", "2026-08-01T10:00:00.000Z");
    const markdown = await Bun.file(proposalsPath).text();
    expect(markdown).toContain("Curator Proposals");
    expect(markdown).not.toContain("Recurring across");
  });
});
