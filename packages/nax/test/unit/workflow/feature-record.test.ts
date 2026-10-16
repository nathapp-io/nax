import { afterEach, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir, makeTestPRD, makeTestStory } from "@test/helpers";
import {
  collectStoryRecords,
  loadPriorFeature,
  minorsFrom,
  newestPreflight,
  newFeatureRecord,
  summariseStories,
} from "@/workflow/feature-record";
import { preflightPath } from "@/workflow/preflight";
import { newStoryRecord, upsertFeatureRecord, upsertStoryRecord } from "@/workflow/result";
import type { WorkflowStoryRecord } from "@/workflow/types";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

const header = (runId: string) => ({ runId, feature: "f" });
const closed = (id: string, over: Partial<WorkflowStoryRecord> = {}): WorkflowStoryRecord => ({
  ...newStoryRecord(id, 5, "t"),
  state: "complete",
  reason: "clean",
  phase: "closed",
  ...over,
});

async function writeRun(
  featureDir: string,
  runId: string,
  secs: number,
  records: WorkflowStoryRecord[],
): Promise<string> {
  const runDir = join(featureDir, runId);
  for (const r of records) await upsertStoryRecord(runDir, header(runId), r);
  await utimes(join(runDir, "result.json"), secs, secs);
  return runDir;
}

describe("collectStoryRecords (P4-R2)", () => {
  test("newest run wins per story; each record keeps its run dir", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const old = await writeRun(feature, "run-1", 100, [closed("US-001", { round: 1 }), closed("US-002")]);
    const fresh = await writeRun(feature, "run-2", 200, [closed("US-001", { round: 3 })]);
    const records = await collectStoryRecords(feature);
    expect(records["US-001"]?.record.round).toBe(3);
    expect(records["US-001"]?.runDir).toBe(fresh);
    expect(records["US-002"]?.runDir).toBe(old);
  });

  test("a missing feature dir is empty", async () => {
    expect(await collectStoryRecords("/nonexistent/wf")).toEqual({});
  });
});

describe("summariseStories", () => {
  test("record states, passed-without-record = complete, everything else not-run", () => {
    const prd = makeTestPRD([
      makeTestStory({ id: "US-001", title: "A" }),
      makeTestStory({ id: "US-002", title: "B", status: "passed", passes: true }),
      makeTestStory({ id: "US-003", title: "C" }),
      makeTestStory({ id: "US-004", title: "D" }),
    ]);
    const summaries = summariseStories(prd, {
      "US-001": {
        record: closed("US-001", { state: "complete-gate-open", reason: "red: lint", round: 2, flagged: 1 }),
        runDir: "/r1",
      },
      "US-004": { record: { ...newStoryRecord("US-004", 5, "t"), phase: "fix", round: 1 }, runDir: "/r1" },
    });
    expect(summaries).toEqual([
      {
        id: "US-001",
        title: "A",
        state: "complete-gate-open",
        reason: "red: lint",
        rounds: 2,
        unreviewed: false,
        flagged: 1,
        runDir: "/r1",
      },
      {
        id: "US-002",
        title: "B",
        state: "complete",
        reason: "passed earlier, no workflow record",
        rounds: 0,
        unreviewed: false,
        flagged: 0,
      },
      { id: "US-003", title: "C", state: "not-run", rounds: 0, unreviewed: false, flagged: 0 },
      { id: "US-004", title: "D", state: "not-run", rounds: 1, unreviewed: false, flagged: 0 },
    ]);
  });
});

describe("loadPriorFeature (P4-R1)", () => {
  test("the newest OTHER run's feature record; the current run is ignored", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const r1 = await writeRun(feature, "run-1", 100, [closed("US-001")]);
    await upsertFeatureRecord(r1, header("run-1"), {
      ...newFeatureRecord({ now: "t", seed: "s1", minors: [] }),
      step: "branch-fix",
    });
    await utimes(join(r1, "result.json"), 100, 100);
    const r2 = await writeRun(feature, "run-2", 200, [closed("US-001")]);
    await upsertFeatureRecord(r2, header("run-2"), newFeatureRecord({ now: "t", seed: "s2", minors: [] }));
    await utimes(join(r2, "result.json"), 200, 200);
    expect((await loadPriorFeature(feature, "run-2"))?.step).toBe("branch-fix");
    expect((await loadPriorFeature(feature, "run-9"))?.seed).toBe("s2");
  });

  test("a malformed feature record is ignored", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const r1 = await writeRun(feature, "run-1", 100, [closed("US-001")]);
    const file = await Bun.file(join(r1, "result.json")).json();
    await Bun.write(join(r1, "result.json"), JSON.stringify({ ...file, featureWorkflow: { step: "teleport" } }));
    expect(await loadPriorFeature(feature, "run-2")).toBeNull();
  });

  test("a record without a numeric nextFindingId is ignored", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const r1 = await writeRun(feature, "run-1", 100, [closed("US-001")]);
    const file = await Bun.file(join(r1, "result.json")).json();
    const noId = { ...newFeatureRecord({ now: "t", seed: "s", minors: [] }), nextFindingId: undefined };
    await Bun.write(join(r1, "result.json"), JSON.stringify({ ...file, featureWorkflow: noId }));
    expect(await loadPriorFeature(feature, "run-2")).toBeNull();
  });
});

describe("minorsFrom and newestPreflight", () => {
  test("minors get M ids in order and start as leave", () => {
    expect(
      minorsFrom([
        { storyId: "US-001", text: "a" },
        { storyId: "US-002", text: "b" },
      ]),
    ).toEqual([
      { id: "M1", storyId: "US-001", text: "a", triage: "leave" },
      { id: "M2", storyId: "US-002", text: "b", triage: "leave" },
    ]);
  });

  test("newestPreflight returns the newest reusable preflight.json, skipping failed ones", async () => {
    const feature = makeTempDir("wf-fr-");
    dirs.push(feature);
    const good = await writeRun(feature, "run-1", 100, [closed("US-001")]);
    const failed = await writeRun(feature, "run-2", 200, [closed("US-001")]);
    await Bun.write(
      preflightPath(good),
      JSON.stringify({ schemaVersion: 1, storyIds: ["US-001"], overlap: [], conflicts: [] }),
    );
    await Bun.write(
      preflightPath(failed),
      JSON.stringify({
        schemaVersion: 1,
        storyIds: ["US-001"],
        overlap: [],
        conflicts: [],
        fallbackReason: "all models failed",
      }),
    );
    expect((await newestPreflight(feature))?.path).toBe(preflightPath(good));
  });
});
