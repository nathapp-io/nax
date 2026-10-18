/**
 * US-006 — the changed-file rules section in a review package, end to end from
 * the review steps that build one.
 *
 * `buildChangedFileRulesSection`'s text is covered by
 * `test/unit/prompts/builders/rules-index-builder-changed-files.test.ts` and the
 * per-file map by `test/unit/workflow/review-rules-map.test.ts`; this file covers
 * the wiring the review steps own — which package, which paths, and index-vs-push
 * delivery — plus the surviving-path contract of `writeReviewPackage`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  assertNaxError,
  cleanupTempDir,
  makeFeatureContext,
  makeNaxConfig,
  makeResolvedTestPatterns,
  makeScriptedCallOp,
  makeSparseNaxConfig,
  makeStepContext,
  makeTempDir,
} from "@test/helpers";
import { workflowBranchReviewOp, workflowStoryReviewOp } from "@/operations";
import { runBranchReview } from "@/workflow/branch-review";
import { writeReviewPackage } from "@/workflow/git";
import { _workflowDeps, type StepContext } from "@/workflow/step-context";
import { runStoryReview } from "@/workflow/story-review";
import type { BranchReviewVerdict, StoryReviewVerdict } from "@/workflow/types";

const original = { ..._workflowDeps };
const dirs: string[] = [];

afterEach(async () => {
  Object.assign(_workflowDeps, original);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

/** One recorded `_workflowDeps.appendChangedFileRules` call. */
interface AppendCall {
  readonly packagePath: string;
  readonly paths: readonly string[];
  readonly input: { repoRoot: string; overrideDir?: string; overrideMode: string };
}

/** Record every `appendChangedFileRules` call; `events` additionally records the order it ran in. */
function stubAppend(events?: string[]): AppendCall[] {
  const calls: AppendCall[] = [];
  _workflowDeps.appendChangedFileRules = async (packagePath, paths, input) => {
    calls.push({ packagePath, paths, input });
    events?.push("append");
  };
  return calls;
}

/** Stub git: `--name-status -z` answers `records` (repo-rooted, NUL separated); every other query is empty. */
function stubPackageGit(records: string): string[][] {
  const calls: string[][] = [];
  _workflowDeps.git = async (args) => {
    calls.push(args);
    return { stdout: args.includes("--name-status") ? records : "", exitCode: 0 };
  };
  return calls;
}

const A_AND_B = "A\0a.ts\0M\0src/b.ts\0";

/** A story context with a temp storyDir; `config` is the default (delivery: "index"). */
function storySc(config?: StepContext["config"]): StepContext {
  const storyDir = makeTempDir("wf-review-rules-");
  dirs.push(storyDir);
  return makeStepContext({ storyDir, base: "base0", ...(config ? { config } : {}) });
}

const STORY_VERDICT: StoryReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
};

const BRANCH_VERDICT: BranchReviewVerdict = {
  spec: "pass",
  quality: "approved",
  findings: [],
  cannotVerify: [],
  inspectedFiles: [],
  minorTriage: [],
};

const FACTS = {
  stories: [{ id: "US-001", state: "complete" }],
  minors: [],
  parked: [],
  cannotVerify: [],
  gateFindings: [],
};

/** Record the order in which the package step and the review op ran. */
function scriptOp(name: string, verdict: unknown, events: string[] = []): string[] {
  _workflowDeps.callOp = makeScriptedCallOp((op) => {
    expect(op.name).toBe(name);
    events.push("op");
    return verdict;
  });
  return events;
}

describe("runStoryReview changed-file rules (AC-7, AC-9)", () => {
  test("AC-7: index delivery appends the returning paths to package-0.diff, before the review op", async () => {
    const sc = storySc();
    stubPackageGit(A_AND_B);
    const events = scriptOp(workflowStoryReviewOp.name, STORY_VERDICT);
    const calls = stubAppend(events);

    expect(await runStoryReview(sc, [])).toEqual({ ran: true, verdict: STORY_VERDICT });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.packagePath).toBe(join(sc.storyDir, "package-0.diff"));
    expect(calls[0]?.paths).toEqual(["a.ts", "src/b.ts"]);
    expect(calls[0]?.input).toMatchObject({ repoRoot: sc.projectDir, overrideMode: "merge" });
    expect(events).toEqual(["append", "op"]);
  });

  test("AC-7: the run's override configuration reaches the map", async () => {
    const sc = storySc(
      makeNaxConfig({
        context: { rules: { delivery: "index", overrideDir: "/abs/org-rules", overrideMode: "replace" } },
      }),
    );
    stubPackageGit(A_AND_B);
    const calls = stubAppend();
    scriptOp(workflowStoryReviewOp.name, STORY_VERDICT);

    await runStoryReview(sc, []);

    expect(calls[0]?.input).toEqual({
      repoRoot: sc.projectDir,
      overrideDir: "/abs/org-rules",
      overrideMode: "replace",
    });
  });

  test("AC-9: push delivery appends nothing", async () => {
    const sc = storySc(makeNaxConfig({ context: { rules: { delivery: "push" } } }));
    stubPackageGit(A_AND_B);
    const calls = stubAppend();
    scriptOp(workflowStoryReviewOp.name, STORY_VERDICT);

    expect((await runStoryReview(sc, [])).ran).toBe(true);

    expect(calls).toEqual([]);
  });

  test("a sparse config reads delivery as index and does not throw", async () => {
    const sc = storySc(makeSparseNaxConfig({}));
    stubPackageGit(A_AND_B);
    const calls = stubAppend();
    scriptOp(workflowStoryReviewOp.name, STORY_VERDICT);

    expect((await runStoryReview(sc, [])).ran).toBe(true);

    expect(calls).toHaveLength(1);
  });

  test("a failing append skips the review and never calls the op", async () => {
    const sc = storySc();
    stubPackageGit(A_AND_B);
    _workflowDeps.appendChangedFileRules = async () => {
      throw new Error("rules exploded");
    };
    const events = scriptOp(workflowStoryReviewOp.name, STORY_VERDICT);

    const out = await runStoryReview(sc, []);

    expect(out.ran).toBe(false);
    expect(!out.ran && out.why).toBe("review package failed: rules exploded");
    expect(events).toEqual([]);
  });

  test("a failing package write is still a skipped review", async () => {
    const sc = storySc();
    _workflowDeps.git = async () => ({ stdout: "", stderr: "bad revision", exitCode: 128 });
    const calls = stubAppend();
    scriptOp(workflowStoryReviewOp.name, STORY_VERDICT);

    const out = await runStoryReview(sc, []);

    expect(out.ran).toBe(false);
    expect(calls).toEqual([]);
  });
});

/** A feature context with a temp runDir; delivery is "index" unless the test says otherwise. */
function featureCtx(config = makeNaxConfig()) {
  const runDir = makeTempDir("wf-review-rules-");
  dirs.push(runDir);
  _workflowDeps.git = async () => ({ stdout: "", exitCode: 0 });
  return makeFeatureContext({ runDir, config });
}

describe("runBranchReview changed-file rules (AC-8, AC-10)", () => {
  test("AC-8: index delivery appends the returned paths to package-branch.diff", async () => {
    const fc = featureCtx();
    stubPackageGit(A_AND_B);
    _workflowDeps.resolveTestPatterns = async () => makeResolvedTestPatterns({ regex: [] });
    const calls = stubAppend();
    scriptOp(workflowBranchReviewOp.name, BRANCH_VERDICT);

    expect((await runBranchReview(fc, { seed: "seed0", facts: FACTS })).ran).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.packagePath).toBe(join(fc.runDir, "package-branch.diff"));
    expect(calls[0]?.paths).toEqual(["a.ts", "src/b.ts"]);
    expect(calls[0]?.input).toMatchObject({ repoRoot: fc.projectDir, overrideMode: "merge" });
  });

  test("AC-10: push delivery appends nothing", async () => {
    const fc = featureCtx(makeNaxConfig({ context: { rules: { delivery: "push" } } }));
    stubPackageGit(A_AND_B);
    _workflowDeps.resolveTestPatterns = async () => makeResolvedTestPatterns({ regex: [] });
    const calls = stubAppend();
    scriptOp(workflowBranchReviewOp.name, BRANCH_VERDICT);

    expect((await runBranchReview(fc, { seed: "seed0", facts: FACTS })).ran).toBe(true);

    expect(calls).toEqual([]);
  });

  test("a failing append skips the branch review and never calls the op", async () => {
    const fc = featureCtx();
    stubPackageGit(A_AND_B);
    _workflowDeps.resolveTestPatterns = async () => makeResolvedTestPatterns({ regex: [] });
    _workflowDeps.appendChangedFileRules = async () => {
      throw new Error("rules exploded");
    };
    const events = scriptOp(workflowBranchReviewOp.name, BRANCH_VERDICT);

    const out = await runBranchReview(fc, { seed: "seed0", facts: FACTS });

    expect(out.ran).toBe(false);
    expect(!out.ran && out.why).toBe("review package failed: rules exploded");
    expect(events).toEqual([]);
  });
});

/** Run `git` in a temp repo, as the package writers do. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

/** A temp repo with one seed commit and a `base` sha to diff from. */
async function seededRepo(files: Record<string, string>): Promise<{ dir: string; base: string }> {
  const dir = makeTempDir("wf-review-pkg-");
  dirs.push(dir);
  await git(dir, "init", "-q");
  await git(dir, "config", "user.email", "t@t");
  await git(dir, "config", "user.name", "t");
  for (const [name, content] of Object.entries(files)) await Bun.write(join(dir, name), content);
  await git(dir, "add", "-A");
  await git(dir, "commit", "-qm", "seed");
  return { dir, base: await git(dir, "rev-parse", "HEAD") };
}

function packagePathIn(dir: string): string {
  return join(dir, "out", "package-0.diff");
}

describe("writeReviewPackage surviving paths (AC-11, AC-12)", () => {
  test("AC-11: an added file and a deleted file resolve to the added one alone", async () => {
    const { dir, base } = await seededRepo({ "b.ts": "export const b = 1;\n" });
    await Bun.write(join(dir, "a.ts"), "export const a = 1;\n");
    await Bun.file(join(dir, "b.ts")).delete();
    await git(dir, "add", "-A");
    await git(dir, "commit", "-qm", "feat: swap");

    expect(await writeReviewPackage(dir, base, packagePathIn(dir))).toEqual(["a.ts"]);
  });

  test("AC-11: a rename resolves to its new path and keeps the rename in the diff", async () => {
    const { dir, base } = await seededRepo({
      "old.ts": "export const kept = 'a stable body long enough to detect a rename';\n",
    });
    await git(dir, "mv", "old.ts", "new.ts");
    await git(dir, "commit", "-qm", "feat: rename");

    const path = packagePathIn(dir);
    expect(await writeReviewPackage(dir, base, path)).toEqual(["new.ts"]);
    const text = await Bun.file(path).text();
    expect(text).toContain("rename to new.ts");
  });

  test("AC-12: a failing --name-status query rejects and writes nothing", async () => {
    const dir = makeTempDir("wf-review-pkg-");
    dirs.push(dir);
    const path = packagePathIn(dir);
    _workflowDeps.git = async (args) =>
      args.includes("--name-status")
        ? { stdout: "", stderr: "bad revision", exitCode: 128 }
        : { stdout: "", exitCode: 0 };

    const err = await writeReviewPackage("/repo", "base0", path).then(
      () => undefined,
      (e: unknown) => e,
    );

    assertNaxError(err);
    expect(err.code).toBe("WORKFLOW_REVIEW_PACKAGE_FAILED");
    expect(err.message).toContain("bad revision");
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("AC-12: the other package queries still fail the package the same way", async () => {
    const dir = makeTempDir("wf-review-pkg-");
    dirs.push(dir);
    for (const failing of [["--name-only"], [] as string[]]) {
      const path = packagePathIn(dir);
      _workflowDeps.git = async (args) => {
        const failed = failing.length > 0 ? args.includes(failing[0] ?? "") : args[0] === "log";
        return failed ? { stdout: "", stderr: "bad revision", exitCode: 128 } : { stdout: "", exitCode: 0 };
      };
      const err = await writeReviewPackage("/repo", "base0", path).then(
        () => undefined,
        (e: unknown) => e,
      );
      assertNaxError(err);
      expect(err.code).toBe("WORKFLOW_REVIEW_PACKAGE_FAILED");
    }
  });
});
