import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeTempDir } from "@test/helpers";
import * as reader from "@/chat/workflow/feature-state";
import { featureDir, featuresDir } from "@/config";
import { NaxError } from "@/errors";
import type { LoadedRun } from "@/workflow/run-verdict";
import type { WorkflowFeatureRecord } from "@/workflow/types";

const originalDeps = { ...reader._featureStateDeps };
let options: reader.FeatureStateOptions;
function loaded(count = 2, record: Partial<WorkflowFeatureRecord> = {}): LoadedRun {
  return {
    runId: "w1",
    runDir: "unused",
    result: { schemaVersion: 1, runId: "w1", feature: "f1", stories: {} },
    record: {
      step: "done",
      startedAt: "2026-10-01",
      seed: null,
      gateFindings: [],
      reviewRan: true,
      reviewOpen: [],
      minors: [],
      newMinors: [],
      nextFindingId: 1,
      fixRan: false,
      rulings: [],
      reasons: [],
      timings: {},
      tokensByRole: {},
      url: "https://example.test/pr/7",
      ...record,
    },
    openItems: Array.from({ length: count }, (_, i) => ({ kind: "finding", id: `F${i + 1}`, issue: "fix this" })),
    reasons: [],
    supplementaryItems: [],
  };
}
function loader(fn: typeof reader._featureStateDeps.loadRunVerdict) {
  return Object.assign(reader._featureStateDeps, { loadRunVerdict: mock(fn) }).loadRunVerdict;
}
beforeEach(() => {
  const repoRoot = makeTempDir("workflow-state-");
  options = { repoRoot, outputDir: join(repoRoot, "output"), maxIterations: 10 };
  loader(async () => loaded());
  reader._featureStateDeps.git = mock(async () => ({ exitCode: 1, stdout: "", stderr: "" }));
});
afterEach(() => {
  Object.assign(reader._featureStateDeps, originalDeps);
  cleanupTempDir(options.repoRoot);
});

describe("readFeatureState", () => {
  test("AC-1 calls the loader with repo root, name and output resolver", async () => {
    const load = loader(async () => loaded());
    await reader.readFeatureState("f1", options);
    expect(load).toHaveBeenCalledTimes(1);
    const args = load.mock.calls[0];
    expect(args?.slice(0, 2)).toEqual([options.repoRoot, "f1"]);
    expect(args).toBeDefined();
    expect(await args?.[2](options.repoRoot)).toBe(options.outputDir);
  });
  test("AC-2 AC-3 projects the workflow and formats open items", async () => {
    const workflow = (await reader.readFeatureState("f1", options)).workflow;
    expect(
      workflow && { runId: workflow.runId, step: workflow.step, url: workflow.url, openItems: workflow.openItems },
    ).toEqual({ runId: "w1", step: "done", url: "https://example.test/pr/7", openItems: 2 });
    expect(workflow?.firstOpenItems[0]).toBe("[finding] F1 — fix this");
  });
  test("AC-4 AC-5 caps displayed items without truncating the count", async () => {
    loader(async () => loaded(7));
    const workflow = (await reader.readFeatureState("f1", options)).workflow;
    expect(workflow?.firstOpenItems).toHaveLength(5);
    expect(workflow?.openItems).toBe(7);
  });
  test("AC-6 AC-8 projects outcome and CI", async () => {
    loader(async () => loaded(0, { outcome: "draft", ci: "pending" }));
    const workflow = (await reader.readFeatureState("f1", options)).workflow;
    expect(workflow?.outcome).toBe("draft");
    expect(workflow?.ci).toBe("pending");
  });
  test("AC-7 omits unpublished outcome, CI and URL keys", async () => {
    const run = loaded();
    const { url, ...record } = run.record;
    loader(async () => ({ ...run, record }));
    const workflow = (await reader.readFeatureState("f1", options)).workflow;
    expect(workflow).not.toBeNull();
    expect(workflow).not.toHaveProperty("outcome");
    expect(workflow).not.toHaveProperty("ci");
    expect(workflow).not.toHaveProperty("url");
  });
  test.each([
    ["AC-9 AC-10", "WORKFLOW_RESULT_MISSING"],
    ["AC-11 AC-12", "WORKFLOW_NOT_STARTED"],
  ])("%s treats %s as ordinary absence", async (_, code) => {
    const load = loader(async () => {
      throw new NaxError("missing", code, { stage: "workflow" });
    });
    const state = await reader.readFeatureState("f1", options);
    expect(load).toHaveBeenCalledTimes(1);
    expect(state.workflow).toBeNull();
    expect(state.warnings).toEqual([]);
  });
  test("AC-13 AC-23 unexpected loader failure warns last and returns null", async () => {
    loader(async () => {
      throw new Error("bad json");
    });
    await Bun.write(join(featureDir(options.repoRoot, "f1"), "prd.json"), "{");
    await Bun.write(
      join(featureDir(options.repoRoot, "f1"), "status.json"),
      JSON.stringify({
        version: 1,
        run: { id: "r1", status: "running", pid: 123, startedAt: "now" },
        cost: { spent: 0, limit: null },
        progress: { passed: 0, total: 1 },
      }),
    );
    reader._featureStateDeps.isProcessAlive = () => false;
    const state = await reader.readFeatureState("f1", options);
    expect(state.workflow).toBeNull();
    expect(state.warnings[0]).toStartWith("prd.json unreadable:");
    expect(state.warnings.slice(1)).toEqual([
      "run r1 is marked running but its process is gone",
      "workflow record unreadable: bad json",
    ]);
  });
  test.each([
    ["AC-14", ["2026-10-01T10-00-00.jsonl", "2026-10-02T10-00-00.jsonl", "latest.jsonl"], "2026-10-02T10-00-00"],
    ["AC-15", [], null],
    ["AC-16", ["latest.jsonl"], null],
  ])("%s discovers only timestamp log filenames", async (_, files, expected) => {
    const runs = join(options.outputDir, "features", "f1", "runs");
    for (const file of files) await Bun.write(join(runs, file), "not log JSON");
    if (files.length) {
      mkdirSync(join(runs, "9999.jsonl"));
      await Bun.write(join(runs, "9999.txt"), "ignored");
    }
    expect((await reader.readFeatureState("f1", options)).lastRunLog).toBe(expected);
  });
});

async function touched(name: string, file: string, time: number) {
  const path = join(featureDir(options.repoRoot, name), file);
  await Bun.write(path, file === "prd.json" ? JSON.stringify(makePRD()) : "fixture");
  utimesSync(path, time, time);
}
describe("readWorkflowStateList", () => {
  test("AC-17 AC-18 AC-19 bounds the newest fully projected features", async () => {
    for (let i = 0; i < 12; i++) await touched(`f${i}`, "spec.md", 1000 + i);
    await touched("f0", "prd.json", 2000);
    const load = loader(async () => loaded());
    const list = await reader.readWorkflowStateList(options);
    expect(list.features).toHaveLength(10);
    expect(list.omitted).toBe(2);
    expect(list.features[0]?.name).toBe("f0");
    expect(list.features[0]?.prd?.total).toBe(1);
    expect(list.features[0]?.workflow?.runId).toBe("w1");
    expect(load).toHaveBeenCalledTimes(10);
  });
  test("AC-20 breaks ties by name ascending", async () => {
    await touched("b", "spec.md", 1000);
    await touched("a", "status.json", 1000);
    expect((await reader.readWorkflowStateList(options)).features.map((f) => f.name)).toEqual(["a", "b"]);
  });
  test("AC-21 skips invalid names, files and spec-only features", async () => {
    await touched("f1", "spec.md", 1000);
    mkdirSync(join(featuresDir(options.repoRoot), "bad name"));
    await Bun.write(join(featuresDir(options.repoRoot), "not-a-directory"), "file");
    await Bun.write(join(options.repoRoot, ".nax", "specs", "legacy.md"), "legacy");
    const list = await reader.readWorkflowStateList(options);
    expect(list.features.map((f) => f.name)).toEqual(["f1"]);
    expect(list.omitted).toBe(0);
    expect((await reader.readFeatureState("legacy", options)).spec).toBe(".nax/specs/legacy.md");
  });
  test("AC-22 missing feature tree returns an empty list", async () => {
    expect(await reader.readWorkflowStateList(options)).toEqual({ features: [], omitted: 0 });
  });
  test("uses status recency and tolerates directories with no tracked artifacts", async () => {
    await touched("older", "spec.md", 1000);
    await touched("newer", "spec.md", 500);
    await touched("newer", "status.json", 2000);
    mkdirSync(featureDir(options.repoRoot, "empty"));
    expect((await reader.readWorkflowStateList(options)).features.map((f) => f.name)).toEqual([
      "newer",
      "older",
      "empty",
    ]);
  });
});
