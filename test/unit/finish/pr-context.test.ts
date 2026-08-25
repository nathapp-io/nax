import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { _finishPrDeps, createFinishState, loadFinishPrContext } from "@/finish";

const originalDeps = { ..._finishPrDeps };
let dir: string;

function stateFor(workdir: string) {
  return createFinishState({
    feature: "demo",
    workdir,
    branch: "feat/demo",
    runId: "run-1",
    base: "origin/main",
    specPath: ".nax/features/demo/spec.md",
  });
}

beforeEach(async () => {
  dir = await makeTempDir("pr-context");
});

afterEach(async () => {
  Object.assign(_finishPrDeps, originalDeps);
  await cleanupTempDir(dir);
});

describe("loadFinishPrContext", () => {
  test("reads stories and out-of-scope from the feature's prd.json", async () => {
    const featureDirPath = join(dir, ".nax", "features", "demo");
    await mkdir(featureDirPath, { recursive: true });
    await writeFile(
      join(featureDirPath, "prd.json"),
      JSON.stringify({
        userStories: [{ id: "US-001", title: "First", acceptanceCriteria: [1, 2, 3] }],
        outOfScope: ["not this"],
      }),
    );
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.stories).toEqual([{ id: "US-001", title: "First", acCount: 3 }]);
    expect(ctx.outOfScope).toEqual(["not this"]);
  });

  test("drops a story row whose id or title is not a string", async () => {
    const featureDirPath = join(dir, ".nax", "features", "demo");
    await mkdir(featureDirPath, { recursive: true });
    await writeFile(
      join(featureDirPath, "prd.json"),
      JSON.stringify({
        userStories: [
          { id: 7, title: "Bad" },
          { id: "US-002", title: "Good" },
        ],
      }),
    );
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.stories.map((s) => s.id)).toEqual(["US-002"]);
  });

  test("splits the diffstat from the nax-artifact summary using a glob pathspec", async () => {
    const calls: string[][] = [];
    _finishPrDeps.run = async (cmd) => {
      calls.push(cmd);
      return cmd.includes("--shortstat")
        ? { exitCode: 0, stdout: " 1 file changed, 5 insertions(+)\n", stderr: "" }
        : { exitCode: 0, stdout: " src/a.ts | 2 +-\n", stderr: "" };
    };

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.diffstat).toContain("src/a.ts");
    expect(ctx.artifactSummary).toBe("1 file changed, 5 insertions(+)");
    const stat = calls.find((c) => c.includes("--stat"));
    expect(stat).toContain(":(glob,exclude)**/.nax/**");
    const shortstat = calls.find((c) => c.includes("--shortstat"));
    expect(shortstat).toContain(":(glob)**/.nax/**");
  });

  test("skips the diffstat entirely when base is empty", async () => {
    let ran = false;
    _finishPrDeps.run = async () => {
      ran = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const state = stateFor(dir);
    state.base = "";

    const ctx = await loadFinishPrContext({
      state,
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ran).toBe(false);
    expect(ctx.diffstat).toBeUndefined();
  });

  test("falls back to feat: <feature> when no title was produced", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.title).toBe("feat: demo");
  });

  test("reports the gate names the machine recorded on state", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });
    const withGates = stateFor(dir);
    withGates.gatesRan = ["lint", "typecheck"];

    const ctx = await loadFinishPrContext({
      state: withGates,
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
    });

    expect(ctx.gatesRan).toEqual(["lint", "typecheck"]);
  });

  test("carries the caller's template mode and section map", async () => {
    _finishPrDeps.run = async () => ({ exitCode: 1, stdout: "", stderr: "" });

    const ctx = await loadFinishPrContext({
      state: stateFor(dir),
      audit: { auditDir: join(dir, "audit"), runId: "run-1" },
      prBody: { template: "strict", sectionMap: { notes: "narrative" } },
    });

    expect(ctx.templateMode).toBe("strict");
    expect(ctx.templateSectionMap).toEqual({ notes: "narrative" });
  });
});
