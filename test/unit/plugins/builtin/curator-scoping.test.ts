/**
 * Curator collection scoping (#1422) and chunk-token accounting (#1421).
 *
 * Split from curator-collector.test.ts, which crossed the 800-line test limit.
 * Concern: WHICH artifacts a run collects, rather than how they are projected.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeNaxConfig } from "@test/helpers";
import type { CuratorPostRunContext } from "@/plugins/builtin/curator";
import { collectObservations } from "@/plugins/builtin/curator";

/** Minimal context pointing the collector at a temp workdir. */
function makeContext(root: string, workdir: string): CuratorPostRunContext {
  return {
    runId: "run-scope",
    feature: "feat-auth",
    workdir,
    prdPath: join(workdir, ".nax", "features", "feat-auth", "prd.json"),
    branch: "main",
    totalDurationMs: 1000,
    totalCost: 10,
    storySummary: { completed: 1, failed: 0, skipped: 0, paused: 0 },
    stories: [],
    version: "0.1.0",
    pluginConfig: {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    config: makeNaxConfig(),
    outputDir: join(root, "out"),
    globalDir: join(root, "global"),
    projectKey: "test-project",
    curatorRollupPath: join(root, "rollup.jsonl"),
  };
}

describe("collectObservations — run scoping", () => {
  test("collects only review-audit entries from THIS run when runStartedAt is set (#1422)", async () => {
    // Curator counts must mean "this run". Re-reading the whole accumulated
    // audit directory made every count monotonically increasing, so a
    // threshold-based proposal tripped once and could never clear.
    const root = await mkdtemp(join(tmpdir(), "curator-run-scope-"));
    const outputDir = join(root, "out");
    const auditDir = join(outputDir, "review-audit", "feat-auth");
    await mkdir(auditDir, { recursive: true });

    const runStartedAt = Date.parse("2026-08-01T12:00:00.000Z");
    await writeFile(
      join(auditDir, "old.json"),
      JSON.stringify({
        timestamp: "2026-07-15T09:00:00.000Z",
        storyId: "US-001",
        featureName: "feat-auth",
        result: { findings: [{ rule: "stale-finding", severity: "error", file: "src/a.ts", line: 1, message: "old" }] },
      }),
    );
    await writeFile(
      join(auditDir, "current.json"),
      JSON.stringify({
        timestamp: "2026-08-01T12:05:00.000Z",
        storyId: "US-002",
        featureName: "feat-auth",
        result: { findings: [{ rule: "fresh-finding", severity: "error", file: "src/b.ts", line: 2, message: "new" }] },
      }),
    );

    const observations = await collectObservations({
      ...makeContext(root, join(root, "work")),
      outputDir,
      runStartedAt,
    });
    const rules = observations.filter((o) => o.kind === "review-finding").map((o) => o.payload.ruleId);
    expect(rules).toContain("fresh-finding");
    expect(rules).not.toContain("stale-finding");
  });

  test("ignores a concurrent run's entries for a DIFFERENT feature (#1422)", async () => {
    // Two `nax run` invocations share outputDir. The other run's entries land
    // inside this run's time window and would inflate H1's distinct-feature
    // count with work this run never saw. Run identity cannot be used: the
    // audit's runId is the runtime's UUID, context.runId is `run-<iso>`.
    const root = await mkdtemp(join(tmpdir(), "curator-concurrent-"));
    const outputDir = join(root, "out");
    await mkdir(join(outputDir, "review-audit", "feat-auth"), { recursive: true });
    await mkdir(join(outputDir, "review-audit", "feat-billing"), { recursive: true });

    const entry = (feature: string, rule: string) =>
      JSON.stringify({
        timestamp: "2026-08-01T12:05:00.000Z",
        storyId: "US-001",
        featureName: feature,
        result: { findings: [{ rule, severity: "error", file: "src/a.ts", line: 1, message: "x" }] },
      });
    await writeFile(join(outputDir, "review-audit", "feat-auth", "a.json"), entry("feat-auth", "mine"));
    await writeFile(join(outputDir, "review-audit", "feat-billing", "b.json"), entry("feat-billing", "theirs"));

    const observations = await collectObservations({
      ...makeContext(root, join(root, "work")),
      feature: "feat-auth",
      outputDir,
      runStartedAt: Date.parse("2026-08-01T12:00:00.000Z"),
    });
    const rules = observations.filter((o) => o.kind === "review-finding").map((o) => o.payload.ruleId);
    expect(rules).toContain("mine");
    expect(rules).not.toContain("theirs");
  });

  test("observations are stamped with the current schema version and their project", async () => {
    // schemaVersion 1 rows in the append-only global rollup are cumulative and
    // not comparable to these; longitudinal analysis must be able to tell them
    // apart. Version 3 adds projectKey — without it a row in the shared global
    // rollup cannot be attributed to the repo that produced it (#1429).
    const root = await mkdtemp(join(tmpdir(), "curator-schema-"));
    const outputDir = join(root, "out");
    const auditDir = join(outputDir, "review-audit", "feat-auth");
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, "a.json"),
      JSON.stringify({
        timestamp: "2026-08-01T12:05:00.000Z",
        storyId: "US-001",
        featureName: "feat-auth",
        result: { findings: [{ rule: "r", severity: "error", file: "src/a.ts", line: 1, message: "x" }] },
      }),
    );

    const observations = await collectObservations({
      ...makeContext(root, join(root, "work")),
      feature: "feat-auth",
      outputDir,
      runStartedAt: Date.parse("2026-08-01T12:00:00.000Z"),
    });
    expect(observations.length).toBeGreaterThan(0);
    for (const o of observations) {
      expect(o.schemaVersion).toBe(3);
      expect(o.projectKey).toBe("test-project");
    }
  });

  test("collects everything when runStartedAt is absent (back-compat)", async () => {
    const root = await mkdtemp(join(tmpdir(), "curator-no-scope-"));
    const outputDir = join(root, "out");
    const auditDir = join(outputDir, "review-audit", "feat-auth");
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, "old.json"),
      JSON.stringify({
        timestamp: "2026-07-15T09:00:00.000Z",
        storyId: "US-001",
        featureName: "feat-auth",
        result: { findings: [{ rule: "stale-finding", severity: "error", file: "src/a.ts", line: 1, message: "old" }] },
      }),
    );

    const observations = await collectObservations({ ...makeContext(root, join(root, "work")), outputDir });
    expect(observations.filter((o) => o.kind === "review-finding")).toHaveLength(1);
  });

  test("an audit entry with no timestamp is kept rather than silently dropped (#1422)", async () => {
    // Dropping undated entries would hide real findings; keeping them only risks
    // a stale count, which is the pre-existing behaviour.
    const root = await mkdtemp(join(tmpdir(), "curator-undated-"));
    const outputDir = join(root, "out");
    const auditDir = join(outputDir, "review-audit", "feat-auth");
    await mkdir(auditDir, { recursive: true });
    await writeFile(
      join(auditDir, "undated.json"),
      JSON.stringify({
        storyId: "US-001",
        featureName: "feat-auth",
        result: { findings: [{ rule: "undated-finding", severity: "error", file: "src/a.ts", line: 1, message: "x" }] },
      }),
    );

    const observations = await collectObservations({
      ...makeContext(root, join(root, "work")),
      outputDir,
      runStartedAt: Date.parse("2026-08-01T12:00:00.000Z"),
    });
    expect(observations.filter((o) => o.kind === "review-finding")).toHaveLength(1);
  });

  test("skips context manifests untouched by this run (#1422)", async () => {
    // Manifests persist per story across runs; a run that touches US-002 must
    // not re-report US-001's chunks as if it had assembled them.
    const root = await mkdtemp(join(tmpdir(), "curator-manifest-scope-"));
    const workdir = join(root, "work");
    const stories = join(workdir, ".nax", "features", "feat-auth", "stories");
    await mkdir(join(stories, "US-001"), { recursive: true });
    await mkdir(join(stories, "US-002"), { recursive: true });

    const manifest = (chunk: string) =>
      JSON.stringify({
        stage: "review",
        includedChunks: [chunk],
        excludedChunks: [],
        providerResults: [],
        chunkTokens: { [chunk]: 100 },
      });
    const stalePath = join(stories, "US-001", "context-manifest-review.json");
    const freshPath = join(stories, "US-002", "context-manifest-review.json");
    await writeFile(stalePath, manifest("stale:chunk"));
    await writeFile(freshPath, manifest("fresh:chunk"));

    // Both mtimes are set explicitly relative to a fixed window. Deriving the
    // window from Date.now() AFTER the write raced the filesystem clock: the
    // fresh manifest landed a millisecond early roughly 1 run in 120.
    const runStartedAt = Date.now();
    const before = new Date(runStartedAt - 86_400_000);
    const after = new Date(runStartedAt + 1_000);
    await utimes(stalePath, before, before);
    await utimes(freshPath, after, after);

    const observations = await collectObservations({ ...makeContext(root, workdir), runStartedAt });
    const chunkIds = observations.filter((o) => o.kind === "chunk-included").map((o) => o.payload.chunkId);
    expect(chunkIds).toContain("fresh:chunk");
    expect(chunkIds).not.toContain("stale:chunk");
  });
});
