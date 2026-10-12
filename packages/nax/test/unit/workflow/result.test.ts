import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { loadPriorStoryRecord, newStoryRecord, readResult, upsertStoryRecord } from "@/workflow/result";

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
