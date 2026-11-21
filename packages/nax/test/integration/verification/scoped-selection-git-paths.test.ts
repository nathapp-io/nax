import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanupTempDir, makeFeatureMachineHarness, makeTempDir } from "@test/helpers";
import { initLogger, resetLogger } from "@/logger";
import { selectScopedTests } from "@/test-runners/scoped-selection";
import { clearGitRootCache, getChangedNonTestFiles, getChangedTestFiles } from "@/verification/smart-runner";
import { newFeatureRecord } from "@/workflow/feature-record";
import { branchReReviewStep } from "@/workflow/feature-steps";
import { changedFilesSince } from "@/workflow/git";

const RE = [/\.test\.ts$/];
const dirs: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim();
}

async function put(root: string, rel: string, text: string): Promise<void> {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  await Bun.write(join(root, rel), text);
}

async function fixture(files: Record<string, string>, project = ""): Promise<{ root: string; project: string }> {
  const root = realpathSync(makeTempDir("nax-gitpaths-"));
  dirs.push(root);
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "t@t");
  await git(root, "config", "user.name", "t");
  await git(root, "config", "core.quotePath", "true");
  await git(root, "config", "diff.renames", "false");
  for (const [rel, text] of Object.entries(files)) await put(root, rel, text);
  await git(root, "add", "-A");
  await git(root, "commit", "-qm", "base");
  return { root, project: project ? join(root, project) : root };
}

const select = (project: string) =>
  selectScopedTests({
    workdir: project,
    repoRoot: project,
    storyId: "s",
    storyGitRef: "HEAD",
    testCommand: "bun test",
    smartRunnerConfig: { enabled: true, testFilePatterns: ["**/*.test.ts"] },
  });

beforeEach(() => {
  initLogger({ level: "silent" });
  clearGitRootCache();
});
afterEach(() => {
  resetLogger();
  clearGitRootCache();
  for (const d of dirs.splice(0)) cleanupTempDir(d);
});

const SIBLING = {
  "app/ing/widget.test.ts": 'import { test } from "bun:test";\ntest("w", () => {});\n',
  "app/src/value.ts": "export const value=1;\n",
  "app/src/value.test.ts":
    'import { expect, test } from "bun:test";\nimport { value } from "./value";\ntest("v", () => expect(value).toBe(1));\n',
};

describe("quoted names", () => {
  test("AC-8/9: select includes the decoded non-ASCII test and the ASCII one", async () => {
    const { root, project } = await fixture({ "base.txt": "x" });
    await put(root, "日本.test.ts", "// a\n");
    await put(root, "other.test.ts", "// b\n");
    await git(root, "add", "-A");
    const r = await select(project);
    expect(r.effectiveCommand).toContain("日本.test.ts");
    expect(r.effectiveCommand).toContain("other.test.ts");
  });

  test("AC-10/11: branchReReviewStep sees a quoted path changed by the fix", async () => {
    const { root, project } = await fixture({ "base.txt": "x" });
    const base = await git(root, "rev-parse", "HEAD");
    await put(root, "src/支払.ts", "export const a = 1;\n");
    await put(root, "src/hello.ts", "export const b = 1;\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "fix");
    for (const [file, ids] of [
      ["src/支払.ts", ["B2"]],
      ["src/hello.ts", ["B2"]],
    ] as const) {
      const draft = { kind: "quality" as const, severity: "important" as const, issue: "new defect", file, line: 1 };
      const open = { kind: "quality" as const, severity: "important" as const, issue: "old", id: "B1" };
      const rec = {
        ...newFeatureRecord({ now: "t", seed: "s", minors: [] }),
        fixRan: true,
        fixBase: base,
        reviewOpen: [open],
        nextFindingId: 2,
      };
      const h = makeFeatureMachineHarness(
        {},
        { record: rec, limits: { maxBranchFixRounds: 2, finalGateRepairRounds: 1 } },
      );
      const env = {
        ...h.env,
        sink: { ...h.env.sink, artifact: async () => {}, ledger: async () => {} },
        steps: {
          ...h.env.steps,
          changedFiles: (from: string) => changedFilesSince(project, from),
          branchReReview: async () => ({
            ran: true as const,
            verdict: { verdicts: [{ id: "B1", addressed: true, note: "" }], newFindings: [draft] },
          }),
        },
      };
      const result = await branchReReviewStep(env, rec);
      expect(result.exit).toBe("again");
      expect(result.patch.fixTargets).toEqual([...ids]);
    }
  });
});

describe("deleted tests", () => {
  const base = { "old.test.ts": "// o\n", "kept.test.ts": "// k\n" };

  test("AC-12: a deleted test is not returned", async () => {
    const { root, project } = await fixture(base);
    await Bun.spawn(["rm", join(root, "old.test.ts")]).exited;
    expect(await getChangedTestFiles(project, project, "HEAD", undefined, RE)).toEqual([]);
  });

  test("AC-13: select runs only the kept, modified test", async () => {
    const { root, project } = await fixture(base);
    await Bun.spawn(["rm", join(root, "old.test.ts")]).exited;
    await put(root, "kept.test.ts", "// k2\n");
    const r = await select(project);
    expect(r.effectiveCommand).toBe(`bun test '${join(project, "kept.test.ts")}'`);
  });

  test("AC-14: a rename returns the new path", async () => {
    const { root, project } = await fixture(base);
    await git(root, "mv", "old.test.ts", "renamed.test.ts");
    expect(await getChangedTestFiles(project, project, "HEAD", undefined, RE)).toEqual([
      join(project, "renamed.test.ts"),
    ]);
  });
});

describe("project below the Git root", () => {
  test("AC-15: a sibling directory's test is dropped", async () => {
    const { root, project } = await fixture(SIBLING, "app");
    await put(root, "sibling/widget.test.ts", "// s\n");
    await git(root, "add", "-A");
    expect(await getChangedTestFiles(project, project, "HEAD", undefined, RE)).toEqual([]);
  });

  test("AC-16: select picks the import-grep test, not a mangled sibling path", async () => {
    const { root, project } = await fixture(SIBLING, "app");
    await put(root, "sibling/widget.test.ts", "// s\n");
    await put(root, "app/src/value.ts", "export const value=0;\n");
    await git(root, "add", "-A");
    const r = await select(project);
    expect(r.effectiveCommand).toBe(`bun test '${join(project, "src/value.test.ts")}'`);
  });

  test("AC-17: a path sharing the project name as a prefix is dropped", async () => {
    const { root, project } = await fixture(SIBLING, "app");
    await put(root, "app2/x.test.ts", "// x\n");
    await git(root, "add", "-A");
    expect(await getChangedTestFiles(project, project, "HEAD", undefined, RE)).toEqual([]);
  });

  test("AC-18: a test inside the project is returned (control)", async () => {
    const { root, project } = await fixture(SIBLING, "app");
    await put(root, "app/src/new.test.ts", "// n\n");
    await git(root, "add", "-A");
    expect(await getChangedTestFiles(project, project, "HEAD", undefined, RE)).toEqual([
      join(project, "src/new.test.ts"),
    ]);
  });

  test("AC-19: non-test paths outside the project are dropped, in-project stay git-root relative", async () => {
    const { root, project } = await fixture(SIBLING, "app");
    await put(root, "sibling/notes.ts", "// n\n");
    await put(root, "app/src/value.ts", "export const value=0;\n");
    await git(root, "add", "-A");
    expect(await getChangedNonTestFiles(project, "HEAD", undefined, RE, undefined, project)).toEqual([
      "app/src/value.ts",
    ]);
  });
});
