import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { globalConfigDir } from "@/config/paths";
import { listCredentialFiles, listFeaturePrdPaths, resolveGitLayout } from "@/sandbox";
import { realOrRaw } from "@/utils/realpath";

let base: string;
beforeEach(() => {
  base = realOrRaw(makeTempDir("sbx-inputs-"));
});
afterEach(() => cleanupTempDir(base));

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(["git", "-c", "user.email=a@b", "-c", "user.name=a", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

describe("resolveGitLayout", () => {
  test("not a repo -> none", async () => {
    expect(await resolveGitLayout(base)).toEqual({ kind: "none" });
  });

  test("main checkout -> main with an absolute git dir", async () => {
    git(["init", "-q", "-b", "main"], base);
    expect(await resolveGitLayout(base)).toEqual({ kind: "main", gitDir: join(base, ".git") });
  });

  test("a nax-style worktree -> worktree with gitDir under the common dir", async () => {
    git(["init", "-q", "-b", "main"], base);
    writeFileSync(join(base, "a.txt"), "a");
    git(["add", "-A"], base);
    git(["commit", "-qm", "seed"], base);
    git(["worktree", "add", "-q", ".nax-wt/US-001", "-b", "wt"], base);
    const layout = await resolveGitLayout(join(base, ".nax-wt", "US-001"));
    expect(layout).toEqual({
      kind: "worktree",
      gitDir: join(base, ".git", "worktrees", "US-001"),
      commonDir: join(base, ".git"),
    });
  });
});

describe("listFeaturePrdPaths", () => {
  test("one prd.json path per feature directory, existing file or not", async () => {
    mkdirSync(join(base, ".nax", "features", "a"), { recursive: true });
    mkdirSync(join(base, ".nax", "features", "b"), { recursive: true });
    writeFileSync(join(base, ".nax", "features", "a", "prd.json"), "{}");
    const paths = (await listFeaturePrdPaths(base)).sort((a, b) => a.localeCompare(b));
    expect(paths).toEqual([
      join(base, ".nax", "features", "a", "prd.json"),
      join(base, ".nax", "features", "b", "prd.json"),
    ]);
  });

  test("no features directory -> empty", async () => {
    expect(await listFeaturePrdPaths(base)).toEqual([]);
  });
});

describe("listCredentialFiles", () => {
  test("every credentials* file in the global nax dir, as literals", async () => {
    const dir = globalConfigDir();
    mkdirSync(dir, { recursive: true });
    const made = ["credentials", "credentials-bak-2", "config.json"].map((n) => join(dir, n));
    try {
      for (const f of made) writeFileSync(f, "{}");
      const files = await listCredentialFiles();
      expect(files).toContain(join(dir, "credentials"));
      expect(files).toContain(join(dir, "credentials-bak-2"));
      expect(files).not.toContain(join(dir, "config.json"));
    } finally {
      for (const f of made) rmSync(f, { force: true });
    }
  });
});
