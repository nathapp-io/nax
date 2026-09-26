import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupTempDir, makeTempDir } from "@test/helpers";
import { globalConfigDir } from "@/config/paths";
import { listCredentialFiles, listNaxEntries, resolveGitLayout } from "@/sandbox";
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

describe("listNaxEntries", () => {
  test("every top-level entry under .nax, files and directories alike", async () => {
    mkdirSync(join(base, ".nax", "features", "a"), { recursive: true });
    mkdirSync(join(base, ".nax", "rules"), { recursive: true });
    writeFileSync(join(base, ".nax", "config.json"), "{}");
    const names = (await listNaxEntries(base)).sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(["config.json", "features", "rules"]);
  });

  test("F1: an entry with a glob character is skipped (it would poison every policy build)", async () => {
    mkdirSync(join(base, ".nax", "ok"), { recursive: true });
    mkdirSync(join(base, ".nax", "x*"), { recursive: true });
    mkdirSync(join(base, ".nax", "a[1]"), { recursive: true });
    expect(await listNaxEntries(base)).toEqual(["ok"]);
  });

  test("no .nax directory -> empty", async () => {
    expect(await listNaxEntries(base)).toEqual([]);
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
