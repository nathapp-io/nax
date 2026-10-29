import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makePRD, makeStory, makeTempDir } from "@test/helpers";
import { _featureStateDeps, type FeatureStateOptions, readFeatureState } from "@/chat/workflow/feature-state";
import { featureDir } from "@/config";

const originalDeps = { ..._featureStateDeps };
const startedAt = "2026-10-01T00:00:00.000Z";
const deadWarning = "run r1 is marked running but its process is gone";
let options: FeatureStateOptions;
let dir: string;

function status(version = 1) {
  return {
    version,
    run: { id: "r1", status: "running", pid: 4242, startedAt },
    cost: { spent: 1.5, limit: null },
    progress: { passed: 1, total: 3 },
  };
}
async function artifact(file: string, value: unknown) {
  await Bun.write(join(dir, file), typeof value === "string" ? value : JSON.stringify(value));
}
async function prd(statuses = ["passed", "passed", "pending"], branchName = "feat/f1") {
  await artifact(
    "prd.json",
    makePRD({
      branchName,
      userStories: statuses.map((s, i) =>
        makeStory({ id: `US-${i}`, status: s === "passed" ? "passed" : "pending", passes: s === "passed" }),
      ),
    }),
  );
}
function negativeBranch(name = "feat/f1") {
  return { name, exists: false, current: false, upstream: null };
}

beforeEach(() => {
  const repoRoot = makeTempDir("feature-state-");
  options = { repoRoot, outputDir: join(repoRoot, "output"), maxIterations: 2 };
  dir = featureDir(repoRoot, "f1");
  _featureStateDeps.git = mock(async () => ({ exitCode: 1, stdout: "", stderr: "" }));
  _featureStateDeps.isProcessAlive = mock(() => true);
});
afterEach(() => {
  Object.assign(_featureStateDeps, originalDeps);
  cleanupTempDir(options.repoRoot);
});

describe("readFeatureState", () => {
  test("AC-1 prefers the feature spec over the legacy spec", async () => {
    await artifact("spec.md", "feature");
    await Bun.write(join(options.repoRoot, ".nax", "specs", "f1.md"), "legacy");
    expect((await readFeatureState("f1", options)).spec).toBe(".nax/features/f1/spec.md");
  });
  test("AC-2 falls back to the legacy spec", async () => {
    await Bun.write(join(options.repoRoot, ".nax", "specs", "f1.md"), "legacy");
    expect((await readFeatureState("f1", options)).spec).toBe(".nax/specs/f1.md");
  });
  test("AC-3 returns null without either spec", async () => {
    expect((await readFeatureState("f1", options)).spec).toBeNull();
  });
  test("AC-4 projects only the requested PRD counts", async () => {
    await prd();
    expect((await readFeatureState("f1", options)).prd).toEqual({
      branchName: "feat/f1",
      total: 3,
      passed: 2,
      failed: 0,
      pending: 1,
    });
  });
  test("AC-5 AC-6 missing PRD has no branch, warning or git calls", async () => {
    const state = await readFeatureState("f1", options);
    expect(state.prd).toBeNull();
    expect(state.branch).toBeNull();
    expect(state.warnings).toEqual([]);
    expect(_featureStateDeps.git).not.toHaveBeenCalled();
  });
  test("AC-7 AC-23 corrupt PRD warns and has no PRD or branch", async () => {
    await artifact("prd.json", "{");
    const state = await readFeatureState("f1", options);
    expect(state.warnings[0]).toStartWith("prd.json unreadable:");
    expect(state.prd).toBeNull();
    expect(state.branch).toBeNull();
    expect(_featureStateDeps.git).not.toHaveBeenCalled();
  });
  test("AC-8 warns with pending count as the iteration floor", async () => {
    await prd(["pending", "pending", "pending"]);
    expect((await readFeatureState("f1", options)).warnings).toEqual([
      "prd has 3 stories left but execution.maxIterations is 2; pass -m 3 to nax run (nax#2706)",
    ]);
  });
  test("nax#2706 workflow mode has no iteration floor: no warning when maxIterations is undefined", async () => {
    await prd(["pending", "pending", "pending"]);
    const workflowOptions = { repoRoot: options.repoRoot, outputDir: options.outputDir };
    expect((await readFeatureState("f1", workflowOptions)).warnings).toEqual([]);
  });
  test("AC-9 does not count passed stories toward the iteration floor", async () => {
    await prd([...Array.from({ length: 24 }, () => "passed"), "pending"]);
    expect((await readFeatureState("f1", options)).warnings).toEqual([]);
  });
  test("AC-10 projects valid run metadata, cost and progress", async () => {
    await artifact("status.json", status());
    const state = await readFeatureState("f1", options);
    expect(state.run).toEqual({ id: "r1", status: "running", startedAt, alive: true, spent: 1.5, passed: 1, total: 3 });
    expect(_featureStateDeps.isProcessAlive).toHaveBeenCalledWith(4242);
    expect(state.warnings).toEqual([]);
  });
  test("AC-11 warns for a dead running process", async () => {
    await artifact("status.json", status());
    _featureStateDeps.isProcessAlive = () => false;
    const state = await readFeatureState("f1", options);
    expect(state.run?.alive).toBe(false);
    expect(state.warnings).toEqual([deadWarning]);
  });
  test("AC-12 rejects status schema drift through the shared reader", async () => {
    await artifact("status.json", status(2));
    expect((await readFeatureState("f1", options)).run).toBeNull();
    expect(_featureStateDeps.isProcessAlive).not.toHaveBeenCalled();
  });
  test("AC-13 orders the PRD warning before the dead-process warning", async () => {
    await artifact("prd.json", "{");
    await artifact("status.json", status());
    _featureStateDeps.isProcessAlive = () => false;
    const state = await readFeatureState("f1", options);
    expect(state.warnings).toHaveLength(2);
    expect(state.warnings[0]).toStartWith("prd.json unreadable:");
    expect(state.warnings[1]).toBe(deadWarning);
  });
  test("AC-14 probes each branch field in repoRoot and trims output", async () => {
    await prd();
    const git = mock(async (args: string[], root: string) => {
      expect(root).toBe(options.repoRoot);
      const outputs: Record<string, string> = {
        "rev-parse --verify --quiet refs/heads/feat/f1": "",
        "symbolic-ref --short HEAD": "feat/f1\n",
        "rev-parse --abbrev-ref feat/f1@{upstream}": "origin/feat/f1\n",
      };
      expect(Object.keys(outputs)).toContain(args.join(" "));
      return { exitCode: 0, stdout: outputs[args.join(" ")], stderr: "" };
    });
    _featureStateDeps.git = git;
    expect((await readFeatureState("f1", options)).branch).toEqual({
      name: "feat/f1",
      exists: true,
      current: true,
      upstream: "origin/feat/f1",
    });
    expect(git).toHaveBeenCalledTimes(3);
  });
  test.each(["nonzero", "throw", "timeout"])("AC-15 AC-16 AC-24 git %s is negative without warnings", async (mode) => {
    await prd();
    _featureStateDeps.git = async () => {
      if (mode === "throw") throw new Error("git unavailable");
      return { exitCode: mode === "timeout" ? 0 : 1, timedOut: mode === "timeout", stdout: "feat/f1", stderr: "" };
    };
    const state = await readFeatureState("f1", options);
    expect(state.branch).toEqual(negativeBranch());
    expect(state.warnings).toEqual([]);
  });
  test.each(["--upload-pack=x", ""])("AC-17 AC-18 AC-19 AC-20 never probes unsafe branch '%s'", async (branch) => {
    await prd(undefined, branch);
    expect((await readFeatureState("f1", options)).branch).toEqual(negativeBranch(branch));
    expect(_featureStateDeps.git).not.toHaveBeenCalled();
  });
  test("a failed existence probe does not hide current branch or upstream", async () => {
    await prd();
    _featureStateDeps.git = async (args) => {
      if (args.includes("--verify")) throw new Error("probe failed");
      return { exitCode: 0, stdout: args[0] === "symbolic-ref" ? "other-branch\n" : "origin/feat/f1\n", stderr: "" };
    };
    const state = await readFeatureState("f1", options);
    expect(state.branch).toEqual({ name: "feat/f1", exists: false, current: false, upstream: "origin/feat/f1" });
    expect(state.warnings).toEqual([]);
  });
  test("terminal failed stories do not increase the iteration floor", async () => {
    await artifact(
      "prd.json",
      makePRD({
        userStories: [
          makeStory({ id: "failed", status: "failed" }),
          makeStory({ id: "regression", status: "regression-failed" }),
          makeStory({ id: "pending" }),
        ],
      }),
    );
    const state = await readFeatureState("f1", options);
    expect(state.prd).toEqual({ branchName: "main", total: 3, passed: 0, failed: 2, pending: 1 });
    expect(state.warnings).toEqual([]);
  });
  test("completed dead runs do not warn", async () => {
    const completed = status();
    completed.run.status = "completed";
    await artifact("status.json", completed);
    _featureStateDeps.isProcessAlive = () => false;
    const state = await readFeatureState("f1", options);
    expect(state.run?.alive).toBe(false);
    expect(state.warnings).toEqual([]);
  });
  test("AC-21 leaves workflow and log aggregation to US-003", async () => {
    const state = await readFeatureState("f1", options);
    expect(state.name).toBe("f1");
    expect(state.workflow).toBeNull();
    expect(state.lastRunLog).toBeNull();
  });
  test.each([null, "not json"])("AC-22 status %s fails soft without warnings", async (contents) => {
    if (contents !== null) await artifact("status.json", contents);
    const state = await readFeatureState("f1", options);
    expect(state.run).toBeNull();
    expect(state.warnings).toEqual([]);
  });
});
