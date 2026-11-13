import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { NaxError } from "@/errors";
import { ALWAYS_EXCLUDED } from "@/review";
import { _branchDiffPartsDeps, writeBranchDiffParts } from "@/workflow/branch-diff-parts";
import { _workflowDeps } from "@/workflow/step-context";

const originalGit = _workflowDeps.git;
const originalDeps = { ..._branchDiffPartsDeps };
const dirs: string[] = [];
afterEach(async () => {
  _workflowDeps.git = originalGit;
  Object.assign(_branchDiffPartsDeps, originalDeps);
  await Promise.all(dirs.map(cleanupTempDir));
  dirs.length = 0;
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
  return stdout.trim();
}

function dir(): string {
  const path = makeTempDir("branch-parts-");
  dirs.push(path);
  return path;
}

function largeDiff(count: number): string {
  return Array.from({ length: count }, (_, i) => {
    const name = `file-${i}.ts`;
    return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,18 @@\n${`+${"x".repeat(998)}\n`.repeat(18)}`;
  }).join("");
}

function stub(diff: string): { writes: { path: string; text: string; append: boolean }[]; removed: string[] } {
  const writes: { path: string; text: string; append: boolean }[] = [];
  const removed: string[] = [];
  _workflowDeps.git = async () => ({ stdout: diff, exitCode: 0 });
  _branchDiffPartsDeps.list = async () => [];
  _branchDiffPartsDeps.remove = async (path) => {
    removed.push(path);
  };
  _branchDiffPartsDeps.write = async (path, text, append) => {
    writes.push({ path, text, append });
  };
  return { writes, removed };
}

describe("writeBranchDiffParts", () => {
  test("writes the complete two-file diff, inventory and excludes nax paths (AC-1–5)", async () => {
    const repo = dir();
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Test");
    await Bun.write(join(repo, "a.ts"), "old\n");
    await Bun.write(join(repo, "b.ts"), "old\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "seed");
    const seed = await git(repo, "rev-parse", "HEAD");
    await Bun.write(join(repo, "a.ts"), "old\nfirst added\nsecond added\n");
    await Bun.write(join(repo, "b.ts"), "old\nother\n");
    await Bun.write(join(repo, ".nax", "excluded.txt"), "excluded\n");
    await git(repo, "add", "-f", ".");
    await git(repo, "commit", "-qm", "change");
    const packagePath = join(repo, "package-branch.diff");
    await Bun.write(packagePath, "package\n");
    const path = join(repo, "package-branch-part-01.diff");
    const parts = await writeBranchDiffParts(repo, seed, packagePath);
    expect(parts).toEqual([{ path, files: ["a.ts", "b.ts"] }]);
    const text = await Bun.file(path).text();
    expect(text).toContain("+first added\n+second added\n");
    expect(parts.flatMap((part) => part.files)).not.toContain(".nax/excluded.txt");
    expect(await Bun.file(packagePath).text()).toEndWith(`## Diff parts (1)\n- ${path}: a.ts, b.ts\n`);
  });

  test.each([3, 120])("numbers %i parts with the required width (AC-6–7)", async (count) => {
    const { writes } = stub(largeDiff(count));
    const parts = await writeBranchDiffParts("/repo", "seed", "/out/package-branch.diff");
    const width = count > 99 ? 3 : 2;
    expect(parts).toHaveLength(count);
    expect(writes.filter((w) => !w.append).map((w) => w.path)).toEqual(
      Array.from({ length: count }, (_, i) => `/out/package-branch-part-${String(i + 1).padStart(width, "0")}.diff`),
    );
  });

  test("deletes only the exact stem's stale parts before writes (AC-8)", async () => {
    const { removed, writes } = stub(largeDiff(1));
    _branchDiffPartsDeps.list = async () => [
      "package-branch-part-07.diff",
      "other.diff",
      "package-branch-extra-part-01.diff",
    ];
    await writeBranchDiffParts("/repo", "seed", "/out/package-branch.diff");
    expect(removed).toEqual(["/out/package-branch-part-07.diff"]);
    expect(writes.length).toBeGreaterThan(0);
  });

  test("deletion failure is a package error and prevents all writes (AC-9–10)", async () => {
    const { writes } = stub(largeDiff(1));
    _branchDiffPartsDeps.list = async () => ["package-branch-part-07.diff"];
    _branchDiffPartsDeps.remove = async () => {
      throw new Error("denied");
    };
    try {
      await writeBranchDiffParts("/repo", "seed", "/out/package-branch.diff");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(NaxError);
      expect(error).toHaveProperty("code", "WORKFLOW_REVIEW_PACKAGE_FAILED");
    }
    expect(writes).toEqual([]);
  });

  test("failed git diff raises a package error and uses the protected pathspec (AC-11)", async () => {
    stub("");
    let args: string[] = [];
    _workflowDeps.git = async (received) => {
      args = received;
      return { stdout: "", stderr: "bad revision", exitCode: 128 };
    };
    await expect(writeBranchDiffParts("/repo", "seed", "/out/package-branch.diff")).rejects.toMatchObject({
      code: "WORKFLOW_REVIEW_PACKAGE_FAILED",
    });
    expect(args).toEqual([
      "-c",
      "core.quotePath=false",
      "diff",
      "--text",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--unified=10",
      "seed..HEAD",
      "--",
      ".",
      ...ALWAYS_EXCLUDED,
    ]);
  });

  test("empty diff returns no parts but appends an empty inventory (AC-12–14)", async () => {
    const { writes } = stub("");
    expect(await writeBranchDiffParts("/repo", "seed", "/out/package-branch.diff")).toEqual([]);
    expect(writes).toEqual([{ path: "/out/package-branch.diff", text: "\n## Diff parts (0)\n", append: true }]);
  });
});
