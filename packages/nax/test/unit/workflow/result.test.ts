import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, withTempDir } from "@test/helpers";
import { newFeatureRecord } from "@/workflow/feature-record";
import {
  loadPriorStoryRecord,
  newStoryRecord,
  readResult,
  runDirsNewestFirst,
  upsertFeatureRecord,
  upsertStoryRecord,
  writePreflightTokens,
} from "@/workflow/result";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});
const header = (runId: string) => ({ runId, feature: "feat-a" });

describe("workflow result.json", () => {
  test("upsert creates, then replaces one story without touching others", async () => {
    const run = makeTempDir("wf-result-");
    dirs.push(run);
    const a = newStoryRecord("US-001", 5, "2026-10-12T00:00:00.000Z");
    const b = newStoryRecord("US-002", 5, "2026-10-12T00:00:00.000Z");
    await upsertStoryRecord(run, header("run-1"), a);
    await upsertStoryRecord(run, header("run-1"), b);
    await upsertStoryRecord(run, header("run-1"), { ...a, round: 2, phase: "fix" });
    const file = await readResult(run);
    expect(file?.schemaVersion).toBe(1);
    expect(file?.stories["US-001"]?.round).toBe(2);
    expect(file?.stories["US-002"]?.phase).toBe("implement");
  });

  test("readResult returns null for a missing or corrupt file", async () => {
    const run = makeTempDir("wf-result-");
    dirs.push(run);
    expect(await readResult(run)).toBeNull();
    await Bun.write(join(run, "result.json"), "{not json");
    expect(await readResult(run)).toBeNull();
  });

  test("loadPriorStoryRecord: newest other run, unfinished records only", async () => {
    const feature = makeTempDir("wf-feature-");
    dirs.push(feature);
    const older = join(feature, "run-old");
    const newer = join(feature, "run-new");
    const current = join(feature, "run-now");
    await Promise.all([older, newer, current].map((d) => mkdir(d, { recursive: true })));
    const base = newStoryRecord("US-003", 5, "2026-10-12T00:00:00.000Z");
    await upsertStoryRecord(older, header("run-old"), { ...base, round: 1, phase: "fix" });
    await upsertStoryRecord(newer, header("run-new"), { ...base, round: 3, phase: "rereview" });
    await upsertStoryRecord(current, header("run-now"), base);
    await utimes(join(older, "result.json"), new Date(1000), new Date(1000));
    await utimes(join(newer, "result.json"), new Date(2000), new Date(2000));

    expect((await loadPriorStoryRecord(feature, "run-now", "US-003"))?.round).toBe(3);

    await upsertStoryRecord(newer, header("run-new"), { ...base, round: 3, state: "complete", phase: "closed" });
    // The newest prior run finished the story: nothing to resume, even though an older run did not.
    expect(await loadPriorStoryRecord(feature, "run-now", "US-003")).toBeNull();
    expect(await loadPriorStoryRecord(feature, "run-now", "US-999")).toBeNull();
  });
});

describe("feature record in result.json (P4-R1)", () => {
  test("upsertFeatureRecord keeps the story records; upsertStoryRecord keeps the feature record", async () => {
    const run = makeTempDir("wf-result-");
    dirs.push(run);
    await upsertStoryRecord(run, header("run-1"), newStoryRecord("US-001", 5, "t"));
    const feature = newFeatureRecord({ now: "t", seed: "s0", minors: [] });
    await upsertFeatureRecord(run, header("run-1"), feature);
    expect((await readResult(run))?.stories["US-001"]).toBeDefined();
    await upsertStoryRecord(run, header("run-1"), { ...newStoryRecord("US-001", 5, "t"), round: 2 });
    const file = await readResult(run);
    expect(file?.featureWorkflow?.seed).toBe("s0");
    expect(file?.stories["US-001"]?.round).toBe(2);
  });

  test("runDirsNewestFirst orders run dirs by result.json mtime and skips dirs without one", async () => {
    const feature = makeTempDir("wf-feature-");
    dirs.push(feature);
    for (const [name, secs] of [
      ["run-a", 100],
      ["run-b", 300],
      ["run-c", 200],
    ] as const) {
      await upsertStoryRecord(join(feature, name), header(name), newStoryRecord("US-001", 5, "t"));
      await utimes(join(feature, name, "result.json"), secs, secs);
    }
    await mkdir(join(feature, "not-a-run"), { recursive: true });
    expect(await runDirsNewestFirst(feature)).toEqual(["run-b", "run-c", "run-a"].map((n) => join(feature, n)));
  });
});

describe("verdict in result.json (#2496)", () => {
  test("upsertFeatureRecord writes a top-level verdict once the outcome is set; story upserts keep it (#2496)", async () => {
    await withTempDir(async (runDir) => {
      const record = {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        outcome: "draft" as const,
        passed: true,
        reasons: ["r"],
      };
      await upsertFeatureRecord(runDir, { runId: "r1", feature: "f" }, record);
      await upsertStoryRecord(runDir, { runId: "r1", feature: "f" }, newStoryRecord("US-001", 3, "t"));
      const file = await readResult(runDir);
      expect(file?.verdict).toEqual({ workflowPassed: true, outcome: "draft", reasons: ["r"], openItems: [] });
    });
  });
});

/** US-004: the pre-flight's role totals are written by the pre-flight and must survive every later write. */
describe("pre-flight tokens in result.json (US-004)", () => {
  const PREFLIGHT = { advisor: { inputTokens: 10, outputTokens: 5, costUsd: 0.3, calls: 1 } };

  test("writePreflightTokens creates the file, then a second write keeps the story records", async () => {
    await withTempDir(async (runDir) => {
      await writePreflightTokens(runDir, { runId: "r1", feature: "f" }, PREFLIGHT);
      await upsertStoryRecord(runDir, { runId: "r1", feature: "f" }, newStoryRecord("US-001", 3, "t"));
      const file = await readResult(runDir);
      expect(file?.preflightTokensByRole).toEqual(PREFLIGHT);
      expect(file?.stories["US-001"]?.storyId).toBe("US-001");
      expect(file?.schemaVersion).toBe(1);
    });
  });

  test("writePreflightTokens keeps the feature record and the verdict an earlier write left", async () => {
    await withTempDir(async (runDir) => {
      await upsertStoryRecord(runDir, { runId: "r1", feature: "f" }, newStoryRecord("US-001", 3, "t"));
      await upsertFeatureRecord(
        runDir,
        { runId: "r1", feature: "f" },
        {
          ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
          outcome: "draft" as const,
          passed: true,
          reasons: ["r"],
        },
      );
      await writePreflightTokens(runDir, { runId: "r1", feature: "f" }, PREFLIGHT);
      const file = await readResult(runDir);
      expect(file?.preflightTokensByRole).toEqual(PREFLIGHT);
      expect(file?.featureWorkflow?.seed).toBe("s");
      expect(file?.verdict?.outcome).toBe("draft");
    });
  });

  test("AC-4: upsertStoryRecord keeps preflightTokensByRole unchanged", async () => {
    await withTempDir(async (runDir) => {
      await writePreflightTokens(runDir, { runId: "r1", feature: "f" }, PREFLIGHT);
      await upsertStoryRecord(runDir, { runId: "r1", feature: "f" }, newStoryRecord("US-001", 3, "t"));
      expect((await readResult(runDir))?.preflightTokensByRole).toEqual(PREFLIGHT);
    });
  });

  test("AC-5: upsertFeatureRecord keeps preflightTokensByRole unchanged", async () => {
    await withTempDir(async (runDir) => {
      await writePreflightTokens(runDir, { runId: "r1", feature: "f" }, PREFLIGHT);
      await upsertFeatureRecord(
        runDir,
        { runId: "r1", feature: "f" },
        newFeatureRecord({ now: "t", seed: "s", minors: [] }),
      );
      expect((await readResult(runDir))?.preflightTokensByRole).toEqual(PREFLIGHT);
    });
  });
});
